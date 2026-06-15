import type { EffectContext, EffectHandler } from '../../workitems/effects.js';
import type { Assignment, WorkItem } from '../../workitems/types.js';
import { type NoopFailAt, type NoopParams, parseNoopParams } from './index.js';

export function createNoopRunHandler(): EffectHandler {
  return {
    kind: 'run',
    recovery: 'resume-or-redispatch',
    canResume: (_payload, assignment, workitem) => canResumeNoop(assignment, workitem),
    run: runNoop,
    resume: runNoop,
  };
}

function canResumeNoop(assignment: Assignment | undefined, workitem: WorkItem): boolean {
  const params = parseNoopParams(workitem.context);
  return (
    params.simulateResumable && assignment?.agentSessionId !== null && assignment !== undefined
  );
}

async function runNoop(ctx: EffectContext): Promise<void> {
  const params = parseNoopParams(ctx.workitem.context);
  const assignmentId = ctx.assignment?.id;
  if (!assignmentId) throw new Error('noop_missing_assignment');

  ctx.setAgentSessionId(`noop:${assignmentId}`);
  if (shouldFail(ctx, params, 'before-run')) throw new Error('noop_before-run');

  ctx.writeArtifact(
    `assignments/${assignmentId}/brief.md`,
    briefContent(ctx, params),
    'noop brief',
  );
  if (shouldFail(ctx, params, 'during-run')) throw new Error('noop_during-run');

  if (params.heartbeatMode === 'beat-no-finish') {
    await beatUntilAbort(ctx, params);
    return;
  }

  await delayUntil(ctx, params);
  if (ctx.signal.aborted) return;
  if (shouldFail(ctx, params, 'before-report')) throw new Error('noop_before-report');

  const events = ctx.eventsSince(ctx.batchFromSeq);
  ctx.writeArtifact(
    `assignments/${assignmentId}/report.md`,
    [
      '# noop report',
      `assignmentId: ${assignmentId}`,
      `eventsSinceBatch: ${events.length}`,
      `batchFromSeq: ${ctx.batchFromSeq}`,
    ].join('\n'),
    'noop report',
  );
}

function shouldFail(ctx: EffectContext, params: NoopParams, failAt: NoopFailAt): boolean {
  return params.failAt === failAt && (ctx.assignment?.retries ?? 0) < params.failCount;
}

function briefContent(ctx: EffectContext, params: NoopParams): string {
  return [
    '# noop brief',
    `workitemId: ${ctx.workitem.id}`,
    `assignmentId: ${ctx.assignment?.id ?? ''}`,
    `delayMs: ${params.delayMs}`,
    `heartbeatMode: ${params.heartbeatMode}`,
  ].join('\n');
}

async function delayUntil(ctx: EffectContext, params: NoopParams): Promise<void> {
  if (params.heartbeatMode === 'normal') ctx.heartbeat();
  const target = ctx.clock.now() + params.delayMs;
  let lastBeat = ctx.clock.now();
  while (!ctx.signal.aborted && ctx.clock.now() < target) {
    if (
      params.heartbeatMode === 'normal' &&
      ctx.clock.now() - lastBeat >= params.heartbeatIntervalMs
    ) {
      ctx.heartbeat();
      lastBeat = ctx.clock.now();
    }
    await waitOneTick(ctx.signal);
  }
}

async function beatUntilAbort(ctx: EffectContext, params: NoopParams): Promise<void> {
  while (!ctx.signal.aborted) {
    ctx.heartbeat();
    await waitOneTick(ctx.signal, params.heartbeatIntervalMs);
  }
}

async function waitOneTick(signal: AbortSignal, ms = 1): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(1, Math.min(ms, 10)),
    );
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
