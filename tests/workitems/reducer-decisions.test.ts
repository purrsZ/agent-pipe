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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-reducer-decisions-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(options: {
  onEvent?: (item: WorkItem, ev: WorkItemEvent) => Transition;
  isDecisionStale?: (decision: Decision, eventsSince: WorkItemEvent[]) => boolean;
}): {
  api: WorkitemsApi;
  reducer: ReducerRuntime;
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
  });
  const artifacts = new ArtifactStore(path.join(tmpDir, 'workitems'), logger);
  registry.register(workType(options));
  return {
    api: new WorkitemsApi({ store, registry, reducer, artifacts }),
    reducer,
    store,
    artifacts,
  };
}

function workType(options: {
  onEvent?: (item: WorkItem, ev: WorkItemEvent) => Transition;
  isDecisionStale?: (decision: Decision, eventsSince: WorkItemEvent[]) => boolean;
}): WorkType {
  return {
    id: 'noop',
    triggers: { api: true },
    initialPhase: () => 'noop:idle',
    onEvent:
      options.onEvent ??
      ((_item, ev) => {
        if (ev.kind === 'start') {
          return { dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }] };
        }
        if (ev.kind === 'run_completed') {
          return { phase: { to: 'noop:done', reason: 'complete' }, terminal: 'done' };
        }
        return {};
      }),
    isDecisionStale: options.isDecisionStale ?? (() => false),
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
  const item = api.createWorkItem({ type: 'noop', title: 'Decision', source: {} }).item;
  reducer.enqueue(item.id, { kind: 'start' });
  const assignment = store.listAssignments(item.id)[0]!;
  const effect = store.listInflightEffects(item.id)[0]!;
  return { item, assignmentId: assignment.id, effectId: effect.id, basedOnSeq: effect.seq };
}

function discardPayload(events: WorkItemEvent[]): unknown {
  return events.find((event) => event.kind === 'decision_discarded')?.payload;
}

describe('ReducerRuntime decision checks', () => {
  it('discards run_completed when the referenced assignment was superseded without deleting artifacts', () => {
    const runCompletedApplied = vi.fn();
    const { api, reducer, store, artifacts } = harness({
      onEvent: (_item, ev) => {
        if (ev.kind === 'start') {
          return { dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }] };
        }
        if (ev.kind === 'run_completed') {
          runCompletedApplied();
          return { phase: { to: 'noop:done', reason: 'should-not-apply' }, terminal: 'done' };
        }
        return {};
      },
    });
    const run = startRun(api, reducer, store);
    artifacts.writeFile(run.item.id, 'assignments/report.md', 'kept', 'decision output');
    store.updateAssignment(run.assignmentId, { status: 'superseded', endedAt: 1500 });

    reducer.enqueue(run.item.id, {
      kind: 'run_completed',
      payload: {
        assignmentId: run.assignmentId,
        effectId: run.effectId,
        basedOnSeq: run.basedOnSeq,
      },
    });

    expect(runCompletedApplied).not.toHaveBeenCalled();
    expect(store.getWorkItem(run.item.id)!.phase).toBe('noop:idle');
    expect(store.getWorkItem(run.item.id)!.status).not.toBe('done');
    expect(discardPayload(store.listEvents(run.item.id))).toMatchObject({
      reason: 'assignment_superseded',
      assignmentId: run.assignmentId,
      effectId: run.effectId,
      basedOnSeq: run.basedOnSeq,
    });
    expect(artifacts.readFile(run.item.id, 'assignments/report.md')).toBe('kept');
    store.close();
  });

  it('discards decisions that reference an already resolved wait', () => {
    const staleSpy = vi.fn(() => false);
    const { api, reducer, store } = harness({
      isDecisionStale: staleSpy,
      onEvent: (_item, ev) => {
        if (ev.kind === 'start') {
          return {
            dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }],
            waits: [{ kind: 'human', reason: 'review', deadlineTtlSec: 60 }],
          };
        }
        if (ev.kind === 'run_completed') return { terminal: 'done' };
        return {};
      },
    });
    const run = startRun(api, reducer, store);
    const wait = store.listOpenWaits(run.item.id)[0]!;
    store.updateWait(wait.id, { resolvedAt: 2000, resolvedBy: 'user', resolveReason: 'done' });

    reducer.enqueue(run.item.id, {
      kind: 'run_completed',
      payload: {
        assignmentId: run.assignmentId,
        effectId: run.effectId,
        basedOnSeq: run.basedOnSeq,
        decision: { refs: { waitIds: [wait.id] } },
      },
    });

    expect(staleSpy).not.toHaveBeenCalled();
    expect(discardPayload(store.listEvents(run.item.id))).toMatchObject({
      reason: 'wait_resolved',
      waitId: wait.id,
      effectId: run.effectId,
    });
    expect(store.getWorkItem(run.item.id)!.status).not.toBe('done');
    expect(store.getAssignment(run.assignmentId)).toMatchObject({
      status: 'superseded',
      endedAt: 1000,
    });
    store.close();
  });

  it('does not rewrite an already aborted effect when a late conclusion arrives', () => {
    const staleSpy = vi.fn(() => false);
    const { api, reducer, store } = harness({ isDecisionStale: staleSpy });
    const run = startRun(api, reducer, store);
    store.setEffectStatus(run.effectId, 'aborted');

    reducer.enqueue(run.item.id, {
      kind: 'run_completed',
      payload: {
        assignmentId: run.assignmentId,
        effectId: run.effectId,
        basedOnSeq: run.basedOnSeq,
      },
    });

    expect(staleSpy).not.toHaveBeenCalled();
    expect(store.getEffect(run.effectId)!.status).toBe('aborted');
    expect(discardPayload(store.listEvents(run.item.id))).toMatchObject({
      reason: 'effect_aborted',
      assignmentId: run.assignmentId,
      effectId: run.effectId,
    });
    store.close();
  });

  it('calls isDecisionStale only after structural checks pass with the open event interval', () => {
    let staleDecision: Decision | undefined;
    let staleEvents: WorkItemEvent[] | undefined;
    const staleSpy = vi.fn((decision: Decision, eventsSince: WorkItemEvent[]) => {
      staleDecision = decision;
      staleEvents = eventsSince;
      return true;
    });
    const { api, reducer, store } = harness({ isDecisionStale: staleSpy });
    const run = startRun(api, reducer, store);
    reducer.enqueue(run.item.id, { kind: 'noise_1' });
    reducer.enqueue(run.item.id, { kind: 'noise_2' });

    reducer.enqueue(run.item.id, {
      kind: 'run_completed',
      payload: {
        assignmentId: run.assignmentId,
        effectId: run.effectId,
        basedOnSeq: run.basedOnSeq,
        decision: { data: { ok: true } },
      },
    });

    expect(staleSpy).toHaveBeenCalledTimes(1);
    expect(staleDecision).toEqual({ data: { ok: true } });
    expect(staleEvents?.map((event) => [event.seq, event.kind])).toEqual([
      [3, 'noise_1'],
      [4, 'noise_2'],
    ]);
    expect(discardPayload(store.listEvents(run.item.id))).toMatchObject({
      reason: 'semantically_stale',
      effectId: run.effectId,
      basedOnSeq: run.basedOnSeq,
    });
    expect(store.getWorkItem(run.item.id)!.status).not.toBe('done');
    store.close();
  });

  it('allows a noop-stale decision to apply even when seq advanced after basedOnSeq', () => {
    const staleSpy = vi.fn(() => false);
    const { api, reducer, store } = harness({ isDecisionStale: staleSpy });
    const run = startRun(api, reducer, store);
    reducer.enqueue(run.item.id, { kind: 'noise' });

    reducer.enqueue(run.item.id, {
      kind: 'run_completed',
      payload: {
        assignmentId: run.assignmentId,
        effectId: run.effectId,
        basedOnSeq: run.basedOnSeq,
        decision: { data: { ok: true } },
      },
    });

    expect(staleSpy).toHaveBeenCalledTimes(1);
    expect(store.listEvents(run.item.id).map((event) => event.kind)).not.toContain(
      'decision_discarded',
    );
    expect(store.getEffect(run.effectId)!.status).toBe('done');
    expect(store.getWorkItem(run.item.id)).toMatchObject({ status: 'done', phase: 'noop:done' });
    store.close();
  });

  it('rejects a run conclusion missing its effectId instead of acting on it (v4 #5)', () => {
    const { api, reducer, store } = harness({});
    const run = startRun(api, reducer, store);

    reducer.enqueue(run.item.id, {
      kind: 'run_completed',
      payload: { assignmentId: run.assignmentId, basedOnSeq: run.basedOnSeq },
    });

    const kinds = store.listEvents(run.item.id).map((event) => event.kind);
    expect(kinds).toContain('conclusion_rejected');
    expect(kinds).not.toContain('run_completed');
    // No state was mutated off a malformed payload: effect stays pending, item active.
    expect(store.getEffect(run.effectId)!.status).toBe('pending');
    expect(store.getWorkItem(run.item.id)!.status).not.toBe('done');
    expect(logger.warn).toHaveBeenCalled();
    store.close();
  });

  it("rejects a conclusion referencing another workitem's effect/assignment (v4 #7)", () => {
    const { api, reducer, store } = harness({});
    const victim = startRun(api, reducer, store);
    const attacker = startRun(api, reducer, store);

    // A conclusion enqueued to the attacker item names the victim's effect/assignment.
    reducer.enqueue(attacker.item.id, {
      kind: 'run_completed',
      payload: {
        assignmentId: victim.assignmentId,
        effectId: victim.effectId,
        basedOnSeq: victim.basedOnSeq,
      },
    });

    const attackerEvents = store.listEvents(attacker.item.id).map((event) => event.kind);
    expect(attackerEvents).toContain('conclusion_rejected');
    // The victim's rows are untouched — no cross-item terminal-ization.
    expect(store.getEffect(victim.effectId)!.status).toBe('pending');
    expect(store.getAssignment(victim.assignmentId)!.status).toBe('running');
    store.close();
  });
});
