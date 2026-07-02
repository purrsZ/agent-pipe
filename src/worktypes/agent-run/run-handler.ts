import * as fs from 'node:fs';
import type { AgentPool } from '../../agents/pool.js';
import type { ProgressCallbacks, RunOptions } from '../../agents/types.js';
import type { Store } from '../../store.js';
import type { EffectContext, EffectHandler } from '../../workitems/effects.js';
import type { Assignment, WorkItem, WorkItemEvent } from '../../workitems/types.js';

/**
 * Per-run strategy (worker-runtime §5.1). The generic run handler stays worktype-agnostic;
 * a worktype injects how its runs differ — prompt, permission/options, cwd, workspace prep,
 * and crash-resume policy. The default reproduces probe's readonly behaviour byte-for-byte;
 * the requirement worker passes a write/worktree strategy. One 'run' handler serves all
 * worktypes (the effect kind is always 'run'); strategyFor(workitem) picks per run.
 */
export interface RunStrategy {
  composePrompt(args: {
    title: string;
    priorReport?: string;
    // All run_completed report paths from the FULL event history (ascending). The owner assess
    // run uses these to aggregate每仓 worker完成回执 (its own batch has no worker reports — they
    // landed before the assess was dispatched). probe/worker strategies ignore it. Optional so
    // pure unit tests may omit it (run-handler always supplies it in production).
    priorReportPaths?: string[];
    followups: string[];
    workitem: WorkItem;
    assignment: Assignment;
    batch: WorkItemEvent[];
    readArtifact: (relPath: string) => string | undefined;
    // WS-0.3: the concluding run effect's dispatch payload (stage / note / repo …). The requirement
    // owner/worker prompts read `stage` to route composition (reconcile vs assess vs steer) and
    // `note` for rework rounds. probe ignores it (zero regression). Optional so unit tests may omit.
    effectPayload?: unknown;
  }): string;
  runOptions(args: { workitem: WorkItem; assignment: Assignment; cwd: string }): RunOptions;
  resolveCwd(args: { workitem: WorkItem; assignment: Assignment; defaultCwd: string }): string;
  /** Create/ready the cwd before the run (probe: mkdir; requirement worker: worktree add). */
  prepareWorkspace(args: { workitem: WorkItem; assignment: Assignment; cwd: string }): void;
  canResume(payload: unknown, assignment: Assignment | undefined, workitem: WorkItem): boolean;
  /**
   * Optional post-run hook (SUCCESS path only). Runs AFTER report.md is persisted and BEFORE
   * onRunEnd. Lets a worktype derive artifacts from the run's own report WITHOUT forging a run
   * conclusion — the requirement owner runs use it: the 拆解 跨仓对账 run升格 the report's structured
   * cross-repo contract into contract/contract.json + reconcile.json, and the 并行实现 assess run
   * registers实现接口 into contract/impl-claims.json (灯③ 对账的实现侧). It is artifact-write only:
   * it MUST NOT throw the run into failure (the handler swallows + logs any throw), so a parse miss
   * degrades to an empty/absent artifact (downstream effects对账 or优雅放行), never a crashed run.
   * probe omits it (no-op).
   */
  afterRun?(args: {
    report: string;
    workitem: WorkItem;
    assignment: Assignment;
    writeArtifact: (relPath: string, content: string, message: string) => void;
    // WS-0.4: the run effect's dispatch payload, so afterRun routes artifact writes by `stage`
    // (reconcile → contract.json/reconcile.json; assess → impl-claims.json) instead of by phase —
    // the precondition for WS-5's in-implement re-reconcile round. Optional; probe has no afterRun.
    effectPayload?: unknown;
  }): void;
}

/**
 * M2 进度可见性：run-handler 在一轮 run 的生命周期里把过程与结论喂给这个中性 sink，桥侧据此
 * 驱动一张实时流式卡（onRunStart 发卡 → onText/onToolUse 流式刷新 → onRunEnd 原地收尾成报告/
 * 失败/中断卡）。纯数据、零 IM/Feishu 类型，handler 保持在 worktypes 层架构边界内。WI-6 的
 * onReport 并入为 onRunEnd(outcome='success') 的特例。
 */
export interface RunProgressSink {
  /**
   * A run is about to start. 出站定位信息全部从 workitem.source 提取后随此事件下发，让流式卡发卡
   * 不依赖任何外部反查（消灭 claim 登记晚于发卡的时序竞态）：
   *   - threadId + anchorMsgId 同时存在 → 群聊话题，流式卡 reply 锚点卡进同一话题；
   *   - 仅 anchorMsgId → p2p 降级，流式卡 reply 锚点卡（主流）；
   *   - 都没有 → 极端兜底用 chatId 直发。
   */
  onRunStart(info: {
    workitemId: string;
    assignmentId: string;
    title: string;
    chatId?: string;
    threadId?: string;
    anchorMsgId?: string;
  }): void;
  /** Streamed assistant text so far (a full snapshot each tick, not a delta). */
  onText(info: { assignmentId: string; fullText: string }): void;
  /** A tool invocation just began. */
  onToolUse(info: { assignmentId: string; toolName: string }): void;
  /**
   * The run reached a terminal outcome. success carries the report full-text (this is the
   * merged WI-6 onReport); failed carries the error summary; aborted carries neither.
   */
  onRunEnd(info: {
    assignmentId: string;
    outcome: 'success' | 'failed' | 'aborted';
    report?: string;
    error?: string;
  }): void;
}

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
   * M2: live progress sink for the run (replaces M1b's onReport, which was just the
   * success-only special case of onRunEnd). Optional — when absent the handler behaves
   * byte-identically to today (no streaming card, no terminal notification), so any test
   * fixture that does not care about outbound progress needs zero changes.
   */
  progress?: RunProgressSink;
  /**
   * Pick a per-run strategy by workitem (worktype). Omitted / returning undefined ⇒ the
   * default readonly probe strategy (zero regression). The requirement worktype wires this
   * to its write/worktree worker strategy.
   */
  strategyFor?: (workitem: WorkItem) => RunStrategy | undefined;
}

// Default strategy = the original readonly probe behaviour, byte-for-byte.
const defaultRunStrategy: RunStrategy = {
  composePrompt: ({ title, priorReport, followups }) =>
    composeProbePrompt(title, priorReport, followups),
  runOptions: () => ({ permission: { mode: 'readonly' } }),
  resolveCwd: ({ workitem, defaultCwd }) => pickCwd(workitem, defaultCwd),
  prepareWorkspace: ({ cwd }) => fs.mkdirSync(cwd, { recursive: true }),
  canResume: () => false,
};

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
    // Per-strategy crash policy: probe is readonly-idempotent (canResume=false → redispatch);
    // the requirement worker is non-idempotent (write) so its strategy decides resume vs
    // worktree-reset+redispatch (D-09/D-30). onSession (D-30) makes the session id reachable.
    canResume: (payload, assignment, workitem) =>
      assignment !== undefined &&
      (deps.strategyFor?.(workitem) ?? defaultRunStrategy).canResume(payload, assignment, workitem),
    run: (ctx) => runAgent(ctx, deps),
    resume: (ctx) => runAgent(ctx, deps),
  };
}

async function runAgent(ctx: EffectContext, deps: AgentRunDeps): Promise<void> {
  const assignment = ctx.assignment;
  if (!assignment) throw new Error('agent_run_missing_assignment');
  const workitem = ctx.workitem;

  // 1) Self-contained prompt: original ask + prior round's report (continuity via
  //    artifact, not --resume) + this round's batched follow-up messages.
  const strategy = deps.strategyFor?.(workitem) ?? defaultRunStrategy;
  const batch = ctx.eventsSince(ctx.batchFromSeq);
  const priorReportPath = lastRunCompletedReportPath(batch);
  const priorReport = priorReportPath ? ctx.readArtifact(priorReportPath) : undefined;
  // B 阶段（回执语义）：全历史的 run_completed 报告路径——owner assess 据此聚合各仓工人完成回执（assess 的
  // batch 里没有工人报告，它们在 assess 被派之前就落了）。probe/worker 不读它。
  const priorReportPaths = allRunCompletedReportPaths(ctx.eventsSince(0));
  const followups = batch
    .filter((e) => e.kind === 'human_message')
    .map(humanMessageText)
    .filter((t): t is string => t.length > 0);
  const prompt = strategy.composePrompt({
    title: workitemTitle(workitem),
    priorReport,
    priorReportPaths,
    followups,
    workitem,
    assignment,
    batch,
    readArtifact: (rel) => ctx.readArtifact(rel),
    effectPayload: ctx.effect.payload,
  });
  ctx.writeArtifact(`assignments/${assignment.id}/brief.md`, prompt, 'agent-run brief');

  // 2) Managed shadow task (per-assignment id, fresh session). The strategy resolves cwd
  //    (probe: repos[0]; requirement worker: its worktree) and readies it (mkdir / worktree add).
  const cwd = strategy.resolveCwd({ workitem, assignment, defaultCwd: deps.defaultCwd });
  strategy.prepareWorkspace({ workitem, assignment, cwd });
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

  // 2b) M2: announce the run up front so the bridge can post a live streaming card before the
  // first token arrives. All outbound locators (chat / thread / anchor) ride from source, set
  // by runProbe BEFORE createWorkItem — so they are available no matter when this run dispatches.
  const loc = locatorFromSource(workitem.source);
  deps.progress?.onRunStart({
    workitemId: workitem.id,
    assignmentId: assignment.id,
    title: workitemTitle(workitem),
    chatId: loc.chatId,
    threadId: loc.threadId,
    anchorMsgId: loc.anchorMsgId,
  });

  // 3) Heartbeat bridge: real runner stream → container watchdog liveness, plus M2 progress.
  const callbacks: ProgressCallbacks = {
    // WI-9: heartbeat on ANY stdout activity (onActivity), not just visible text/tool events.
    // A thinking/long turn that streams no assistant text still keeps the watchdog alive —
    // heartbeatTimeoutSec now means "stdout fully silent for N s" (= true wedge), decoupled
    // from how long the turn legitimately runs. wallclockCapSec stays the resource ceiling.
    onActivity: () => ctx.heartbeat(),
    // D-30: persist the session id the instant it appears so a crash before run-end can still
    // resume (the precondition for the requirement worker's resume path).
    onSession: (_id, sid) => ctx.setAgentSessionId(sid),
    // M2: forward visible stream events to the progress sink (drives the live card). Neutral
    // payload keeps this worktypes-layer handler free of any feishu type.
    onText: (_id, full) => deps.progress?.onText({ assignmentId: assignment.id, fullText: full }),
    onToolUse: (_id, tool) =>
      deps.progress?.onToolUse({ assignmentId: assignment.id, toolName: tool.name }),
  };

  // 4) Permission/options come from the strategy: probe → readonly; requirement worker →
  //    write + writableDirs=[worktree] (never full, R04.AC-6).
  const options = strategy.runOptions({ workitem, assignment, cwd });

  // 5) Abort bridge: container abort (stall / close) → SIGINT the runner.
  ctx.signal.addEventListener('abort', () => deps.pool.abort(task.id), { once: true });

  // 6) Run the real agent (passes through the WI-C global concurrency slot inside send()).
  const result = await deps.pool.send(task, prompt, callbacks, options);
  if (ctx.signal.aborted) {
    // aborted: effects.ts owns the conclusion (none emitted). Still notify the sink so the
    // streaming card patches itself into its 中断 terminal state instead of spinning forever.
    deps.progress?.onRunEnd({ assignmentId: assignment.id, outcome: 'aborted' });
    return;
  }
  if (result.error) {
    // failed: tell the sink first (streaming card → error card), then throw so effects.ts
    // emits run_failed. The post-commit observer no longer replies its own error card (M2:
    // anchorAction run_failed → update-only), so there is exactly one failure card per run.
    deps.progress?.onRunEnd({
      assignmentId: assignment.id,
      outcome: 'failed',
      error: result.error,
    });
    throw new Error(result.error); // → effects.ts emits run_failed
  }

  // 7) Outputs: session id (audit only in M1b) + report.md (validateRunReport gate).
  if (result.sessionId) ctx.setAgentSessionId(result.sessionId);
  const report = result.fullText ?? '';
  ctx.writeArtifact(`assignments/${assignment.id}/report.md`, report, 'agent-run report');
  // Optional strategy post-processing (e.g. spec-design 升格 → contract/contract.json). Kept off
  // the run-conclusion path: it writes artifacts only. Swallow any throw so a strategy parse bug
  // can never flip a successful run into run_failed (the contract is then empty, gated at 灯②).
  if (strategy.afterRun) {
    try {
      strategy.afterRun({
        report,
        workitem,
        assignment,
        writeArtifact: (rel, content, msg) => ctx.writeArtifact(rel, content, msg),
        effectPayload: ctx.effect.payload,
      });
    } catch (err) {
      deps.logger?.error?.(
        { err, assignmentId: assignment.id },
        'strategy.afterRun failed (non-fatal)',
      );
    }
  }
  // M2 (merges WI-6): hand the report to the sink so the streaming card patches itself into
  // the report card. success path only — abort returns early above, failure throws before here.
  deps.progress?.onRunEnd({ assignmentId: assignment.id, outcome: 'success', report });
}

// All run_completed report paths in the given events (seq-ascending). The owner assess run reads
// them to aggregate每仓 worker完成回执 across the whole history (its own batch has none).
function allRunCompletedReportPaths(events: WorkItemEvent[]): string[] {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.kind !== 'run_completed') continue;
    const p = ev.payload;
    if (isObject(p) && typeof p.reportPath === 'string') out.push(p.reportPath);
  }
  return out;
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

// M2: pull the streaming card's outbound locators out of the work item's opaque source (set by
// runProbe). chatId / threadId / anchorMsgId together tell the sink exactly where (and whether
// in a thread) to post the live card, with zero kernel/IM import in this worktypes-layer file.
function locatorFromSource(source: unknown): {
  chatId?: string;
  threadId?: string;
  anchorMsgId?: string;
} {
  if (!isObject(source)) return {};
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    chatId: str(source.chatId),
    threadId: str(source.threadId),
    anchorMsgId: str(source.anchorMsgId),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
