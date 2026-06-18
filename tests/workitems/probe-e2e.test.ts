import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPool } from '../../src/agents/pool.js';
import type { ProgressCallbacks, RunOptions, TurnResult } from '../../src/agents/types.js';
import type { Store, Task } from '../../src/store.js';
import {
  createWorkitemsContainer,
  type WorkitemsContainer,
} from '../../src/workitems/container.js';
import type { Clock, WorkItem, WorkItemEvent } from '../../src/workitems/types.js';
import {
  createAgentRunHandler,
  type RunProgressSink,
} from '../../src/worktypes/agent-run/run-handler.js';
import { registerProbe } from '../../src/worktypes/probe/index.js';

// Full-container integration: the real container (reducer → effects → dispatch loop) drives
// the probe worktype through the real agent-run handler, with a FAKE pool standing in for
// Claude. This exercises the multi-round journey end to end (M1b plan §5.1 / WI-2), the part
// the component tests (agent-run-handler.test.ts hand-mocks the EffectContext) can't reach.

let tmpDir: string;
let now = 1000;
const clock: Clock = { now: () => now };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-probe-e2e-'));
  now = 1000;
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

type SendImpl = (
  task: Task,
  text: string,
  callbacks?: ProgressCallbacks,
  options?: RunOptions,
) => TurnResult | Promise<TurnResult>;

function fakePool(onSend: SendImpl): {
  pool: AgentPool;
  sends: Array<{ task: Task; text: string }>;
  aborts: string[];
} {
  const sends: Array<{ task: Task; text: string }> = [];
  const aborts: string[] = [];
  const pool = {
    send: async (task: Task, text: string, callbacks?: ProgressCallbacks, options?: RunOptions) => {
      sends.push({ task, text });
      return onSend(task, text, callbacks, options);
    },
    abort: (taskId: string) => {
      aborts.push(taskId);
      return true;
    },
  } as unknown as AgentPool;
  return { pool, sends, aborts };
}

// The agent-run handler only touches kernelStore.upsertTask; everything else lives in the
// workitems container store. A minimal fake keeps the kernel DB out of the picture.
function fakeKernelStore(): Store {
  return {
    upsertTask: (t: Omit<Task, 'created_at' | 'last_active_at'>) =>
      ({ ...t, created_at: 1, last_active_at: 1 }) as Task,
  } as unknown as Store;
}

// M2: the run-handler now drives a neutral RunProgressSink (replaces WI-6 onReport). This
// collector reconstructs the old { workitemId, report } view by joining onRunStart's workitemId
// with onRunEnd's outcome, so the journey assertions stay equivalent — and also captures
// failures (onRunEnd(failed)) to prove the streaming card gets its terminal notification.
function progressCollector(): {
  sink: RunProgressSink;
  reports: Array<{ workitemId: string; report: string }>;
  failures: Array<{ workitemId: string; error: string }>;
} {
  const reports: Array<{ workitemId: string; report: string }> = [];
  const failures: Array<{ workitemId: string; error: string }> = [];
  const workitemByAssignment = new Map<string, string>();
  const sink: RunProgressSink = {
    onRunStart: (i) => workitemByAssignment.set(i.assignmentId, i.workitemId),
    onText: () => {},
    onToolUse: () => {},
    onRunEnd: (i) => {
      const workitemId = workitemByAssignment.get(i.assignmentId) ?? '?';
      if (i.outcome === 'success') reports.push({ workitemId, report: i.report ?? '' });
      else if (i.outcome === 'failed') failures.push({ workitemId, error: i.error ?? '' });
    },
  };
  return { sink, reports, failures };
}

function harness(opts: {
  pool: AgentPool;
  progress: RunProgressSink;
  onCommitted?: (workitemId: string, event: WorkItemEvent) => void;
}): WorkitemsContainer {
  const container = createWorkitemsContainer({
    dbPath: path.join(tmpDir, 'workitems.sqlite'),
    workitemsDir: path.join(tmpDir, 'workitems'),
    backupsDir: path.join(tmpDir, 'backups'),
    clock,
    logger,
    onCommitted: opts.onCommitted,
    env: {
      // High heartbeat budget + no manual clock advance → the watchdog never fires here;
      // these tests are about the dispatch/event loop, not stalls (covered by noop-e2e).
      WORKITEMS_HEARTBEAT_TIMEOUT_SEC: '1000',
      WORKITEMS_RETRY_BUDGET: '1',
      WORKITEMS_MAX_OPEN: '8',
    },
  });
  registerProbe(container.registry);
  container.effects.registerHandler(
    createAgentRunHandler({
      pool: opts.pool,
      kernelStore: fakeKernelStore(),
      defaultCwd: tmpDir,
      logger,
      progress: opts.progress,
    }),
  );
  container.start();
  return container;
}

function createProbe(container: WorkitemsContainer, title: string): WorkItem {
  return container.api.createWorkItem({
    type: 'probe',
    title,
    source: { kind: 'feishu', chatId: 'c1' },
    context: {},
  }).item;
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1500;
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

describe('probe in-process e2e (WI-2/3/4/5/6)', () => {
  it('runs a full multi-round journey: create → run → idle → follow-up (prior context) → idle → close → done', async () => {
    let round = 0;
    const { pool, sends } = fakePool(() => {
      round += 1;
      return { fullText: `REPORT-${round}`, sessionId: `sess-${round}` } as TurnResult;
    });
    const { sink, reports } = progressCollector();
    const container = harness({ pool, progress: sink });

    const item = createProbe(container, '看看 src 里有几个 runner');

    // round 1 finishes → item rests idle (active, NON-terminal) → report handed to the bridge.
    await waitFor(() =>
      expect(
        container.store.listEvents(item.id).filter((e) => e.kind === 'run_completed'),
      ).toHaveLength(1),
    );
    expect(container.api.getWorkItem(item.id)!.status).toBe('active'); // idle, never terminal (S1)
    expect(reports).toEqual([{ workitemId: item.id, report: 'REPORT-1' }]);

    // follow-up while idle (path A): a fresh round that carries the prior report + the ask.
    container.api.injectHumanMessage(item.id, { text: '再确认下 codex 那条', feishuMsgId: 'm2' });
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]!.text).toContain('REPORT-1'); // prior report continued via readArtifact
    expect(sends[1]!.text).toContain('再确认下 codex 那条'); // follow-up entered the prompt

    await waitFor(() =>
      expect(
        container.store.listEvents(item.id).filter((e) => e.kind === 'run_completed'),
      ).toHaveLength(2),
    );
    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual({ workitemId: item.id, report: 'REPORT-2' });
    expect(container.api.getWorkItem(item.id)!.status).toBe('active'); // still idle

    // close (/done): the only path to a terminal state (S1 fix).
    container.api.injectClose(item.id);
    await waitFor(() => expect(container.api.getWorkItem(item.id)!.status).toBe('done'));

    // Core journey (phase_changed bookkeeping events filtered out).
    expect(
      container.store
        .listEvents(item.id)
        .map((e) => e.kind)
        .filter((k) => k !== 'phase_changed'),
    ).toEqual([
      'workitem_created',
      'run_completed',
      'human_message',
      'run_completed',
      'close_requested',
    ]);
    // report.md committed to the work item's own git repo (artifact-first, P2).
    const commitCount = Number(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], {
        cwd: container.artifacts.repoPath(item.id),
        encoding: 'utf8',
      }).trim(),
    );
    expect(commitCount).toBeGreaterThanOrEqual(2);
    container.stop();
  });

  it('absorbs a mid-run follow-up into wake_pending, then re-dispatches exactly one fresh round (path B)', async () => {
    let release!: () => void;
    const firstInFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let round = 0;
    const { pool, sends } = fakePool(async () => {
      round += 1;
      if (round === 1) {
        await firstInFlight; // hold the first round open so the follow-up lands mid-run
        return { fullText: 'REPORT-1', sessionId: 'sess-1' } as TurnResult;
      }
      return { fullText: 'REPORT-2', sessionId: 'sess-2' } as TurnResult;
    });
    const { sink, reports } = progressCollector();
    const container = harness({ pool, progress: sink });

    const item = createProbe(container, 'probe path B');

    // first round is in flight (send pending).
    await waitFor(() => expect(sends).toHaveLength(1));

    // follow-up DURING the run → absorbed as wake_pending, NOT a second concurrent run.
    container.api.injectHumanMessage(item.id, { text: '追问 B', feishuMsgId: 'm2' });
    expect(container.api.getWorkItem(item.id)!.wakePending).toBe(true);
    expect(sends).toHaveLength(1); // single-flight: no second run dispatched yet

    // let the first round finish → releaseWakePending re-dispatches exactly one round.
    release();
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]!.text).toContain('REPORT-1'); // prior report carried into the woken round
    expect(sends[1]!.text).toContain('追问 B');

    await waitFor(() =>
      expect(
        container.store.listEvents(item.id).filter((e) => e.kind === 'run_completed'),
      ).toHaveLength(2),
    );
    expect(container.api.getWorkItem(item.id)!.wakePending).toBe(false);
    expect(reports.map((r) => r.report)).toEqual(['REPORT-1', 'REPORT-2']);
    container.stop();
  });

  it('surfaces terminal failure via onRunEnd(failed) + onCommitted(run_failed), never a success report (WI-7 → M2)', async () => {
    // probe maxRetries defaults to 1 → first run_failed redispatches, the second is terminal.
    // (This is the worktype's own retry budget, NOT the harness WORKITEMS_RETRY_BUDGET, which
    // is the reducer stall path and does not gate run_failed — plan P4.)
    const { pool, sends } = fakePool(
      () => ({ fullText: '', error: 'boom: spawn failed' }) as TurnResult,
    );
    const { sink, reports, failures } = progressCollector();
    const committed: Array<{ workitemId: string; kind: string }> = [];
    const container = harness({
      pool,
      progress: sink,
      onCommitted: (workitemId, event) => committed.push({ workitemId, kind: event.kind }),
    });

    const item = createProbe(container, 'probe that fails');

    // two failed rounds (attempt + one retry) → terminal failed.
    await waitFor(() => expect(container.api.getWorkItem(item.id)!.status).toBe('failed'));

    expect(sends).toHaveLength(2);
    // onCommitted saw run_failed (the terminal one at minimum) — the bridge's failure hook source.
    expect(committed.some((c) => c.kind === 'run_failed' && c.workitemId === item.id)).toBe(true);
    // bootstrapApply's workitem_created does NOT flow through onCommitted (plan §2.1 / #3).
    expect(committed.some((c) => c.kind === 'workitem_created')).toBe(false);
    // M2: each failed round notified the streaming card (→ it patches into the error card),
    // while the success report never fired on the failure path (D3).
    expect(failures).toHaveLength(2);
    expect(failures.every((f) => f.workitemId === item.id)).toBe(true);
    expect(failures.every((f) => f.error.includes('boom: spawn failed'))).toBe(true);
    expect(reports).toEqual([]);
    container.stop();
  });
});
