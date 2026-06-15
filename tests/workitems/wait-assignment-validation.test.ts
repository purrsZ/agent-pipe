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
  WaitKind,
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-wait-assignment-validation-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(onEvent: (item: WorkItem, ev: WorkItemEvent) => Transition): {
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
    cfg: loadWorkitemsConfig({}),
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

function expectRolledBack(store: WorkitemsStore, workitemId: string, eventKind: string): void {
  expect(store.listEvents(workitemId).map((event) => event.kind)).not.toContain(eventKind);
  expect(store.listAssignments(workitemId)).toHaveLength(0);
  expect(store.listOpenWaits(workitemId)).toHaveLength(0);
  expect(store.listInflightEffects(workitemId)).toHaveLength(0);
}

describe('wait and assignment transition validation', () => {
  it('rejects invalid wait kinds and rolls back the whole event', () => {
    const { api, reducer, store } = harness((_item, ev) =>
      ev.kind === 'bad_wait'
        ? {
            waits: [
              {
                kind: 'calendar' as unknown as WaitKind,
                reason: 'bad',
                deadlineTtlSec: 60,
              },
            ],
          }
        : {},
    );
    const item = api.createWorkItem({ type: 'noop', title: 'Bad wait', source: {} }).item;

    expect(() => reducer.enqueue(item.id, { kind: 'bad_wait' })).toThrow(/wait kind/i);

    expectRolledBack(store, item.id, 'bad_wait');
    store.close();
  });

  it.each([
    undefined,
    0,
    -1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])('rejects invalid wait deadlineTtlSec=%s', (deadlineTtlSec) => {
    const { api, reducer, store } = harness((_item, ev) =>
      ev.kind === 'bad_wait_deadline'
        ? {
            waits: [
              {
                kind: 'human',
                reason: 'bad',
                deadlineTtlSec: deadlineTtlSec as number,
              },
            ],
          }
        : {},
    );
    const item = api.createWorkItem({ type: 'noop', title: 'Bad wait deadline', source: {} }).item;

    expect(() => reducer.enqueue(item.id, { kind: 'bad_wait_deadline' })).toThrow(
      /deadlineTtlSec/i,
    );

    expectRolledBack(store, item.id, 'bad_wait_deadline');
    store.close();
  });

  it('requires agent waits to reference an existing origin assignment', () => {
    const { api, reducer, store } = harness((_item, ev) => {
      if (ev.kind === 'missing_origin') {
        return { waits: [{ kind: 'agent', reason: 'agent', deadlineTtlSec: 60 }] };
      }
      if (ev.kind === 'unknown_origin') {
        return {
          waits: [
            {
              kind: 'agent',
              reason: 'agent',
              deadlineTtlSec: 60,
              originAssignmentId: 'as-missing',
            },
          ],
        };
      }
      return {};
    });
    const item = api.createWorkItem({ type: 'noop', title: 'Agent wait', source: {} }).item;

    expect(() => reducer.enqueue(item.id, { kind: 'missing_origin' })).toThrow(
      /originAssignmentId/i,
    );
    expect(() => reducer.enqueue(item.id, { kind: 'unknown_origin' })).toThrow(
      /originAssignmentId/i,
    );

    expectRolledBack(store, item.id, 'missing_origin');
    expectRolledBack(store, item.id, 'unknown_origin');
    store.close();
  });

  it.each([
    { deadlineTtlSec: undefined, wallclockCapSec: 30 },
    { deadlineTtlSec: 0, wallclockCapSec: 30 },
    { deadlineTtlSec: 60, wallclockCapSec: undefined },
    { deadlineTtlSec: 60, wallclockCapSec: 0 },
    { deadlineTtlSec: 60, wallclockCapSec: -1 },
  ])('rejects invalid assignment supervision parameters %#', (spec) => {
    const { api, reducer, store } = harness((_item, ev) =>
      ev.kind === 'bad_dispatch'
        ? {
            dispatch: [
              {
                role: 'solo',
                deadlineTtlSec: spec.deadlineTtlSec as number,
                wallclockCapSec: spec.wallclockCapSec as number,
              },
            ],
          }
        : {},
    );
    const item = api.createWorkItem({ type: 'noop', title: 'Bad dispatch', source: {} }).item;

    expect(() => reducer.enqueue(item.id, { kind: 'bad_dispatch' })).toThrow(
      /deadlineTtlSec|wallclockCapSec/i,
    );

    expectRolledBack(store, item.id, 'bad_dispatch');
    store.close();
  });

  it('accepts a far-future deadline while still deriving deadlineAt from the clock', () => {
    const tenYearsSec = 10 * 365 * 24 * 60 * 60;
    const { api, reducer, store } = harness((_item, ev) =>
      ev.kind === 'far_wait'
        ? { waits: [{ kind: 'timer', reason: 'far', deadlineTtlSec: tenYearsSec }] }
        : {},
    );
    const item = api.createWorkItem({ type: 'noop', title: 'Far wait', source: {} }).item;

    reducer.enqueue(item.id, { kind: 'far_wait' });

    expect(store.listOpenWaits(item.id)[0]).toMatchObject({
      kind: 'timer',
      deadlineAt: 1000 + tenYearsSec * 1000,
    });
    store.close();
  });
});
