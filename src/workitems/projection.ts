import type { WaitKind, WorkItemStatus } from './types.js';
import type { WorkitemsStore } from './store.js';

const TERMINAL = new Set<WorkItemStatus>(['done', 'failed', 'cancelled']);

export interface RollupInput {
  current: WorkItemStatus;
  openWaitKinds: WaitKind[];
  hasRunningAssignment: boolean;
  hasEventsBeyondCreation: boolean;
}

export interface RollupResult {
  status: WorkItemStatus;
  detail: WaitKind | null;
}

export function computeRollup(input: RollupInput): RollupResult {
  if (TERMINAL.has(input.current)) {
    return { status: input.current, detail: null };
  }
  if (input.openWaitKinds.includes('human')) {
    return { status: 'waiting', detail: 'human' };
  }
  if (input.hasRunningAssignment) {
    return { status: 'active', detail: null };
  }
  if (input.openWaitKinds.includes('agent')) {
    return { status: 'waiting', detail: 'agent' };
  }
  if (input.openWaitKinds.includes('timer')) {
    return { status: 'waiting', detail: 'timer' };
  }
  return input.hasEventsBeyondCreation
    ? { status: 'active', detail: null }
    : { status: 'open', detail: null };
}

export function recomputeRollup(
  store: WorkitemsStore,
  workitemId: string,
  updatedAt = Date.now(),
): RollupResult {
  const item = store.getWorkItem(workitemId);
  if (!item) {
    throw new Error(`WorkItem not found: ${workitemId}`);
  }
  const result = computeRollup({
    current: item.status,
    openWaitKinds: store.listOpenWaits(workitemId).map((wait) => wait.kind),
    hasRunningAssignment: store
      .listAssignments(workitemId)
      .some((assignment) => assignment.status === 'running'),
    hasEventsBeyondCreation: store.hasEventsBeyondCreation(workitemId),
  });
  store.updateWorkItem(workitemId, {
    status: result.status,
    statusDetail: result.detail,
    updatedAt,
  });
  return result;
}
