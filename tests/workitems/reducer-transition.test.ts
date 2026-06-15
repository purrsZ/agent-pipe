import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { ReducerRuntime } from '../../src/workitems/reducer.js';
import { WorkitemsStore } from '../../src/workitems/store.js';
import type {
  Clock,
  Transition,
  WorkItem,
  WorkItemEvent,
  WorkType,
} from '../../src/workitems/types.js';

let tmpDir: string;
const clock: Clock = { now: () => 1000 };
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-reducer-transition-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(onEvent: (item: WorkItem, ev: WorkItemEvent) => Transition): {
  api: WorkitemsApi;
  reducer: ReducerRuntime;
  store: WorkitemsStore;
  registry: WorkTypeRegistry;
} {
  const store = new WorkitemsStore(path.join(tmpDir, 'workitems.sqlite'), clock);
  const registry = new WorkTypeRegistry();
  const reducer = new ReducerRuntime({
    store,
    registry,
    clock,
    cfg: loadWorkitemsConfig({
      WORKITEMS_DEFAULT_DEADLINE_TTL_SEC: '7',
      WORKITEMS_DEFAULT_WALLCLOCK_CAP_SEC: '5',
    }),
    logger,
    isRunClass: (kind) => kind === 'run',
    postCommit: () => {},
  });
  const artifacts = new ArtifactStore(path.join(tmpDir, 'workitems'), logger);
  registry.register(workType(onEvent));
  return {
    api: new WorkitemsApi({ store, registry, reducer, artifacts }),
    reducer,
    store,
    registry,
  };
}

function workType(onEvent: (item: WorkItem, ev: WorkItemEvent) => Transition): WorkType {
  return {
    id: 'noop',
    triggers: { api: true },
    initialPhase: () => 'noop:idle',
    onEvent,
    isDecisionStale: () => false,
    topology: () => 'solo',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: true },
  };
}

function explicitDispatch(): Transition {
  return {
    dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }],
  };
}

describe('ReducerRuntime transition writes', () => {
  it('creates dispatch assignments and run effects in the same declaration seq', () => {
    const { api, reducer, store } = harness((_item, ev) =>
      ev.kind === 'start' ? explicitDispatch() : {},
    );
    const item = api.createWorkItem({ type: 'noop', title: 'Dispatch', source: {} }).item;

    reducer.enqueue(item.id, { kind: 'start' });

    const [assignment] = store.listAssignments(item.id);
    const [effect] = store.listInflightEffects(item.id);
    expect(assignment).toMatchObject({ status: 'running', basedOnSeq: 2 });
    expect(effect).toMatchObject({ kind: 'run', status: 'pending', seq: 2 });
    expect(effect!.payload).toEqual({ assignmentId: assignment!.id });
    store.close();
  });

  it('rolls back event, status, assignment, and effect writes when a transition write fails', () => {
    const { api, reducer, store } = harness((_item, ev) => {
      if (ev.kind !== 'bad') return {};
      return {
        phase: { to: 'noop:changed', reason: 'bad-write' },
        dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }],
        effects: [{ kind: undefined as unknown as string }],
      };
    });
    const item = api.createWorkItem({ type: 'noop', title: 'Rollback', source: {} }).item;

    expect(() => reducer.enqueue(item.id, { kind: 'bad' })).toThrow();

    expect(store.getWorkItem(item.id)!.phase).toBe('noop:idle');
    expect(store.listEvents(item.id).map((ev) => ev.kind)).toEqual(['workitem_created']);
    expect(store.listAssignments(item.id)).toHaveLength(0);
    expect(store.listInflightEffects(item.id)).toHaveLength(0);
    store.close();
  });

  it('coalesces dispatch while a run-class effect is already pending', () => {
    const { api, reducer, store } = harness((_item, ev) =>
      ev.kind === 'start' || ev.kind === 'again' ? explicitDispatch() : {},
    );
    const item = api.createWorkItem({ type: 'noop', title: 'Single flight', source: {} }).item;

    reducer.enqueue(item.id, { kind: 'start' });
    reducer.enqueue(item.id, { kind: 'again' });

    expect(store.listAssignments(item.id)).toHaveLength(1);
    expect(store.listInflightEffects(item.id).map((effect) => effect.kind)).toEqual(['run']);
    expect(store.getWorkItem(item.id)!.wakePending).toBe(true);
    store.close();
  });

  it('starts one default run after a conclusion when wakePending was set', () => {
    const { api, reducer, store } = harness((_item, ev) =>
      ev.kind === 'start' || ev.kind === 'again' ? explicitDispatch() : {},
    );
    const item = api.createWorkItem({ type: 'noop', title: 'Wake once', source: {} }).item;
    reducer.enqueue(item.id, { kind: 'start' });
    const firstEffect = store.listInflightEffects(item.id)[0]!;
    const firstAssignment = store.listAssignments(item.id)[0]!;
    reducer.enqueue(item.id, { kind: 'again' });

    reducer.enqueue(item.id, {
      kind: 'run_completed',
      payload: {
        assignmentId: firstAssignment.id,
        effectId: firstEffect.id,
        basedOnSeq: firstEffect.seq,
      },
    });

    const assignments = [...store.listAssignments(item.id)].sort(
      (a, b) => a.basedOnSeq - b.basedOnSeq,
    );
    const secondEffect = store.listInflightEffects(item.id)[0]!;
    expect(store.getEffect(firstEffect.id)!.status).toBe('done');
    expect(assignments.map((assignment) => assignment.status)).toEqual(['done', 'running']);
    expect(secondEffect).toMatchObject({ kind: 'run', status: 'pending', seq: 4 });
    expect(assignments[1]).toMatchObject({
      basedOnSeq: 4,
      deadlineAt: 8000,
      wallclockCapSec: 5,
    });
    expect(store.getWorkItem(item.id)!.wakePending).toBe(false);
    store.close();
  });

  it('returns the previous run effect seq for batch windows', () => {
    const { api, reducer, store } = harness((_item, ev) =>
      ev.kind === 'start' || ev.kind === 'again' ? explicitDispatch() : {},
    );
    const item = api.createWorkItem({ type: 'noop', title: 'Batch window', source: {} }).item;
    reducer.enqueue(item.id, { kind: 'start' });
    const firstEffect = store.listInflightEffects(item.id)[0]!;
    const firstAssignment = store.listAssignments(item.id)[0]!;
    reducer.enqueue(item.id, { kind: 'again' });
    reducer.enqueue(item.id, {
      kind: 'run_completed',
      payload: {
        assignmentId: firstAssignment.id,
        effectId: firstEffect.id,
        basedOnSeq: firstEffect.seq,
      },
    });
    const secondEffect = store.listInflightEffects(item.id)[0]!;

    expect(store.lastRunEffectSeqBefore(item.id, firstEffect.id, ['run'])).toBe(0);
    expect(store.lastRunEffectSeqBefore(item.id, secondEffect.id, ['run'])).toBe(firstEffect.seq);
    store.close();
  });

  it('drops dispatch/waits/effects declared alongside a terminal transition (v4 #4)', () => {
    const { api, reducer, store } = harness((_item, ev) =>
      ev.kind === 'finish'
        ? {
            terminal: 'done',
            dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }],
            waits: [{ kind: 'timer', reason: 'leftover', deadlineTtlSec: 5 }],
            effects: [{ kind: 'side' }],
          }
        : {},
    );
    const item = api.createWorkItem({ type: 'noop', title: 'Terminal', source: {} }).item;

    reducer.enqueue(item.id, { kind: 'finish' });

    expect(store.getWorkItem(item.id)!.status).toBe('done');
    expect(store.listAssignments(item.id)).toHaveLength(0);
    expect(store.listInflightEffects(item.id)).toHaveLength(0);
    expect(store.listOpenWaits(item.id)).toHaveLength(0);
    expect(store.listEvents(item.id).map((event) => event.kind)).toContain('terminal_work_dropped');
    store.close();
  });

  it('does not wake a fresh run after a conclusion terminal-izes the item (v4 #4)', () => {
    const { api, reducer, store } = harness((_item, ev) => {
      if (ev.kind === 'start' || ev.kind === 'again') return explicitDispatch();
      if (ev.kind === 'run_completed') return { terminal: 'done' };
      return {};
    });
    const item = api.createWorkItem({ type: 'noop', title: 'Wake terminal', source: {} }).item;
    reducer.enqueue(item.id, { kind: 'start' });
    const firstEffect = store.listInflightEffects(item.id)[0]!;
    const firstAssignment = store.listAssignments(item.id)[0]!;
    reducer.enqueue(item.id, { kind: 'again' });
    expect(store.getWorkItem(item.id)!.wakePending).toBe(true);

    reducer.enqueue(item.id, {
      kind: 'run_completed',
      payload: {
        assignmentId: firstAssignment.id,
        effectId: firstEffect.id,
        basedOnSeq: firstEffect.seq,
      },
    });

    // The pending wake must not resurrect a run on the now-terminal item.
    expect(store.getWorkItem(item.id)!.status).toBe('done');
    expect(store.getWorkItem(item.id)!.wakePending).toBe(false);
    expect(store.listAssignments(item.id)).toHaveLength(1);
    expect(store.listInflightEffects(item.id)).toHaveLength(0);
    store.close();
  });

  it('resolves open waits and supersedes running assignments on terminal-ization (v4 #3)', () => {
    const { api, reducer, store } = harness((_item, ev) => {
      if (ev.kind === 'arm') {
        return {
          waits: [{ kind: 'human', reason: 'review', deadlineTtlSec: 9 }],
          dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }],
        };
      }
      if (ev.kind === 'finish') return { terminal: 'done' };
      return {};
    });
    const item = api.createWorkItem({ type: 'noop', title: 'Cleanup', source: {} }).item;
    reducer.enqueue(item.id, { kind: 'arm' });
    const assignment = store.listAssignments(item.id)[0]!;
    expect(store.listOpenWaits(item.id)).toHaveLength(1);

    reducer.enqueue(item.id, { kind: 'finish' });

    expect(store.getWorkItem(item.id)!.status).toBe('done');
    expect(store.listOpenWaits(item.id)).toHaveLength(0);
    expect(store.getAssignment(assignment.id)).toMatchObject({
      status: 'superseded',
      endedAt: 1000,
    });
    expect(store.listEvents(item.id).map((event) => event.kind)).toContain('terminal_cleanup');
    store.close();
  });
});
