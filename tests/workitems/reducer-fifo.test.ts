import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { ReducerRuntime, type PendingEvent } from '../../src/workitems/reducer.js';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-reducer-fifo-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(): {
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
    cfg: loadWorkitemsConfig({}),
    logger,
    postCommit: () => {},
  });
  const artifacts = new ArtifactStore(path.join(tmpDir, 'workitems'), logger);
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
    initialPhase: () => 'noop:initial',
    onEvent,
    isDecisionStale: () => false,
    topology: () => 'solo',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: true },
  };
}

describe('ReducerRuntime enqueue', () => {
  it('applies same-workitem events in FIFO order, including events enqueued during drain', () => {
    const { api, reducer, store, registry } = harness();
    const applied: string[] = [];
    registry.register(
      workType((item, ev) => {
        applied.push(ev.kind);
        if (ev.kind === 'e1') reducer.enqueue(item.id, { kind: 'e2' });
        return {};
      }),
    );
    const created = api.createWorkItem({ type: 'noop', title: 'FIFO', source: {} });
    applied.length = 0;

    reducer.enqueue(created.item.id, { kind: 'e1' });

    expect(applied).toEqual(['e1', 'e2']);
    expect(store.listEvents(created.item.id).map((ev) => [ev.seq, ev.kind])).toEqual([
      [1, 'workitem_created'],
      [2, 'e1'],
      [3, 'e2'],
    ]);
    store.close();
  });

  it('keeps seq sequences independent across workitems', () => {
    const { api, reducer, store, registry } = harness();
    registry.register(workType(() => ({})));
    const a = api.createWorkItem({ type: 'noop', title: 'A', source: {} }).item;
    const b = api.createWorkItem({ type: 'noop', title: 'B', source: {} }).item;

    reducer.enqueue(a.id, { kind: 'a1' });
    reducer.enqueue(b.id, { kind: 'b1' });

    expect(store.listEvents(a.id).map((ev) => ev.seq)).toEqual([1, 2]);
    expect(store.listEvents(b.id).map((ev) => ev.seq)).toEqual([1, 2]);
    store.close();
  });

  it('short-circuits terminal workitems while still appending audit events', () => {
    const { api, reducer, store, registry } = harness();
    const applied: PendingEvent[] = [];
    registry.register(
      workType((_item, ev) => {
        applied.push({ kind: ev.kind, payload: ev.payload });
        return {};
      }),
    );
    const created = api.createWorkItem({ type: 'noop', title: 'Done', source: {} });
    applied.length = 0;
    store.updateWorkItem(created.item.id, { status: 'done', statusDetail: null, updatedAt: 2000 });

    reducer.enqueue(created.item.id, { kind: 'late_event', payload: { ok: true } });

    expect(applied).toEqual([]);
    expect(store.getWorkItem(created.item.id)!.status).toBe('done');
    expect(store.listEvents(created.item.id).map((ev) => ev.kind)).toEqual([
      'workitem_created',
      'late_event',
    ]);
    store.close();
  });

  it('persists declared effects without executing them during apply', () => {
    const { api, reducer, store, registry } = harness();
    registry.register(workType(() => ({ effects: [{ kind: 'audit', payload: { ok: true } }] })));
    const created = api.createWorkItem({ type: 'noop', title: 'Effect', source: {} });

    reducer.enqueue(created.item.id, { kind: 'needs_effect' });

    expect(store.listInflightEffects(created.item.id).map((effect) => effect.kind)).toEqual([
      'audit',
      'audit',
    ]);
    expect(
      store.listInflightEffects(created.item.id).every((effect) => effect.status === 'pending'),
    ).toBe(true);
    store.close();
  });
});
