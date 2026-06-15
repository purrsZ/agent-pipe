import type { Transition, WorkItem, WorkItemEvent, WorkType } from '../../workitems/types.js';

export type NoopFailAt = 'before-run' | 'during-run' | 'before-report';
export type NoopHeartbeatMode = 'silent' | 'normal' | 'beat-no-finish';

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
}

export const noopWorkType: WorkType = {
  id: 'noop',
  triggers: { api: true },
  initialPhase: () => 'noop:idle',
  onEvent: (item, ev) => noopTransition(item, ev),
  isDecisionStale: () => false,
  topology: () => 'solo',
  permissions: { mode: 'readonly' },
  checkpoints: { requiredBefore: [] },
  artifacts: { reportRequired: true },
};

export function registerNoop(registry: { register(type: WorkType): void }): void {
  registry.register(noopWorkType);
}

function noopTransition(item: WorkItem, ev: WorkItemEvent): Transition {
  const params = parseNoopParams(item.context);
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
