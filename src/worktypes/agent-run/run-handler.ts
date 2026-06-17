import * as fs from 'node:fs';
import type { AgentPool } from '../../agents/pool.js';
import type { ProgressCallbacks } from '../../agents/types.js';
import type { Store } from '../../store.js';
import type { EffectContext, EffectHandler } from '../../workitems/effects.js';
import type { WorkItem, WorkItemEvent } from '../../workitems/types.js';

export interface AgentRunDeps {
  pool: AgentPool;
  kernelStore: Store;
  /** Fallback cwd when the workitem declares no repo. */
  defaultCwd: string;
  logger?: {
    info?: (obj: unknown, msg?: string) => void;
    error?: (obj: unknown, msg?: string) => void;
  };
  /**
   * M1b WI-6: notified with the report text after a SUCCESSFUL run so the bridge can post
   * it back to the IM thread. Not called on abort or failure (success path only). The
   * handler stays free of any IM/Feishu type — the assembler supplies the posting closure.
   */
  onReport?: (info: { workitemId: string; report: string }) => void;
}

// M1b WI-2: the generic "real agent run" effect handler. It is NOT probe-specific —
// any solo readonly worktype reuses it. The worktype's onEvent decides WHEN to dispatch
// a solo run; this handler decides HOW to run it (drive the kernel pool). It is fully
// self-contained for prompt composition (does not rely on AssignmentSpec.brief), because
// the single-flight wake path re-dispatches via the container's defaultDispatchSpec which
// carries no brief (M1b plan §2.2 / §2.4).
export function createAgentRunHandler(deps: AgentRunDeps): EffectHandler {
  return {
    kind: 'run',
    recovery: 'resume-or-redispatch',
    // M1b: no onSession callback on the runner → the session id is not reliably written
    // to the assignment before a crash, so a true --resume is not possible. Crash recovery
    // therefore redispatches a fresh assignment (readonly probe is idempotent). §2.3.
    canResume: () => false,
    run: (ctx) => runAgent(ctx, deps),
    // Formal only: recovery goes through redispatch (canResume=false), so this never runs.
    resume: (ctx) => runAgent(ctx, deps),
  };
}

async function runAgent(ctx: EffectContext, deps: AgentRunDeps): Promise<void> {
  const assignment = ctx.assignment;
  if (!assignment) throw new Error('agent_run_missing_assignment');
  const workitem = ctx.workitem;

  // 1) Self-contained prompt: original ask + prior round's report (continuity via
  //    artifact, not --resume) + this round's batched follow-up messages.
  const batch = ctx.eventsSince(ctx.batchFromSeq);
  const priorReportPath = lastRunCompletedReportPath(batch);
  const priorReport = priorReportPath ? ctx.readArtifact(priorReportPath) : undefined;
  const followups = batch
    .filter((e) => e.kind === 'human_message')
    .map(humanMessageText)
    .filter((t): t is string => t.length > 0);
  const prompt = composeProbePrompt(workitemTitle(workitem), priorReport, followups);
  ctx.writeArtifact(`assignments/${assignment.id}/brief.md`, prompt, 'agent-run brief');

  // 2) Managed shadow task (per-assignment id, fresh session). cwd decides which dir the
  //    readonly agent browses.
  const cwd = pickCwd(workitem, deps.defaultCwd);
  fs.mkdirSync(cwd, { recursive: true });
  const task = deps.kernelStore.upsertTask({
    id: `managed:${assignment.id}`,
    display_name: workitemTitle(workitem).slice(0, 60) || assignment.id,
    agent_kind: 'claude',
    owner_kind: 'managed',
    mode: 'project',
    cwd,
    root_msg_id: null,
    root_chat_id: null,
    agent_session_id: assignment.agentSessionId,
    status: 'suspended',
    model: null,
  });

  // 3) Heartbeat bridge: real runner stream → container watchdog liveness.
  const callbacks: ProgressCallbacks = {
    // WI-9: heartbeat on ANY stdout activity (onActivity), not just visible text/tool events.
    // A thinking/long turn that streams no assistant text still keeps the watchdog alive —
    // heartbeatTimeoutSec now means "stdout fully silent for N s" (= true wedge), decoupled
    // from how long the turn legitimately runs. wallclockCapSec stays the resource ceiling.
    onActivity: () => ctx.heartbeat(),
  };

  // 4) Permission: worktype readonly → agents-layer readonly weak profile (WI-B).
  const options = { permission: { mode: 'readonly' as const } };

  // 5) Abort bridge: container abort (stall / close) → SIGINT the runner.
  ctx.signal.addEventListener('abort', () => deps.pool.abort(task.id), { once: true });

  // 6) Run the real agent (passes through the WI-C global concurrency slot inside send()).
  const result = await deps.pool.send(task, prompt, callbacks, options);
  if (ctx.signal.aborted) return; // aborted: effects.ts owns the conclusion (none emitted)
  if (result.error) throw new Error(result.error); // → effects.ts emits run_failed

  // 7) Outputs: session id (audit only in M1b) + report.md (validateRunReport gate).
  if (result.sessionId) ctx.setAgentSessionId(result.sessionId);
  ctx.writeArtifact(
    `assignments/${assignment.id}/report.md`,
    result.fullText ?? '',
    'agent-run report',
  );
  // WI-6: hand the report to the outbound bridge (success path only — abort returns early
  // above and failure throws before reaching here).
  deps.onReport?.({ workitemId: workitem.id, report: result.fullText ?? '' });
}

function lastRunCompletedReportPath(batch: WorkItemEvent[]): string | undefined {
  // batch is seq-ascending; the most recent run_completed (with reportPath) is the prior
  // round's report. run_failed carries no reportPath → priorReport stays undefined.
  for (let i = batch.length - 1; i >= 0; i--) {
    const ev = batch[i];
    if (!ev || ev.kind !== 'run_completed') continue;
    const p = ev.payload;
    if (isObject(p) && typeof p.reportPath === 'string') return p.reportPath;
  }
  return undefined;
}

function composeProbePrompt(
  title: string,
  priorReport: string | undefined,
  followups: string[],
): string {
  const lines: string[] = [
    '你是一个只读的代码调查助手。请只读浏览当前工作目录下的代码，回答下面的问题，',
    '最终产出一份结构化的调查报告（现象 / 依据 / 结论 / 建议）。不要修改任何文件。',
    '',
    `# 调查诉求`,
    title,
  ];
  if (priorReport) {
    lines.push('', '# 上一轮你的报告（供延续，不要重复已有结论）', priorReport);
  }
  if (followups.length > 0) {
    lines.push('', '# 本轮追问', ...followups.map((f) => `- ${f}`));
  }
  return lines.join('\n');
}

function pickCwd(workitem: WorkItem, fallback: string): string {
  const first = workitem.repos[0];
  return first && first.trim().length > 0 ? first : fallback;
}

function workitemTitle(workitem: WorkItem): string {
  return typeof workitem.title === 'string' ? workitem.title : '';
}

function humanMessageText(ev: WorkItemEvent): string {
  const p = ev.payload;
  return isObject(p) && typeof p.text === 'string' ? p.text : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
