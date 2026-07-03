import { describe, expect, it } from 'vitest';
import type { WorkItemEvent } from '../../src/workitems/types.js';
import {
  assembleAuqAnswers,
  caseFileDetail,
  caseFileLabel,
  deliverGateNote,
  humanizeMs,
  waitCardKindFor,
  withAdvisorHint,
} from '../../src/index.js';

// 病历(非 checkpoint 的 human wait)→ 飞书卡标签/详情的桥层纯核心（B：病历飞书出口）。

function ev(kind: string, payload: unknown): WorkItemEvent {
  return { id: 1, workitemId: 'wi-1', seq: 1, kind, payload, createdAt: 1000 };
}

describe('caseFileLabel', () => {
  it('把 4 类病历 reason 映射成人类标签；非病历 → undefined', () => {
    expect(caseFileLabel('reconcile_conflict')).toContain('跨仓对账');
    expect(caseFileLabel('gatekeeper_big')).toContain('监工');
    expect(caseFileLabel('run_failed')).toContain('执行报错');
    expect(caseFileLabel('integration_unresolved')).toContain('集成');
    expect(caseFileLabel('checkpoint:requirement:交付')).toBeUndefined();
    expect(caseFileLabel('cancel_confirm')).toBeUndefined();
  });

  it('WS-1 补三类容器/自检病历标签（stalled_no_path / retry_exhausted / thrash）', () => {
    expect(caseFileLabel('stalled_no_path')).toContain('卡死');
    expect(caseFileLabel('retry_exhausted')).toContain('重试');
    expect(caseFileLabel('thrash')).toContain('震荡');
  });

  it('WS-10.3 全覆盖：所有走 caseFileLabel 的 human wait reason 都有卡（防新病历成无卡暗仓）', () => {
    for (const r of [
      'reconcile_conflict',
      'gatekeeper_big',
      'run_failed',
      'integration_unresolved',
      'retry_exhausted',
      'thrash',
      'stalled_no_path',
      'steer_escalated',
    ]) {
      expect(caseFileLabel(r), r).toBeTruthy();
    }
    // 专属卡（非 caseFileLabel）：cancel_confirm → buildCancelConfirmCard（WS-10.9）、awaiting_close →
    // buildClosureCard（WS-7.7）、checkpoint:* → buildCheckpointCard。surfaceCheckpoints 各有专属分支。
    expect(caseFileLabel('cancel_confirm')).toBeUndefined();
    expect(caseFileLabel('awaiting_close')).toBeUndefined();
  });
});

describe('assembleAuqAnswers (WS-9 AUQ 答案组装)', () => {
  it('自定义优先于下拉、未作答占位；lines 给 agent、brief 给卡片', () => {
    const { lines, brief } = assembleAuqAnswers(
      { q0_custom: '  莫兰迪色  ', q1_pick: '面包', q2_custom: '' },
      3,
      ['配色', '主食', '甜点'],
    );
    expect(lines[0]).toContain('莫兰迪色');
    expect(lines[0]).toContain('自定义回答');
    expect(lines[1]).toContain('面包');
    expect(lines[1]).toContain('选自预设');
    expect(lines[2]).toContain('(未作答)');
    expect(brief).toEqual(['配色：莫兰迪色', '主食：面包', '甜点：(未作答)']);
  });

  it('select_static value 可为 { value } 对象形态', () => {
    const { brief } = assembleAuqAnswers({ q0_pick: { value: '粥' } }, 1, ['主食']);
    expect(brief[0]).toBe('主食：粥');
  });
});

describe('humanizeMs', () => {
  it('把毫秒时长格式化成中文（分钟 / 小时 / 天）', () => {
    expect(humanizeMs(30 * 60_000)).toBe('30 分钟');
    expect(humanizeMs(4 * 3_600_000)).toBe('4 小时');
    expect(humanizeMs(26 * 3_600_000)).toBe('1 天 2 小时');
    expect(humanizeMs(48 * 3_600_000)).toBe('2 天');
    expect(humanizeMs(-5)).toBe('0 分钟');
  });
});

describe('caseFileDetail', () => {
  it('reconcile_conflict：抽 unresolved[].detail', () => {
    const events = [
      ev('reconcile_conflict', {
        unresolved: [{ detail: '后端仓未列入' }, { detail: '设计目录缺失' }],
      }),
    ];
    expect(caseFileDetail(events, 'reconcile_conflict')).toBe('后端仓未列入；设计目录缺失');
  });

  it('gatekeeper_big：抽 raises[].question', () => {
    const events = [ev('gatekeeper_big', { raises: [{ question: '要改 createOrder 字段' }] })];
    expect(caseFileDetail(events, 'gatekeeper_big')).toBe('要改 createOrder 字段');
  });

  it('integration_unresolved：读 integration_check_failed 的破坏性计数', () => {
    const events = [ev('integration_check_failed', { breaking: [{}, {}] })];
    expect(caseFileDetail(events, 'integration_unresolved')).toBe('破坏性变更 2 处');
  });

  it('WS-2 steer_escalated：标签 + detail 取最近 steer_directive 的 note', () => {
    expect(caseFileLabel('steer_escalated')).toContain('包工头');
    const events = [
      ev('steer_directive', { action: 'raise_human', note: '用户要求超出范围，请裁决' }),
    ];
    expect(caseFileDetail(events, 'steer_escalated')).toBe('用户要求超出范围，请裁决');
  });

  // WS-10.2（审查修复 T9）：病历详情带上受影响仓。注意 caseFileDetail 仅在主详情（detail/question）
  // 非空时才追加「（涉及：仓）」，故 payload 同时给主详情 + 仓。
  it('reconcile_conflict 带仓 → detail 含「涉及：」与两仓名', () => {
    const events = [
      ev('reconcile_conflict', { unresolved: [{ detail: '契约漂移', repos: ['a', 'b'] }] }),
    ];
    const detail = caseFileDetail(events, 'reconcile_conflict');
    expect(detail).toContain('涉及：');
    expect(detail).toContain('a');
    expect(detail).toContain('b');
  });

  it('gatekeeper_big 带仓 → detail 含仓名 x', () => {
    const events = [
      ev('gatekeeper_big', { raises: [{ question: '要改 createOrder 字段', repo: 'x' }] }),
    ];
    expect(caseFileDetail(events, 'gatekeeper_big')).toContain('x');
  });

  it('抽不到 → undefined（永不抛）', () => {
    expect(caseFileDetail([], 'reconcile_conflict')).toBeUndefined();
    expect(caseFileDetail([ev('run_failed', {})], 'run_failed')).toBeUndefined();
  });
});

describe('deliverGateNote (WS-7.3 灯③ 证据 note，审查修复 F3)', () => {
  it('真对账通过带 interfaceCount → 文案标注契约条数', () => {
    expect(deliverGateNote([ev('integration_check_passed', { interfaceCount: 3 })])).toBe(
      '✅ 静态跨仓对账通过（契约 3 条接口）',
    );
  });

  it('历史事件无 interfaceCount → 回落原通过文案', () => {
    expect(deliverGateNote([ev('integration_check_passed', {})])).toBe('✅ 静态跨仓对账通过');
  });

  it('no_contract → 提示人工验收（reason 分支不被 interfaceCount 改动干扰）', () => {
    expect(deliverGateNote([ev('integration_check_passed', { reason: 'no_contract' })])).toContain(
      '静态跨仓对账未生效',
    );
  });
});

describe('waitCardKindFor 全覆盖（审查修复 T3：每个会 raise 的 human wait reason 都有专属卡）', () => {
  it('枚举所有会 raise 的 reason → 返回精确 cardKind（新 reason 忘配卡即返回 null → 测试红）', () => {
    const cases: Array<[string, ReturnType<typeof waitCardKindFor>]> = [
      ['checkpoint:requirement:交付', 'checkpoint'],
      ['reconcile_conflict', 'case-file'],
      ['gatekeeper_big', 'gatekeeper-big'], // 也有 caseFileLabel，须在 case-file 之前判定
      ['run_failed', 'case-file'],
      ['integration_unresolved', 'case-file'],
      ['retry_exhausted', 'case-file'],
      ['thrash', 'case-file'],
      ['stalled_no_path', 'case-file'],
      ['steer_escalated', 'case-file'],
      ['cancel_confirm', 'cancel-confirm'],
      ['awaiting_close', 'closure'],
    ];
    for (const [reason, expected] of cases) {
      expect(waitCardKindFor(reason), reason).toBe(expected);
    }
  });

  it('未知 reason → null（surfaceCheckpoints 跳过发卡）', () => {
    expect(waitCardKindFor('some_unknown_reason')).toBeNull();
  });
});

describe('withAdvisorHint（ENHANCE E4：事故卡注明参谋在路上）', () => {
  it('三类业务事故 → detail 尾部追加参谋提示；detail 为空时只给提示', () => {
    for (const reason of ['gatekeeper_big', 'reconcile_conflict', 'integration_unresolved']) {
      expect(withAdvisorHint(reason, '出事了'), reason).toContain('参谋正在分析');
      expect(withAdvisorHint(reason, '出事了'), reason).toContain('出事了');
      expect(withAdvisorHint(reason, undefined), reason).toContain('参谋正在分析');
    }
  });

  it('机械故障病历不加提示（不派参谋，detail 原样透传）', () => {
    expect(withAdvisorHint('run_failed', '报错了')).toBe('报错了');
    expect(withAdvisorHint('retry_exhausted', undefined)).toBeUndefined();
  });
});
