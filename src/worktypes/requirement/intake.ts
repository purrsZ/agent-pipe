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
// WS-6 复杂度自适应：'multi-conditional' = 多仓（≥2）时必填、单仓时选填。让约束与需求复杂度成比例。
export type IntakeRequirement = 'required' | 'conditional' | 'multi-conditional' | 'optional';

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
    requirement: 'multi-conditional', // WS-6：单仓选填、多仓必填
    hint: '群里上传 PRD 的 MD 文件，或直接发文字描述',
  },
  {
    key: 'acceptance',
    label: '验收标准 / 完成定义',
    requirement: 'multi-conditional', // WS-6：单仓选填、多仓必填
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

// WS-6：单一必填判定源——required 恒在；conditional（ui）当 uiRequired；multi-conditional（prd/acceptance）
// 当 repos ≥ 2。bridge 的 buildIntakeView 与 requiredDefs 共用这一份，杜绝两处判定漂移（WS-6.3）。
export function isDefRequired(def: IntakeFieldDef, state: IntakeState): boolean {
  const multiRepo = intakeReposOf(state).length >= 2;
  return (
    def.requirement === 'required' ||
    (def.requirement === 'conditional' && state.uiRequired) ||
    (def.requirement === 'multi-conditional' && multiRepo)
  );
}

// 当前生效的必填项集合（随 uiRequired / repos 数变）。
export function requiredDefs(state: IntakeState): IntakeFieldDef[] {
  return INTAKE_CHECKLIST.filter((d) => isDefRequired(d, state));
}

// 还缺哪些必填项（引导者据此逐项追）。
export function requiredMissing(state: IntakeState): IntakeFieldDef[] {
  const byKey = new Map(state.fields.map((f) => [f.key, f]));
  return requiredDefs(state).filter((d) => !isFieldSatisfied(byKey.get(d.key)));
}

// 引导式收料：下一个还没齐的必填项（bridge 据它主动逐项追问，并把群内来的普通消息填进这一项）。
// 全齐 → undefined（此时该弹立项 gate，不再追问）。
export function nextRequiredToFill(state: IntakeState): IntakeFieldDef | undefined {
  return requiredMissing(state)[0];
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

// ── AI 抽取（M-I3 step8 的 live 版）：把用户在立项群发的自由描述喂给 AI，让它一次抽多个字段回 JSON。
// 下面是「prompt 组装」+「输出解析」的纯核心（可单测，不 async/不 fs）；真正起 AI run 在 bridge。

export interface IntakeExtraction {
  fields: Array<{ key: IntakeFieldKey; value: string | string[] }>;
  uiRequired?: boolean;
  // INTAKE L0.3：用户提到但未命中登记表、且不是绝对路径的仓名/项目名（原词照录，不猜路径）。桥层据它
  // 触发勘探 run（L1）。命中登记表的仓名 AI 直接输出到 fields.repos（绝对路径），不进 repoHints。
  repoHints?: string[];
}

// 组装抽取 prompt：给 AI 字段菜单 + 当前已填/还缺，约束「只抽明确表达的、repos 只放绝对路径、只输出 JSON」。
// registry = 已知仓库登记表快照（名字 → 绝对路径，按最近使用排序，最多 20 条），命中则秒解析绝对路径。
export function composeIntakeExtractPrompt(
  userText: string,
  filledLabels: string[],
  missingRequiredLabels: string[],
  registry: Array<{ name: string; path: string }> = [],
): string {
  const menu = INTAKE_CHECKLIST.map(
    (d) => `- ${d.key}：${d.label}${d.hint ? `（${d.hint}）` : ''}`,
  );
  const registryLines =
    registry.length > 0
      ? [
          '',
          '已知仓库登记（仓名 → 绝对路径，按最近使用排序）：',
          ...registry.map((r) => `- ${r.name} → ${r.path}`),
        ]
      : [];
  return [
    '你是「立项收料」助手。用户在需求立项群里发来一段话，请只做**信息抽取**：从这段话里识别能确定的',
    '立项字段值，输出 JSON。不要执行任何任务、不要读写文件、不要追问、不要解释。',
    '',
    '可填字段（key：含义）：',
    ...menu,
    ...registryLines,
    '',
    `当前已填：${filledLabels.length ? filledLabels.join('、') : '（无）'}`,
    `还缺必填：${missingRequiredLabels.length ? missingRequiredLabels.join('、') : '（无）'}`,
    '',
    '规则：',
    '- 只抽用户**明确表达**了的字段；没提到的别编、别输出该 key。',
    '- repos 只放**绝对路径**（以 / 开头）进字符串数组；别把说明文字/编号/“仓库:”当路径。',
    '- 用户提到的仓名/项目名**命中上面的已知仓库登记** → 直接把对应绝对路径放进 repos。',
    '- 用户提到的仓名/项目名**未命中登记、也不是绝对路径**（如“就在 alaeatposapp 里”）→ 放进 repoHints',
    '  字符串数组（**原词照录，不要猜路径**），别放进 repos。',
    '- 文档链接（PRD/UI 设计稿）按原样作为对应字段的值。',
    '- 用户表达“涉及 UI 改动/要做 UI”时置 uiRequired=true。',
    '- 只输出一个 JSON，无任何额外文字：',
    '  {"fields":[{"key":"summary","value":"…"},{"key":"repos","value":["/abs/a"]}],"repoHints":["alaeatposapp"],"uiRequired":false}',
    '',
    '用户这段话：',
    '"""',
    userText,
    '"""',
  ].join('\n');
}

// 解析 AI 输出为抽取结果（永不抛）：兼容围栏块 / 裸 JSON / 前后带话术。非清单 key、空值、坏类型一律丢。
export function parseIntakeExtraction(raw: string): IntakeExtraction | null {
  for (const candidate of jsonCandidates(raw)) {
    let obj: unknown;
    try {
      obj = JSON.parse(candidate);
    } catch {
      continue;
    }
    const ex = coerceExtraction(obj);
    if (ex) return ex;
  }
  return null;
}

function jsonCandidates(raw: string): string[] {
  if (typeof raw !== 'string') return [];
  const out: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m = fence.exec(raw);
  while (m !== null) {
    if (m[1]) out.push(m[1].trim());
    m = fence.exec(raw);
  }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) out.push(raw.slice(first, last + 1));
  out.push(raw.trim());
  return out;
}

function coerceExtraction(obj: unknown): IntakeExtraction | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const fields: Array<{ key: IntakeFieldKey; value: string | string[] }> = [];
  const rawFields = Array.isArray(o.fields) ? o.fields : [];
  for (const rf of rawFields) {
    if (typeof rf !== 'object' || rf === null) continue;
    const r = rf as Record<string, unknown>;
    if (typeof r.key !== 'string' || !CHECKLIST_BY_KEY.has(r.key as IntakeFieldKey)) continue;
    const key = r.key as IntakeFieldKey;
    let value: string | string[] | undefined;
    if (Array.isArray(r.value)) value = r.value.filter((v): v is string => typeof v === 'string');
    else if (typeof r.value === 'string') value = r.value;
    if (value === undefined) continue;
    if (Array.isArray(value) ? value.length > 0 : value.trim().length > 0)
      fields.push({ key, value });
  }
  const uiRequired = typeof o.uiRequired === 'boolean' ? o.uiRequired : undefined;
  // INTAKE L0.3：repoHints——未命中登记表的仓名原词（去空白 + 非空）。坏类型/非数组一律成空。
  const repoHints = Array.isArray(o.repoHints)
    ? o.repoHints
        .filter((h): h is string => typeof h === 'string')
        .map((h) => h.trim())
        .filter((h) => h.length > 0)
    : [];
  if (fields.length === 0 && uiRequired === undefined && repoHints.length === 0) return null;
  const result: IntakeExtraction = { fields };
  if (uiRequired !== undefined) result.uiRequired = uiRequired;
  if (repoHints.length > 0) result.repoHints = repoHints;
  return result;
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
