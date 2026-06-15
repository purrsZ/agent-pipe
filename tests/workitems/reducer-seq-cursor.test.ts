import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { type PostCommitAction, ReducerRuntime } from '../../src/workitems/reducer.js';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { WorkitemsStore } from '../../src/workitems/store.js';
import { makeWait } from '../helpers/workitems.js';
import type {
  Clock,
  Transition,
  WorkItem,
  WorkItemEvent,
  WorkType,
} from '../../src/workitems/types.js';

// v4 #1 regression: a future work type that declares a phase transition on a
// container event (assignment_stalled) used to collide with the container's own
// audit append (assignment_retry_exhausted / wait_resolved) — both hardcoded
// event.seq+1 — tripping UNIQUE(workitem_id, seq), rolling the whole apply back
// and persisting a poison state that the watchdog re-triggers every tick.

let tmpDir: string;
const now = 1000;
const clock: Clock = { now: () => now };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-seq-cursor-test-'));
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
    cfg: loadWorkitemsConfig({ WORKITEMS_RETRY_BUDGET: '1', WORKITEMS_HUMAN_WAIT_TTL_SEC: '9' }),
    logger,
    isRunClass: (kind) => kind === 'run',
    postCommit: vi.fn<(actions: PostCommitAction[]) => void>(),
  });
  const artifacts = new ArtifactStore(path.join(tmpDir, 'workitems'), logger);
  registry.register(workType(onEvent));
  return { api: new WorkitemsApi({ store, registry, reducer, artifacts }), reducer, store };
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

function startRun(
  api: WorkitemsApi,
  reducer: ReducerRuntime,
  store: WorkitemsStore,
): {
  item: WorkItem;
  assignmentId: string;
} {
  const item = api.createWorkItem({ type: 'noop', title: 'Seq', source: {} }).item;
  reducer.enqueue(item.id, { kind: 'start' });
  const effect = store.listInflightEffects(item.id)[0]!;
  return { item, assignmentId: (effect.payload as { assignmentId: string }).assignmentId };
}

function stalledThenPhase(_item: WorkItem, ev: WorkItemEvent): Transition {
  if (ev.kind === 'start') {
    return { dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }] };
  }
  if (ev.kind === 'assignment_stalled') {
    return { phase: { to: 'noop:stalled', reason: 'stalled' } };
  }
  return {};
}

function assertSeqsUnique(store: WorkitemsStore, workitemId: string): void {
  const seqs = store.listEvents(workitemId).map((event) => event.seq);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
}

describe('apply-level event seq cursor (v4 #1)', () => {
  it('does not collide when a type adds a phase transition in the retry-exhausted branch', () => {
    const { api, reducer, store } = harness(stalledThenPhase);
    const run = startRun(api, reducer, store);
    store.updateAssignment(run.assignmentId, { retries: 1 });

    expect(() =>
      reducer.enqueue(run.item.id, {
        kind: 'assignment_stalled',
        payload: { assignmentId: run.assignmentId, reason: 'deadline_exceeded' },
      }),
    ).not.toThrow();

    const kinds = store.listEvents(run.item.id).map((event) => event.kind);
    expect(kinds).toContain('assignment_retry_exhausted');
    expect(kinds).toContain('phase_changed');
    assertSeqsUnique(store, run.item.id);
    expect(store.getWorkItem(run.item.id)!.phase).toBe('noop:stalled');
    expect(store.getAssignment(run.assignmentId)!.status).toBe('failed');
    store.close();
  });

  it('does not collide when a type adds a phase transition alongside an agent-wait resolution', () => {
    const { api, reducer, store } = harness(stalledThenPhase);
    const run = startRun(api, reducer, store);
    store.insertWait(
      makeWait('wt-agent', run.item.id, {
        kind: 'agent',
        originAssignmentId: run.assignmentId,
        deadlineAt: 1000,
      }),
    );

    expect(() =>
      reducer.enqueue(run.item.id, {
        kind: 'assignment_stalled',
        payload: {
          assignmentId: run.assignmentId,
          reason: 'agent_wait_expired',
          waitId: 'wt-agent',
        },
      }),
    ).not.toThrow();

    const kinds = store.listEvents(run.item.id).map((event) => event.kind);
    expect(kinds).toContain('wait_resolved');
    expect(kinds).toContain('phase_changed');
    assertSeqsUnique(store, run.item.id);
    expect(store.getAssignment(run.assignmentId)!.status).toBe('superseded');
    expect(store.getWait('wt-agent')!.resolveReason).toBe('origin_terminal');
    store.close();
  });
});
