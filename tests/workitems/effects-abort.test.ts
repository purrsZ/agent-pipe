import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { EffectRuntime } from '../../src/workitems/effects.js';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { ReducerRuntime } from '../../src/workitems/reducer.js';
import { WorkitemsStore } from '../../src/workitems/store.js';
import type { Clock, Transition, WorkItem, WorkType } from '../../src/workitems/types.js';

let tmpDir: string;
const clock: Clock = { now: () => 1000 };
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-effects-abort-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(): {
  api: WorkitemsApi;
  reducer: ReducerRuntime;
  effects: EffectRuntime;
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
  const effects = new EffectRuntime({ store, reducer, registry, artifacts, clock, logger });
  registry.register(workType());
  return {
    api: new WorkitemsApi({ store, registry, reducer, artifacts }),
    reducer,
    effects,
    store,
  };
}

function workType(): WorkType {
  return {
    id: 'noop',
    triggers: { api: true },
    initialPhase: () => 'noop:idle',
    onEvent: (_item, ev): Transition => {
      if (ev.kind === 'start') {
        return { dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }] };
      }
      if (ev.kind === 'run_completed') return { terminal: 'done' };
      if (ev.kind === 'run_failed') return { terminal: 'failed' };
      return {};
    },
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
  basedOnSeq: number;
} {
  const item = api.createWorkItem({ type: 'noop', title: 'Abort', source: {} }).item;
  reducer.enqueue(item.id, { kind: 'start' });
  const effect = store.listInflightEffects(item.id)[0]!;
  const assignmentId = (effect.payload as { assignmentId: string }).assignmentId;
  return { item, assignmentId, effectId: effect.id, basedOnSeq: effect.seq };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

describe('EffectRuntime abort', () => {
  it('aborts an inflight handler, marks the effect aborted, and emits effect_aborted', async () => {
    const { api, reducer, effects, store } = harness();
    const started = deferred();
    const aborted = deferred();
    let calls = 0;
    effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      run: async (ctx) => {
        calls += 1;
        if (calls > 1) {
          // the redispatched replacement: park until its own abort signal
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return;
        }
        ctx.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        started.resolve();
        await aborted.promise;
      },
    });
    const run = startRun(api, reducer, store);
    effects.poke(run.item.id);
    await started.promise;

    effects.abort(run.effectId, 'wallclock_exceeded');

    await aborted.promise;
    await waitFor(() => expect(store.getEffect(run.effectId)!.status).toBe('aborted'));
    expect(store.listEvents(run.item.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'effect_aborted',
          payload: {
            effectId: run.effectId,
            assignmentId: run.assignmentId,
            basedOnSeq: run.basedOnSeq,
            reason: 'wallclock_exceeded',
          },
        }),
      ]),
    );
    expect(store.listEvents(run.item.id).map((event) => event.kind)).not.toContain('run_completed');
    expect(store.listEvents(run.item.id).map((event) => event.kind)).not.toContain('run_failed');
    effects.stopIntake();
    store.close();
  });

  it('can abort a running DB row even when it is not in the inflight map', () => {
    const { api, reducer, effects, store } = harness();
    const run = startRun(api, reducer, store);
    store.setEffectStatus(run.effectId, 'running');

    effects.abort(run.effectId, 'recovery_redispatch');

    expect(store.getEffect(run.effectId)!.status).toBe('aborted');
    expect(store.listEvents(run.item.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'effect_aborted',
          payload: expect.objectContaining({
            effectId: run.effectId,
            assignmentId: run.assignmentId,
            reason: 'recovery_redispatch',
          }),
        }),
      ]),
    );
    store.close();
  });

  it('discards a late conclusion after abort through the reducer structural check', async () => {
    const { api, reducer, effects, store } = harness();
    const started = deferred();
    const aborted = deferred();
    let calls = 0;
    effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      run: async (ctx) => {
        calls += 1;
        if (calls > 1) {
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return;
        }
        ctx.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        started.resolve();
        await aborted.promise;
      },
    });
    const run = startRun(api, reducer, store);
    effects.poke(run.item.id);
    await started.promise;
    effects.abort(run.effectId, 'wallclock_exceeded');
    await aborted.promise;

    reducer.enqueue(run.item.id, {
      kind: 'run_completed',
      payload: {
        assignmentId: run.assignmentId,
        effectId: run.effectId,
        basedOnSeq: run.basedOnSeq,
      },
    });

    expect(store.getEffect(run.effectId)!.status).toBe('aborted');
    expect(store.listEvents(run.item.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'decision_discarded',
          payload: expect.objectContaining({
            reason: 'effect_aborted',
            effectId: run.effectId,
          }),
        }),
      ]),
    );
    expect(store.getWorkItem(run.item.id)!.status).not.toBe('done');
    effects.stopIntake();
    store.close();
  });
});
