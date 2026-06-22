import type {
  AssignmentSpec,
  Transition,
  WorkItem,
  WorkItemEvent,
  WorkType,
} from '../../workitems/types.js';
import { checkpointDecisionOf, crossesCheckpoint, raiseCheckpoint, ttlsOf } from './checkpoint.js';
import { isRequirementDecisionStale } from './contract.js';
import { fixRoundExceeded } from './integration.js';
import { nextPhase, PHASE } from './phases.js';

// requirement worktype — the 7-phase coordinator (D-08/D-15). Pure sync reducer: this file
// declares all side effects as Transition (dispatch / waits / effects); the effect handlers
// (Stage 4: worker run, integration_check, checkpoint, design) do the IO. The container
// never interprets a requirement phase name (red-line).
//
// Lifecycle (4 lights gate the boundaries):
//   理解 →[灯①]→ 合同 →[灯②快]→ 详设 →[灯②慢]→ 拆解 → 并行实现 → 集成验证 →[灯③]→ 交付 →[灯④ close]
//
// Skeleton scope (Stage 3): runs go through the generic readonly agent-run handler so the
// phase machine + checkpoint gates are exercised end to end without a real write agent. The
// multi-worker batch aggregation (owner snapshot) + contract freeze + real integration_check
// are layered in Stage 4; here a single owner "assess" run drives 并行实现 → 集成验证.

const CHECKPOINT_WAIT_TTL_SEC = 86_400;

export const requirementWorkType: WorkType = {
  id: 'requirement',
  triggers: { api: true },
  initialPhase: () => PHASE.understand,
  onEvent: requirementTransition,
  isDecisionStale: isRequirementDecisionStale,
  // The parallel-dispatch master switch: returning non-'solo' makes the container's
  // single-flight gate route by role (owner single-flight / worker concurrency cap).
  topology: () => 'owner-workers',
  permissions: { mode: 'write' },
  checkpoints: {
    requiredBefore: [PHASE.contract, PHASE.design, PHASE.split, PHASE.deliver],
  },
  artifacts: { reportRequired: true },
};

export function registerRequirement(registry: { register(type: WorkType): void }): void {
  registry.register(requirementWorkType);
}

export function requirementTransition(item: WorkItem, ev: WorkItemEvent): Transition {
  switch (ev.kind) {
    case 'workitem_created':
      return {
        phase: { to: PHASE.understand, reason: 'created' },
        dispatch: [ownerSpec(item, 'understand')],
      };
    case 'wait_resolved':
      return onWaitResolved(item, ev);
    case 'run_completed':
      return onRunCompleted(item, ev);
    case 'design_ready':
      // Stage 5 emits this from the spec-design run; treat like the contract/design owner run
      // finishing for the current phase.
      return onRunCompleted(item, { ...ev, payload: { ...asObject(ev.payload), role: 'owner' } });
    case 'integration_check_passed':
      return requestAdvance(item, PHASE.integrate, PHASE.deliver, 'integration_passed');
    case 'integration_check_failed':
      return onIntegrationFailed(item, ev);
    case 'human_message':
      return onHumanMessage(item, ev);
    case 'close_requested':
      return onClose(item);
    default:
      return {};
  }
}

function onRunCompleted(item: WorkItem, ev: WorkItemEvent): Transition {
  const role = roleOf(ev.payload);
  switch (item.phase) {
    case PHASE.understand:
      return role === 'owner'
        ? requestAdvance(item, PHASE.understand, PHASE.contract, 'understand_done')
        : {};
    case PHASE.contract:
      return role === 'owner'
        ? requestAdvance(item, PHASE.contract, PHASE.design, 'contract_done')
        : {};
    case PHASE.design:
      return role === 'owner' ? requestAdvance(item, PHASE.design, PHASE.split, 'design_done') : {};
    case PHASE.split:
      return role === 'owner' ? enterPhase(item, PHASE.implement, 'split_done', ev) : {};
    case PHASE.implement:
      // worker finished → wake the owner to assess the batch (Stage 4: owner snapshot decides
      // if every repo is in). owner finished → the batch is judged complete, advance.
      if (role === 'worker') return { dispatch: [ownerSpec(item, 'assess')] };
      if (role === 'owner') return enterPhase(item, PHASE.integrate, 'workers_done', ev);
      return {};
    case PHASE.integrate:
      // A fix worker finished → re-run the static integration对账 (idempotent effect). The
      // integration verdict drives the phase, not a run conclusion.
      return role === 'worker' ? { effects: [{ kind: 'integration_check' }] } : {};
    default:
      return {};
  }
}

// 集成验证 fix loop (R13.AC-4/AC-6, D-11): the failure's round (counted by the
// integration_check handler, NOT assignment.retries) decides fix vs escalate.
function onIntegrationFailed(item: WorkItem, ev: WorkItemEvent): Transition {
  if (item.phase !== PHASE.integrate) return {};
  const round = numberField(ev.payload, 'round') ?? 1;
  if (fixRoundExceeded(round)) {
    // 连续集成失败 → 契约/拆解可能有问题，升级 human wait（病历）。
    return {
      waits: [
        {
          kind: 'human',
          reason: 'integration_unresolved',
          deadlineTtlSec: CHECKPOINT_WAIT_TTL_SEC,
        },
      ],
    };
  }
  const repos = stringArrayField(ev.payload, 'affectedRepos');
  const targets = repos.length > 0 ? repos : item.repos.length > 0 ? item.repos : [''];
  return {
    dispatch: targets.map((repo) => ({
      role: 'worker' as const,
      repo: repo || undefined,
      deadlineTtlSec: ttlsOf(item).deadlineTtlSec,
      wallclockCapSec: ttlsOf(item).wallclockCapSec,
      payload: { stage: 'fix', repo, round },
    })),
  };
}

// Phase-work done → either gate (raise the human wait, stay) or advance + run entry work.
function requestAdvance(item: WorkItem, expected: string, to: string, reason: string): Transition {
  if (item.phase !== expected) return {};
  if (crossesCheckpoint(to)) return raiseCheckpoint(to, CHECKPOINT_WAIT_TTL_SEC);
  return enterPhase(item, to, reason, undefined);
}

function onWaitResolved(item: WorkItem, ev: WorkItemEvent): Transition {
  const decision = checkpointDecisionOf(ev);
  if (!decision) return {}; // a救场/other resolve carries no decision — nothing to advance.

  // Cancel-confirm rides a decision too (防误触): approved → cancelled, declined → resume.
  if (isCancelDecision(decision)) {
    return decision.approved ? { terminal: 'cancelled' } : {};
  }

  // Checkpoint p板. The pending gate is the boundary into the next phase.
  const to = nextPhase(item.phase);
  if (!to) return {};
  if (decision.approved) return enterPhase(item, to, 'checkpoint_approved', ev);
  // Rejected → stay in the current phase and redo its work (灯② back to design, 灯③ refix).
  return redoPhase(item);
}

// Entry side effects per phase. Gated boundaries (合同/详设/拆解/交付) arrive here only after
// approval; non-gated (并行实现/集成验证) arrive straight from a run conclusion.
function enterPhase(
  item: WorkItem,
  to: string,
  reason: string,
  triggerEv: WorkItemEvent | undefined,
): Transition {
  const base: Transition = { phase: { to, reason } };
  switch (to) {
    case PHASE.contract:
    case PHASE.design:
    case PHASE.split:
      // Stage 5 swaps these owner runs for the spec-design / splitter runs.
      return { ...base, dispatch: [ownerSpec(item, stageKey(to))] };
    case PHASE.implement:
      return { ...base, dispatch: workerDispatches(item, ownerAssignmentIdOf(triggerEv)) };
    case PHASE.integrate:
      // 静态集成对账 effect（质检员）— emits integration_check_passed/failed, drives 灯③ / fix loop.
      return { ...base, effects: [{ kind: 'integration_check' }] };
    case PHASE.deliver:
      // 灯④: rest in non-terminal — no auto MR/上线. close_requested drives terminal (D-14).
      return base;
    default:
      return base;
  }
}

function redoPhase(item: WorkItem): Transition {
  // Re-run the current phase's work after a rejection. design phases re-run the owner;
  // 集成验证 re-runs the static对账 effect (灯③ 打回 → 回集成验证重核).
  if (item.phase === PHASE.understand) return { dispatch: [ownerSpec(item, 'understand')] };
  if (item.phase === PHASE.contract) return { dispatch: [ownerSpec(item, 'contract')] };
  if (item.phase === PHASE.design) return { dispatch: [ownerSpec(item, 'design')] };
  if (item.phase === PHASE.integrate) return { effects: [{ kind: 'integration_check' }] };
  return {};
}

function onHumanMessage(_item: WorkItem, ev: WorkItemEvent): Transition {
  const text = humanText(ev.payload).trim();
  if (text === '/cancel') {
    // 防误触: confirm before tearing down. The confirm card resolves with a cancel decision.
    return {
      waits: [{ kind: 'human', reason: 'cancel_confirm', deadlineTtlSec: CHECKPOINT_WAIT_TTL_SEC }],
    };
  }
  // Other follow-ups are recorded; the owner picks them up on its next wake (skeleton).
  return {};
}

function onClose(item: WorkItem): Transition {
  // 灯④ proceed: only the delivery phase honours close → done. Elsewhere a stray close is inert.
  return item.phase === PHASE.deliver ? { terminal: 'done' } : {};
}

// ── helpers (pure) ────────────────────────────────────────────────────────────────────

function ownerSpec(item: WorkItem, stage: string): AssignmentSpec {
  const t = ttlsOf(item);
  return {
    role: 'owner',
    deadlineTtlSec: t.deadlineTtlSec,
    wallclockCapSec: t.wallclockCapSec,
    payload: { stage },
  };
}

function workerDispatches(
  item: WorkItem,
  parentAssignmentId: string | undefined,
): AssignmentSpec[] {
  const t = ttlsOf(item);
  const repos = item.repos.length > 0 ? item.repos : [''];
  return repos.map((repo) => ({
    role: 'worker' as const,
    repo: repo || undefined,
    deadlineTtlSec: t.deadlineTtlSec,
    wallclockCapSec: t.wallclockCapSec,
    parentAssignmentId,
    payload: { stage: 'implement', repo },
  }));
}

function stageKey(phase: string): string {
  if (phase === PHASE.contract) return 'contract';
  if (phase === PHASE.design) return 'design';
  if (phase === PHASE.split) return 'split';
  return 'owner';
}

function roleOf(payload: unknown): string | undefined {
  const o = asObject(payload);
  return typeof o.role === 'string' ? o.role : undefined;
}

function ownerAssignmentIdOf(ev: WorkItemEvent | undefined): string | undefined {
  if (!ev) return undefined;
  const o = asObject(ev.payload);
  return typeof o.assignmentId === 'string' ? o.assignmentId : undefined;
}

function isCancelDecision(decision: { approved: boolean; payload?: unknown }): boolean {
  const p = asObject(decision.payload);
  return p.action === 'cancel';
}

function humanText(payload: unknown): string {
  const o = asObject(payload);
  return typeof o.text === 'string' ? o.text : '';
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function numberField(payload: unknown, key: string): number | undefined {
  const v = asObject(payload)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function stringArrayField(payload: unknown, key: string): string[] {
  const v = asObject(payload)[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
