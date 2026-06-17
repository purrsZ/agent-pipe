import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNoopRunHandler } from '../../src/worktypes/noop/run-handler.js';
import { makeAssignment, makeWorkItem } from '../helpers/workitems.js';
import type { Assignment, Clock, Effect, WorkItemEvent } from '../../src/workitems/types.js';
import type { EffectContext } from '../../src/workitems/effects.js';

function effect(overrides: Partial<Effect> = {}): Effect {
  return {
    id: 1,
    workitemId: 'wi-1',
    seq: 2,
    kind: 'run',
    payload: { assignmentId: 'as-1' },
    status: 'running',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function event(seq: number, kind: string): WorkItemEvent {
  return { id: seq, workitemId: 'wi-1', seq, kind, payload: {}, createdAt: seq };
}

function deferredContext(options: {
  nowRef: { value: number };
  context?: unknown;
  assignment?: Assignment;
  signal?: AbortSignal;
  events?: WorkItemEvent[];
}): {
  ctx: EffectContext;
  artifacts: Map<string, string>;
  heartbeats: number[];
  agentSessionIds: string[];
} {
  const artifacts = new Map<string, string>();
  const heartbeats: number[] = [];
  const agentSessionIds: string[] = [];
  const clock: Clock = { now: () => options.nowRef.value };
  const assignment = options.assignment ?? makeAssignment('as-1', 'wi-1');
  const events = options.events ?? [event(1, 'workitem_created'), event(2, 'run')];
  return {
    artifacts,
    heartbeats,
    agentSessionIds,
    ctx: {
      effect: effect(),
      workitem: makeWorkItem('wi-1', { context: options.context ?? {} }),
      assignment,
      signal: options.signal ?? new AbortController().signal,
      clock,
      logger: {},
      batchFromSeq: 0,
      heartbeat: () => heartbeats.push(clock.now()),
      eventsSince: (afterSeq) => events.filter((ev) => ev.seq > afterSeq),
      setAgentSessionId: (id) => agentSessionIds.push(id),
      writeArtifact: (relPath, content) => artifacts.set(relPath, content),
      readArtifact: (relPath) => artifacts.get(relPath),
      emit: () => {
        throw new Error('noop handler should not emit conclusions directly');
      },
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('noop run handler', () => {
  it('delays completion using the injected clock and writes brief plus report artifacts', async () => {
    const handler = createNoopRunHandler();
    const nowRef = { value: 1000 };
    const { ctx, artifacts, agentSessionIds } = deferredContext({
      nowRef,
      context: { delayMs: 100, heartbeatMode: 'silent' },
      events: [event(1, 'workitem_created'), event(2, 'run'), event(3, 'side_event')],
    });
    let done = false;
    const run = handler.run(ctx).then(() => {
      done = true;
    });

    await flush();
    expect(done).toBe(false);
    nowRef.value = 1100;
    await run;

    expect(agentSessionIds).toEqual(['noop:as-1']);
    expect(artifacts.get('assignments/as-1/brief.md')).toContain('noop');
    expect(artifacts.get('assignments/as-1/report.md')).toContain('eventsSinceBatch: 3');
  });

  it('does not import process runners or spawn agents', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/worktypes/noop/run-handler.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/AgentPool|Runner|spawn|execFile|child_process/);
  });

  it.each([
    'before-run',
    'during-run',
    'before-report',
  ] as const)('fails at %s until failCount is exceeded', async (failAt) => {
    const handler = createNoopRunHandler();
    const failing = deferredContext({
      nowRef: { value: 1000 },
      context: { failAt, failCount: 1 },
      assignment: makeAssignment('as-1', 'wi-1', { retries: 0 }),
    });
    await expect(handler.run(failing.ctx)).rejects.toThrow(`noop_${failAt}`);

    const passing = deferredContext({
      nowRef: { value: 1000 },
      context: { failAt, failCount: 1 },
      assignment: makeAssignment('as-1', 'wi-1', { retries: 1 }),
    });
    await expect(handler.run(passing.ctx)).resolves.toBeUndefined();
    expect(passing.artifacts.get('assignments/as-1/report.md')).toBeTruthy();
  });

  it('supports silent, normal, and beat-no-finish heartbeat modes', async () => {
    const handler = createNoopRunHandler();
    const silent = deferredContext({
      nowRef: { value: 1000 },
      context: { delayMs: 0, heartbeatMode: 'silent' },
    });
    await handler.run(silent.ctx);
    expect(silent.heartbeats).toEqual([]);

    const normal = deferredContext({
      nowRef: { value: 1000 },
      context: { delayMs: 0, heartbeatMode: 'normal' },
    });
    await handler.run(normal.ctx);
    expect(normal.heartbeats.length).toBeGreaterThan(0);

    const controller = new AbortController();
    const forever = deferredContext({
      nowRef: { value: 1000 },
      context: { heartbeatMode: 'beat-no-finish', heartbeatIntervalMs: 1 },
      signal: controller.signal,
    });
    let done = false;
    const run = handler.run(forever.ctx).then(() => {
      done = true;
    });
    await flush();
    expect(forever.heartbeats.length).toBeGreaterThan(0);
    expect(done).toBe(false);
    controller.abort();
    await run;
  });

  it('resumes only resumable noop assignments with an existing agent session', () => {
    const handler = createNoopRunHandler();
    const resumable = makeWorkItem('wi-1', { context: { simulateResumable: true } });
    const plain = makeWorkItem('wi-1', { context: { simulateResumable: false } });

    expect(
      handler.canResume?.(
        {},
        makeAssignment('as-1', 'wi-1', { agentSessionId: 'noop:as-1' }),
        resumable,
      ),
    ).toBe(true);
    expect(handler.canResume?.({}, makeAssignment('as-1', 'wi-1'), resumable)).toBe(false);
    expect(
      handler.canResume?.(
        {},
        makeAssignment('as-1', 'wi-1', { agentSessionId: 'noop:as-1' }),
        plain,
      ),
    ).toBe(false);
  });
});
