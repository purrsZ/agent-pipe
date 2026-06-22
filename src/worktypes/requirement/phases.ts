// requirement worktype — phase vocabulary (worktypes layer; business words allowed, but
// this file stays pure: no async/await/fs/child_process). Phase names carry a `requirement:`
// prefix (like probe's `probe:looking`); they are opaque strings to the container.

export const PHASE = {
  understand: 'requirement:理解',
  contract: 'requirement:合同',
  design: 'requirement:详设',
  split: 'requirement:拆解',
  implement: 'requirement:并行实现',
  integrate: 'requirement:集成验证',
  deliver: 'requirement:交付',
} as const;

export type RequirementPhase = (typeof PHASE)[keyof typeof PHASE];

// Fixed 7-phase sequence (D-02). nextPhase walks it.
export const PHASE_SEQUENCE: RequirementPhase[] = [
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

// The phase boundaries that require a human checkpoint before being crossed (R03/D-02):
//   灯① 理解→合同 · 灯②快 合同→详设 · 灯②慢 详设→拆解 · 灯③ 集成验证→交付.
// (灯④ delivery→submit is NOT here — it is a two-stage rest-in-non-terminal, §交付.)
export const CHECKPOINT_REQUIRED_BEFORE: string[] = [
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
] as const;

export type RequirementEventKind = (typeof REQUIREMENT_EVENT_KINDS)[number];
