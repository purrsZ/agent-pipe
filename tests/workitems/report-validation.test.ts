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
import type { Clock, Transition, WorkItem, WorkType } from '../../src/workitems/types.js';

let tmpDir: string;
const clock: Clock = { now: () => 1000 };
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-report-validation-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(reportRequired = true): {
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
  const effects = new EffectRuntime({ store, reducer, artifacts, clock, logger, registry });
  registry.register(workType(reportRequired));
  return {
    api: new WorkitemsApi({ store, registry, reducer, artifacts }),
    reducer,
    effects,
    store,
  };
}

function workType(reportRequired: boolean): WorkType {
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
    artifacts: { reportRequired },
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
  const item = api.createWorkItem({ type: 'noop', title: 'Report', source: {} }).item;
  reducer.enqueue(item.id, { kind: 'start' });
  const effect = store.listInflightEffects(item.id)[0]!;
  const assignmentId = (effect.payload as { assignmentId: string }).assignmentId;
  return { item, assignmentId, effectId: effect.id, basedOnSeq: effect.seq };
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

describe('run report validation', () => {
  it('allows run_completed only after a non-empty assignment report is written', async () => {
    const { api, reducer, effects, store } = harness(true);
    effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      run: async (ctx) => {
        ctx.writeArtifact(`assignments/${ctx.assignment!.id}/report.md`, 'ready\n', 'report');
      },
    });
    const run = startRun(api, reducer, store);

    effects.poke(run.item.id);

    await waitFor(() => expect(store.getEffect(run.effectId)!.status).toBe('done'));
    expect(store.getAssignment(run.assignmentId)).toMatchObject({
      status: 'done',
      reportPath: `assignments/${run.assignmentId}/report.md`,
    });
    expect(store.listEvents(run.item.id).map((event) => event.kind)).toContain('run_completed');
    store.close();
  });

  it.each([
    ['missing', async () => {}],
    [
      'empty',
      async (ctx: EffectContext) => {
        ctx.writeArtifact(`assignments/${ctx.assignment!.id}/report.md`, '', 'empty report');
      },
    ],
    [
      'blank',
      async (ctx: EffectContext) => {
        ctx.writeArtifact(`assignments/${ctx.assignment!.id}/report.md`, ' \n\t', 'blank report');
      },
    ],
  ])('fails run handlers with %s reports', async (_name, runHandler) => {
    const { api, reducer, effects, store } = harness(true);
    effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      run: runHandler,
    });
    const run = startRun(api, reducer, store);

    effects.poke(run.item.id);

    await waitFor(() => expect(store.getEffect(run.effectId)!.status).toBe('aborted'));
    expect(store.getAssignment(run.assignmentId)).toMatchObject({ status: 'failed' });
    expect(store.listEvents(run.item.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'run_failed',
          payload: expect.objectContaining({ error: 'artifact_missing' }),
        }),
      ]),
    );
    expect(store.listEvents(run.item.id).map((event) => event.kind)).not.toContain('run_completed');
    store.close();
  });

  it('does not let a handler bypass validation by directly emitting run_completed', async () => {
    const { api, reducer, effects, store } = harness(true);
    effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      run: async (ctx) => {
        ctx.emit('run_completed', {
          assignmentId: ctx.assignment!.id,
          effectId: ctx.effect.id,
          basedOnSeq: ctx.effect.seq,
        });
      },
    });
    const run = startRun(api, reducer, store);

    effects.poke(run.item.id);

    await waitFor(() => expect(store.getEffect(run.effectId)!.status).toBe('aborted'));
    expect(store.getAssignment(run.assignmentId)).toMatchObject({ status: 'failed' });
    expect(store.listEvents(run.item.id).map((event) => event.kind)).not.toContain('run_completed');
    expect(store.listEvents(run.item.id).map((event) => event.kind)).toContain('run_failed');
    store.close();
  });

  it('skips report validation for work types that do not require reports', async () => {
    const { api, reducer, effects, store } = harness(false);
    effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      run: async () => {},
    });
    const run = startRun(api, reducer, store);

    effects.poke(run.item.id);

    await waitFor(() => expect(store.getEffect(run.effectId)!.status).toBe('done'));
    expect(store.getAssignment(run.assignmentId)).toMatchObject({
      status: 'done',
      reportPath: null,
    });
    store.close();
  });
});
