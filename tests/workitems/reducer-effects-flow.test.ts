import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { EffectRuntime, type EffectContext } from '../../src/workitems/effects.js';
import { startupRecovery } from '../../src/workitems/recovery.js';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-reducer-effects-flow-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(options: {
  onEvent: (item: WorkItem, ev: WorkItemEvent) => Transition;
  isDecisionStale?: (decision: Decision, eventsSince: WorkItemEvent[]) => boolean;
}): {
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
    cfg: loadWorkitemsConfig({
      WORKITEMS_MAX_OPEN: '8',
      WORKITEMS_DEFAULT_DEADLINE_TTL_SEC: '7',
      WORKITEMS_DEFAULT_WALLCLOCK_CAP_SEC: '5',
      WORKITEMS_HUMAN_WAIT_TTL_SEC: '9',
    }),
    logger,
    isRunClass: (kind) => kind === 'run',
    postCommit: () => {},
  });
  const artifacts = new ArtifactStore(path.join(tmpDir, 'workitems'), logger);
  const effects = new EffectRuntime({ store, reducer, registry, artifacts, clock, logger });
  registry.register(workType(options));
  return {
    api: new WorkitemsApi({ store, registry, reducer, artifacts }),
    reducer,
    effects,
    store,
    artifacts,
  };
}

function workType(options: {
  onEvent: (item: WorkItem, ev: WorkItemEvent) => Transition;
  isDecisionStale?: (decision: Decision, eventsSince: WorkItemEvent[]) => boolean;
}): WorkType {
  return {
    id: 'noop',
    triggers: { api: true },
    initialPhase: () => 'noop:idle',
    onEvent: options.onEvent,
    isDecisionStale: options.isDecisionStale ?? (() => false),
    topology: () => 'solo',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: false },
  };
}

function dispatch(): Transition {
  return { dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }] };
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

describe('G3/G4 reducer and effects flows', () => {
  it('batches events that arrive during a run into exactly one next run window', async () => {
    const firstRelease = deferred();
    const windows: string[][] = [];
    let runs = 0;
    const { api, reducer, effects, store } = harness({
      onEvent: (_item, ev) => (ev.kind === 'start' || ev.kind === 'again' ? dispatch() : {}),
    });
    effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      run: async (ctx: EffectContext) => {
        runs += 1;
        windows.push(ctx.eventsSince(ctx.batchFromSeq).map((event) => event.kind));
        if (runs === 1) await firstRelease.promise;
      },
    });
    const item = api.createWorkItem({ type: 'noop', title: 'Batch flow', source: {} }).item;
    reducer.enqueue(item.id, { kind: 'start' });
    effects.poke(item.id);
    await waitFor(() => expect(store.listInflightEffects(item.id)[0]!.status).toBe('running'));

    reducer.enqueue(item.id, { kind: 'during_1' });
    reducer.enqueue(item.id, { kind: 'during_2' });
    reducer.enqueue(item.id, { kind: 'during_3' });
    reducer.enqueue(item.id, { kind: 'again' });
    firstRelease.resolve();

    await waitFor(() => expect(runs).toBe(2));
    expect(windows[1]).toEqual(['during_1', 'during_2', 'during_3', 'again', 'run_completed']);
    expect(store.listInflightEffects(item.id)).toHaveLength(0);
    store.close();
  });

  it('keeps artifacts through stale-decision thrash escalation', () => {
    const { api, reducer, store, artifacts } = harness({
      onEvent: (_item, ev) => (ev.kind === 'start' ? dispatch() : {}),
      isDecisionStale: () => true,
    });
    const item = api.createWorkItem({ type: 'noop', title: 'Thrash flow', source: {} }).item;
    artifacts.writeFile(item.id, 'assignments/report.md', 'survives', 'stale result');
    reducer.enqueue(item.id, { kind: 'start' });
    completeRun(reducer, item.id, currentRun(store, item.id));
    completeRun(reducer, item.id, currentRun(store, item.id));

    expect(store.getWorkItem(item.id)).toMatchObject({ status: 'waiting', statusDetail: 'human' });
    expect(store.listOpenWaits(item.id)[0]).toMatchObject({ kind: 'human', reason: 'thrash' });
    expect(artifacts.readFile(item.id, 'assignments/report.md')).toBe('survives');
    store.close();
  });

  it('runs the pending to running to done pipeline while reducer keeps accepting events', async () => {
    const release = deferred();
    const { api, reducer, effects, store } = harness({
      onEvent: (_item, ev) => {
        if (ev.kind === 'start') return dispatch();
        if (ev.kind === 'run_completed') return { terminal: 'done' };
        return {};
      },
    });
    effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      run: async () => {
        await release.promise;
      },
    });
    const item = api.createWorkItem({ type: 'noop', title: 'Pipeline', source: {} }).item;
    reducer.enqueue(item.id, { kind: 'start' });
    const effect = store.listInflightEffects(item.id)[0]!;
    effects.poke(item.id);
    await waitFor(() => expect(store.getEffect(effect.id)!.status).toBe('running'));
    reducer.enqueue(item.id, { kind: 'side_event' });
    release.resolve();

    await waitFor(() => expect(store.getEffect(effect.id)!.status).toBe('done'));
    expect(store.listEvents(item.id).map((event) => event.kind)).toContain('side_event');
    expect(store.getWorkItem(item.id)!.status).toBe('done');
    store.close();
  });

  it('recovers pending, rerun, redispatch, and reconcile paths in one startup pass', async () => {
    const { api, reducer, effects, store, artifacts } = harness({
      onEvent: (_item, ev) => {
        if (ev.kind === 'start') return dispatch();
        if (ev.kind === 'audit') return { effects: [{ kind: 'audit', payload: { ok: true } }] };
        return {};
      },
    });
    const auditRuns: number[] = [];
    effects.registerHandler({
      kind: 'audit',
      recovery: 'rerun',
      run: async (ctx) => {
        auditRuns.push(ctx.effect.id);
      },
    });
    effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      canResume: () => false,
      run: async () => {},
    });
    const pending = api.createWorkItem({ type: 'noop', title: 'Pending', source: {} }).item;
    reducer.enqueue(pending.id, { kind: 'audit' });
    const running = api.createWorkItem({ type: 'noop', title: 'Running', source: {} }).item;
    reducer.enqueue(running.id, { kind: 'audit' });
    const runningAudit = store.listInflightEffects(running.id)[0]!;
    store.setEffectStatus(runningAudit.id, 'running');
    const redispatch = api.createWorkItem({ type: 'noop', title: 'Redispatch', source: {} }).item;
    reducer.enqueue(redispatch.id, { kind: 'start' });
    const oldRun = currentRun(store, redispatch.id);
    store.setEffectStatus(oldRun.effectId, 'running');
    const dirty = api.createWorkItem({ type: 'noop', title: 'Dirty', source: {} }).item;
    fs.writeFileSync(path.join(artifacts.repoPath(dirty.id), 'dirty.txt'), 'dirty');

    startupRecovery({ store, effects, artifacts, clock, logger, reducer });

    await waitFor(() => expect(auditRuns).toHaveLength(2));
    await waitFor(() => expect(store.getEffect(oldRun.effectId)!.status).toBe('aborted'));
    expect(store.listAssignments(redispatch.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: oldRun.assignmentId, status: 'superseded' }),
        expect.objectContaining({ replacesAssignmentId: oldRun.assignmentId }),
      ]),
    );
    expect(artifacts.isClean(dirty.id)).toBe(true);
    expect(store.listEvents(dirty.id).map((event) => event.kind)).toContain('artifact_reconciled');
    store.close();
  });
});
