import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { EffectRuntime } from '../../src/workitems/effects.js';
import { startupRecovery } from '../../src/workitems/recovery.js';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-recovery-basic-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(onEvent: (item: WorkItem, ev: WorkItemEvent) => Transition = defaultOnEvent): {
  api: WorkitemsApi;
  reducer: ReducerRuntime;
  effects: EffectRuntime;
  store: WorkitemsStore;
  artifacts: ArtifactStore;
  dbPath: string;
} {
  const dbPath = path.join(tmpDir, 'workitems.sqlite');
  const store = new WorkitemsStore(dbPath, clock);
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
  const effects = new EffectRuntime({ store, reducer, registry, artifacts, clock, logger });
  registry.register(workType(onEvent));
  return {
    api: new WorkitemsApi({ store, registry, reducer, artifacts }),
    reducer,
    effects,
    store,
    artifacts,
    dbPath,
  };
}

function defaultOnEvent(_item: WorkItem, ev: WorkItemEvent): Transition {
  if (ev.kind === 'audit') return { effects: [{ kind: 'audit', payload: { ok: true } }] };
  if (ev.kind === 'touch') return {};
  return {};
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

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('waitFor timed out');
}

function clearEvents(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    DROP TRIGGER IF EXISTS workitem_events_no_delete;
    DELETE FROM workitem_events;
  `);
  db.close();
}

describe('startupRecovery basic recovery', () => {
  it('logs the fixed recovery sequence', () => {
    const { store, effects, artifacts } = harness();

    startupRecovery({ store, effects, artifacts, clock, logger });

    expect(logger.info.mock.calls.map((call) => call[0])).toEqual([
      'recovery: step 2 rebuild',
      'recovery: step 3 outbox',
      'recovery: step 4 reconcile',
    ]);
    store.close();
  });

  it('executes pending effects after recovery without inserting replacement rows', async () => {
    const { api, reducer, effects, store, artifacts } = harness();
    const runs: number[] = [];
    effects.registerHandler({
      kind: 'audit',
      recovery: 'rerun',
      run: async (ctx) => {
        runs.push(ctx.effect.id);
      },
    });
    const item = api.createWorkItem({ type: 'noop', title: 'Pending', source: {} }).item;
    reducer.enqueue(item.id, { kind: 'audit' });
    const effect = store.listInflightEffects(item.id)[0]!;

    startupRecovery({ store, effects, artifacts, clock, logger });

    await waitFor(() => expect(store.getEffect(effect.id)!.status).toBe('done'));
    expect(runs).toEqual([effect.id]);
    expect(store.getEffect(effect.id)).toMatchObject({ id: effect.id, kind: 'audit' });
    store.close();
  });

  it('reruns a running rerun-class effect on the same row', async () => {
    const { api, reducer, effects, store, artifacts } = harness();
    const runs: number[] = [];
    effects.registerHandler({
      kind: 'audit',
      recovery: 'rerun',
      run: async (ctx) => {
        runs.push(ctx.effect.id);
      },
    });
    const item = api.createWorkItem({ type: 'noop', title: 'Running', source: {} }).item;
    reducer.enqueue(item.id, { kind: 'audit' });
    const effect = store.listInflightEffects(item.id)[0]!;
    store.setEffectStatus(effect.id, 'running');

    startupRecovery({ store, effects, artifacts, clock, logger });

    await waitFor(() => expect(store.getEffect(effect.id)!.status).toBe('done'));
    expect(runs).toEqual([effect.id]);
    store.close();
  });

  it('isolates a throwing reconcile so one bad repo cannot block startup', () => {
    const { api, reducer, effects, store, artifacts } = harness();
    api.createWorkItem({ type: 'noop', title: 'A', source: {} });
    api.createWorkItem({ type: 'noop', title: 'B', source: {} });
    // A corrupt/locked artifact git repo makes reconcile throw. Recovery must log and
    // continue rather than letting container.start() throw and the bridge never boot.
    const boom = vi.spyOn(artifacts, 'reconcile').mockImplementation(() => {
      throw new Error('corrupt git repo');
    });

    expect(() =>
      startupRecovery({ store, effects, artifacts, clock, logger, reducer }),
    ).not.toThrow();
    expect(boom).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    store.close();
  });

  it('does not depend on events when rebuilding non-terminal workitems', () => {
    const { api, reducer, store, dbPath } = harness();
    const item = api.createWorkItem({ type: 'noop', title: 'Events gone', source: {} }).item;
    reducer.enqueue(item.id, { kind: 'touch' });
    expect(store.getWorkItem(item.id)!.status).toBe('active');
    store.close();
    clearEvents(dbPath);

    const reopened = new WorkitemsStore(dbPath, clock);
    const artifacts = new ArtifactStore(path.join(tmpDir, 'workitems'), logger);
    const registry = new WorkTypeRegistry();
    const reducerAfter = new ReducerRuntime({
      store: reopened,
      registry,
      clock,
      cfg: loadWorkitemsConfig({}),
      logger,
      isRunClass: (kind) => kind === 'run',
      postCommit: () => {},
    });
    const effects = new EffectRuntime({
      store: reopened,
      reducer: reducerAfter,
      registry,
      artifacts,
      clock,
      logger,
    });

    startupRecovery({ store: reopened, effects, artifacts, clock, logger });

    expect(reopened.getWorkItem(item.id)!.status).toBe('active');
    expect(reopened.listEvents(item.id)).toHaveLength(0);
    reopened.close();
  });
});
