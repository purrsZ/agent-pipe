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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-lifecycle-projection-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(type: WorkType): {
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
  registry.register(type);
  return {
    api: new WorkitemsApi({ store, registry, reducer, artifacts }),
    reducer,
    store,
  };
}

function workType(
  onEvent: (item: WorkItem, ev: WorkItemEvent) => Transition,
  initialPhase = 'noop:idle',
): WorkType {
  return {
    id: 'noop',
    triggers: { api: true },
    initialPhase: () => initialPhase,
    onEvent,
    isDecisionStale: () => false,
    topology: () => 'solo',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: true },
  };
}

function dispatch(): Transition {
  return { dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }] };
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
    },
  });
}

describe('workitem lifecycle projection integration', () => {
  it('drives open to active to waiting to active to done from authoritative rows', () => {
    let completions = 0;
    const { api, reducer, store } = harness(
      workType((_item, ev) => {
        if (ev.kind === 'start')
          return { phase: { to: 'noop:running', reason: 'start' }, ...dispatch() };
        if (ev.kind === 'resume')
          return { phase: { to: 'noop:running', reason: 'resume' }, ...dispatch() };
        if (ev.kind === 'run_completed') {
          completions += 1;
          if (completions === 1) {
            return {
              phase: { to: 'noop:waiting', reason: 'cooldown' },
              waits: [{ kind: 'timer', reason: 'cooldown', deadlineTtlSec: 60 }],
            };
          }
          return { phase: { to: 'noop:done', reason: 'complete' }, terminal: 'done' };
        }
        return {};
      }),
    );
    const item = api.createWorkItem({ type: 'noop', title: 'Lifecycle', source: {} }).item;
    expect(store.getWorkItem(item.id)!.status).toBe('open');

    reducer.enqueue(item.id, { kind: 'start' });
    expect(store.getWorkItem(item.id)).toMatchObject({ status: 'active', phase: 'noop:running' });

    completeRun(reducer, item.id, currentRun(store, item.id));
    const timerWait = store.listOpenWaits(item.id)[0]!;
    expect(store.getWorkItem(item.id)).toMatchObject({
      status: 'waiting',
      statusDetail: 'timer',
      phase: 'noop:waiting',
    });

    store.updateWait(timerWait.id, {
      resolvedAt: 2000,
      resolvedBy: 'test',
      resolveReason: 'done',
    });
    reducer.enqueue(item.id, { kind: 'resume' });
    expect(store.getWorkItem(item.id)).toMatchObject({ status: 'active', phase: 'noop:running' });

    completeRun(reducer, item.id, currentRun(store, item.id));
    expect(store.getWorkItem(item.id)).toMatchObject({ status: 'done', phase: 'noop:done' });
    store.close();
  });

  it('keeps human wait status while execution continues and assignments finish', () => {
    const { api, reducer, store } = harness(
      workType((_item, ev) => {
        if (ev.kind === 'need_human') {
          return { waits: [{ kind: 'human', reason: 'review', deadlineTtlSec: 60 }] };
        }
        if (ev.kind === 'dispatch_anyway') return dispatch();
        return {};
      }),
    );
    const item = api.createWorkItem({ type: 'noop', title: 'Human priority', source: {} }).item;
    reducer.enqueue(item.id, { kind: 'need_human' });
    expect(store.getWorkItem(item.id)).toMatchObject({ status: 'waiting', statusDetail: 'human' });

    reducer.enqueue(item.id, { kind: 'dispatch_anyway' });
    expect(store.listAssignments(item.id)).toHaveLength(1);
    expect(store.getWorkItem(item.id)).toMatchObject({ status: 'waiting', statusDetail: 'human' });

    completeRun(reducer, item.id, currentRun(store, item.id));
    expect(store.listAssignments(item.id)[0]!.status).toBe('done');
    expect(store.getWorkItem(item.id)).toMatchObject({ status: 'waiting', statusDetail: 'human' });
    store.close();
  });

  it('accepts phase rollback and appends a phase_changed audit event', () => {
    const { api, reducer, store } = harness(
      workType(
        (_item, ev) =>
          ev.kind === 'rewind' ? { phase: { to: 'phase:a', reason: 'backtrack' } } : {},
        'phase:b',
      ),
    );
    const item = api.createWorkItem({ type: 'noop', title: 'Phase rollback', source: {} }).item;

    reducer.enqueue(item.id, { kind: 'rewind' });

    expect(store.getWorkItem(item.id)!.phase).toBe('phase:a');
    expect(store.listEvents(item.id).map((event) => event.kind)).toEqual([
      'workitem_created',
      'rewind',
      'phase_changed',
    ]);
    expect(store.listEvents(item.id)[2]!.payload).toEqual({
      from: 'phase:b',
      to: 'phase:a',
      reason: 'backtrack',
    });
    store.close();
  });

  it('round-trips non-ASCII phase strings byte-for-byte', () => {
    const phase = '阶段:β→完成';
    const { api, reducer, store } = harness(
      workType((_item, ev) =>
        ev.kind === 'unicode' ? { phase: { to: phase, reason: 'utf8' } } : {},
      ),
    );
    const item = api.createWorkItem({ type: 'noop', title: 'Unicode phase', source: {} }).item;

    reducer.enqueue(item.id, { kind: 'unicode' });

    const stored = store.getWorkItem(item.id)!.phase;
    expect(stored).toBe(phase);
    expect(Buffer.from(stored, 'utf8')).toEqual(Buffer.from(phase, 'utf8'));
    store.close();
  });
});
