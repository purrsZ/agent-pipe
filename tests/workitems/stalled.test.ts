import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { type PostCommitAction, ReducerRuntime } from '../../src/workitems/reducer.js';
import { WorkitemsStore } from '../../src/workitems/store.js';
import { makeWait } from '../helpers/workitems.js';
import type { Clock, Transition, WorkItem, WorkType } from '../../src/workitems/types.js';

let tmpDir: string;
let now = 1000;
const clock: Clock = { now: () => now };
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-stalled-test-'));
  now = 1000;
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(retryBudget = 1): {
  api: WorkitemsApi;
  reducer: ReducerRuntime;
  store: WorkitemsStore;
  postCommit: ReturnType<typeof vi.fn<(actions: PostCommitAction[]) => void>>;
} {
  const store = new WorkitemsStore(path.join(tmpDir, 'workitems.sqlite'), clock);
  const registry = new WorkTypeRegistry();
  const postCommit = vi.fn<(actions: PostCommitAction[]) => void>();
  const reducer = new ReducerRuntime({
    store,
    registry,
    clock,
    cfg: loadWorkitemsConfig({
      WORKITEMS_RETRY_BUDGET: String(retryBudget),
      WORKITEMS_HUMAN_WAIT_TTL_SEC: '9',
    }),
    logger,
    isRunClass: (kind) => kind === 'run',
    postCommit,
  });
  const artifacts = new ArtifactStore(path.join(tmpDir, 'workitems'), logger);
  registry.register(workType());
  return {
    api: new WorkitemsApi({ store, registry, reducer, artifacts }),
    reducer,
    store,
    postCommit,
  };
}

function workType(): WorkType {
  return {
    id: 'noop',
    triggers: { api: true },
    initialPhase: () => 'noop:idle',
    onEvent: (_item, ev): Transition =>
      ev.kind === 'start'
        ? { dispatch: [{ role: 'solo', repo: 'repo-a', deadlineTtlSec: 60, wallclockCapSec: 30 }] }
        : {},
    isDecisionStale: () => false,
    topology: () => 'solo',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: true },
  };
}

function startRun(
  api: WorkitemsApi,
  reducer: ReducerRuntime,
  store: WorkitemsStore,
): {
  item: WorkItem;
  assignmentId: string;
  effectId: number;
} {
  const item = api.createWorkItem({ type: 'noop', title: 'Stalled', source: {} }).item;
  reducer.enqueue(item.id, { kind: 'start' });
  const effect = store.listInflightEffects(item.id)[0]!;
  const assignmentId = (effect.payload as { assignmentId: string }).assignmentId;
  return { item, assignmentId, effectId: effect.id };
}

describe('assignment_stalled reducer handling', () => {
  it('supersedes and redispatches within retry budget while scheduling effect abort', () => {
    const { api, reducer, store, postCommit } = harness(1);
    const run = startRun(api, reducer, store);

    reducer.enqueue(run.item.id, {
      kind: 'assignment_stalled',
      payload: { assignmentId: run.assignmentId, reason: 'heartbeat_silent' },
    });

    const assignments = [...store.listAssignments(run.item.id)].sort(
      (a, b) => a.retries - b.retries,
    );
    expect(assignments).toHaveLength(2);
    expect(assignments[0]).toMatchObject({ id: run.assignmentId, status: 'superseded' });
    expect(assignments[1]).toMatchObject({
      status: 'running',
      replacesAssignmentId: run.assignmentId,
      retries: 1,
      role: 'solo',
      repo: 'repo-a',
      wallclockCapSec: 30,
    });
    expect(postCommit).toHaveBeenCalledWith([
      { kind: 'abort_effect', effectId: run.effectId, reason: 'heartbeat_silent' },
      { kind: 'poke', workitemId: run.item.id },
    ]);
    store.close();
  });

  it('fails the assignment and opens a human wait after retry budget is exhausted', () => {
    const { api, reducer, store, postCommit } = harness(1);
    const run = startRun(api, reducer, store);
    store.updateAssignment(run.assignmentId, { retries: 1 });

    reducer.enqueue(run.item.id, {
      kind: 'assignment_stalled',
      payload: { assignmentId: run.assignmentId, reason: 'deadline_exceeded' },
    });

    expect(store.getAssignment(run.assignmentId)).toMatchObject({ status: 'failed' });
    expect(store.listOpenWaits(run.item.id)).toEqual([
      expect.objectContaining({
        kind: 'human',
        originAssignmentId: run.assignmentId,
        reason: 'retry_exhausted',
        deadlineAt: 10_000,
      }),
    ]);
    expect(store.listEvents(run.item.id).map((event) => event.kind)).toContain(
      'assignment_retry_exhausted',
    );
    expect(postCommit).toHaveBeenCalledWith([
      { kind: 'abort_effect', effectId: run.effectId, reason: 'deadline_exceeded' },
    ]);
    store.close();
  });

  it('ignores repeated stalled events after the assignment is no longer running', () => {
    const { api, reducer, store } = harness(1);
    const run = startRun(api, reducer, store);

    reducer.enqueue(run.item.id, {
      kind: 'assignment_stalled',
      payload: { assignmentId: run.assignmentId, reason: 'heartbeat_silent' },
    });
    reducer.enqueue(run.item.id, {
      kind: 'assignment_stalled',
      payload: { assignmentId: run.assignmentId, reason: 'heartbeat_silent' },
    });

    expect(store.listAssignments(run.item.id)).toHaveLength(2);
    store.close();
  });

  it('resolves an expired agent wait whose origin assignment already finished', () => {
    const { api, reducer, store } = harness(1);
    const run = startRun(api, reducer, store);
    store.updateAssignment(run.assignmentId, { status: 'done', endedAt: 1000 });
    const wait = makeWait('wt-agent', run.item.id, {
      kind: 'agent',
      originAssignmentId: run.assignmentId,
      deadlineAt: 1000,
    });
    store.insertWait(wait);

    reducer.enqueue(run.item.id, {
      kind: 'assignment_stalled',
      payload: { assignmentId: run.assignmentId, reason: 'agent_wait_expired', waitId: wait.id },
    });
    reducer.enqueue(run.item.id, {
      kind: 'assignment_stalled',
      payload: { assignmentId: run.assignmentId, reason: 'agent_wait_expired', waitId: wait.id },
    });

    expect(store.getWait(wait.id)).toMatchObject({
      resolvedAt: 1000,
      resolvedBy: 'container',
      resolveReason: 'origin_terminal',
    });
    expect(
      store.listEvents(run.item.id).filter((event) => event.kind === 'wait_resolved'),
    ).toHaveLength(1);
    store.close();
  });

  it('re-counts the original deadline TTL when redispatching after deadline_exceeded', () => {
    const { api, reducer, store } = harness(1);
    const run = startRun(api, reducer, store);
    now = 70_000;

    reducer.enqueue(run.item.id, {
      kind: 'assignment_stalled',
      payload: { assignmentId: run.assignmentId, reason: 'deadline_exceeded' },
    });

    const replacement = store
      .listAssignments(run.item.id)
      .find((assignment) => assignment.replacesAssignmentId === run.assignmentId)!;
    expect(replacement).toMatchObject({ status: 'running', retries: 1, wallclockCapSec: 30 });
    expect(replacement.deadlineAt).toBe(70_000 + 60_000);
    store.close();
  });

  it('resolves the expired agent wait when stalled handling supersedes a running origin', () => {
    const { api, reducer, store } = harness(1);
    const run = startRun(api, reducer, store);
    const wait = makeWait('wt-agent-running', run.item.id, {
      kind: 'agent',
      originAssignmentId: run.assignmentId,
      deadlineAt: 1000,
    });
    store.insertWait(wait);

    reducer.enqueue(run.item.id, {
      kind: 'assignment_stalled',
      payload: { assignmentId: run.assignmentId, reason: 'agent_wait_expired', waitId: wait.id },
    });

    expect(store.getAssignment(run.assignmentId)).toMatchObject({ status: 'superseded' });
    expect(store.getWait(wait.id)).toMatchObject({
      resolvedBy: 'container',
      resolveReason: 'origin_terminal',
    });
    expect(
      store
        .listAssignments(run.item.id)
        .filter((assignment) => assignment.replacesAssignmentId === run.assignmentId),
    ).toHaveLength(1);
    store.close();
  });

  it('escalates to a human wait when effect_aborted arrives with retry budget exhausted', () => {
    const { api, reducer, store } = harness(1);
    const run = startRun(api, reducer, store);
    store.updateAssignment(run.assignmentId, { retries: 1 });

    reducer.enqueue(run.item.id, {
      kind: 'effect_aborted',
      payload: {
        assignmentId: run.assignmentId,
        effectId: run.effectId,
        basedOnSeq: 2,
        reason: 'recovery_redispatch',
      },
    });

    expect(store.getAssignment(run.assignmentId)).toMatchObject({ status: 'failed' });
    expect(store.listOpenWaits(run.item.id)).toEqual([
      expect.objectContaining({
        kind: 'human',
        reason: 'retry_exhausted',
        originAssignmentId: run.assignmentId,
      }),
    ]);
    expect(store.listEvents(run.item.id).map((event) => event.kind)).toContain(
      'assignment_retry_exhausted',
    );
    expect(store.listAssignments(run.item.id)).toHaveLength(1);
    store.close();
  });

  it('ignores late effect_aborted after stalled already superseded the assignment', () => {
    const { api, reducer, store } = harness(1);
    const run = startRun(api, reducer, store);
    reducer.enqueue(run.item.id, {
      kind: 'assignment_stalled',
      payload: { assignmentId: run.assignmentId, reason: 'heartbeat_silent' },
    });
    const assignmentCount = store.listAssignments(run.item.id).length;

    reducer.enqueue(run.item.id, {
      kind: 'effect_aborted',
      payload: {
        assignmentId: run.assignmentId,
        effectId: run.effectId,
        basedOnSeq: 2,
        reason: 'heartbeat_silent',
      },
    });

    expect(store.listAssignments(run.item.id)).toHaveLength(assignmentCount);
    store.close();
  });
});
