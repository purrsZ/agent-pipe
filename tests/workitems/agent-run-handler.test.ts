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
  source?: unknown;
}): CtxRecord {
  const controller = new AbortController();
  const writes: Array<{ relPath: string; content: string }> = [];
  const sessionIds: string[] = [];
  let heartbeats = 0;
  const workitem = makeWorkItem('wi-1', {
    type: 'probe',
    title: '看看 src 里有几个 runner',
    repos: opts.workitemRepos ?? [],
    source: opts.source ?? { kind: 'test' },
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
      callbacks?.onActivity?.('tid'); // WI-9: exercise heartbeat bridge (any stdout line)
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
    // heartbeat fired from onActivity (any stdout line)
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

  it('drives the progress sink onRunStart → onText/onToolUse → onRunEnd(success) with the report (M2, merges WI-6)', async () => {
    const events: string[] = [];
    const ends: Array<{ outcome: string; report?: string; error?: string }> = [];
    const starts: Array<{ workitemId: string; assignmentId: string; title: string }> = [];
    const { pool } = fakePool((_t, _text, callbacks) => {
      callbacks?.onToolUse?.('tid', { name: 'Read' });
      callbacks?.onText?.('tid', 'partial text');
      return { fullText: 'REPORT BODY', sessionId: 's' } as TurnResult;
    });
    const { store } = fakeStore();
    const rec = makeCtx({});
    const handler = createAgentRunHandler({
      pool,
      kernelStore: store,
      defaultCwd: tmpDir,
      progress: {
        onRunStart: (i) => {
          starts.push({ workitemId: i.workitemId, assignmentId: i.assignmentId, title: i.title });
          events.push('start');
        },
        onText: (i) => events.push(`text:${i.fullText}`),
        onToolUse: (i) => events.push(`tool:${i.toolName}`),
        onRunEnd: (i) => {
          ends.push({ outcome: i.outcome, report: i.report, error: i.error });
          events.push(`end:${i.outcome}`);
        },
      },
    });
    await handler.run(rec.ctx);
    expect(starts).toEqual([
      { workitemId: 'wi-1', assignmentId: 'as-1', title: '看看 src 里有几个 runner' },
    ]);
    expect(events).toEqual(['start', 'tool:Read', 'text:partial text', 'end:success']);
    expect(ends).toEqual([{ outcome: 'success', report: 'REPORT BODY', error: undefined }]);
  });

  it('forwards source locators (chat/thread/anchor) on onRunStart for streaming card placement (M2)', async () => {
    const starts: Array<{ chatId?: string; threadId?: string; anchorMsgId?: string }> = [];
    const { pool } = fakePool(() => ({ fullText: 'r', sessionId: 's' }) as TurnResult);
    const { store } = fakeStore();
    const rec = makeCtx({
      source: { kind: 'feishu', chatId: 'c-9', threadId: 'omt_1', anchorMsgId: 'om_a' },
    });
    const handler = createAgentRunHandler({
      pool,
      kernelStore: store,
      defaultCwd: tmpDir,
      progress: {
        onRunStart: (i) =>
          starts.push({ chatId: i.chatId, threadId: i.threadId, anchorMsgId: i.anchorMsgId }),
        onText: () => {},
        onToolUse: () => {},
        onRunEnd: () => {},
      },
    });
    await handler.run(rec.ctx);
    expect(starts).toEqual([{ chatId: 'c-9', threadId: 'omt_1', anchorMsgId: 'om_a' }]);
  });

  it('ends with outcome=failed (carrying the error) when the run errors, then throws (M2)', async () => {
    const ends: Array<{ outcome: string; error?: string }> = [];
    const { pool } = fakePool(() => ({ fullText: '', error: 'boom' }) as TurnResult);
    const { store } = fakeStore();
    const rec = makeCtx({});
    const handler = createAgentRunHandler({
      pool,
      kernelStore: store,
      defaultCwd: tmpDir,
      progress: {
        onRunStart: () => {},
        onText: () => {},
        onToolUse: () => {},
        onRunEnd: (i) => ends.push({ outcome: i.outcome, error: i.error }),
      },
    });
    await expect(handler.run(rec.ctx)).rejects.toThrow('boom');
    expect(ends).toEqual([{ outcome: 'failed', error: 'boom' }]);
  });

  it('calls strategy.afterRun with the report AFTER report.md is written (success path)', async () => {
    const calls: Array<{ report: string; phase: string }> = [];
    const { pool } = fakePool(() => ({ fullText: 'REPORT BODY', sessionId: 's' }) as TurnResult);
    const { store } = fakeStore();
    const rec = makeCtx({});
    const handler = createAgentRunHandler({
      pool,
      kernelStore: store,
      defaultCwd: tmpDir,
      strategyFor: () => ({
        composePrompt: () => 'p',
        runOptions: () => ({ permission: { mode: 'readonly' } }),
        resolveCwd: ({ defaultCwd }) => defaultCwd,
        prepareWorkspace: () => {},
        canResume: () => false,
        afterRun: ({ report, workitem, writeArtifact }) => {
          calls.push({ report, phase: workitem.phase });
          writeArtifact('contract/contract.json', '{"derived":true}', 'derived');
        },
      }),
    });
    await handler.run(rec.ctx);
    expect(calls).toEqual([{ report: 'REPORT BODY', phase: 'noop:idle' }]);
    // afterRun's own artifact landed too (report.md + the derived file)
    expect(rec.writes.map((w) => w.relPath)).toEqual([
      'assignments/as-1/brief.md',
      'assignments/as-1/report.md',
      'contract/contract.json',
    ]);
  });

  it('a throwing afterRun is swallowed (never flips a successful run into run_failed)', async () => {
    const { pool } = fakePool(() => ({ fullText: 'ok', sessionId: 's' }) as TurnResult);
    const { store } = fakeStore();
    const rec = makeCtx({});
    const handler = createAgentRunHandler({
      pool,
      kernelStore: store,
      defaultCwd: tmpDir,
      strategyFor: () => ({
        composePrompt: () => 'p',
        runOptions: () => ({ permission: { mode: 'readonly' } }),
        resolveCwd: ({ defaultCwd }) => defaultCwd,
        prepareWorkspace: () => {},
        canResume: () => false,
        afterRun: () => {
          throw new Error('parse boom');
        },
      }),
    });
    // resolves (does NOT throw) — the run already succeeded; afterRun is best-effort.
    await expect(handler.run(rec.ctx)).resolves.toBeUndefined();
    // report still written despite the afterRun throw.
    expect(rec.writes.find((w) => w.relPath === 'assignments/as-1/report.md')?.content).toBe('ok');
  });

  it('ends with outcome=aborted (no report) when aborted mid-run (M2)', async () => {
    const ends: Array<{ outcome: string; report?: string }> = [];
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
      progress: {
        onRunStart: () => {},
        onText: () => {},
        onToolUse: () => {},
        onRunEnd: (i) => ends.push({ outcome: i.outcome, report: i.report }),
      },
    });
    await handler.run(rec.ctx);
    expect(ends).toEqual([{ outcome: 'aborted', report: undefined }]);
  });

  it('forwards onAskUser to the progress sink with assignmentId/workitemId/title/questions (WS-9, 审查修复 T8)', async () => {
    const asks: Array<{
      assignmentId: string;
      workitemId: string;
      title: string;
      questions: unknown;
    }> = [];
    const questions = [{ question: '选配色', options: [{ label: 'A' }, { label: 'B' }] }];
    const { pool } = fakePool((_t, _text, callbacks) => {
      // agent 中途 AskUserQuestion → runner 触发 onAskUser（run 照常收尾）。
      callbacks?.onAskUser?.('tid', { toolUseId: 'tu-1', questions });
      return { fullText: 'r', sessionId: 's' } as TurnResult;
    });
    const { store } = fakeStore();
    const rec = makeCtx({});
    const handler = createAgentRunHandler({
      pool,
      kernelStore: store,
      defaultCwd: tmpDir,
      progress: {
        onRunStart: () => {},
        onText: () => {},
        onToolUse: () => {},
        onRunEnd: () => {},
        onAskUser: (i) => asks.push(i),
      },
    });
    await handler.run(rec.ctx);
    expect(asks).toEqual([
      { assignmentId: 'as-1', workitemId: 'wi-1', title: '看看 src 里有几个 runner', questions },
    ]);
  });
});
