import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { EffectRuntime, type EffectContext } from '../../src/workitems/effects.js';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-effects-runtime-test-'));
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
  const effects = new EffectRuntime({ store, reducer, registry, artifacts, clock, logger });
  registry.register(workType(onEvent));
  return {
    api: new WorkitemsApi({ store, registry, reducer, artifacts }),
    reducer,
    effects,
    store,
    artifacts,
  };
}

function defaultOnEvent(_item: WorkItem, ev: WorkItemEvent): Transition {
  if (ev.kind === 'start') {
    return { dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }] };
  }
  if (ev.kind === 'run_completed') return { terminal: 'done' };
  if (ev.kind === 'run_failed') return { terminal: 'failed' };
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
    artifacts: { reportRequired: false },
  };
}

function startRun(api: WorkitemsApi, reducer: ReducerRuntime, store: WorkitemsStore): WorkItem {
  const item = api.createWorkItem({ type: 'noop', title: 'Effect', source: {} }).item;
  reducer.enqueue(item.id, { kind: 'start' });
  expect(store.listInflightEffects(item.id)).toHaveLength(1);
  return item;
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

describe('EffectRuntime', () => {
  it('marks a pending effect running and executes the handler outside the reducer', async () => {
    const { api, reducer, effects, store } = harness();
    const started = deferred();
    const release = deferred();
    effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      run: async () => {
        started.resolve();
        await release.promise;
      },
    });
    const item = startRun(api, reducer, store);
    const effect = store.listInflightEffects(item.id)[0]!;

    effects.poke(item.id);
    await started.promise;

    expect(store.getEffect(effect.id)!.status).toBe('running');
    reducer.enqueue(item.id, { kind: 'side_event' });
    expect(store.listEvents(item.id).map((event) => event.kind)).toContain('side_event');

    release.resolve();
    await waitFor(() => expect(store.getEffect(effect.id)!.status).toBe('done'));
    expect(store.getWorkItem(item.id)!.status).toBe('done');
    store.close();
  });

  it('emits run_failed for thrown run handlers and lets the reducer abort the effect', async () => {
    const { api, reducer, effects, store } = harness();
    effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      run: async () => {
        throw new Error('boom');
      },
    });
    const item = startRun(api, reducer, store);
    const effect = store.listInflightEffects(item.id)[0]!;

    effects.poke(item.id);

    await waitFor(() => expect(store.getEffect(effect.id)!.status).toBe('aborted'));
    expect(store.listEvents(item.id).map((event) => event.kind)).toContain('run_failed');
    expect(store.getWorkItem(item.id)!.status).toBe('failed');
    store.close();
  });

  it('aborts failed rerun handlers without emitting conclusion events', async () => {
    const { api, reducer, effects, store } = harness((_item, ev) =>
      ev.kind === 'audit' ? { effects: [{ kind: 'audit', payload: { ok: true } }] } : {},
    );
    effects.registerHandler({
      kind: 'audit',
      recovery: 'rerun',
      run: async () => {
        throw new Error('audit failed');
      },
    });
    const item = api.createWorkItem({ type: 'noop', title: 'Audit', source: {} }).item;
    reducer.enqueue(item.id, { kind: 'audit' });
    const effect = store.listInflightEffects(item.id)[0]!;

    effects.poke(item.id);

    await waitFor(() => expect(store.getEffect(effect.id)!.status).toBe('aborted'));
    expect(store.listEvents(item.id).map((event) => event.kind)).not.toContain('run_failed');
    expect(store.getWorkItem(item.id)!.status).toBe('active');
    store.close();
  });

  it('runs effects serially per workitem and concurrently across workitems', async () => {
    const { api, reducer, effects, store } = harness((_item, ev) =>
      ev.kind === 'audit'
        ? {
            effects: [
              { kind: 'audit', payload: { n: 1 } },
              { kind: 'audit', payload: { n: 2 } },
            ],
          }
        : {},
    );
    const releases = new Map<number, ReturnType<typeof deferred>>();
    const starts: Array<[string, number]> = [];
    effects.registerHandler({
      kind: 'audit',
      recovery: 'rerun',
      run: async (ctx) => {
        starts.push([ctx.effect.workitemId, ctx.effect.id]);
        const gate = deferred();
        releases.set(ctx.effect.id, gate);
        await gate.promise;
      },
    });
    const a = api.createWorkItem({ type: 'noop', title: 'A', source: {} }).item;
    const b = api.createWorkItem({ type: 'noop', title: 'B', source: {} }).item;
    reducer.enqueue(a.id, { kind: 'audit' });
    reducer.enqueue(b.id, { kind: 'audit' });
    const [a1, a2] = store.listInflightEffects(a.id);
    const [b1] = store.listInflightEffects(b.id);

    effects.poke(a.id);
    effects.poke(b.id);

    await waitFor(() =>
      expect(starts).toEqual(
        expect.arrayContaining([
          [a.id, a1!.id],
          [b.id, b1!.id],
        ]),
      ),
    );
    expect(starts).not.toContainEqual([a.id, a2!.id]);
    releases.get(a1!.id)!.resolve();
    await waitFor(() => expect(starts).toContainEqual([a.id, a2!.id]));
    releases.get(a2!.id)!.resolve();
    releases.get(b1!.id)!.resolve();
    await waitFor(() => expect(store.listInflightEffects(a.id)).toHaveLength(0));
    store.close();
  });

  it('provides batchFromSeq and an inclusive upper-bound eventsSince window', async () => {
    const windows: Array<{ batchFromSeq: number; kinds: string[] }> = [];
    const firstRelease = deferred();
    let runCount = 0;
    const { api, reducer, effects, store } = harness((_item, ev) => {
      if (ev.kind === 'start' || ev.kind === 'again') {
        return { dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }] };
      }
      return {};
    });
    effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      run: async (ctx: EffectContext) => {
        runCount += 1;
        windows.push({
          batchFromSeq: ctx.batchFromSeq,
          kinds: ctx.eventsSince(ctx.batchFromSeq).map((event) => event.kind),
        });
        if (runCount === 1) await firstRelease.promise;
      },
    });
    const item = api.createWorkItem({ type: 'noop', title: 'Batch', source: {} }).item;
    reducer.enqueue(item.id, { kind: 'start' });
    effects.poke(item.id);
    await waitFor(() => expect(store.listInflightEffects(item.id)[0]!.status).toBe('running'));

    reducer.enqueue(item.id, { kind: 'during_1' });
    reducer.enqueue(item.id, { kind: 'during_2' });
    reducer.enqueue(item.id, { kind: 'again' });
    firstRelease.resolve();

    await waitFor(() => expect(windows).toHaveLength(2));
    expect(windows[0]).toMatchObject({ batchFromSeq: 0 });
    expect(windows[1]).toEqual({
      batchFromSeq: 2,
      kinds: ['during_1', 'during_2', 'again', 'run_completed'],
    });
    store.close();
  });

  it('blocks a non-run handler from forging a run conclusion through ctx.emit', async () => {
    const { api, reducer, effects, store } = harness((_item, ev) => {
      if (ev.kind === 'start') return { effects: [{ kind: 'sideeffect' }] };
      if (ev.kind === 'run_completed') return { terminal: 'done' };
      return {};
    });
    const emitted = deferred();
    effects.registerHandler({
      kind: 'sideeffect',
      recovery: 'rerun',
      run: async (ctx: EffectContext) => {
        // A non-run effect tries to forge a run conclusion. The emit guard must
        // suppress it — otherwise it bypasses validateRunReport and fakes a report.md.
        ctx.emit('run_completed', { assignmentId: 'forged', reportPath: 'fabricated.md' });
        emitted.resolve();
      },
    });
    const item = api.createWorkItem({ type: 'noop', title: 'Forge', source: {} }).item;
    reducer.enqueue(item.id, { kind: 'start' });
    const effect = store.listInflightEffects(item.id)[0]!;

    effects.poke(item.id);
    await emitted.promise;
    await waitFor(() => expect(store.getEffect(effect.id)!.status).toBe('done'));

    expect(store.listEvents(item.id).map((event) => event.kind)).not.toContain('run_completed');
    expect(store.getWorkItem(item.id)!.status).not.toBe('done');
    store.close();
  });
});
