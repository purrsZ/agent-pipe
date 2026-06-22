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
import type { Transition, WorkItem, WorkItemEvent, WorkType } from '../../src/workitems/types.js';

// ── Stage 1 regression: container-concurrency (owner-workers topology). ───────────
// Verifies the single-flight gate role split, per-assignment inflight + abort, the
// parent chain, the worker concurrency cap, and per-assignment crash recovery — while
// solo topology stays byte-for-byte unchanged (covered by the existing probe/noop suite).

let tmpDir: string;
let seq = 0;
const clock = { now: () => 1000 };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// Controllable run handler state (reset per test).
let started: string[] = [];
let blockMode: 'none' | 'workers' | 'all' = 'none';
let canResume = false;
let gate: { promise: Promise<void>; resolve: () => void };
const live: Array<{ store: WorkitemsStore; effects: EffectRuntime }> = [];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-owner-workers-'));
  vi.clearAllMocks();
  started = [];
  blockMode = 'none';
  canResume = false;
  gate = deferred();
});

afterEach(async () => {
  // Quiesce every harness before closing its DB: stop intake (future pokes no-op),
  // abort in-flight handlers (they unwind on signal without touching the store), then
  // let the abort microtasks settle so no conclusion lands on a closed connection.
  const harnesses = live.splice(0);
  for (const h of harnesses) {
    h.effects.stopIntake();
    h.effects.abortInflight();
  }
  await new Promise((r) => setTimeout(r, 10));
  for (const h of harnesses) h.store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

type OnEvent = (item: WorkItem, ev: WorkItemEvent) => Transition;

function ownerWorkersType(onEvent: OnEvent): WorkType {
  return {
    id: 'ow',
    triggers: { api: true },
    initialPhase: () => 'ow:start',
    onEvent,
    isDecisionStale: () => false,
    topology: () => 'owner-workers',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: true },
  };
}

function harness(opts: { onEvent: OnEvent; maxWorkers?: number; autoPoke?: boolean }) {
  seq += 1;
  const store = new WorkitemsStore(path.join(tmpDir, `wi-${seq}.sqlite`), clock);
  const registry = new WorkTypeRegistry();
  let effects: EffectRuntime | undefined;
  const reducer = new ReducerRuntime({
    store,
    registry,
    clock,
    cfg: loadWorkitemsConfig({
      WORKITEMS_MAX_OPEN: '8',
      WORKITEMS_MAX_WORKERS_PER_ITEM: String(opts.maxWorkers ?? 2),
      WORKITEMS_RETRY_BUDGET: '1',
    }),
    logger,
    isRunClass: (kind) => effects?.isRunClass(kind) ?? kind === 'run',
    postCommit: (actions) => {
      for (const a of actions) {
        if (a.kind === 'abort_effect') effects?.abort(a.effectId, a.reason);
        else effects?.poke(a.workitemId);
      }
    },
  });
  const artifacts = new ArtifactStore(path.join(tmpDir, `art-${seq}`), logger);
  effects = new EffectRuntime({ store, reducer, registry, artifacts, clock, logger });
  registry.register(ownerWorkersType(opts.onEvent));
  effects.registerHandler({
    kind: 'run',
    recovery: 'resume-or-redispatch',
    canResume: () => canResume,
    run: runControlled,
    resume: runControlled,
  });
  const api = new WorkitemsApi({
    store,
    registry,
    reducer,
    artifacts,
    afterCreate: opts.autoPoke === false ? undefined : (item) => effects?.poke(item.id),
  });
  live.push({ store, effects });
  return { store, reducer, effects, artifacts, api };
}

function shouldBlock(role: string): boolean {
  return blockMode === 'all' || (blockMode === 'workers' && role === 'worker');
}

async function runControlled(ctx: EffectContext): Promise<void> {
  const a = ctx.assignment;
  if (!a) throw new Error('missing assignment');
  started.push(a.id);
  ctx.heartbeat();
  if (shouldBlock(a.role)) {
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) return resolve();
      const onAbort = () => resolve();
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      void gate.promise.then(() => {
        ctx.signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }
  if (ctx.signal.aborted) return;
  ctx.writeArtifact(`assignments/${a.id}/report.md`, `ok ${a.id}`, 'report');
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('waitFor timed out');
}

// onEvent: creation → one owner; owner run_completed → N workers parented to the owner.
function ownerThenWorkers(n: number): OnEvent {
  return (_item, ev) => {
    if (ev.kind === 'workitem_created') {
      return { dispatch: [{ role: 'owner', deadlineTtlSec: 60, wallclockCapSec: 30 }] };
    }
    if (ev.kind === 'run_completed' && (ev.payload as { role?: string }).role === 'owner') {
      const owner = (ev.payload as { assignmentId: string }).assignmentId;
      return {
        dispatch: Array.from({ length: n }, () => ({
          role: 'worker' as const,
          deadlineTtlSec: 60,
          wallclockCapSec: 30,
          parentAssignmentId: owner,
        })),
      };
    }
    return {};
  };
}

function dispatchRoles(roles: Array<'owner' | 'worker'>): OnEvent {
  return (_item, ev) =>
    ev.kind === 'workitem_created'
      ? { dispatch: roles.map((role) => ({ role, deadlineTtlSec: 60, wallclockCapSec: 30 })) }
      : {};
}

describe('container-concurrency: owner-workers topology', () => {
  it('runs workers concurrently (not serialised by single-flight) and writes the parent chain', async () => {
    blockMode = 'workers';
    const { api, store } = harness({ onEvent: ownerThenWorkers(2) });
    const item = api.createWorkItem({ type: 'ow', title: 'fan-out', source: {} }).item;

    // owner runs then completes; two workers fan out and both reach 'running' at once.
    await waitFor(() => {
      const running = store.listInflightEffects(item.id).filter((e) => e.status === 'running');
      expect(running).toHaveLength(2);
    });
    expect(store.countRunningWorkers(item.id)).toBe(2);

    const workers = store.listAssignments(item.id).filter((a) => a.role === 'worker');
    expect(workers).toHaveLength(2);
    const owner = store.listAssignments(item.id).find((a) => a.role === 'owner')!;
    for (const w of workers) expect(w.parentId).toBe(owner.id);
    expect(store.listAssignmentsByParent(owner.id)).toHaveLength(2);

    // release both — they conclude independently and the workitem drains.
    gate.resolve();
    await waitFor(() => expect(store.listInflightEffects(item.id)).toHaveLength(0));
  });

  it('caps concurrent workers at maxWorkersPerItem; the surplus is parked wakePending', async () => {
    blockMode = 'workers';
    const { api, store } = harness({
      onEvent: dispatchRoles(['worker', 'worker', 'worker']),
      maxWorkers: 2,
    });
    const item = api.createWorkItem({ type: 'ow', title: 'cap', source: {} }).item;

    await waitFor(() => expect(store.countRunningWorkers(item.id)).toBe(2));
    // Only two assignments were created — the third dispatch parked as wakePending.
    expect(store.listAssignments(item.id).filter((a) => a.role === 'worker')).toHaveLength(2);
    expect(store.getWorkItem(item.id)!.wakePending).toBe(true);
  });

  it('owner run is single-flight (a second owner dispatch parks wakePending)', async () => {
    blockMode = 'all'; // keep owners from completing so we can observe the cap
    const { api, store } = harness({ onEvent: dispatchRoles(['owner', 'owner']) });
    const item = api.createWorkItem({ type: 'ow', title: 'owner-sf', source: {} }).item;

    await waitFor(() => expect(store.countRunningByRole(item.id, 'owner')).toBe(1));
    expect(store.listAssignments(item.id).filter((a) => a.role === 'owner')).toHaveLength(1);
    expect(store.getWorkItem(item.id)!.wakePending).toBe(true);
  });

  it('aborts one worker per-assignment without touching its sibling', async () => {
    blockMode = 'workers';
    const { api, effects, store } = harness({ onEvent: ownerThenWorkers(2) });
    const item = api.createWorkItem({ type: 'ow', title: 'abort-one', source: {} }).item;

    await waitFor(() =>
      expect(store.listInflightEffects(item.id).filter((e) => e.status === 'running')).toHaveLength(
        2,
      ),
    );
    const running = store.listInflightEffects(item.id).filter((e) => e.status === 'running');
    const victim = running[0]!;
    const survivor = running[1]!;

    effects.abort(victim.id, 'test_abort');

    // victim's effect ends aborted; the sibling keeps running untouched.
    await waitFor(() => expect(store.getEffect(victim.id)!.status).toBe('aborted'));
    expect(store.getEffect(survivor.id)!.status).toBe('running');
    const survivorAssignment = (survivor.payload as { assignmentId: string }).assignmentId;
    expect(store.getAssignment(survivorAssignment)!.status).toBe('running');
  });

  it('recovers EVERY worker on the same workitem (not just the first) — R23.AC-4', async () => {
    const { store, effects, reducer, artifacts } = harness({
      onEvent: dispatchRoles(['worker', 'worker']),
      autoPoke: false,
    });
    canResume = false;
    const item = reducer.bootstrapApply({ type: 'ow', title: 'recover-all', source: {} }).item;

    // Two pending worker run effects were dispatched on creation (no poke yet).
    const effs = store.listInflightEffects(item.id);
    expect(effs).toHaveLength(2);
    // Simulate a crash mid-run: both effects were 'running' when the process died.
    for (const e of effs) store.setEffectStatus(e.id, 'running');
    const originals = effs.map((e) => (e.payload as { assignmentId: string }).assignmentId);

    startupRecovery({ store, effects, artifacts, clock, logger, reducer });

    // Both originals must be superseded + redispatched — the pre-fix bug recovered only
    // the first because the inflight guard was keyed by workitemId.
    await waitFor(() => {
      for (const id of originals) expect(store.getAssignment(id)!.status).toBe('superseded');
    });
    const replacements = store
      .listAssignments(item.id)
      .filter((a) => a.replacesAssignmentId !== null);
    expect(replacements.map((a) => a.replacesAssignmentId).sort()).toEqual([...originals].sort());
  });
});

describe('checkpoint-gate enabler: resolveWait carries a decision', () => {
  it('rides the decision through to the wait_resolved event payload', () => {
    const onEvent: OnEvent = (_item, ev) =>
      ev.kind === 'workitem_created'
        ? { waits: [{ kind: 'human', reason: 'checkpoint:requirement:合同', deadlineTtlSec: 600 }] }
        : {};
    const { api, store } = harness({ onEvent });
    const item = api.createWorkItem({ type: 'ow', title: 'decision', source: {} }).item;
    const wait = store.listOpenWaits(item.id)[0]!;

    const result = api.resolveWait(wait.id, {
      operator: 'lichao',
      reason: 'approve',
      decision: { approved: true, payload: { fingerprint: 'abc123' } },
    });
    expect(result).toEqual({ resolved: true });

    const resolved = store.listEvents(item.id).find((e) => e.kind === 'wait_resolved')!;
    expect(resolved.payload).toMatchObject({
      waitId: wait.id,
      operator: 'lichao',
      decision: { approved: true, payload: { fingerprint: 'abc123' } },
    });
  });
});
