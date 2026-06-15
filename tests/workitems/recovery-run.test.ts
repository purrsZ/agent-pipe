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
import type { Clock, Transition, WorkItem, WorkType } from '../../src/workitems/types.js';

let tmpDir: string;
const clock: Clock = { now: () => 1000 };
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-recovery-run-test-'));
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
  registry.register(workType());
  return {
    api: new WorkitemsApi({ store, registry, reducer, artifacts }),
    reducer,
    effects,
    store,
    artifacts,
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
      return {};
    },
    isDecisionStale: () => false,
    topology: () => 'solo',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: false },
  };
}

function startRunningRun(
  api: WorkitemsApi,
  reducer: ReducerRuntime,
  store: WorkitemsStore,
): {
  item: WorkItem;
  assignmentId: string;
  effectId: number;
} {
  const item = api.createWorkItem({ type: 'noop', title: 'Run recovery', source: {} }).item;
  reducer.enqueue(item.id, { kind: 'start' });
  const effect = store.listInflightEffects(item.id)[0]!;
  const assignmentId = (effect.payload as { assignmentId: string }).assignmentId;
  store.setEffectStatus(effect.id, 'running');
  return { item, assignmentId, effectId: effect.id };
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

describe('startupRecovery run-class recovery and artifact reconciliation', () => {
  it('resumes a running run effect when canResume is true', async () => {
    const { api, reducer, effects, store, artifacts } = harness();
    const resumed: string[] = [];
    effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      canResume: (_payload, assignment) => assignment?.agentSessionId === 'session-1',
      resume: async (ctx) => {
        resumed.push(ctx.assignment!.id);
      },
      run: async () => {
        throw new Error('should resume, not rerun');
      },
    });
    const run = startRunningRun(api, reducer, store);
    store.updateAssignment(run.assignmentId, { agentSessionId: 'session-1' });

    startupRecovery({ store, effects, artifacts, clock, logger, reducer });

    await waitFor(() => expect(store.getEffect(run.effectId)!.status).toBe('done'));
    expect(resumed).toEqual([run.assignmentId]);
    expect(store.listAssignments(run.item.id)).toHaveLength(1);
    expect(store.getWorkItem(run.item.id)!.status).toBe('done');
    store.close();
  });

  it('aborts and redispatches a running run effect when canResume is false', async () => {
    const { api, reducer, effects, store, artifacts } = harness();
    effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      canResume: () => false,
      run: async () => {
        throw new Error('should abort for redispatch');
      },
    });
    const run = startRunningRun(api, reducer, store);

    startupRecovery({ store, effects, artifacts, clock, logger, reducer });

    await waitFor(() => expect(store.getEffect(run.effectId)!.status).toBe('aborted'));
    const assignments = [...store.listAssignments(run.item.id)].sort(
      (a, b) => a.createdAt - b.createdAt || a.basedOnSeq - b.basedOnSeq,
    );
    expect(assignments).toHaveLength(2);
    expect(assignments[0]).toMatchObject({ id: run.assignmentId, status: 'superseded' });
    expect(assignments[1]).toMatchObject({
      status: 'running',
      replacesAssignmentId: run.assignmentId,
      retries: 1,
    });
    expect(store.listInflightEffects(run.item.id)).toEqual([
      expect.objectContaining({ kind: 'run', status: 'pending' }),
    ]);
    expect(store.listEvents(run.item.id).map((event) => event.kind)).toContain('effect_aborted');
    store.close();
  });

  it('aborts a running run whose assignment is no longer running, never resuming it (v4 #8)', async () => {
    const { api, reducer, effects, store, artifacts } = harness();
    const resumeSpy = vi.fn();
    const runSpy = vi.fn();
    effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      canResume: () => true,
      resume: async () => {
        resumeSpy();
      },
      run: async () => {
        runSpy();
      },
    });
    const run = startRunningRun(api, reducer, store);
    // The stall already superseded the assignment (committed) but the post-commit
    // abort never ran before the crash; a session id would otherwise pass canResume.
    store.updateAssignment(run.assignmentId, {
      status: 'superseded',
      endedAt: 1500,
      agentSessionId: 'session-1',
    });

    startupRecovery({ store, effects, artifacts, clock, logger, reducer });

    await waitFor(() => expect(store.getEffect(run.effectId)!.status).toBe('aborted'));
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
    expect(store.listEvents(run.item.id).map((event) => event.kind)).toContain('effect_aborted');
    // effect_aborted on a non-running assignment is inert — no double redispatch.
    expect(store.listAssignments(run.item.id)).toHaveLength(1);
    store.close();
  });

  it('commits dirty artifact repositories and emits artifact_reconciled', () => {
    const { api, store, artifacts, effects, reducer } = harness();
    const item = api.createWorkItem({ type: 'noop', title: 'Dirty artifact', source: {} }).item;
    const dirtyPath = path.join(artifacts.repoPath(item.id), 'orphan.txt');
    fs.writeFileSync(dirtyPath, 'not committed');
    expect(artifacts.isClean(item.id)).toBe(false);

    startupRecovery({ store, effects, artifacts, clock, logger, reducer });

    expect(artifacts.isClean(item.id)).toBe(true);
    expect(store.listEvents(item.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'artifact_reconciled',
          payload: { result: 'committed' },
        }),
      ]),
    );
    store.close();
  });

  it('recreates missing artifact repositories and emits artifact_reconciled', () => {
    const { api, store, artifacts, effects, reducer } = harness();
    const item = api.createWorkItem({ type: 'noop', title: 'Missing artifact', source: {} }).item;
    fs.rmSync(artifacts.repoPath(item.id), { recursive: true, force: true });

    startupRecovery({ store, effects, artifacts, clock, logger, reducer });

    expect(fs.existsSync(path.join(artifacts.repoPath(item.id), '.git'))).toBe(true);
    expect(store.listEvents(item.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'artifact_reconciled',
          payload: { result: 'recreated' },
        }),
      ]),
    );
    store.close();
  });
});
