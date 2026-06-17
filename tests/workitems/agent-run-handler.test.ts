import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentPool } from '../../src/agents/pool.js';
import type { ProgressCallbacks, RunOptions, TurnResult } from '../../src/agents/types.js';
import type { Store, Task } from '../../src/store.js';
import type { EffectContext } from '../../src/workitems/effects.js';
import type { Effect, WorkItemEvent } from '../../src/workitems/types.js';
import { createAgentRunHandler } from '../../src/worktypes/agent-run/run-handler.js';
import { makeAssignment, makeWorkItem } from '../helpers/workitems.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-agent-run-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface CtxRecord {
  ctx: EffectContext;
  writes: Array<{ relPath: string; content: string }>;
  sessionIds: string[];
  heartbeats: number;
  controller: AbortController;
}

function makeCtx(opts: {
  workitemRepos?: string[];
  assignmentSession?: string | null;
  batch?: WorkItemEvent[];
  artifacts?: Record<string, string>;
}): CtxRecord {
  const controller = new AbortController();
  const writes: Array<{ relPath: string; content: string }> = [];
  const sessionIds: string[] = [];
  let heartbeats = 0;
  const workitem = makeWorkItem('wi-1', {
    type: 'probe',
    title: '看看 src 里有几个 runner',
    repos: opts.workitemRepos ?? [],
  });
  const assignment = makeAssignment('as-1', 'wi-1', {
    agentSessionId: opts.assignmentSession ?? null,
  });
  const effect: Effect = {
    id: 1,
    workitemId: 'wi-1',
    seq: 5,
    kind: 'run',
    payload: { assignmentId: 'as-1' },
    status: 'running',
    createdAt: 1000,
    updatedAt: 1000,
  };
  const ctx: EffectContext = {
    effect,
    workitem,
    assignment,
    signal: controller.signal,
    clock: { now: () => 1000 },
    logger: {},
    batchFromSeq: 0,
    heartbeat: () => {
      heartbeats += 1;
    },
    eventsSince: () => opts.batch ?? [],
    setAgentSessionId: (id) => sessionIds.push(id),
    writeArtifact: (relPath, content) => writes.push({ relPath, content }),
    readArtifact: (relPath) => opts.artifacts?.[relPath],
    emit: () => {},
  };
  return {
    ctx,
    writes,
    sessionIds,
    get heartbeats() {
      return heartbeats;
    },
    controller,
  } as CtxRecord & { heartbeats: number };
}

function fakePool(
  onSend: (
    task: Task,
    text: string,
    callbacks?: ProgressCallbacks,
    options?: RunOptions,
  ) => TurnResult,
): {
  pool: AgentPool;
  sends: Array<{ task: Task; text: string; options?: RunOptions }>;
  aborts: string[];
} {
  const sends: Array<{ task: Task; text: string; options?: RunOptions }> = [];
  const aborts: string[] = [];
  const pool = {
    send: async (task: Task, text: string, callbacks?: ProgressCallbacks, options?: RunOptions) => {
      sends.push({ task, text, options });
      return onSend(task, text, callbacks, options);
    },
    abort: (taskId: string) => {
      aborts.push(taskId);
      return true;
    },
  } as unknown as AgentPool;
  return { pool, sends, aborts };
}

function fakeStore(): { store: Store; upserts: Task[] } {
  const upserts: Task[] = [];
  const store = {
    upsertTask: (t: Omit<Task, 'created_at' | 'last_active_at'>) => {
      const row = { ...t, created_at: 1, last_active_at: 1 } as Task;
      upserts.push(row);
      return row;
    },
  } as unknown as Store;
  return { store, upserts };
}

describe('agent-run handler (WI-2)', () => {
  it('canResume is false (M1b redispatches on crash)', () => {
    const { pool } = fakePool(() => ({ fullText: '', sessionId: '' }) as TurnResult);
    const { store } = fakeStore();
    const handler = createAgentRunHandler({ pool, kernelStore: store, defaultCwd: tmpDir });
    expect(handler.canResume?.(undefined, undefined, makeWorkItem('wi-1'))).toBe(false);
  });

  it('drives pool.send with a managed shadow task, readonly profile, and writes report.md', async () => {
    const { pool, sends } = fakePool((_t, _text, callbacks) => {
      callbacks?.onText?.('tid', 'partial'); // exercise heartbeat bridge
      return { fullText: 'REPORT BODY', sessionId: 'sess-1' } as TurnResult;
    });
    const { store, upserts } = fakeStore();
    const rec = makeCtx({});
    const handler = createAgentRunHandler({ pool, kernelStore: store, defaultCwd: tmpDir });

    await handler.run(rec.ctx);

    // shadow task
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      id: 'managed:as-1',
      owner_kind: 'managed',
      agent_kind: 'claude',
      agent_session_id: null,
      cwd: tmpDir,
    });
    // readonly profile + prompt carries the title
    expect(sends[0]?.options?.permission?.mode).toBe('readonly');
    expect(sends[0]?.text).toContain('看看 src 里有几个 runner');
    // heartbeat fired from onText
    expect((rec as unknown as { heartbeats: number }).heartbeats).toBeGreaterThan(0);
    // outputs: session recorded + report written
    expect(rec.sessionIds).toEqual(['sess-1']);
    const report = rec.writes.find((w) => w.relPath === 'assignments/as-1/report.md');
    expect(report?.content).toBe('REPORT BODY');
  });

  it('uses workitem.repos[0] as cwd when present', async () => {
    const repoDir = path.join(tmpDir, 'repo');
    const { pool } = fakePool(() => ({ fullText: 'r', sessionId: 's' }) as TurnResult);
    const { store, upserts } = fakeStore();
    const rec = makeCtx({ workitemRepos: [repoDir] });
    const handler = createAgentRunHandler({ pool, kernelStore: store, defaultCwd: tmpDir });
    await handler.run(rec.ctx);
    expect(upserts[0]?.cwd).toBe(repoDir);
    expect(fs.existsSync(repoDir)).toBe(true); // mkdir'd
  });

  it('throws on result.error so effects.ts emits run_failed', async () => {
    const { pool } = fakePool(() => ({ fullText: '', error: 'boom' }) as TurnResult);
    const { store } = fakeStore();
    const rec = makeCtx({});
    const handler = createAgentRunHandler({ pool, kernelStore: store, defaultCwd: tmpDir });
    await expect(handler.run(rec.ctx)).rejects.toThrow('boom');
  });

  it('continues context: prior run_completed report + follow-up enter the prompt', async () => {
    const batch: WorkItemEvent[] = [
      {
        id: 10,
        workitemId: 'wi-1',
        seq: 2,
        kind: 'run_completed',
        payload: { reportPath: 'assignments/old/report.md' },
        createdAt: 1,
      },
      {
        id: 11,
        workitemId: 'wi-1',
        seq: 3,
        kind: 'human_message',
        payload: { text: '再确认下 codex 那条' },
        createdAt: 1,
      },
    ];
    const { pool, sends } = fakePool(() => ({ fullText: 'r2', sessionId: 's2' }) as TurnResult);
    const { store } = fakeStore();
    const rec = makeCtx({
      batch,
      artifacts: { 'assignments/old/report.md': 'PRIOR REPORT CONTENT' },
    });
    const handler = createAgentRunHandler({ pool, kernelStore: store, defaultCwd: tmpDir });
    await handler.run(rec.ctx);
    const prompt = sends[0]?.text ?? '';
    expect(prompt).toContain('PRIOR REPORT CONTENT');
    expect(prompt).toContain('再确认下 codex 那条');
  });

  it('on abort during run: returns without writing report (effects.ts owns the conclusion)', async () => {
    const rec = makeCtx({});
    const { pool, aborts } = fakePool(() => {
      rec.controller.abort(); // container aborts mid-run
      return { fullText: 'late', sessionId: 's' } as TurnResult;
    });
    const { store } = fakeStore();
    const handler = createAgentRunHandler({ pool, kernelStore: store, defaultCwd: tmpDir });
    await handler.run(rec.ctx);
    // abort listener fired → pool.abort called with the shadow task id
    expect(aborts).toEqual(['managed:as-1']);
    // no report written (early return)
    expect(rec.writes.find((w) => w.relPath === 'assignments/as-1/report.md')).toBeUndefined();
  });

  it('calls onReport with the work item id + report text on success (WI-6)', async () => {
    const reports: Array<{ workitemId: string; report: string }> = [];
    const { pool } = fakePool(() => ({ fullText: 'REPORT BODY', sessionId: 's' }) as TurnResult);
    const { store } = fakeStore();
    const rec = makeCtx({});
    const handler = createAgentRunHandler({
      pool,
      kernelStore: store,
      defaultCwd: tmpDir,
      onReport: (info) => reports.push(info),
    });
    await handler.run(rec.ctx);
    expect(reports).toEqual([{ workitemId: 'wi-1', report: 'REPORT BODY' }]);
  });

  it('does not call onReport when the run errors (WI-6)', async () => {
    const reports: unknown[] = [];
    const { pool } = fakePool(() => ({ fullText: '', error: 'boom' }) as TurnResult);
    const { store } = fakeStore();
    const rec = makeCtx({});
    const handler = createAgentRunHandler({
      pool,
      kernelStore: store,
      defaultCwd: tmpDir,
      onReport: () => reports.push(1),
    });
    await expect(handler.run(rec.ctx)).rejects.toThrow('boom');
    expect(reports).toEqual([]);
  });

  it('does not call onReport when aborted mid-run (WI-6)', async () => {
    const reports: unknown[] = [];
    const rec = makeCtx({});
    const { pool } = fakePool(() => {
      rec.controller.abort();
      return { fullText: 'late', sessionId: 's' } as TurnResult;
    });
    const { store } = fakeStore();
    const handler = createAgentRunHandler({
      pool,
      kernelStore: store,
      defaultCwd: tmpDir,
      onReport: () => reports.push(1),
    });
    await handler.run(rec.ctx);
    expect(reports).toEqual([]);
  });
});
