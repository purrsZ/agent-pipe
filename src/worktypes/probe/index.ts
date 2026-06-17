import type { Transition, WorkItem, WorkItemEvent, WorkType } from '../../workitems/types.js';

// Defaults mirror the container's defaultDispatchSpec (cfg.defaultDeadlineTtlSec /
// defaultWallclockCapSec, ADR-10) so the idle-dispatch path (probe.onEvent) and the
// single-flight wake path (defaultDispatchSpec) produce equivalent runs (§2.4).
export interface ProbeParams {
  deadlineTtlSec: number;
  wallclockCapSec: number;
  maxRetries: number;
}

export const probeWorkType: WorkType = {
  id: 'probe',
  triggers: { api: true },
  initialPhase: () => 'probe:looking',
  onEvent: (item, ev) => probeTransition(item, ev),
  isDecisionStale: () => false,
  topology: () => 'solo',
  permissions: { mode: 'readonly' },
  checkpoints: { requiredBefore: [] },
  artifacts: { reportRequired: true },
};

export function registerProbe(registry: { register(type: WorkType): void }): void {
  registry.register(probeWorkType);
}

function probeTransition(item: WorkItem, ev: WorkItemEvent): Transition {
  const params = parseProbeParams(item.context);
  switch (ev.kind) {
    case 'workitem_created':
      return { phase: { to: 'probe:looking', reason: 'created' }, dispatch: [soloRun(params)] };
    case 'run_completed':
      // Rest idle — NON-terminal — so follow-ups stay reachable (S1 fix / D7). If a
      // follow-up arrived during the run, the container's releaseWakePending re-dispatches
      // automatically; no work needed here.
      return { phase: { to: 'probe:idle', reason: 'run_completed' } };
    case 'human_message':
      // Idle follow-up (path A): dispatch a fresh round. Mid-run follow-up (path B) is
      // absorbed into wake_pending by the container — this dispatch is then a no-op there.
      return { phase: { to: 'probe:looking', reason: 'follow_up' }, dispatch: [soloRun(params)] };
    case 'run_failed':
      if (assignmentRetries(ev.payload) >= params.maxRetries) {
        return { phase: { to: 'probe:failed', reason: 'run_failed' }, terminal: 'failed' };
      }
      return {
        phase: { to: 'probe:looking', reason: 'retry' },
        dispatch: [
          {
            ...soloRun(params),
            replacesAssignmentId: assignmentId(ev.payload),
            retries: assignmentRetries(ev.payload) + 1,
          },
        ],
      };
    case 'close_requested':
      return { phase: { to: 'probe:done', reason: 'closed' }, terminal: 'done' };
    default:
      return {};
  }
}

function soloRun(params: ProbeParams): NonNullable<Transition['dispatch']>[number] {
  // No brief: the agent-run handler composes the prompt itself (§2.2), so this matches the
  // brief-less defaultDispatchSpec of the wake path.
  return {
    role: 'solo',
    deadlineTtlSec: params.deadlineTtlSec,
    wallclockCapSec: params.wallclockCapSec,
  };
}

export function parseProbeParams(value: unknown): ProbeParams {
  const input = isObject(value) ? value : {};
  return {
    deadlineTtlSec: positiveNumber(input.deadlineTtlSec, 3600),
    wallclockCapSec: positiveNumber(input.wallclockCapSec, 1800),
    maxRetries: nonNegativeInteger(input.maxRetries, 1),
  };
}

function assignmentRetries(payload: unknown): number {
  if (!isObject(payload)) return 0;
  return nonNegativeInteger(payload.assignmentRetries, 0);
}

function assignmentId(payload: unknown): string | undefined {
  if (!isObject(payload)) return undefined;
  return typeof payload.assignmentId === 'string' ? payload.assignmentId : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
