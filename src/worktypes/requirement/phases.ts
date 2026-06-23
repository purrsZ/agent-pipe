// requirement worktype — phase vocabulary (worktypes layer; business words allowed, but
// this file stays pure: no async/await/fs/child_process). Phase names carry a `requirement:`
// prefix (like probe's `probe:looking`); they are opaque strings to the container.

export const PHASE = {
  // 立项（intake）= 生命周期最前面新增的一段：建专属群 → 引导者收齐前置料 → 立项 gate 放行进「理解」。
  // 收料的副作用走 bridge/effect；这里只是个 opaque phase 名，序列上排在「理解」之前。
  intake: 'requirement:立项',
  understand: 'requirement:理解',
  contract: 'requirement:合同',
  design: 'requirement:详设',
  split: 'requirement:拆解',
  implement: 'requirement:并行实现',
  integrate: 'requirement:集成验证',
  deliver: 'requirement:交付',
} as const;

export type RequirementPhase = (typeof PHASE)[keyof typeof PHASE];

// Fixed sequence (D-02 + 立项前插). nextPhase walks it: 立项 →[立项 gate]→ 理解 →[灯①]→ …
export const PHASE_SEQUENCE: RequirementPhase[] = [
  PHASE.intake,
  PHASE.understand,
  PHASE.contract,
  PHASE.design,
  PHASE.split,
  PHASE.implement,
  PHASE.integrate,
  PHASE.deliver,
];

export function nextPhase(current: string): RequirementPhase | undefined {
  const i = PHASE_SEQUENCE.indexOf(current as RequirementPhase);
  if (i < 0 || i >= PHASE_SEQUENCE.length - 1) return undefined;
  return PHASE_SEQUENCE[i + 1];
}

// 判断是否处于「立项」收料阶段。包成函数，让 index/bridge(kernel-exempt) 据它分流群内消息（收料 vs
// 普通追问）/ 出站卡（清单卡 vs 锚点卡），而不必在那些文件里写 `phase === …`（会被 wiring/红线扫到）。
export function isIntakePhase(phase: string): boolean {
  return phase === PHASE.intake;
}

// The phase boundaries that require a human checkpoint before being crossed (R03/D-02):
//   立项 gate 立项→理解（料齐+确认开干，复用 checkpoint 机制但语义≠审设计）·
//   灯① 理解→合同 · 灯②快 合同→详设 · 灯②慢 详设→拆解 · 灯③ 集成验证→交付.
// (灯④ delivery→submit is NOT here — it is a two-stage rest-in-non-terminal, §交付.)
export const CHECKPOINT_REQUIRED_BEFORE: string[] = [
  PHASE.understand, // 立项 gate（立项→理解）
  PHASE.contract,
  PHASE.design,
  PHASE.split,
  PHASE.deliver,
];

// internal-apis §7 — authoritative new event-kind list. The container does not interpret
// these; only requirementTransition switches on them. This array is the single source of
// truth for the anchorAction drift assertion (R24.AC-7 / data-model §8).
export const REQUIREMENT_EVENT_KINDS = [
  'checkpoint_reached',
  'checkpoint_decision',
  'contract_frozen',
  'contract_patched',
  'contract_change_proposed',
  'contract_change_approved',
  'contract_change_applied',
  'worker_report',
  'integration_check_passed',
  'integration_check_failed',
  'design_ready',
  'intake_field_set', // 立项收料：每填一项一条（fold 出立项清单状态，gateReady 时 raise 立项 gate）
] as const;

export type RequirementEventKind = (typeof REQUIREMENT_EVENT_KINDS)[number];
