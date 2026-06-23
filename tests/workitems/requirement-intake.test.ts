import { describe, expect, it } from 'vitest';
import {
  applyFieldInput,
  buildIntakeBrief,
  foldIntake,
  INTAKE_CHECKLIST,
  initialIntakeState,
  intakeReposOf,
  isFieldSatisfied,
  isGateReady,
  requiredMissing,
  requiredProgress,
} from '../../src/worktypes/requirement/intake.js';

// 立项清单纯核心（M-I1 任务1）：清单 v1 + fold + 必填判定 + 立项书。全沙箱可测，不读 fs / 不建群 / 不调 AI。

const REQUIRED_KEYS = ['name', 'summary', 'repos', 'prd', 'acceptance'] as const;

function fillAllRequired() {
  return foldIntake([
    { key: 'name', value: '订单状态查询' },
    { key: 'summary', value: '给运营加一个按订单号查状态的入口' },
    { key: 'repos', value: ['/abs/backend', '/abs/frontend'] },
    { key: 'prd', value: 'PRD 全文……' },
    { key: 'acceptance', value: '输入订单号能返回状态' },
  ]);
}

describe('INTAKE_CHECKLIST v1', () => {
  it('定义 10 项，其中 5 项恒必填、ui 为条件必填', () => {
    expect(INTAKE_CHECKLIST).toHaveLength(10);
    const required = INTAKE_CHECKLIST.filter((d) => d.requirement === 'required').map((d) => d.key);
    expect(required).toEqual([...REQUIRED_KEYS]);
    expect(INTAKE_CHECKLIST.find((d) => d.key === 'ui')?.requirement).toBe('conditional');
    expect(INTAKE_CHECKLIST.find((d) => d.key === 'repos')?.multi).toBe(true);
  });
});

describe('applyFieldInput', () => {
  it('user 填的项算确认；repos 归一为去空白数组', () => {
    const s = applyFieldInput(initialIntakeState(), { key: 'repos', value: ['  /a  ', '', '/b'] });
    const repos = s.fields.find((f) => f.key === 'repos')!;
    expect(repos.value).toEqual(['/a', '/b']);
    expect(repos.filledBy).toBe('user');
    expect(repos.confirmed).toBe(true);
  });

  it('ai-extracted 默认未确认，除非显式 confirmed', () => {
    let s = applyFieldInput(initialIntakeState(), {
      key: 'acceptance',
      value: '从 PRD 抽的草稿',
      filledBy: 'ai-extracted',
    });
    expect(isFieldSatisfied(s.fields[0])).toBe(false); // 未 confirm 不算齐
    s = applyFieldInput(s, {
      key: 'acceptance',
      value: '从 PRD 抽的草稿',
      filledBy: 'ai-extracted',
      confirmed: true,
    });
    expect(isFieldSatisfied(s.fields.find((f) => f.key === 'acceptance'))).toBe(true);
  });

  it('同 key 覆盖（最后一次为准），且不改入参', () => {
    const s0 = applyFieldInput(initialIntakeState(), { key: 'name', value: '旧名' });
    const s1 = applyFieldInput(s0, { key: 'name', value: '新名' });
    expect(s1.fields.filter((f) => f.key === 'name')).toHaveLength(1);
    expect(s1.fields.find((f) => f.key === 'name')?.value).toBe('新名');
    expect(s0.fields.find((f) => f.key === 'name')?.value).toBe('旧名'); // 入参未变
  });

  it('uiRequired 可独立设置（无 key 也行）', () => {
    const s = applyFieldInput(initialIntakeState(), { uiRequired: true });
    expect(s.uiRequired).toBe(true);
    expect(s.fields).toHaveLength(0);
  });

  it('非清单 key / 空值的填项被忽略', () => {
    const s = applyFieldInput(initialIntakeState(), {
      key: 'bogus' as never,
      value: 'x',
    });
    expect(s.fields).toHaveLength(0);
  });
});

describe('foldIntake', () => {
  it('把事件历史 fold 成当前态，坏 payload 跳过', () => {
    const s = foldIntake([
      { key: 'name', value: '需求A' },
      null,
      'garbage',
      {},
      { key: 'summary', value: '背景说明' },
      { uiRequired: true },
    ]);
    expect(s.fields.map((f) => f.key).sort()).toEqual(['name', 'summary']);
    expect(s.uiRequired).toBe(true);
  });

  it('fields 按 checklist 顺序归一（与填入顺序无关）', () => {
    const s = foldIntake([
      { key: 'acceptance', value: 'a' },
      { key: 'name', value: 'n' },
      { key: 'summary', value: 's' },
    ]);
    expect(s.fields.map((f) => f.key)).toEqual(['name', 'summary', 'acceptance']);
  });
});

describe('isGateReady / requiredMissing', () => {
  it('5 必填齐 → gate ready', () => {
    const s = fillAllRequired();
    expect(requiredMissing(s)).toHaveLength(0);
    expect(isGateReady(s)).toBe(true);
  });

  it('缺任一必填 → 未 ready，且 requiredMissing 指明缺项', () => {
    let s = fillAllRequired();
    s = { ...s, fields: s.fields.filter((f) => f.key !== 'prd') };
    expect(isGateReady(s)).toBe(false);
    expect(requiredMissing(s).map((d) => d.key)).toEqual(['prd']);
  });

  it('勾选「涉及 UI 改动」后 ui 升为必填，缺 ui → 未 ready', () => {
    let s = fillAllRequired();
    s = applyFieldInput(s, { uiRequired: true });
    expect(isGateReady(s)).toBe(false);
    expect(requiredMissing(s).map((d) => d.key)).toEqual(['ui']);
    s = applyFieldInput(s, { key: 'ui', value: 'https://figma/x' });
    expect(isGateReady(s)).toBe(true);
  });

  it('未勾 UI 时 ui 项不影响 gate', () => {
    expect(isGateReady(fillAllRequired())).toBe(true);
  });

  it('空 repos 数组（去空白后为空）建了字段但不算齐 → 未 ready，requiredMissing 含 repos', () => {
    let s = fillAllRequired();
    s = applyFieldInput(s, { key: 'repos', value: ['', '  '] });
    const repos = s.fields.find((f) => f.key === 'repos')!;
    expect(repos.value).toEqual([]); // 字段存在但值为空数组
    expect(isFieldSatisfied(repos)).toBe(false); // 空数组不算「有值」
    expect(isGateReady(s)).toBe(false);
    expect(requiredMissing(s).map((d) => d.key)).toContain('repos');
  });
});

describe('requiredProgress', () => {
  it('随必填项填充与 uiRequired 变化', () => {
    let s = initialIntakeState();
    expect(requiredProgress(s)).toEqual({ filled: 0, total: 5 });
    s = applyFieldInput(s, { key: 'name', value: 'n' });
    expect(requiredProgress(s)).toEqual({ filled: 1, total: 5 });
    s = applyFieldInput(s, { uiRequired: true });
    expect(requiredProgress(s)).toEqual({ filled: 1, total: 6 });
  });
});

describe('buildIntakeBrief', () => {
  it('产结构化立项书，含标题/仓库/验收，只输出有值项', () => {
    const brief = buildIntakeBrief(fillAllRequired());
    expect(brief).toContain('# 立项书：订单状态查询');
    expect(brief).toContain('## 一句话需求 + 背景');
    expect(brief).toContain('## 涉及代码仓库');
    expect(brief).toContain('- /abs/backend');
    expect(brief).toContain('## 验收标准 / 完成定义');
    expect(brief).not.toContain('## 范围边界'); // 未填 → 不输出
    expect(brief.endsWith('\n')).toBe(true);
  });

  it('prdSummary 优先于 prd 原文喂下游', () => {
    let s = fillAllRequired();
    s = applyFieldInput(s, { prdSummary: 'AI 摘要：三步走' });
    const brief = buildIntakeBrief(s);
    expect(brief).toContain('AI 摘要：三步走');
    expect(brief).not.toContain('PRD 全文');
  });

  it('勾了 UI 但未填稿 → 立项书标注待补', () => {
    const s = applyFieldInput(fillAllRequired(), { uiRequired: true });
    expect(buildIntakeBrief(s)).toContain('设计稿待补');
  });
});

describe('intakeReposOf', () => {
  it('取立项收齐的仓库（repos 字段归一值）供 workitem.repos 提升', () => {
    expect(intakeReposOf(fillAllRequired())).toEqual(['/abs/backend', '/abs/frontend']);
  });

  it('未填 repos → 空数组', () => {
    expect(intakeReposOf(initialIntakeState())).toEqual([]);
  });
});
