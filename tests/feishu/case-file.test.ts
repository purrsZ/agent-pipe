import { describe, expect, it } from 'vitest';
import type { WorkItemEvent } from '../../src/workitems/types.js';
import { caseFileDetail, caseFileLabel } from '../../src/index.js';

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

  it('抽不到 → undefined（永不抛）', () => {
    expect(caseFileDetail([], 'reconcile_conflict')).toBeUndefined();
    expect(caseFileDetail([ev('run_failed', {})], 'run_failed')).toBeUndefined();
  });
});
