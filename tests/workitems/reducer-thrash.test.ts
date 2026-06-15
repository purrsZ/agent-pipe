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
  Decision,
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-reducer-thrash-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(isDecisionStale: (decision: Decision, eventsSince: WorkItemEvent[]) => boolean): {
  api: WorkitemsApi;
  reducer: ReducerRuntime;
  store: WorkitemsStore;
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
      WORKITEMS_HUMAN_WAIT_TTL_SEC: '9',
    }),
    logger,
    isRunClass: (kind) => kind === 'run',
    postCommit: () => {},
  });
  const artifacts = new ArtifactStore(path.join(tmpDir, 'workitems'), logger);
  registry.register(workType(isDecisionStale));
  return {
    api: new WorkitemsApi({ store, registry, reducer, artifacts }),
    reducer,
    store,
  };
}

function workType(
  isDecisionStale: (decision: Decision, eventsSince: WorkItemEvent[]) => boolean,
): WorkType {
  return {
    id: 'noop',
    triggers: { api: true },
    initialPhase: () => 'noop:idle',
    onEvent: (_item, ev): Transition => {
      if (ev.kind === 'start') {
        return { dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }] };
      }
      if (ev.kind === 'run_completed') {
        return { phase: { to: 'noop:done', reason: 'complete' }, terminal: 'done' };
      }
      return {};
    },
    isDecisionStale,
    topology: () => 'solo',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: true },
  };
}

function startRun(api: WorkitemsApi, reducer: ReducerRuntime, store: WorkitemsStore): WorkItem {
  const item = api.createWorkItem({ type: 'noop', title: 'Thrash', source: {} }).item;
  reducer.enqueue(item.id, { kind: 'start' });
  expect(store.listInflightEffects(item.id)).toHaveLength(1);
  return item;
}

function currentRun(
  store: WorkitemsStore,
  workitemId: string,
): {
  assignmentId: string;
  effectId: number;
  basedOnSeq: number;
} {
  const effect = store.listInflightEffects(workitemId)[0]!;
  const assignmentId = (effect.payload as { assignmentId: string }).assignmentId;
  return { assignmentId, effectId: effect.id, basedOnSeq: effect.seq };
}

function completeRun(
  reducer: ReducerRuntime,
  workitemId: string,
  run: ReturnType<typeof currentRun>,
): void {
  reducer.enqueue(workitemId, {
    kind: 'run_completed',
    payload: {
      assignmentId: run.assignmentId,
      effectId: run.effectId,
      basedOnSeq: run.basedOnSeq,
      decision: { data: { ok: true } },
    },
  });
}

describe('ReducerRuntime thrash protection', () => {
  it('increments discardStreak and automatically wakes once after the first discarded decision', () => {
    const { api, reducer, store } = harness(() => true);
    const item = startRun(api, reducer, store);
    completeRun(reducer, item.id, currentRun(store, item.id));

    const assignments = [...store.listAssignments(item.id)].sort(
      (a, b) => a.basedOnSeq - b.basedOnSeq,
    );
    const nextEffect = store.listInflightEffects(item.id)[0]!;
    expect(store.getWorkItem(item.id)).toMatchObject({ discardStreak: 1, wakePending: false });
    expect(assignments.map((assignment) => assignment.status)).toEqual(['superseded', 'running']);
    expect(assignments[0]!.endedAt).toBe(1000);
    expect(assignments[1]).toMatchObject({
      basedOnSeq: 3,
      deadlineAt: 8000,
      wallclockCapSec: 5,
    });
    expect(nextEffect).toMatchObject({ kind: 'run', status: 'pending', seq: 3 });
    store.close();
  });

  it('escalates to a human wait and suppresses the third auto wake after two consecutive discards', () => {
    const { api, reducer, store } = harness(() => true);
    const item = startRun(api, reducer, store);
    completeRun(reducer, item.id, currentRun(store, item.id));
    completeRun(reducer, item.id, currentRun(store, item.id));

    expect(store.getWorkItem(item.id)).toMatchObject({
      discardStreak: 0,
      status: 'waiting',
      statusDetail: 'human',
      wakePending: false,
    });
    expect(store.listInflightEffects(item.id)).toHaveLength(0);
    expect(store.listAssignments(item.id)).toHaveLength(2);
    expect(store.listOpenWaits(item.id)).toEqual([
      expect.objectContaining({
        kind: 'human',
        reason: 'thrash',
        deadlineAt: 10_000,
      }),
    ]);
    expect(store.listEvents(item.id).map((event) => event.kind)).toEqual([
      'workitem_created',
      'start',
      'decision_discarded',
      'decision_discarded',
      'thrash_escalated',
    ]);
    store.close();
  });

  it('resets discardStreak after any decision applies successfully', () => {
    let calls = 0;
    const { api, reducer, store } = harness(() => {
      calls += 1;
      return calls === 1;
    });
    const item = startRun(api, reducer, store);
    completeRun(reducer, item.id, currentRun(store, item.id));
    expect(store.getWorkItem(item.id)!.discardStreak).toBe(1);

    completeRun(reducer, item.id, currentRun(store, item.id));

    expect(store.getWorkItem(item.id)).toMatchObject({
      discardStreak: 0,
      status: 'done',
      phase: 'noop:done',
    });
    store.close();
  });

  it('does not count effect_aborted as thrash and does not re-wake', () => {
    const { api, reducer, store } = harness(() => false);
    const item = startRun(api, reducer, store);
    const run = currentRun(store, item.id);
    store.setEffectStatus(run.effectId, 'aborted');

    completeRun(reducer, item.id, run);

    expect(store.getWorkItem(item.id)).toMatchObject({ discardStreak: 0, wakePending: false });
    expect(store.getEffect(run.effectId)!.status).toBe('aborted');
    expect(store.listInflightEffects(item.id)).toHaveLength(0);
    expect(store.listAssignments(item.id)).toHaveLength(1);
    expect(store.listOpenWaits(item.id)).toHaveLength(0);
    store.close();
  });
});
