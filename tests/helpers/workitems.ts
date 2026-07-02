import type { Assignment, Wait, WorkItem } from '../../src/workitems/types.js';

export function makeWorkItem(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    type: 'noop',
    title: id,
    status: 'open',
    statusDetail: null,
    phase: 'noop:idle',
    source: { kind: 'test' },
    dedupeKey: null,
    repos: [],
    context: null,
    wakePending: false,
    discardStreak: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

export function makeAssignment(
  id: string,
  workitemId: string,
  overrides: Partial<Assignment> = {},
): Assignment {
  return {
    id,
    workitemId,
    parentId: null,
    repo: null,
    role: 'solo',
    status: 'running',
    agentSessionId: null,
    replacesAssignmentId: null,
    deadlineAt: 10_000,
    wallclockCapSec: 60,
    retries: 0,
    basedOnSeq: 1,
    briefPath: null,
    reportPath: null,
    createdAt: 1000,
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

export function makeWait(id: string, workitemId: string, overrides: Partial<Wait> = {}): Wait {
  return {
    id,
    workitemId,
    kind: 'human',
    originAssignmentId: null,
    reason: 'test',
    deadlineAt: 10_000,
    renewedCount: 0,
    remindedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    resolveReason: null,
    cardMsgId: null,
    createdAt: 1000,
    ...overrides,
  };
}
