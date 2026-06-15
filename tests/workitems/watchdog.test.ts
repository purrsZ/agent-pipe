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
import { Watchdog } from '../../src/workitems/watchdog.js';
import { makeAssignment, makeWait } from '../helpers/workitems.js';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-watchdog-test-'));
  now = 1000;
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(lastBeat: (assignmentId: string) => number | undefined = () => undefined): {
  api: WorkitemsApi;
  reducer: ReducerRuntime;
  store: WorkitemsStore;
  watchdog: Watchdog;
} {
  const store = new WorkitemsStore(path.join(tmpDir, 'workitems.sqlite'), clock);
  const registry = new WorkTypeRegistry();
  const cfg = loadWorkitemsConfig({
    WORKITEMS_HEARTBEAT_TIMEOUT_SEC: '5',
    WORKITEMS_WATCHDOG_INTERVAL_MS: '100',
  });
  const reducer = new ReducerRuntime({
    store,
    registry,
    clock,
    cfg,
    logger,
    isRunClass: (kind) => kind === 'run',
  });
  const artifacts = new ArtifactStore(path.join(tmpDir, 'workitems'), logger);
  registry.register(workType());
  const watchdog = new Watchdog({
    store,
    reducer,
    effects: { lastBeat },
    clock,
    logger,
    cfg,
  });
  return {
    api: new WorkitemsApi({ store, registry, reducer, artifacts }),
    reducer,
    store,
    watchdog,
  };
}

function workType(): WorkType {
  return {
    id: 'noop',
    triggers: { api: true },
    initialPhase: () => 'noop:idle',
    onEvent: (item, ev): Transition => {
      // A poisoned item throws when the watchdog drives it, exercising tick isolation.
      if (item.title === 'poison' && ev.kind === 'timer_fired') {
        throw new Error('poisoned timer apply');
      }
      return {};
    },
    isDecisionStale: () => false,
    topology: () => 'solo',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: true },
  };
}

function createItem(api: WorkitemsApi): WorkItem {
  return api.createWorkItem({ type: 'noop', title: 'Watchdog', source: {} }).item;
}

describe('Watchdog.tick', () => {
  it('emits one human wait reminder across repeated due ticks', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    const wait = makeWait('wt-human', item.id, {
      kind: 'human',
      deadlineAt: 1000,
      remindedAt: null,
    });
    store.insertWait(wait);

    watchdog.tick();
    watchdog.tick();
    watchdog.tick();

    expect(store.listEvents(item.id).map((event) => event.kind)).toEqual([
      'workitem_created',
      'wait_reminder',
    ]);
    expect(store.getWait(wait.id)!.remindedAt).toBe(1000);
    store.close();
  });

  it('ignores resolved waits when their deadline arrives later', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    const wait = makeWait('wt-resolved', item.id, {
      kind: 'human',
      deadlineAt: 1000,
      resolvedAt: 900,
      resolvedBy: 'user',
      resolveReason: 'done',
    });
    store.insertWait(wait);

    watchdog.tick();

    expect(store.listEvents(item.id).map((event) => event.kind)).toEqual(['workitem_created']);
    store.close();
  });

  it('fires and resolves timer waits', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    const wait = makeWait('wt-timer', item.id, { kind: 'timer', deadlineAt: 1000 });
    store.insertWait(wait);

    watchdog.tick();

    expect(store.listEvents(item.id).map((event) => event.kind)).toEqual([
      'workitem_created',
      'timer_fired',
    ]);
    expect(store.getWait(wait.id)).toMatchObject({
      resolvedAt: 1000,
      resolvedBy: 'container',
      resolveReason: 'timer_fired',
    });
    store.close();
  });

  it('turns due agent waits into assignment_stalled events', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    const assignment = makeAssignment('as-agent', item.id, {
      deadlineAt: 10_000,
      wallclockCapSec: 60,
      startedAt: 1000,
    });
    store.insertAssignment(assignment);
    const wait = makeWait('wt-agent', item.id, {
      kind: 'agent',
      originAssignmentId: assignment.id,
      deadlineAt: 1000,
    });
    store.insertWait(wait);

    watchdog.tick();

    expect(store.listEvents(item.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assignment_stalled',
          payload: {
            assignmentId: assignment.id,
            reason: 'agent_wait_expired',
            waitId: wait.id,
          },
        }),
      ]),
    );
    store.close();
  });

  it('resolves expired agent waits whose origin already finished, without tick spam', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    const assignment = makeAssignment('as-done', item.id, {
      status: 'done',
      deadlineAt: 10_000,
      wallclockCapSec: 60,
      startedAt: 1000,
      endedAt: 900,
    });
    store.insertAssignment(assignment);
    const wait = makeWait('wt-agent-dangling', item.id, {
      kind: 'agent',
      originAssignmentId: assignment.id,
      deadlineAt: 1000,
    });
    store.insertWait(wait);

    watchdog.tick();
    watchdog.tick();
    watchdog.tick();

    expect(store.getWait(wait.id)).toMatchObject({
      resolvedAt: 1000,
      resolvedBy: 'container',
      resolveReason: 'origin_terminal',
    });
    const kinds = store.listEvents(item.id).map((event) => event.kind);
    expect(kinds.filter((kind) => kind === 'assignment_stalled')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'wait_resolved')).toHaveLength(1);
    expect(store.getAssignment(assignment.id)!.status).toBe('done');
    store.close();
  });

  it('emits heartbeat_silent when no heartbeat arrives before timeout', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    const assignment = makeAssignment('as-heartbeat', item.id, {
      deadlineAt: 20_000,
      wallclockCapSec: 60,
      startedAt: 1000,
      createdAt: 1000,
    });
    store.insertAssignment(assignment);
    now = 6000;

    watchdog.tick();

    expect(store.listEvents(item.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assignment_stalled',
          payload: { assignmentId: assignment.id, reason: 'heartbeat_silent' },
        }),
      ]),
    );
    store.close();
  });

  it('prefers wallclock_exceeded over heartbeat_silent when heartbeat is fresh', () => {
    const { api, store, watchdog } = harness(() => 6900);
    const item = createItem(api);
    const assignment = makeAssignment('as-wallclock', item.id, {
      deadlineAt: 20_000,
      wallclockCapSec: 5,
      startedAt: 1000,
      createdAt: 1000,
    });
    store.insertAssignment(assignment);
    now = 7000;

    watchdog.tick();

    const stalled = store
      .listEvents(item.id)
      .filter((event) => event.kind === 'assignment_stalled');
    expect(stalled).toHaveLength(1);
    expect(stalled[0]!.payload).toEqual({
      assignmentId: assignment.id,
      reason: 'wallclock_exceeded',
    });
    store.close();
  });

  it('emits only one stalled event per assignment with wallclock priority', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    const assignment = makeAssignment('as-many', item.id, {
      deadlineAt: 1000,
      wallclockCapSec: 5,
      startedAt: 1000,
      createdAt: 1000,
    });
    store.insertAssignment(assignment);
    now = 7000;

    watchdog.tick();

    const stalled = store
      .listEvents(item.id)
      .filter((event) => event.kind === 'assignment_stalled');
    expect(stalled).toHaveLength(1);
    expect(stalled[0]!.payload).toEqual({
      assignmentId: assignment.id,
      reason: 'wallclock_exceeded',
    });
    store.close();
  });

  it('isolates a poisoned workitem so one throwing apply cannot crash the tick', () => {
    const { api, store, watchdog } = harness();
    const poison = api.createWorkItem({ type: 'noop', title: 'poison', source: {} }).item;
    const healthy = api.createWorkItem({ type: 'noop', title: 'healthy', source: {} }).item;
    store.insertWait(makeWait('wt-poison', poison.id, { kind: 'timer', deadlineAt: 1000 }));
    store.insertWait(makeWait('wt-healthy', healthy.id, { kind: 'timer', deadlineAt: 1000 }));

    // The poisoned item throws inside its apply; the tick must survive and still
    // drive the healthy item to completion rather than bubbling up an uncaught throw.
    expect(() => watchdog.tick()).not.toThrow();
    expect(logger.error).toHaveBeenCalled();

    expect(store.getWait('wt-healthy')).toMatchObject({
      resolvedAt: 1000,
      resolveReason: 'timer_fired',
    });
    expect(store.listEvents(healthy.id).map((e) => e.kind)).toContain('timer_fired');

    // The poisoned apply rolled back atomically: no committed timer_fired, wait still open.
    expect(store.getWait('wt-poison')!.resolvedAt).toBeNull();
    expect(store.listEvents(poison.id).map((e) => e.kind)).toEqual(['workitem_created']);
    store.close();
  });

  it('never drives a terminal workitem — no timer/agent/assignment spam (v4 #3)', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    store.updateWorkItem(item.id, { status: 'done', updatedAt: 1000 });
    // Dangling open wait + running assignment left on a now-terminal item.
    store.insertWait(makeWait('wt-timer', item.id, { kind: 'timer', deadlineAt: 1000 }));
    store.insertAssignment(
      makeAssignment('as-run', item.id, {
        deadlineAt: 1000,
        wallclockCapSec: 5,
        startedAt: 1000,
        createdAt: 1000,
      }),
    );

    now = 7000;
    watchdog.tick();
    watchdog.tick();
    watchdog.tick();

    // The terminal item is excluded from every scan: nothing appended across ticks.
    expect(store.listEvents(item.id).map((event) => event.kind)).toEqual(['workitem_created']);
    store.close();
  });
});
