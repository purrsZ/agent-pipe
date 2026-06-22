import type { Transition, WorkItem, WorkItemEvent, WorkType } from '../../workitems/types.js';

export type NoopFailAt = 'before-run' | 'during-run' | 'before-report';
export type NoopHeartbeatMode = 'silent' | 'normal' | 'beat-no-finish';
export type NoopTopology = 'solo' | 'owner-workers';

export interface NoopParams {
  deadlineTtlSec: number;
  wallclockCapSec: number;
  timerWaitSec: number;
  noopMaxRetries: number;
  delayMs: number;
  heartbeatIntervalMs: number;
  heartbeatMode: NoopHeartbeatMode;
  failAt?: NoopFailAt;
  failCount: number;
  simulateResumable: boolean;
  // owner-workers concurrency regression knobs (Stage 1 / R01/R23). Solo is the default
  // so every existing fixture path is unchanged.
  topology: NoopTopology;
  workerCount: number;
}

export const noopWorkType: WorkType = {
  id: 'noop',
  triggers: { api: true },
  initialPhase: () => 'noop:idle',
  onEvent: (item, ev) => noopTransition(item, ev),
  isDecisionStale: () => false,
  topology: (item) => parseNoopParams(item.context).topology,
  permissions: { mode: 'readonly' },
  checkpoints: { requiredBefore: [] },
  artifacts: { reportRequired: true },
};

export function registerNoop(registry: { register(type: WorkType): void }): void {
  registry.register(noopWorkType);
}

function noopTransition(item: WorkItem, ev: WorkItemEvent): Transition {
  const params = parseNoopParams(item.context);
  if (params.topology === 'owner-workers') {
    return ownerWorkersTransition(item, ev, params);
  }
  if (ev.kind === 'workitem_created') {
    return { dispatch: [dispatch(params)] };
  }
  if (ev.kind === 'run_completed') {
    return {
      waits: [{ kind: 'timer', reason: 'noop_complete', deadlineTtlSec: params.timerWaitSec }],
    };
  }
  if (ev.kind === 'timer_fired') {
    return { terminal: 'done' };
  }
  if (ev.kind === 'run_failed') {
    const retries = assignmentRetries(ev.payload);
    if (retries >= params.noopMaxRetries) {
      return { terminal: 'failed' };
    }
    return {
      dispatch: [
        {
          ...dispatch(params),
          replacesAssignmentId: assignmentId(ev.payload),
          retries: retries + 1,
        },
      ],
    };
  }
  return {};
}

// Minimal owner-workers state machine for regression (no real agent): creation
// dispatches one owner; the owner's run_completed fans out `workerCount` workers, each
// parented to the owner; workers rest non-terminal on completion (the worktype can't
// count running workers from a pure onEvent — that's the owner snapshot's job in the
// real requirement type). `close_requested` drives terminal. A worker run_failed
// retries within budget. This exercises the single-flight gate, per-assignment inflight
// + abort, the parent chain, and concurrent crash recovery. onEvent stays pure — the
// owner assignment id rides the run_completed payload so we never read the store here.
function ownerWorkersTransition(
  _item: WorkItem,
  ev: WorkItemEvent,
  params: NoopParams,
): Transition {
  if (ev.kind === 'workitem_created') {
    return { dispatch: [{ ...dispatch(params), role: 'owner' }] };
  }
  if (ev.kind === 'run_completed') {
    if (roleOf(ev.payload) !== 'owner') return {};
    const owner = assignmentId(ev.payload);
    return {
      dispatch: Array.from({ length: params.workerCount }, () => ({
        ...dispatch(params),
        role: 'worker' as const,
        parentAssignmentId: owner,
      })),
    };
  }
  if (ev.kind === 'run_failed') {
    const retries = assignmentRetries(ev.payload);
    if (retries >= params.noopMaxRetries) return {};
    return {
      dispatch: [
        {
          ...dispatch(params),
          role: roleOf(ev.payload) === 'owner' ? 'owner' : 'worker',
          replacesAssignmentId: assignmentId(ev.payload),
          retries: retries + 1,
        },
      ],
    };
  }
  if (ev.kind === 'close_requested') {
    return { terminal: 'done' };
  }
  return {};
}

function roleOf(payload: unknown): string | undefined {
  if (!isObject(payload)) return undefined;
  return typeof payload.role === 'string' ? payload.role : undefined;
}

function dispatch(params: NoopParams): NonNullable<Transition['dispatch']>[number] {
  return {
    role: 'solo',
    deadlineTtlSec: params.deadlineTtlSec,
    wallclockCapSec: params.wallclockCapSec,
  };
}

export function parseNoopParams(value: unknown): NoopParams {
  const input = isObject(value) ? value : {};
  return {
    deadlineTtlSec: positiveNumber(input.deadlineTtlSec, 60),
    wallclockCapSec: positiveNumber(input.wallclockCapSec, 30),
    timerWaitSec: positiveNumber(input.timerWaitSec, 1),
    noopMaxRetries: nonNegativeInteger(input.noopMaxRetries, 0),
    delayMs: nonNegativeNumber(input.delayMs, 0),
    heartbeatIntervalMs: positiveNumber(input.heartbeatIntervalMs, 1000),
    heartbeatMode: heartbeatMode(input.heartbeatMode),
    failAt: failAt(input.failAt),
    failCount: nonNegativeCount(input.failCount, 0),
    simulateResumable: input.simulateResumable === true,
    topology: input.topology === 'owner-workers' ? 'owner-workers' : 'solo',
    workerCount: positiveNumber(input.workerCount, 2),
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

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function nonNegativeCount(value: unknown, fallback: number): number {
  if (value === 'Infinity' || value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return nonNegativeInteger(value, fallback);
}

function heartbeatMode(value: unknown): NoopHeartbeatMode {
  if (value === 'silent' || value === 'normal' || value === 'beat-no-finish') return value;
  return 'normal';
}

function failAt(value: unknown): NoopFailAt | undefined {
  if (value === 'before-run' || value === 'during-run' || value === 'before-report') return value;
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
