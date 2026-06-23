// 立项（intake）域纯核心（worktypes 层；业务词可用，但本文件保持纯：无 async/await/fs/child_process）。
//
// 立项 = requirement 生命周期最前面新增的一段：建专属群 → 引导者把前置料收齐 → 立项 gate 放行进「理解」。
// 本文件只负责「立项清单」的状态语义：定义清单 v1、把一条条「填项事实」folder 成清单状态、判定必填是否
// 齐、产出喂给下游 spec-design 的立项书。建群 / 读 PRD / 起 AI 抽取等副作用走 effect/bridge，不在这里。
//
// 状态走事件溯源（不塞 workitem.context，worktype 对 context 只读）：每填一项 = 一条 `intake_field_set`
// 事件，清单状态由 foldIntake(事件历史) 重建，gateReady 由 isGateReady(state) 算出——和 runningWorkers /
// 集成失败计数同套路（容器中性搬运历史，worktype 拥有判定逻辑）。

// 立项触发的事件 kind。worktype 在 requirementTransition 里 switch 它；reducer/api（容器层不能 import
// 本文件）用裸字符串 'intake_field_set' 与此约定对齐。
export const INTAKE_FIELD_SET = 'intake_field_set';

export type IntakeFieldKey =
  | 'name' // 需求名称（= 群名）
  | 'summary' // 一句话需求 + 背景
  | 'repos' // 涉及代码仓库（多值）
  | 'prd' // PRD（群里上传 MD 或文字）
  | 'acceptance' // 验收标准 / 完成定义
  | 'ui' // UI 设计稿地址（涉及 UI 改动时必填）
  | 'scope' // 范围边界（明确不做什么）
  | 'stakeholders' // 相关端 / 相关方
  | 'priority' // 优先级 / 期望交付时间
  | 'constraints'; // 已知依赖 / 技术约束 / 不能动的

// 必填语义：required=恒必填；conditional=条件必填（ui：勾选「涉及 UI 改动」才必填）；optional=选填。
export type IntakeRequirement = 'required' | 'conditional' | 'optional';

export interface IntakeFieldDef {
  key: IntakeFieldKey;
  label: string; // 中文展示名（清单卡 / 立项书用）
  requirement: IntakeRequirement;
  multi?: boolean; // repos 是 string[]，其余文本
  hint?: string; // 引导者追问这一项时的提示
}

// 立项清单 v1（intake-phase.md §核心概念）。顺序即清单卡 / 立项书的渲染顺序。
export const INTAKE_CHECKLIST: readonly IntakeFieldDef[] = [
  {
    key: 'name',
    label: '需求名称',
    requirement: 'required',
    hint: '一句话给这个需求起个名（= 群名）',
  },
  {
    key: 'summary',
    label: '一句话需求 + 背景',
    requirement: 'required',
    hint: '要解决什么 / 为谁 / 为什么现在',
  },
  {
    key: 'repos',
    label: '涉及代码仓库',
    requirement: 'required',
    multi: true,
    hint: '仓库绝对路径，可多个；会当场校验是不是 git 仓',
  },
  {
    key: 'prd',
    label: 'PRD',
    requirement: 'required',
    hint: '群里上传 PRD 的 MD 文件，或直接发文字描述',
  },
  {
    key: 'acceptance',
    label: '验收标准 / 完成定义',
    requirement: 'required',
    hint: '怎么算做完（可从 PRD 抽草稿待你确认）',
  },
  {
    key: 'ui',
    label: 'UI 设计稿地址',
    requirement: 'conditional',
    hint: '涉及 UI 改动则必填：Figma / 蓝湖 / 飞书设计稿链接',
  },
  {
    key: 'scope',
    label: '范围边界（明确不做什么）',
    requirement: 'optional',
    hint: '有没有明确不做的，防需求蔓延',
  },
  { key: 'stakeholders', label: '相关端 / 相关方', requirement: 'optional' },
  { key: 'priority', label: '优先级 / 期望交付时间', requirement: 'optional' },
  {
    key: 'constraints',
    label: '已知依赖 / 技术约束 / 不能动的',
    requirement: 'optional',
    hint: '有没有硬约束 / 不能碰的',
  },
];

const CHECKLIST_BY_KEY: ReadonlyMap<IntakeFieldKey, IntakeFieldDef> = new Map(
  INTAKE_CHECKLIST.map((d) => [d.key, d]),
);

// 一项已填的值。ai-extracted（AI 从 PRD 预填的候选）需 confirmed=true 才算「齐」。
export interface IntakeField {
  key: IntakeFieldKey;
  value: string | string[];
  filledBy: 'user' | 'ai-extracted';
  confirmed: boolean;
}

export interface IntakeState {
  fields: IntakeField[]; // 已填项（按 checklist 顺序归一）
  uiRequired: boolean; // 用户勾选「涉及 UI 改动」→ ui 项升为必填
  prdSummary?: string; // 读 PRD 文档后的 AI 摘要（M-I3 live 填；优先于 prd 原文喂下游）
}

// 一条「填项事实」= 一条 intake_field_set 事件的 payload。可同时携带 uiRequired（勾选 UI 改动），
// 也可只设 uiRequired 而不填字段（key 省略）。bridge（live）/ 测试（沙箱）构造它后 enqueue。
export interface IntakeFieldInput {
  key?: IntakeFieldKey;
  value?: string | string[];
  filledBy?: 'user' | 'ai-extracted';
  confirmed?: boolean;
  uiRequired?: boolean; // 勾选「涉及 UI 改动」（独立维度，决定 ui 项是否必填）
  prdSummary?: string; // 读 PRD 后的摘要（随 prd 项一并落，M-I3）
}

export function initialIntakeState(): IntakeState {
  return { fields: [], uiRequired: false };
}

// 应用一条填项事实，返回新状态（纯，不改入参）。同 key 覆盖（最后一次填的为准）。
export function applyFieldInput(state: IntakeState, input: IntakeFieldInput): IntakeState {
  let fields = state.fields;
  if (input.key !== undefined && CHECKLIST_BY_KEY.has(input.key) && input.value !== undefined) {
    const def = CHECKLIST_BY_KEY.get(input.key)!;
    const value = normalizeValue(def, input.value);
    const field: IntakeField = {
      key: input.key,
      value,
      filledBy: input.filledBy ?? 'user',
      // user 填的恒算确认；ai-extracted 默认未确认，除非显式 confirmed。
      confirmed: (input.filledBy ?? 'user') === 'user' ? true : input.confirmed === true,
    };
    fields = [...state.fields.filter((f) => f.key !== input.key), field];
  }
  return {
    fields: sortByChecklist(fields),
    uiRequired: input.uiRequired ?? state.uiRequired,
    prdSummary: input.prdSummary ?? state.prdSummary,
  };
}

// 从事件历史（intake_field_set 的 payload 序列）重建立项清单状态。崩溃恢复 / 容器 enrich 后 worktype
// 都靠它把「一条条事实」folder 成当前态。永不抛：坏 payload 当成无效输入跳过。
export function foldIntake(inputs: readonly unknown[]): IntakeState {
  let state = initialIntakeState();
  for (const raw of inputs) {
    const input = coerceInput(raw);
    if (input) state = applyFieldInput(state, input);
  }
  return state;
}

// 这一项是否「算齐」：有非空值，且（user 填 或 ai-extracted 已 confirmed）。
export function isFieldSatisfied(field: IntakeField | undefined): boolean {
  if (!field) return false;
  if (!hasValue(field.value)) return false;
  return field.filledBy === 'user' || field.confirmed === true;
}

// 当前生效的必填项集合：required 恒在；conditional（ui）当 uiRequired 时才在。
export function requiredDefs(state: IntakeState): IntakeFieldDef[] {
  return INTAKE_CHECKLIST.filter(
    (d) => d.requirement === 'required' || (d.requirement === 'conditional' && state.uiRequired),
  );
}

// 还缺哪些必填项（引导者据此逐项追）。
export function requiredMissing(state: IntakeState): IntakeFieldDef[] {
  const byKey = new Map(state.fields.map((f) => [f.key, f]));
  return requiredDefs(state).filter((d) => !isFieldSatisfied(byKey.get(d.key)));
}

// 立项 gate 是否可放行：所有当前生效的必填项都已齐。
export function isGateReady(state: IntakeState): boolean {
  return requiredMissing(state).length === 0;
}

// 必填进度（清单卡顶部「必填 x/N」）。N 随 uiRequired 变（勾了 UI 则 +1）。
export function requiredProgress(state: IntakeState): { filled: number; total: number } {
  const defs = requiredDefs(state);
  const byKey = new Map(state.fields.map((f) => [f.key, f]));
  const filled = defs.filter((d) => isFieldSatisfied(byKey.get(d.key))).length;
  return { filled, total: defs.length };
}

// 立项收齐的仓库（repos 字段的归一值）。立项 gate 通过时由 intake_finalize effect 提升为
// workitem.repos——worker 拆分 / spec-design repo 候选都读 workitem.repos，而 /req 不再带 --repo。
export function intakeReposOf(state: IntakeState): string[] {
  const f = state.fields.find((x) => x.key === 'repos');
  return f && Array.isArray(f.value) ? f.value : [];
}

// 产出结构化立项书（MD），作为「理解」/ spec-design run 的首要上游输入。只输出有值的项。
export function buildIntakeBrief(state: IntakeState): string {
  const byKey = new Map(state.fields.map((f) => [f.key, f]));
  const nameField = byKey.get('name');
  const title =
    nameField && typeof nameField.value === 'string' ? nameField.value : '（未命名需求）';
  const lines: string[] = [`# 立项书：${title}`, ''];

  const section = (heading: string, body: string | undefined): void => {
    if (body && body.trim().length > 0) lines.push(`## ${heading}`, body.trim(), '');
  };

  section('一句话需求 + 背景', textOf(byKey.get('summary')));
  const repos = byKey.get('repos');
  if (repos && Array.isArray(repos.value) && repos.value.length > 0) {
    lines.push('## 涉及代码仓库', ...repos.value.map((r) => `- ${r}`), '');
  }
  // PRD：优先 AI 摘要，回落原文；ai-extracted 未确认的项标注，提示下游这是待核草稿。
  const prd = state.prdSummary?.trim() || textOf(byKey.get('prd'));
  section('PRD 摘要', prd);
  section('验收标准 / 完成定义', textOf(byKey.get('acceptance')));
  if (state.uiRequired || isFieldSatisfied(byKey.get('ui'))) {
    section('UI 设计稿', textOf(byKey.get('ui')) ?? '（涉及 UI 改动，设计稿待补）');
  }
  section('范围边界（明确不做）', textOf(byKey.get('scope')));
  section('相关端 / 相关方', textOf(byKey.get('stakeholders')));
  section('已知依赖 / 技术约束', textOf(byKey.get('constraints')));
  section('优先级 / 期望交付', textOf(byKey.get('priority')));

  return `${lines.join('\n').trimEnd()}\n`;
}

// ── helpers (pure) ────────────────────────────────────────────────────────────────────

function normalizeValue(def: IntakeFieldDef, value: string | string[]): string | string[] {
  if (def.multi) {
    const arr = Array.isArray(value) ? value : [value];
    return arr.map((v) => String(v).trim()).filter((v) => v.length > 0);
  }
  return Array.isArray(value) ? value.join('、').trim() : String(value).trim();
}

function hasValue(value: string | string[]): boolean {
  return Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
}

function textOf(field: IntakeField | undefined): string | undefined {
  if (!field) return undefined;
  if (Array.isArray(field.value)) return field.value.join('、');
  return field.value;
}

function sortByChecklist(fields: IntakeField[]): IntakeField[] {
  const order = new Map(INTAKE_CHECKLIST.map((d, i) => [d.key, i]));
  return [...fields].sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}

function coerceInput(raw: unknown): IntakeFieldInput | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const input: IntakeFieldInput = {};
  if (typeof o.key === 'string' && CHECKLIST_BY_KEY.has(o.key as IntakeFieldKey)) {
    input.key = o.key as IntakeFieldKey;
  }
  if (typeof o.value === 'string') input.value = o.value;
  else if (Array.isArray(o.value))
    input.value = o.value.filter((v): v is string => typeof v === 'string');
  if (o.filledBy === 'user' || o.filledBy === 'ai-extracted') input.filledBy = o.filledBy;
  if (typeof o.confirmed === 'boolean') input.confirmed = o.confirmed;
  if (typeof o.uiRequired === 'boolean') input.uiRequired = o.uiRequired;
  if (typeof o.prdSummary === 'string') input.prdSummary = o.prdSummary;
  // 既没填有效字段、也没设 uiRequired/prdSummary 的空 payload → 无效。
  if (input.key === undefined && input.uiRequired === undefined && input.prdSummary === undefined) {
    return undefined;
  }
  return input;
}
