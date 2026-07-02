import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClaudeFactory } from './agents/claude/runner.js';
import { createCodexFactory } from './agents/codex/runner.js';
import { AgentPool } from './agents/pool.js';
import type { AskUserQuestion, ProgressCallbacks } from './agents/types.js';
import { scheduleDailyBackup } from './backup.js';
import { CommandHandler, currentTaskKey } from './bridge/commands.js';
import { loadConfig, type Config } from './config.js';
import {
  anchorAction,
  AUQ_ACTION_KIND,
  buildAnchorCard,
  buildCaseFileAnsweredCard,
  buildCaseFileCard,
  buildCheckpointAnsweredCard,
  buildCheckpointCard,
  buildProcessingCard,
  buildQuestionAnsweredCard,
  buildQuestionFormCard,
  buildResultCard,
  buildStatusCard,
  CHECKPOINT_ACTION_KIND,
} from './feishu/card.js';
import { createFeishuClients } from './feishu/client.js';
import { startWsReconnectGuard } from './feishu/ws-health.js';
import { createDispatcher } from './feishu/event-router.js';
import { ProgressCards } from './feishu/progress-cards.js';
import { Sender } from './feishu/sender.js';
import { StreamingCard } from './feishu/stream-card.js';
import type { CardAction, IncomingMessage } from './feishu/types.js';
import { installCrashGuard, removeOwnPidFile, startHeartbeat } from './lifecycle.js';
import { createLogger, type Logger } from './logger.js';
import type { Task } from './store.js';
import { Store } from './store.js';
import { composeRepoKnowledge, KNOWLEDGE_BUDGET_CHARS } from './knowledge/compose.js';
import { loadFreshnessPolicy } from './knowledge/freshness.js';
import { KnowledgeStore } from './knowledge/store.js';
import { createWorkitemsContainer, type WorkitemsContainer } from './workitems/container.js';
import { createConsoleServer } from './console/server.js';
import { buildRequirementBoard } from './worktypes/requirement/board.js';
import { createWorkbenchAdapter } from './workitems/workbench-adapter.js';
import { createTokenAuth } from './workbench/auth.js';
import { createWorkbenchServer } from './workbench/server.js';
import { OpenLimitError } from './workitems/errors.js';
import { isTerminalStatus } from './workitems/shared.js';
import type { WorkItem, WorkItemEvent } from './workitems/types.js';
import { createAgentRunHandler } from './worktypes/agent-run/run-handler.js';
import { registerProbe } from './worktypes/probe/index.js';
import { checkpointBoundaryOf } from './worktypes/requirement/checkpoint.js';
import { registerRequirement } from './worktypes/requirement/index.js';
import { createIntegrationCheckHandler } from './worktypes/requirement/integration.js';
import { createGatekeeperReviewHandler } from './worktypes/requirement/gatekeeper.js';
import { createReconcileCheckHandler } from './worktypes/requirement/reconcile.js';
import { checkpointGateLabel, checkpointRail } from './worktypes/requirement/lights.js';
import { createRequirementRunStrategy } from './worktypes/requirement/worker-handler.js';
import { PendingIntakeStore } from './bridge/pending-intake.js';
import { buildIntakeChecklistCard, type IntakeChecklistView } from './feishu/intake-card.js';
import {
  composeIntakeExtractPrompt,
  foldIntake,
  INTAKE_CHECKLIST,
  isFieldSatisfied,
  isGateReady,
  nextRequiredToFill,
  parseIntakeExtraction,
  requiredMissing,
  requiredProgress,
} from './worktypes/requirement/intake.js';
import { createIntakeFinalizeHandler } from './worktypes/requirement/intake-finalize.js';
import { isIntakePhase } from './worktypes/requirement/phases.js';

const COMPACT_PROMPT = [
  '请把我们到目前为止的完整对话压缩成一份结构化摘要，供新会话继续使用。',
  '务必覆盖：',
  '1. 用户的目标与需求；',
  '2. 关键决策与结论（含放弃的方案及原因）；',
  '3. 已完成的工作：改动过的文件、运行过的命令及其结果；',
  '4. 进行中的任务与下一步计划；',
  '5. 重要的上下文、约束与未决事项。',
  '只输出摘要正文，不要任何寒暄或额外说明。',
].join('\n');

// WI-A /diag-mcp (admin-only): resolve the echo MCP fixture relative to this module
// (not cwd), injected for one turn to confirm per-run tool injection reaches Claude.
const DIAG_ECHO_MCP_PATH = fileURLToPath(new URL('../scripts/diag-echo-mcp.mjs', import.meta.url));

const DIAG_MCP_PROMPT = [
  '这是一次 MCP 工具注入自检。请：',
  '1) 列出你当前能看到的 MCP 工具名；',
  "2) 调用名为 echo 的工具，参数 message 设为 'mcp-injection-ok'，把返回原样贴出来；",
  '3) 如果完全看不到任何 MCP 工具，直接说明“未注入”。',
].join('\n');

const DIAG_READONLY_PROMPT = [
  '这是一次 readonly 权限档的【边界】自检。它是弱档：预期写工具(Write/Edit)被工具级拦截，',
  '但 Bash 这类不受工具级限制的路径可能仍能写——目的就是如实暴露拦住了什么、没拦住什么，别美化。',
  '请在当前工作目录内，分别独立尝试一次（不重试、互不依赖）：',
  '1) 用 Write 工具创建 probe-write.txt；',
  '2) 用 Edit 工具创建/修改 probe-edit.txt；',
  '3) 用 Bash 执行 `echo probe > probe-bash.txt`。',
  '然后逐项如实报告每一项落在哪一档：「成功落盘 / 被工具级拒绝 / 被要求人工批准 / 卡住无返回」，',
  '并把系统的原始拒绝信息原文贴出。最后给一句总结：这个档到底算不算只读。',
].join('\n');

async function fetchBotOpenId(client: any, logger: Logger): Promise<string> {
  for (let i = 0; i < 3; i++) {
    try {
      const resp = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      const openId = resp?.data?.bot?.open_id ?? resp?.bot?.open_id ?? '';
      if (openId) return openId;
    } catch (err) {
      logger.warn({ err, attempt: i + 1 }, 'fetch bot info failed, retrying');
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return '';
}

// Anchor-card header noun by unit type: requirement reads "需求", everything else keeps the
// historical "调查" (probe). Lives in index (kernel-exempt) so the neutral card builder stays
// type-agnostic — it just takes the rendered noun.
export function anchorNoun(type: string): string {
  return type === 'requirement' ? '需求' : '调查';
}

// 病历(非 checkpoint 的 human wait)的飞书卡标签。返回 undefined ⇒ 不是病历(不发病历卡)。
// 放 index(kernel-exempt 桥层),故可用业务词。
export function caseFileLabel(reason: string): string | undefined {
  switch (reason) {
    case 'reconcile_conflict':
      return '跨仓对账 · 冲突/悬空';
    case 'gatekeeper_big':
      return '监工 · 跨仓外溢';
    case 'run_failed':
      return '执行报错';
    case 'integration_unresolved':
      return '集成验证 · 未通过';
    // WS-1.3/1.5：活性看门自曝 + 两类容器病历（此前无飞书卡，只能从管控台 resolve）→ 补齐同权。
    case 'stalled_no_path':
      return '流程卡死（系统自检出，无在途工作）';
    case 'retry_exhausted':
      return '重试用尽（stall/超时连续失败）';
    case 'thrash':
      return '决策震荡（连续被判过期）';
    default:
      return undefined;
  }
}

// 从事件历史里抽一句人类可读的病历详情(为什么卡住),喂进病历卡。永不抛,抽不到 → undefined。
export function caseFileDetail(events: WorkItemEvent[], reason: string): string | undefined {
  const kind = reason === 'integration_unresolved' ? 'integration_check_failed' : reason;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || ev.kind !== kind) continue;
    const p = (typeof ev.payload === 'object' && ev.payload ? ev.payload : {}) as Record<
      string,
      unknown
    >;
    const pick = (arr: unknown, key: string): string | undefined => {
      if (!Array.isArray(arr)) return undefined;
      const parts = arr
        .map((x) => (typeof x === 'object' && x ? (x as Record<string, unknown>)[key] : undefined))
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .slice(0, 3);
      return parts.length > 0 ? parts.join('；') : undefined;
    };
    if (reason === 'reconcile_conflict') return pick(p.unresolved, 'detail');
    if (reason === 'gatekeeper_big') return pick(p.raises, 'question');
    if (reason === 'integration_unresolved') {
      return Array.isArray(p.breaking) ? `破坏性变更 ${p.breaking.length} 处` : undefined;
    }
    return undefined; // run_failed：无结构化详情，卡上只给类型 + 处理指引
  }
  return undefined;
}

// 立项清单事件流 → feishu 清单卡的中性视图。kernel-exempt：index 可 import worktypes 的 intake 纯核心，
// 把领域状态压成 feishu 层只认的 view（feishu 层不做 fold、不 import worktypes）。
function foldIntakeState(events: WorkItemEvent[]): ReturnType<typeof foldIntake> {
  return foldIntake(events.filter((e) => e.kind === 'intake_field_set').map((e) => e.payload));
}

function buildIntakeView(title: string, state: ReturnType<typeof foldIntake>): IntakeChecklistView {
  const byKey = new Map(state.fields.map((f) => [f.key, f]));
  const items = INTAKE_CHECKLIST.map((d) => {
    const f = byKey.get(d.key);
    const value = f ? (Array.isArray(f.value) ? f.value.join('、') : f.value) : undefined;
    return {
      label: d.label,
      done: isFieldSatisfied(f),
      required:
        d.requirement === 'required' || (d.requirement === 'conditional' && state.uiRequired),
      pending: f?.filledBy === 'ai-extracted' && !f.confirmed,
      value,
    };
  });
  const prog = requiredProgress(state);
  return {
    title,
    items,
    filled: prog.filled,
    total: prog.total,
    ready: isGateReady(state),
    missing: requiredMissing(state).map((d) => d.label),
  };
}

// 立项收料的仓库项校验：绝对路径 + 是 git 仓 + 有 HEAD（当场退回不合格项）。副作用（git/fs）放在
// index(kernel-exempt) 里做，不进 worktype 纯核心。校验失败一律当「不是有效仓库」处理。
function isGitRepo(repoPath: string): boolean {
  if (!path.isAbsolute(repoPath)) return false;
  try {
    const head = execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return head.toString().trim().length > 0;
  } catch {
    return false;
  }
}

export function ensureSingleInstance(pidPath: string, logger: Logger): void {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  try {
    const oldPid = Number.parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 'SIGTERM');
        logger.info({ oldPid }, 'killed previous instance');
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no previous pid file */
  }
  fs.writeFileSync(pidPath, String(process.pid));
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  fs.mkdirSync(config.sessionsDir, { recursive: true });

  const pidPath = path.join(config.dataDir, 'bot.pid');
  ensureSingleInstance(pidPath, logger);

  const store = new Store(config.dbPath);

  if (store.whitelistCount() === 0) {
    for (const id of config.allowedOpenIds) store.addWhitelist(id, 'bootstrap');
    logger.info({ count: config.allowedOpenIds.size }, 'seeded whitelist from .env');
  }
  const { client, wsClient, wsHealth } = createFeishuClients(
    config.feishu.appId,
    config.feishu.appSecret,
    logger,
  );
  const sender = new Sender(client, logger);

  const botOpenId = await fetchBotOpenId(client, logger);
  if (!botOpenId) {
    logger.warn('could not fetch bot open_id (not fatal, but /bot/v3/info failed)');
  }

  const claudeFactory = createClaudeFactory({
    binPath: config.claude.path,
    defaultModel: config.claude.model,
    effort: config.claude.effort,
  });
  const codexFactory = createCodexFactory({
    binPath: config.codex.path,
    defaultModel: config.codex.model,
    reasoningEffort: config.codex.reasoningEffort,
  });
  const pool = new AgentPool(
    { claude: claudeFactory, codex: codexFactory },
    { maxHot: config.maxHot, maxConcurrent: config.maxConcurrent },
    store,
    logger,
  );
  // workitems runtime drives real agent runs through the pool (managed shadow tasks),
  // so it must be wired after the pool exists. defaultCwd is the fallback dir the
  // readonly probe agent browses when a workitem declares no repo.
  const workitems = createWorkitemsRuntime({
    config,
    logger,
    pool,
    sender,
    kernelStore: store,
    defaultCwd: config.allowedCwdPrefixes[0] ?? process.cwd(),
  });
  const runningTasks = new Set<string>();
  // /req 后「等群名」的临时待答态（M-I2，keyed by 用户+会话，带 TTL，纯内存）。
  const pendingIntake = new PendingIntakeStore();
  const botStartTime = Date.now();

  // HTML 工作台 (R17/R18): SSR 读视图 + 单写入口（funnels through resolveWait/injectHumanMessage，
  // 页面只读投影、agent 不碰页面）。读开放、写要本人 token（Authorization: Bearer 或 wb_token
  // cookie）。绑定地址/端口可配；公司外访问走内网穿透（在外，R17.AC-6）。WORKBENCH_ENABLED=false
  // 可整体关停。listen 在 ws 就绪后进行（见下）。
  // Single write path shared by the board (T2) and the feishu 灯卡 (T3): both funnel a checkpoint
  // p板 through workbenchAdapter.actions.resolve → resolveWait. Built unconditionally (cheap, no
  // IO) so card-action handling works even when the HTTP board is disabled.
  const workbenchAdapter = createWorkbenchAdapter({
    store: workitems.store,
    artifacts: workitems.artifacts,
    api: workitems.api,
  });
  const workbenchServer = config.workbench.enabled
    ? createWorkbenchServer({
        data: workbenchAdapter.data,
        actions: workbenchAdapter.actions,
        auth: createTokenAuth(config.workbench),
        logger,
      })
    : null;

  // 需求管控台（React SPA 的 JSON API + 静态托管）。与 workbench 并存，复用同一 resolveWait 单写口、
  // 同一本人 token。最佳努力：bind 失败不拖垮 bot（见下方 listen 的 error 监听）。
  const consoleServer = config.console.enabled
    ? createConsoleServer({
        board: () =>
          buildRequirementBoard({ store: workitems.store, artifacts: workitems.artifacts }),
        resolve: ({ waitId, approved, reason }, operator) => {
          const r = workitems.api.resolveWait(waitId, {
            operator,
            reason,
            decision: { approved, payload: { reason } },
          });
          return { ok: r.resolved };
        },
        auth: createTokenAuth(config.workbench),
        staticDir: config.console.staticDir,
        logger,
      })
    : null;

  const releaseResources = createReleaseResources({
    pool,
    workitems,
    store,
    pidPath,
    workbenchServer,
    consoleServer,
  });
  installCrashGuard(logger, releaseResources);
  scheduleDailyBackup(store, path.join(config.dataDir, 'backups'), logger, [workitems.backupJob()]);

  const ATTACHMENT_TTL_MS = 30 * 60 * 1000;
  const pendingAttachments = new Map<string, Array<{ path: string; expiresAt: number }>>();
  const drainPending = (chatId: string): string[] => {
    const now = Date.now();
    const list = pendingAttachments.get(chatId) ?? [];
    const fresh = list.filter((e) => e.expiresAt > now);
    pendingAttachments.delete(chatId);
    return fresh.map((e) => e.path);
  };
  const sanitizeName = (name: string): string =>
    name
      // biome-ignore lint/suspicious/noControlCharactersInRegex: 故意剥离文件名里的控制字符
      .replace(/[/\\\x00-\x1f]/g, '_')
      .replace(/^\.+/, '_')
      .slice(0, 120) || 'file';

  // ---- per-task serial execution: queue while busy, drain after each turn ----
  type TurnInput = {
    chatId: string;
    messageId: string;
    text: string;
    parentId?: string;
  };
  const MAX_QUEUE = 10;
  const queues = new Map<string, TurnInput[]>();
  const cancelledTasks = new Set<string>();
  const enqueue = (taskId: string, input: TurnInput): boolean => {
    const list = queues.get(taskId) ?? [];
    if (list.length >= MAX_QUEUE) return false;
    list.push(input);
    queues.set(taskId, list);
    return true;
  };
  const dequeue = (taskId: string): TurnInput | undefined => {
    const list = queues.get(taskId);
    if (!list || list.length === 0) return undefined;
    const next = list.shift();
    if (list.length === 0) queues.delete(taskId);
    return next;
  };
  const clearQueue = (taskId: string): number => {
    const n = queues.get(taskId)?.length ?? 0;
    queues.delete(taskId);
    return n;
  };
  // /stop: 清空排队 + 中断当前轮，并标记取消，让 runOneTurn 收尾成"已中断"卡。
  const requestStop = (taskId: string): { aborted: boolean; dropped: number } => {
    const dropped = clearQueue(taskId);
    const aborted = pool.abort(taskId);
    if (aborted) cancelledTasks.add(taskId);
    return { aborted, dropped };
  };

  const compactKey = (taskId: string): string => `compact_summary:${taskId}`;

  const escapeAttr = (v: string): string =>
    v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // 拉取被引用消息渲染成 <replied_message> 块；图片/文件下载进任务 inbox 并带上本地路径。
  // best-effort：拉取失败返回 null（跳过注入，不阻塞本轮）。
  async function buildRepliedBlock(parentId: string, task: Task): Promise<string | null> {
    const m = await sender.getMessage(parentId);
    if (!m) return null;
    const lines: string[] = [];
    if (m.text) lines.push(m.text);
    if (m.imageKey || m.fileKey) {
      const inboxDir = path.join(task.cwd, 'inbox');
      try {
        fs.mkdirSync(inboxDir, { recursive: true });
      } catch (err) {
        logger.warn({ err, inboxDir }, 'mkdir inbox for replied attachment failed');
      }
      if (m.imageKey) {
        const dest = path.join(inboxDir, `replied-${parentId}.png`);
        const ok = await sender.downloadAttachment(parentId, m.imageKey, 'image', dest);
        lines.push(ok ? `📎 引用图片: ${dest}` : '📎 引用图片: (下载失败)');
      }
      if (m.fileKey) {
        const dest = path.join(
          inboxDir,
          `replied-${parentId}-${sanitizeName(m.fileName ?? 'file')}`,
        );
        const ok = await sender.downloadAttachment(parentId, m.fileKey, 'file', dest);
        lines.push(ok ? `📎 引用文件: ${dest}` : `📎 引用文件: (下载失败) ${m.fileName ?? ''}`);
      }
    }
    if (lines.length === 0) lines.push(`(${m.msgType || '未知类型'} 消息，无文本)`);
    const attrs = [`sender_type="${escapeAttr(m.senderType || 'unknown')}"`];
    if (m.createTime) attrs.push(`sent_at="${escapeAttr(m.createTime)}"`);
    return `<replied_message ${attrs.join(' ')}>\n${lines.join('\n')}\n</replied_message>`;
  }

  // Run one turn for a task: processing card → throttled streaming progress → result
  // card. Injects replied-message + pending compact summary + attachment paths into
  // the prompt. Never throws — failures are reported as a reply/card so drain keeps going.
  async function runOneTurn(taskId: string, input: TurnInput): Promise<void> {
    const task = store.getTask(taskId);
    if (!task) return;
    let ackCardId: string | null = null;
    try {
      ackCardId = await sender.replyCard(
        input.messageId,
        buildProcessingCard(task.display_name, task.agent_kind),
      );
      if (ackCardId) store.recordTaskMessage(task.id, ackCardId);

      let prompt = input.text;
      const pendingPaths = drainPending(input.chatId);
      if (pendingPaths.length > 0) {
        prompt = `[已附加文件，请读取以下路径后继续处理]\n${pendingPaths
          .map((p) => `- ${p}`)
          .join('\n')}\n\n${prompt}`;
      }
      // 引用消息注入：仅当用户回复的是「非本任务线程内」的消息（外部内容）时注入；
      // 回复本任务自己的卡/历史（已在 agent 上下文里）则跳过，避免冗余 token。
      if (input.parentId) {
        const owner = store.getTaskByMessageId(input.parentId);
        if (!owner || owner.id !== task.id) {
          const block = await buildRepliedBlock(input.parentId, task);
          if (block) prompt = `${block}\n\n${prompt}`;
        }
      }
      const summary = store.getState(compactKey(task.id));
      if (summary) {
        store.deleteState(compactKey(task.id));
        prompt = `[以下是之前对话的压缩摘要，请基于它继续]\n${summary}\n\n${prompt}`;
      }

      const streaming = ackCardId
        ? new StreamingCard(sender, ackCardId, task.display_name, task.agent_kind)
        : null;
      let pendingQuestion: AskUserQuestion | null = null;
      const callbacks: ProgressCallbacks = {
        // Claude asked the user mid-turn (AskUserQuestion). The headless CLI auto-closes the
        // tool so this turn still ends normally — we render the choices as the final card and
        // resume the picked answer as the next message (see handleCardAction).
        onAskUser: (_id, q) => {
          pendingQuestion = q;
        },
      };
      if (streaming) {
        callbacks.onToolUse = (_id, t) => streaming.onToolUse(t.name);
        callbacks.onText = (_id, full) => streaming.onText(full);
      }

      let result: Awaited<ReturnType<typeof pool.send>>;
      try {
        result = await pool.send(task, prompt, callbacks, undefined, () => {
          // WI-C/R2: global concurrency slot full — tell the user instead of going silent.
          void sender.reply(
            input.messageId,
            `[${task.display_name}] 全局繁忙，排队等待空闲运行槽…`,
          );
        });
      } finally {
        await streaming?.stop();
      }

      // If Claude asked a question this turn, replace the result card (which would otherwise be
      // the CLI's "弹窗关闭了" degrade text) with an interactive choice card.
      const card = pendingQuestion
        ? buildQuestionFormCard(task.display_name, pendingQuestion, {
            taskId: task.id,
            chatId: input.chatId,
          })
        : buildResultCard(task.display_name, result);
      if (ackCardId) {
        const ok = await sender.updateCard(ackCardId, card);
        if (!ok) {
          const replyId = await sender.replyCard(input.messageId, card);
          if (replyId) store.recordTaskMessage(task.id, replyId);
        }
      } else {
        const replyId = await sender.replyCard(input.messageId, card);
        if (replyId) store.recordTaskMessage(task.id, replyId);
      }
      cancelledTasks.delete(task.id); // consume any stale /stop flag on success
    } catch (err) {
      const cancelled = cancelledTasks.delete(task.id);
      if (cancelled) {
        logger.info({ taskId: task.id }, 'task turn cancelled via /stop');
      } else {
        logger.error({ err, taskId: task.id }, 'task execution failed');
      }
      const statusCard = cancelled
        ? buildStatusCard(task.display_name, 'cancelled', '已手动中断当前轮。')
        : buildStatusCard(task.display_name, 'error', (err as Error).message);
      let patched = false;
      if (ackCardId) patched = await sender.updateCard(ackCardId, statusCard);
      if (!patched) {
        const replyId = await sender.replyCard(input.messageId, statusCard);
        if (replyId) store.recordTaskMessage(task.id, replyId);
      }
    }
  }

  // Hold the task's serial slot, run the turn, then drain queued messages FIFO.
  async function runWithDrain(taskId: string, input: TurnInput): Promise<void> {
    runningTasks.add(taskId);
    try {
      let cur: TurnInput | undefined = input;
      while (cur) {
        await runOneTurn(taskId, cur);
        cur = dequeue(taskId);
      }
    } finally {
      runningTasks.delete(taskId);
    }
  }

  // /compact: drive the agent to emit a structured summary, persist it, reset the
  // session, and let the next message resume from the summary. Shares runningTasks so
  // it can't race a normal turn; drains anything queued during the compact turn.
  async function runCompact(taskId: string, replyMsgId: string): Promise<void> {
    const task = store.getTask(taskId);
    if (!task) {
      await sender.reply(replyMsgId, `任务不存在: ${taskId}`);
      return;
    }
    if (runningTasks.has(taskId)) {
      await sender.reply(replyMsgId, `[${task.display_name}] 正忙，等当前消息处理完再 /compact`);
      return;
    }
    runningTasks.add(taskId);
    try {
      await sender.reply(replyMsgId, `[${task.display_name}] 正在压缩上下文…`);
      const r = await pool.send(task, COMPACT_PROMPT);
      if (r.error) {
        await sender.reply(replyMsgId, `[${task.display_name}] 压缩失败: ${r.error}`);
        return;
      }
      const summary = (r.fullText ?? '').trim();
      if (!summary) {
        await sender.reply(replyMsgId, `[${task.display_name}] 压缩失败: 摘要为空，会话未重置`);
        return;
      }
      store.setState(compactKey(taskId), summary);
      store.clearAgentSessionId(taskId);
      pool.respawn(taskId);
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] 已压缩上下文，原会话重置，下条消息会带着摘要继续。`,
      );
    } catch (err) {
      await sender.reply(replyMsgId, `[${task.display_name}] 压缩失败: ${(err as Error).message}`);
    } finally {
      cancelledTasks.delete(taskId); // /stop during compact must not leak the flag
      runningTasks.delete(taskId);
      const next = dequeue(taskId);
      if (next) void runWithDrain(taskId, next);
    }
  }

  // /diag-mcp: inject the echo MCP server for one turn and report the agent's output.
  // Shares runningTasks (can't race a normal turn); the injected options change the
  // fingerprint → pool rebuilds the Claude proc with --mcp-config (§2.1 / WI-A).
  async function runDiagMcp(taskId: string, replyMsgId: string): Promise<void> {
    const task = store.getTask(taskId);
    if (!task) {
      await sender.reply(replyMsgId, `任务不存在: ${taskId}`);
      return;
    }
    if (runningTasks.has(taskId)) {
      await sender.reply(replyMsgId, `[${task.display_name}] 正忙，等当前消息处理完再 /diag-mcp`);
      return;
    }
    runningTasks.add(taskId);
    try {
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] 注入 MCP server「diag-echo」跑一轮自检…（会触发 runner 重建）`,
      );
      const result = await pool.send(task, DIAG_MCP_PROMPT, undefined, {
        mcpServers: [{ name: 'diag-echo', command: 'node', args: [DIAG_ECHO_MCP_PATH] }],
      });
      if (result.error) {
        await sender.reply(replyMsgId, `[${task.display_name}] /diag-mcp 失败: ${result.error}`);
        return;
      }
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] /diag-mcp 完成，agent 输出：\n${(result.fullText ?? '').slice(0, 1500)}`,
      );
    } catch (err) {
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] /diag-mcp 异常: ${(err as Error).message}`,
      );
    } finally {
      cancelledTasks.delete(taskId);
      runningTasks.delete(taskId);
      const next = dequeue(taskId);
      if (next) void runWithDrain(taskId, next);
    }
  }

  // /diag-readonly: run one turn under the readonly permission profile and report the
  // agent's output — confirms the write-tool deny works (and surfaces reject-vs-hang, D6).
  async function runDiagReadonly(taskId: string, replyMsgId: string): Promise<void> {
    const task = store.getTask(taskId);
    if (!task) {
      await sender.reply(replyMsgId, `任务不存在: ${taskId}`);
      return;
    }
    if (runningTasks.has(taskId)) {
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] 正忙，等当前消息处理完再 /diag-readonly`,
      );
      return;
    }
    runningTasks.add(taskId);
    try {
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] 以 readonly 权限档跑一轮写入自检…（会触发 runner 重建）`,
      );
      const result = await pool.send(task, DIAG_READONLY_PROMPT, undefined, {
        permission: { mode: 'readonly' },
      });
      if (result.error) {
        await sender.reply(
          replyMsgId,
          `[${task.display_name}] /diag-readonly 失败: ${result.error}`,
        );
        return;
      }
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] /diag-readonly 完成，agent 输出：\n${(result.fullText ?? '').slice(0, 1500)}`,
      );
    } catch (err) {
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] /diag-readonly 异常: ${(err as Error).message}`,
      );
    } finally {
      cancelledTasks.delete(taskId);
      runningTasks.delete(taskId);
      const next = dequeue(taskId);
      if (next) void runWithDrain(taskId, next);
    }
  }

  // M1b WI-4: /probe creates a managed read-only investigation, posts an anchor card, and
  // claims the thread so follow-ups route into it (WI-5). /done closes it and MUST release
  // the claim — otherwise a closed thread keeps a stale managed claim and later follow-ups
  // hit the terminal short-circuit and silently vanish.
  async function runProbe(
    msg: IncomingMessage,
    opts: { repo?: string; description: string },
  ): Promise<void> {
    const repos = opts.repo ? [opts.repo] : [config.allowedCwdPrefixes[0] ?? process.cwd()];

    // 1) 先发占位锚点卡，建话题（群聊 reply_in_thread）/普通回复（p2p），拿 anchorMsgId + threadId。
    //    必须先于 createWorkItem：run 一派发就要从 source 读 thread/anchor 定位去发流式卡，所以
    //    这些定位得在创建工作项之前就备好（彻底避开 claim 登记晚于发卡的时序竞态）。
    const placeholder = buildAnchorCard({
      id: '创建中…',
      title: opts.description,
      stage: 'probe:looking',
      status: 'open',
    });
    let anchorMsgId: string | null;
    let threadId: string | undefined;
    if (msg.chatType === 'group') {
      const res = await sender.replyCardInThread(msg.messageId, placeholder);
      anchorMsgId = res?.messageId ?? null;
      threadId = res?.threadId ?? undefined;
    } else {
      anchorMsgId = await sender.replyCard(msg.messageId, placeholder);
    }
    if (!anchorMsgId) {
      await sender.reply(msg.messageId, '锚点卡发送失败，请重试 /probe。');
      return;
    }

    // 2) createWorkItem：把 thread/anchor 定位写进 source，随 run 下发给 run-handler → ProgressCards。
    let item: WorkItem;
    try {
      item = workitems.api.createWorkItem({
        type: 'probe',
        title: opts.description,
        source: {
          kind: 'feishu',
          userId: msg.userId,
          chatId: msg.chatId,
          messageId: msg.messageId,
          threadId,
          anchorMsgId,
        },
        repos,
        context: {},
      }).item;
    } catch (err) {
      const why =
        err instanceof OpenLimitError
          ? `${err.message}（先用 /done 关掉几个再来）`
          : `调查创建失败: ${(err as Error).message}`;
      if (!(err instanceof OpenLimitError)) logger.error({ err }, 'probe create failed');
      await sender.updateCard(anchorMsgId, buildStatusCard(opts.description, 'error', why));
      return;
    }

    // 3) 同步建 claim（入站路由）：话题内追问带同一 thread_id（群聊）或回复根（p2p）即可匹配。
    const claimKey = threadId ?? msg.rootId ?? msg.messageId;
    store.claimThread(claimKey, 'managed', item.id, anchorMsgId);

    // 4) 把占位锚点卡补全为真实 id / 状态。
    await sender.updateCard(
      anchorMsgId,
      buildAnchorCard({ id: item.id, title: item.title, stage: item.phase, status: item.status }),
    );
    logger.info({ workitemId: item.id, threadId, anchorMsgId }, 'probe anchor posted');
  }

  async function runDone(msg: IncomingMessage, threadRoot: string): Promise<void> {
    const claim = store.getThreadClaim(threadRoot);
    if (!claim || claim.owner_kind !== 'managed') {
      await sender.reply(msg.messageId, '当前话题不是调查，无需 /done。');
      return;
    }
    const item = workitems.api.getWorkItem(claim.owner_id);
    if (!item) {
      store.releaseThreadClaim(threadRoot);
      await sender.reply(msg.messageId, '该调查已不存在，已清理话题认领。');
      return;
    }
    workitems.api.injectClose(item.id);
    store.releaseThreadClaim(threadRoot);
    // WI-8: refresh the anchor card via its own message id, not the thread root — updateCard
    // targets the original card message.
    if (claim.anchor_msg_id) {
      await sender.updateCard(
        claim.anchor_msg_id,
        buildAnchorCard({
          id: item.id,
          title: item.title,
          stage: item.phase,
          status: 'done',
          closed: true,
          noun: anchorNoun(item.type),
        }),
      );
    }
    await sender.reply(msg.messageId, `已关闭调查 ${item.id}。`);
  }

  // /req (立项重塑, M-I2/3): /req 不再直接建单。bridge 先在原会话问群名（临时待答态），用户下一条
  // 普通消息即群名 → startIntakeGroup 建专属群发起立项。createWorkItem + claim + 清单卡都在
  // startIntakeGroup 里（建群成功后才建单）。
  async function runRequirement(
    msg: IncomingMessage,
    opts: { description: string },
  ): Promise<void> {
    pendingIntake.set(msg.userId, msg.chatId, opts.description, Date.now());
    const tail = opts.description ? `\n需求一句话：${opts.description}` : '';
    await sender.reply(
      msg.messageId,
      `好，咱们给这个需求建个专属群来推进立项。请直接回一条消息作为群名（比如「订单导出」）。${tail}`,
    );
  }

  // M-I2: 用户回了群名 → 建专属群（拉发起人）→ 群里发立项清单卡 → 建立项单（type=requirement，
  // 起步阶段=立项）→ claim 群 chatId（群内消息/卡回调据此路由）→ 预填 name(=群名)+summary(=一句话)
  // → 群里引导收下一项。建群是唯一硬前置（im:chat scope），失败兜底回原会话报错、不建单。
  async function startIntakeGroup(
    msg: IncomingMessage,
    description: string,
    groupName: string,
  ): Promise<void> {
    const groupChatId = await sender.createGroup(groupName, [msg.userId]);
    if (!groupChatId) {
      await sender.reply(
        msg.messageId,
        '建群失败（多半是未开通 im:chat 权限）。开通后重发 /req 再试。',
      );
      return;
    }
    // 预置 name(=群名)+summary(=一句话) 的初始清单视图，先把清单卡发进群拿到 anchorMsgId（同 runProbe
    // 的「建单前先备好出站定位」时序）。
    const seed: Array<{ key: string; value: string }> = [{ key: 'name', value: groupName }];
    if (description) seed.push({ key: 'summary', value: description });
    const view0 = buildIntakeView(groupName, foldIntake(seed));
    const anchorMsgId = await sender.sendCard(groupChatId, buildIntakeChecklistCard(view0));
    if (!anchorMsgId) {
      await sender.reply(
        msg.messageId,
        `群「${groupName}」已建好，但清单卡发送失败，请在群里发一条消息或重发 /req。`,
      );
      return;
    }
    let item: WorkItem;
    try {
      item = workitems.api.createWorkItem({
        type: 'requirement',
        title: groupName,
        source: {
          kind: 'feishu',
          userId: msg.userId,
          chatId: groupChatId,
          messageId: anchorMsgId,
          anchorMsgId,
        },
        repos: [],
        context: {},
      }).item;
    } catch (err) {
      const why =
        err instanceof OpenLimitError
          ? `${err.message}（先用 /done 关掉几个再来）`
          : `需求创建失败: ${(err as Error).message}`;
      if (!(err instanceof OpenLimitError)) logger.error({ err }, 'requirement create failed');
      await sender.updateCard(anchorMsgId, buildStatusCard(groupName, 'error', why));
      return;
    }
    // claim key = 群 chatId（立项群一需求一群；群内消息常无 thread/root/parent，按 chatId 路由）。
    const claimKey = groupChatId;
    store.claimThread(claimKey, 'managed', item.id, anchorMsgId);
    // 预填项进事件流（立项书 fold + gate 判定都靠它）。立项阶段 postStatus 是 no-op，清单卡由本路径就地维护。
    for (const f of seed) workitems.api.injectIntakeField(item.id, f);
    logger.info(
      { workitemId: item.id, groupChatId, anchorMsgId },
      'requirement intake group started',
    );
    await sender.reply(
      msg.messageId,
      `已建群「${groupName}」并发起立项，请到群里继续把前置料收齐。`,
    );
    await promptNextIntake(item.id, groupChatId);
  }

  // M-I3 群内收料（AI 抽取版）：用户在群里发的自由描述喂给一次性 AI run，让它**一次抽多个字段**——这样
  // 一条消息把仓库/PRD/验收都甩进来也能拆开。仓库项仍当场校验 git 仓+HEAD；文本项落为 ai-extracted
  // （「立项完成」这一步就是人工兜底确认）。AI 没起来/没抽到 → 回退确定性逐项填。文件附件走 PRD 分支。
  async function handleIntakeMessage(item: WorkItem, msg: IncomingMessage): Promise<void> {
    if (msg.attachments.length > 0) {
      await handleIntakePrd(item, msg);
      return;
    }
    const text = msg.text.trim();
    if (!text) return;
    await sender.sendText(msg.chatId, '🤔 正在从你的描述里提取立项信息…');
    const ex = await aiExtractIntake(item.id, item.title, text);
    if (!ex || ex.fields.length === 0) {
      if (ex?.uiRequired !== undefined) {
        workitems.api.injectIntakeField(item.id, { uiRequired: ex.uiRequired });
      }
      await fillIntakeDeterministic(item, msg, text);
      return;
    }
    const applied: string[] = [];
    const badRepos: string[] = [];
    if (ex.uiRequired !== undefined) {
      workitems.api.injectIntakeField(item.id, { uiRequired: ex.uiRequired });
    }
    for (const f of ex.fields) {
      if (f.key === 'repos') {
        const paths = (Array.isArray(f.value) ? f.value : [f.value])
          .map((s) => String(s).trim())
          .filter((s) => s.length > 0);
        const good = paths.filter((p) => isGitRepo(p));
        for (const p of paths) if (!isGitRepo(p)) badRepos.push(p);
        if (good.length > 0) {
          workitems.api.injectIntakeField(item.id, { key: 'repos', value: good });
          applied.push(`涉及代码仓库（${good.length} 个）`);
        }
      } else {
        const value = Array.isArray(f.value) ? f.value.join('、') : f.value;
        workitems.api.injectIntakeField(item.id, {
          key: f.key,
          value,
          filledBy: 'ai-extracted',
          confirmed: true,
        });
        applied.push(INTAKE_CHECKLIST.find((d) => d.key === f.key)?.label ?? f.key);
      }
    }
    await refreshIntakeCard(item.id);
    const lines: string[] = [];
    if (applied.length > 0) lines.push(`✅ 已从你的描述里填入：${applied.join('、')}`);
    if (badRepos.length > 0) {
      lines.push(
        `⚠️ 这些仓库路径无效（需绝对路径 + 是 git 仓）：\n${badRepos.map((p) => `- ${p}`).join('\n')}`,
      );
    }
    const after = foldIntakeState(workitems.api.listEvents(item.id));
    const miss = requiredMissing(after).map((d) => d.label);
    lines.push(
      miss.length > 0
        ? `还差：${miss.join('、')}`
        : '必填已齐 ✅ 核对清单卡无误后点「立项完成 · 开始开发」开跑。',
    );
    await sender.sendText(msg.chatId, lines.join('\n'));
  }

  // 起一次性 readonly AI run 把自由描述抽成立项字段（managed 影子 task，每次清会话保持独立）。失败返 null。
  async function aiExtractIntake(
    itemId: string,
    title: string,
    text: string,
  ): Promise<ReturnType<typeof parseIntakeExtraction>> {
    const state = foldIntakeState(workitems.api.listEvents(itemId));
    const filled = state.fields.map(
      (f) => INTAKE_CHECKLIST.find((d) => d.key === f.key)?.label ?? f.key,
    );
    const missing = requiredMissing(state).map((d) => d.label);
    const prompt = composeIntakeExtractPrompt(text, filled, missing);
    const taskId = `managed:intake-extract:${itemId}`;
    const task = store.upsertTask({
      id: taskId,
      display_name: `立项抽取:${title}`.slice(0, 60),
      agent_kind: 'claude',
      owner_kind: 'managed',
      mode: 'project',
      cwd: config.allowedCwdPrefixes[0] ?? process.cwd(),
      root_msg_id: null,
      root_chat_id: null,
      agent_session_id: null,
      status: 'suspended',
      model: null,
    });
    store.clearAgentSessionId(taskId); // 每次抽取独立、无上轮串扰
    try {
      const r = await pool.send(task, prompt, undefined, { permission: { mode: 'readonly' } });
      if (r.error) {
        logger.warn({ err: r.error, itemId }, 'intake extract run error');
        return null;
      }
      return parseIntakeExtraction(r.fullText ?? '');
    } catch (err) {
      logger.warn({ err, itemId }, 'intake extract failed');
      return null;
    }
  }

  // 回退：AI 不可用时按「当前待填项」确定性填。仓库项只认绝对路径 token（杜绝把整段话当路径刷垃圾列表）。
  async function fillIntakeDeterministic(
    item: WorkItem,
    msg: IncomingMessage,
    text: string,
  ): Promise<void> {
    const state = foldIntakeState(workitems.api.listEvents(item.id));
    const next = nextRequiredToFill(state);
    if (!next) {
      await sender.sendText(
        msg.chatId,
        '必填项已齐 ✅ 点上方清单卡「立项完成 · 开始开发」即可开跑。',
      );
      return;
    }
    if (next.key === 'repos') {
      const paths = text
        .split(/[\s,，、]+/)
        .map((s) => s.trim())
        .filter((s) => s.startsWith('/'));
      const good = paths.filter((p) => isGitRepo(p));
      const bad = paths.filter((p) => !isGitRepo(p));
      if (good.length === 0) {
        await sender.sendText(
          msg.chatId,
          '没识别到有效仓库——请发仓库的**绝对路径**（一行或空格分隔一个，需是 git 仓）。',
        );
        return;
      }
      workitems.api.injectIntakeField(item.id, { key: 'repos', value: good });
      if (bad.length > 0) {
        await sender.sendText(
          msg.chatId,
          `已收 ${good.length} 个仓库；这些路径无效已跳过：\n${bad.map((p) => `- ${p}`).join('\n')}`,
        );
      }
    } else {
      workitems.api.injectIntakeField(item.id, { key: next.key, value: text });
    }
    await refreshIntakeCard(item.id);
    await promptNextIntake(item.id, msg.chatId);
  }

  // M-I3 PRD：群里上传 MD → 下载 → 存进 artifact 仓 intake/prd.md → 填 prd 项（AI 摘要/预填留后续增强）。
  async function handleIntakePrd(item: WorkItem, msg: IncomingMessage): Promise<void> {
    const md = msg.attachments.find(
      (a) => a.kind === 'file' && /\.(md|markdown|txt)$/i.test(a.name),
    );
    if (!md) {
      await sender.sendText(msg.chatId, '📎 PRD 请上传 .md 文件，或直接发文字描述。');
      return;
    }
    const inbox = path.join(config.dataDir, 'intake-inbox');
    try {
      fs.mkdirSync(inbox, { recursive: true });
    } catch (err) {
      logger.warn({ err, inbox }, 'mkdir intake-inbox failed');
    }
    const tmp = path.join(inbox, `${item.id}-${sanitizeName(md.name)}`);
    const ok = await sender.downloadAttachment(msg.messageId, md.fileKey, 'file', tmp);
    if (!ok) {
      await sender.sendText(msg.chatId, 'PRD 下载失败，请重试。');
      return;
    }
    let content = '';
    try {
      content = fs.readFileSync(tmp, 'utf8');
    } catch (err) {
      logger.warn({ err, tmp }, 'read prd failed');
    }
    workitems.artifacts.writeFile(item.id, 'intake/prd.md', content, '立项上传 PRD');
    workitems.api.injectIntakeField(item.id, {
      key: 'prd',
      value: `见 intake/prd.md（${md.name}）`,
    });
    await sender.sendText(msg.chatId, `📄 已收下 PRD「${md.name}」并存档（intake/prd.md）。`);
    await refreshIntakeCard(item.id);
    await promptNextIntake(item.id, msg.chatId);
  }

  // 引导：群里追下一个还缺的必填项；全齐则提示点「立项完成」。
  async function promptNextIntake(itemId: string, chatId: string): Promise<void> {
    const state = foldIntakeState(workitems.api.listEvents(itemId));
    const next = nextRequiredToFill(state);
    if (next) {
      await sender.sendText(chatId, `📋 还差「${next.label}」：${next.hint ?? '请补充'}`);
    } else {
      await sender.sendText(chatId, '✅ 必填已齐，点上方清单卡「立项完成 · 开始开发」即可开跑。');
    }
  }

  // 就地刷新立项清单卡（料齐时带上立项 gate 路由 → 卡上出「立项完成」按钮）。
  async function refreshIntakeCard(itemId: string): Promise<void> {
    const it = workitems.api.getWorkItem(itemId);
    if (!it) return;
    const anchorMsgId = store.getThreadAnchorByOwner(itemId);
    if (anchorMsgId) await sender.updateCard(anchorMsgId, buildIntakeCard(itemId, it.title));
  }

  function buildIntakeCard(itemId: string, title: string): object {
    const state = foldIntakeState(workitems.api.listEvents(itemId));
    const view = buildIntakeView(title, state);
    if (!view.ready) return buildIntakeChecklistCard(view);
    // 料齐：找立项 gate 的 open human wait（立项阶段仅此一种 checkpoint wait），把路由带进按钮。
    const wait = workitems.store
      .listOpenWaits(itemId)
      .find((w) => w.kind === 'human' && checkpointBoundaryOf(w.reason) !== undefined);
    if (!wait) return buildIntakeChecklistCard(view);
    return buildIntakeChecklistCard(view, {
      itemId,
      waitId: wait.id,
      boundary: checkpointBoundaryOf(wait.reason)!,
    });
  }

  const commands = new CommandHandler(
    store,
    sender,
    config,
    logger,
    pool,
    (taskId, replyMsgId) => {
      void runCompact(taskId, replyMsgId);
    },
    (taskId) => requestStop(taskId),
    (taskId, replyMsgId) => {
      void runDiagMcp(taskId, replyMsgId);
    },
    (taskId, replyMsgId) => {
      void runDiagReadonly(taskId, replyMsgId);
    },
    (msg, opts) => {
      void runProbe(msg, opts);
    },
    (msg, threadRoot) => {
      void runDone(msg, threadRoot);
    },
    (msg, opts) => {
      void runRequirement(msg, opts);
    },
  );

  // Card button callbacks (R06/D-12) all arrive through one onCardAction; route by value.kind.
  // The whitelist gate is common to every kind; kind-specific handling follows.
  async function handleCardAction(action: CardAction): Promise<void> {
    const value = (action.value ?? {}) as Record<string, unknown>;
    if (!config.allowedOpenIds.has(action.operatorId) && !store.isAllowed(action.operatorId)) {
      logger.warn({ operatorId: action.operatorId }, 'unauthorized card action, ignoring');
      return;
    }
    if (value.kind === CHECKPOINT_ACTION_KIND) {
      await handleCheckpointAction(action, value);
      return;
    }
    if (value.kind !== AUQ_ACTION_KIND) {
      logger.warn({ kind: value.kind }, 'unhandled card action kind');
      return;
    }
    // auq 表单卡提交：凑齐每题答案（input 自定义优先、否则下拉 select），拼成一段文本一次回灌。
    const taskId = typeof value.taskId === 'string' ? value.taskId : '';
    const chatId = typeof value.chatId === 'string' ? value.chatId : '';
    const total = typeof value.total === 'number' ? value.total : 0;
    const headers = Array.isArray(value.headers) ? (value.headers as unknown[]) : [];
    if (!taskId || total <= 0) {
      logger.warn({ taskId, total }, 'auq form submit missing taskId/total');
      return;
    }
    const task = store.getTask(taskId);
    if (!task) {
      logger.warn({ taskId }, 'auq form submit for unknown task');
      return;
    }
    const fv = action.formValue ?? {};
    // select_static value may arrive as a plain string or as { value } / { option }.
    const selVal = (raw: unknown): string => {
      if (typeof raw === 'string') return raw;
      if (raw && typeof raw === 'object') {
        const o = raw as Record<string, unknown>;
        if (typeof o.value === 'string') return o.value;
        if (typeof o.option === 'string') return o.option;
      }
      return '';
    };
    const lines: string[] = [];
    const brief: string[] = [];
    for (let i = 0; i < total; i++) {
      const customRaw = fv[`q${i}_custom`];
      const custom = typeof customRaw === 'string' ? customRaw.trim() : '';
      const picked = selVal(fv[`q${i}_pick`]);
      const hdr = typeof headers[i] === 'string' ? (headers[i] as string) : `问题${i + 1}`;
      // Free-text wins over the dropdown, and is flagged so the agent takes it verbatim instead
      // of snapping it back to one of its preset options (AskUserQuestion is a choice tool, so
      // by default the model maps the reply onto its options — the flag overrides that).
      if (custom) {
        lines.push(
          `${i + 1}. 【${hdr}】→ ${custom}（自定义回答，请按字面采纳，不要套到预设选项上）`,
        );
        brief.push(`${hdr}：${custom}`);
      } else if (picked) {
        lines.push(`${i + 1}. 【${hdr}】→ ${picked}（选自预设）`);
        brief.push(`${hdr}：${picked}`);
      } else {
        lines.push(`${i + 1}. 【${hdr}】→ (未作答)`);
        brief.push(`${hdr}：(未作答)`);
      }
    }
    // Patch the form card to a terminal "已选 …" so it can't be submitted twice.
    if (action.messageId) {
      await sender.updateCard(
        action.messageId,
        buildQuestionAnsweredCard(task.display_name, brief.join('；')),
      );
    }
    // Feed all answers back as the next turn — same --resume path as a normal reply (the CLI
    // already auto-closed the AskUserQuestion tool, so a tool_result can't go back in).
    const text =
      '这是我对你刚才提问的回答（下列即为最终答复；凡标「自定义回答」的，请按我写的字面采纳，' +
      `不要再归类或套用到你给的预设选项上）：\n${lines.join('\n')}`;
    const turnInput: TurnInput = {
      chatId,
      messageId: action.messageId ?? '',
      text,
    };
    if (runningTasks.has(taskId)) {
      enqueue(taskId, turnInput);
    } else {
      void runWithDrain(taskId, turnInput);
    }
  }

  // Checkpoint 灯卡 click (T3): 通过/打回 funnels through the same single write path the board
  // uses (workbenchAdapter.actions.resolve → resolveWait). The card carries the exact waitId, so
  // no lookup is needed; an already-resolved wait (board / double click) resolves to ok=false and
  // the card is patched to a neutral "已处理".
  async function handleCheckpointAction(
    action: CardAction,
    value: Record<string, unknown>,
  ): Promise<void> {
    const itemId = typeof value.itemId === 'string' ? value.itemId : '';
    const waitId = typeof value.waitId === 'string' ? value.waitId : '';
    if (!itemId || !waitId) {
      logger.warn({ itemId, waitId }, 'checkpoint card action missing itemId/waitId');
      return;
    }
    const title = workitems.api.getWorkItem(itemId)?.title ?? itemId;
    const caseLabel = typeof value.caseLabel === 'string' ? value.caseLabel : '';
    // 立项 gate 的「立项完成」按钮就在清单卡（= 单元锚点卡）上：点完不在此就地打补丁，交给 postStatus
    // 把它 morph 成锚点卡，避免对同一张卡双改打架。独立卡（≠锚点卡）才就地补「已处理」。
    const anchorId = store.getThreadAnchorByOwner(itemId);
    const patch = async (card: object): Promise<void> => {
      if (action.messageId && action.messageId !== anchorId) {
        await sender.updateCard(action.messageId, card);
      }
    };

    // 病历「取消整单」：resolve wait 带 cancel 决策 → onWaitResolved 认出 isCancelDecision → terminal cancelled。
    if (value.cancel === true) {
      const r = workitems.api.resolveWait(waitId, {
        operator: action.operatorId,
        reason: '飞书：取消整单',
        decision: { approved: true, payload: { action: 'cancel' } },
      });
      await patch(buildCaseFileAnsweredCard(title, caseLabel || '病历', r.resolved));
      return;
    }

    // 通过/打回（关卡灯 或 病历「已处理·继续」）。飞书按钮无输入框，理由用固定文案；操作者 = 点按钮的飞书用户。
    const approved = value.approved === true;
    const reason = approved ? '飞书拍板：通过' : '飞书拍板：打回，请按反馈修改';
    const r = workbenchAdapter.actions.resolve({
      itemId,
      waitId,
      operator: action.operatorId,
      approved,
      reason,
    });
    if (caseLabel) {
      await patch(buildCaseFileAnsweredCard(title, caseLabel, false));
    } else {
      const boundary = typeof value.boundary === 'string' ? value.boundary : '';
      const gateLabel = boundary ? checkpointGateLabel(boundary) : '检查点';
      await patch(buildCheckpointAnsweredCard(title, gateLabel, r.ok ? approved : null));
    }
  }

  const dispatcher = createDispatcher(
    botOpenId,
    logger,
    botStartTime,
    async (msg) => {
      if (msg.chatType === 'group' && !msg.isMentioned) {
        // 已被 managed 认领的群（立项群：一需求一群，bot 是群成员）内的消息不强制 @bot——收料/追问是
        // 高频多轮，逐条 @ 体验差，且文件消息（PRD）无法附带 @。其它群仍需 @bot 才响应；下方白名单门仍生效。
        if (store.getThreadClaim(msg.chatId)?.owner_kind !== 'managed') {
          return;
        }
      }
      const isAdmin = config.allowedOpenIds.has(msg.userId);
      if (!isAdmin && !store.isAllowed(msg.userId)) {
        logger.warn(
          {
            userId: msg.userId,
            chatType: msg.chatType,
            text: msg.text.slice(0, 50),
          },
          'unauthorized sender, ignoring',
        );
        return;
      }

      if (msg.text.startsWith('/')) {
        await commands.dispatch(msg);
        return;
      }

      // M-I2: /req 后「等群名」待答——用户下一条普通消息即群名 → 建专属群发起立项。先于一切路由，
      // 因为此刻还没有 claim/任务可路由。空群名（如发了张图）→ 保留待答、回提示。
      if (pendingIntake.has(msg.userId, msg.chatId, Date.now())) {
        const groupName = msg.text.trim();
        if (!groupName) {
          await sender.reply(
            msg.messageId,
            '群名不能为空，请回一条文字作为群名（比如「订单导出」）。',
          );
          return;
        }
        const naming = pendingIntake.take(msg.userId, msg.chatId, Date.now());
        await startIntakeGroup(msg, naming?.description ?? '', groupName);
        return;
      }

      // WI-D/WI-5 + M-I2/3: consult the thread-claim registry BEFORE the bridge task fallback. A
      // managed (workitems) claim must not be swallowed by the bridge's root→task / recent-task
      // fallback. probe 按飞书话题 thread 认领；立项群按群 chatId 认领（群内消息常无 thread/root/
      // parent，故 thread 找不到再按 chatId 找）。
      const threadRoot = msg.threadId ?? msg.rootId ?? msg.parentId;
      let managedKey: string | undefined;
      let claim = threadRoot ? store.getThreadClaim(threadRoot) : undefined;
      if (claim?.owner_kind === 'managed') {
        managedKey = threadRoot;
      } else if (msg.chatType === 'group') {
        const byChat = store.getThreadClaim(msg.chatId);
        if (byChat?.owner_kind === 'managed') {
          claim = byChat;
          managedKey = msg.chatId;
        }
      }
      if (claim?.owner_kind === 'managed' && managedKey) {
        const item = workitems.api.getWorkItem(claim.owner_id);
        if (item) {
          // WI-7 P1: a terminal item (e.g. failed) keeps its claim until /done. Injecting a
          // follow-up would hit the reducer terminal short-circuit (recorded, never dispatched)
          // — so reply honestly instead of promising a report that never comes.
          if (isTerminalStatus(item.status)) {
            await sender.reply(msg.messageId, '该单元已结束，回复 `/done` 关闭后可重新发起。');
            return;
          }
          // 立项收料：群内普通消息当作「当前待填项」的值（缺哪项填哪项），写 intake_field_set 事件并
          // 刷新清单卡；非立项阶段才走普通追问注入。
          if (isIntakePhase(item.phase)) {
            await handleIntakeMessage(item, msg);
            return;
          }
          workitems.api.injectHumanMessage(item.id, {
            text: msg.text,
            feishuMsgId: msg.messageId,
          });
          await sender.reply(msg.messageId, '已转交，稍候进展会在本话题/群更新。');
          return;
        }
        // Owner vanished but the claim lingered — release it and fall through to normal bridge
        // routing instead of swallowing the message forever.
        logger.warn({ managedKey, ownerId: claim.owner_id }, 'managed claim with missing owner');
        store.releaseThreadClaim(managedKey);
      }

      const candidates = [msg.rootId, msg.parentId].filter((v): v is string => !!v);
      let task = candidates.length > 0 ? store.getTaskByRootMsg(candidates[0]!) : undefined;
      if (!task) {
        for (const id of candidates) {
          task = store.getTaskByMessageId(id);
          if (task) break;
        }
      }
      if (!task) {
        const currentId = store.getState(currentTaskKey(msg.chatId));
        if (currentId) {
          task = store.getBridgeTask(currentId);
          if (task) {
            logger.info(
              { fallbackTo: task.id, chatId: msg.chatId },
              'routed to current task in chat',
            );
          }
        }
      }
      if (!task) {
        task = store.mostRecentTaskInChat(msg.chatId);
        if (task) {
          logger.info(
            { fallbackTo: task.id, chatId: msg.chatId },
            'fallback to most recent task in chat',
          );
        }
      }
      if (!task) {
        await sender.reply(msg.messageId, '本会话没有任务，用 /new <name> 新建一个。');
        return;
      }

      store.recordTaskMessage(task.id, msg.messageId);
      store.logEvent(task.id, 'user', undefined, {
        text: msg.text,
        attachments: msg.attachments,
      });
      store.touchTask(task.id);

      if (msg.attachments.length > 0) {
        const inboxDir = path.join(task.cwd, 'inbox');
        try {
          fs.mkdirSync(inboxDir, { recursive: true });
        } catch (err) {
          logger.error({ err, inboxDir }, 'mkdir inbox failed');
          await sender.reply(msg.messageId, `[${task.display_name}] 创建 inbox 目录失败`);
          return;
        }
        const downloaded: string[] = [];
        for (let i = 0; i < msg.attachments.length; i++) {
          const a = msg.attachments[i]!;
          const safe = sanitizeName(a.name);
          const dest = path.join(inboxDir, `${msg.messageId}-${i}-${safe}`);
          const ok = await sender.downloadAttachment(msg.messageId, a.fileKey, a.kind, dest);
          if (ok) downloaded.push(dest);
        }
        if (downloaded.length === 0) {
          await sender.reply(msg.messageId, `[${task.display_name}] 附件下载失败`);
          return;
        }
        const expiresAt = Date.now() + ATTACHMENT_TTL_MS;
        const list = pendingAttachments.get(msg.chatId) ?? [];
        for (const p of downloaded) list.push({ path: p, expiresAt });
        pendingAttachments.set(msg.chatId, list);
        const ackLines = downloaded.map((p) => `- \`${p}\``).join('\n');
        const agentLabel = task.agent_kind === 'codex' ? 'Codex' : 'Claude';
        await sender.reply(
          msg.messageId,
          `[${task.display_name}] 已收到附件，存放在：\n${ackLines}\n\n下条消息会自动把这些路径告诉 ${agentLabel}。`,
        );
        if (!msg.text) return;
      }

      const input: TurnInput = {
        chatId: msg.chatId,
        messageId: msg.messageId,
        text: msg.text,
        parentId: msg.parentId,
      };
      if (runningTasks.has(task.id)) {
        const ok = enqueue(task.id, input);
        const depth = queues.get(task.id)?.length ?? 0;
        await sender.reply(
          msg.messageId,
          ok
            ? `[${task.display_name}] 正忙，已排队（队列第 ${depth} 位），处理完会自动接着跑。`
            : `[${task.display_name}] 队列已满（上限 ${MAX_QUEUE}），请稍后再发。`,
        );
        return;
      }
      void runWithDrain(task.id, input);
    },
    handleCardAction,
  );

  await wsClient.start({ eventDispatcher: dispatcher });
  // WS reconnect guard: the SDK's reconnect interval is a hard-coded 120s, so a dropped ws
  // leaves the bot "deaf" for up to 2 min. This proactively re-starts the ws once it's been
  // unhealthy past the grace window — start() is re-entrant (see feishu/ws-health.ts).
  startWsReconnectGuard({
    reconnect: () => wsClient.start({ eventDispatcher: dispatcher }),
    health: wsHealth,
    logger,
  });
  logger.info(
    { botOpenId, appId: config.feishu.appId, dataDir: config.dataDir },
    'agent-pipe ready',
  );

  // Bring up the workbench last, after the bridge is live. An 'error' listener keeps a bind
  // failure (e.g. EADDRINUSE) from taking down the whole bot — the board is best-effort.
  if (workbenchServer) {
    workbenchServer.on('error', (err) => {
      logger.error(
        { err, host: config.workbench.host, port: config.workbench.port },
        'workbench server error',
      );
    });
    workbenchServer.listen(config.workbench.port, config.workbench.host, () => {
      logger.info(
        { host: config.workbench.host, port: config.workbench.port },
        'workbench listening',
      );
    });
  }

  // 需求管控台同样最后拉起、best-effort（bind 失败只记日志，不拖垮 bot）。
  if (consoleServer) {
    consoleServer.on('error', (err) => {
      logger.error({ err, port: config.console.port }, 'requirement console server error');
    });
    consoleServer.listen(config.console.port, config.workbench.host, () => {
      logger.info(
        { host: config.workbench.host, port: config.console.port },
        'requirement console listening',
      );
    });
  }

  startHeartbeat(logger, () => ({
    uptimeSec: Math.floor(process.uptime()),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    runningTurns: runningTasks.size,
    queuedMessages: [...queues.values()].reduce((n, q) => n + q.length, 0),
    hotRunners: pool.hotCount(),
  }));

  const shutdown = () => {
    logger.info('shutting down');
    releaseResources();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// M1b WI-6: extract the IM chat id from a work item's source for the report fallback path
// (used when the anchor-card thread can't be reverse-looked-up).
export function createWorkitemsRuntime(deps: {
  config: Pick<Config, 'workitemsDbPath' | 'workitemsDir' | 'dataDir'>;
  logger: Logger;
  pool: AgentPool;
  sender: Pick<Sender, 'replyCard' | 'sendCard' | 'updateCard' | 'replyCardInThread'>;
  kernelStore: Store;
  defaultCwd: string;
  createContainer?: typeof createWorkitemsContainer;
}): WorkitemsContainer {
  const createContainer = deps.createContainer ?? createWorkitemsContainer;
  // WI-7: post-commit observer. Late-bound via a thunk because postStatus needs `workitems`
  // (the createContainer return value); the thunk defers the lookup until events actually
  // fire (well after assembly — create-time never emits onCommitted).
  let postStatus: (workitemId: string, event: WorkItemEvent) => void = () => {};
  const workitems = createContainer({
    dbPath: deps.config.workitemsDbPath,
    workitemsDir: deps.config.workitemsDir,
    backupsDir: path.join(deps.config.dataDir, 'backups'),
    logger: deps.logger,
    onCommitted: (workitemId, event) => postStatus(workitemId, event),
  });
  // M2 进度可见性：ProgressCards 是 run-handler 中性 RunProgressSink 的 feishu 实现。每轮 run
  // 一张实时流式卡（onRunStart 发卡 → onText/onToolUse 流式刷新 → onRunEnd 原地收尾成报告/失败/
  // 中断卡），合并了 WI-6 的报告回贴（不再独立 replyCard，报告就是流式卡的终态）。出站定位全部
  // 由 onRunStart 携带（run-handler 从 source 提取），本组件零 store 反查。
  const progressCards = new ProgressCards({
    sender: deps.sender,
    logger: deps.logger,
  });
  // T3: 灯卡 dedup — a checkpoint human wait gets exactly one interactive card. In-memory; a
  // restart may re-post (best-effort, like the anchor refresh). A 打回 re-raises a fresh wait id
  // → a new card, which is correct.
  const cardedWaits = new Set<string>();
  // Surface any new human checkpoint wait as an interactive 灯卡 replied under the anchor (so it
  // lands in the thread). The worktype owns the phase→灯 mapping (checkpointBoundaryOf/lights);
  // this kernel-exempt observer only renders + routes.
  const surfaceCheckpoints = async (
    workitemId: string,
    title: string,
    anchorMsgId: string,
  ): Promise<void> => {
    for (const w of workitems.store.listOpenWaits(workitemId)) {
      if (w.kind !== 'human' || cardedWaits.has(w.id)) continue;
      const boundary = checkpointBoundaryOf(w.reason);
      // 关卡灯(checkpoint:*) → 灯卡(通过/打回)；病历(对账冲突/监工判大/执行报错/集成未决) → 病历卡
      // (已处理·继续/取消整单)。二者皆非 → 跳过(如 cancel_confirm 走别的路径)。
      const caseLabel = boundary ? undefined : caseFileLabel(w.reason);
      if (!boundary && !caseLabel) continue;
      cardedWaits.add(w.id);
      const card = boundary
        ? buildCheckpointCard(
            { title, gateLabel: checkpointGateLabel(boundary), rail: checkpointRail(boundary) },
            { itemId: workitemId, waitId: w.id, boundary },
          )
        : buildCaseFileCard(
            {
              title,
              label: caseLabel!,
              detail: caseFileDetail(workitems.api.listEvents(workitemId), w.reason),
            },
            { itemId: workitemId, waitId: w.id },
          );
      const posted = await deps.sender.replyCard(anchorMsgId, card);
      if (!posted) cardedWaits.delete(w.id); // 发送失败 → 允许下一次事件重试
    }
  };
  // M1b WI-7 → M2: outbound status bridge — subscribe to committed events and refresh the
  // anchor card per anchorAction. M2: the failure card is now the streaming card's own
  // onRunEnd(failed) terminal patch (ProgressCards, one card per run), so this observer no
  // longer replies its own error card — anchorAction collapses run_failed to update-only.
  // The anchor refresh can't fall back (updateCard needs the original message id) so it logs.
  // T3: after the anchor refresh, surface any pending checkpoint as a 灯卡.
  postStatus = (workitemId, event) => {
    void (async () => {
      try {
        const item = workitems.api.getWorkItem(workitemId);
        if (!item) return;
        // 立项阶段：清单卡由 bridge 收料路径就地刷新（含立项 gate 按钮），观察者不插手，否则会用锚点卡
        // 覆盖清单卡。立项 gate 通过 → 进理解（非立项）→ 下面常规锚点刷新接管（卡 morph 成锚点卡）。
        if (isIntakePhase(item.phase)) return;
        // WI-8: anchor / 灯卡 both target the anchor card's own message id, not the thread root
        // (which keys routing / report replies).
        const anchorMsgId = deps.kernelStore.getThreadAnchorByOwner(workitemId);
        const { update } = anchorAction(event.kind, isTerminalStatus(item.status));
        if (update && anchorMsgId) {
          await deps.sender.updateCard(
            anchorMsgId,
            buildAnchorCard({
              id: item.id,
              title: item.title,
              stage: item.phase,
              status: item.status,
              noun: anchorNoun(item.type),
            }),
          );
        } else if (update) {
          deps.logger.warn({ workitemId }, 'no anchor to refresh');
        }
        if (anchorMsgId) await surfaceCheckpoints(workitemId, item.title, anchorMsgId);
      } catch (err) {
        deps.logger.error({ err, workitemId }, 'post status failed');
      }
    })();
  };
  // Production wiring: the real agent-run handler (drives the pool) replaces the noop
  // run handler; noop stays a test-only fixture (M1b WI-2/WI-3).
  registerProbe(workitems.registry);
  // requirement worktype (D-15): reuses the generic agent-run handler for owner/worker runs;
  // its own effect handlers (worker write run / integration_check / checkpoint) are layered
  // in later stages. Registered after probe so the shared 'run' handler covers both.
  registerRequirement(workitems.registry);
  // requirement workers run under the WRITE profile in their own worktree (Stage 4); probe
  // keeps the default readonly strategy. strategyFor picks per workitem type. Stage 5: each
  // worker also gets budget-bounded, freshness-flagged repo knowledge (repoKey == repo path).
  // The cold-index run that FILLS the knowledge docs is the live half (Stage 7); here we only
  // read+inject — a never-indexed repo yields undefined and the prompt simply omits the block.
  const knowledgeStore = new KnowledgeStore(path.join(deps.config.dataDir, 'knowledge'));
  const freshnessPolicy = loadFreshnessPolicy();
  const requirementStrategy = createRequirementRunStrategy({
    worktreesDir: path.join(deps.config.dataDir, 'worktrees'),
    knowledgeFor: (repo) =>
      composeRepoKnowledge(
        {
          store: knowledgeStore,
          policy: freshnessPolicy,
          budgetChars: KNOWLEDGE_BUDGET_CHARS,
          now: () => Date.now(),
        },
        repo,
        repo,
      ),
  });
  workitems.effects.registerHandler(
    createAgentRunHandler({
      pool: deps.pool,
      kernelStore: deps.kernelStore,
      defaultCwd: deps.defaultCwd,
      logger: deps.logger,
      progress: progressCards,
      strategyFor: (item) => (item.type === 'requirement' ? requirementStrategy : undefined),
    }),
  );
  // requirement 集成验证: static contract对账 effect (emits integration_check_passed/failed).
  workitems.effects.registerHandler(createIntegrationCheckHandler());
  // requirement 拆解阶段 owner 跨仓对账: static reconcile_check effect (PIVOT §3.1)。读 owner 对账产物
  // contract/reconcile.json + workitem.repos → emit reconcile_passed / reconcile_conflict（病历）。
  workitems.effects.registerHandler(createReconcileCheckHandler());
  // requirement 并行实现阶段监工科层 (PIVOT §4): static gatekeeper_review effect。扫各仓工人「疑则上报」→
  // 跨仓外溢/疑则判大 emit gatekeeper_big（病历）/ 纯本仓判小回写图纸 emit gatekeeper_passed → owner assess。
  workitems.effects.registerHandler(createGatekeeperReviewHandler());
  // 立项收尾 effect: 立项 gate 通过 → fold 立项填项历史 → 落立项书 intake/intake.md + 提升 repos
  // (emit repos_set)。注册在这里，与 agent-run / integration_check 同批，进理解时由 worktype 发起。
  workitems.effects.registerHandler(createIntakeFinalizeHandler());
  workitems.start();
  return workitems;
}

export function createReleaseResources(deps: {
  pool: Pick<AgentPool, 'killAll'>;
  workitems: Pick<WorkitemsContainer, 'stop'>;
  store: Pick<Store, 'close'>;
  pidPath: string;
  // HTML 工作台 server — closed first so it stops accepting requests before the store/pool it
  // reads through are torn down. Optional/nullable: absent when WORKBENCH_ENABLED=false.
  workbenchServer?: { close(): void } | null;
  // 需求管控台 server — 与 workbench 同样最先关停（停止读 store/pool）。可空：CONSOLE_ENABLED=false 时缺席。
  consoleServer?: { close(): void } | null;
  removePidFile?: typeof removeOwnPidFile;
}): () => void {
  return () => {
    try {
      deps.consoleServer?.close();
    } catch {
      /* ignore */
    }
    try {
      deps.workbenchServer?.close();
    } catch {
      /* ignore */
    }
    try {
      deps.pool.killAll();
    } catch {
      /* ignore */
    }
    try {
      deps.workitems.stop();
    } catch {
      /* ignore */
    }
    try {
      deps.store.close();
    } catch {
      /* ignore */
    }
    (deps.removePidFile ?? removeOwnPidFile)(deps.pidPath);
  };
}

function isCliEntrypoint(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCliEntrypoint()) {
  main().catch((err) => {
    console.error('fatal:', err);
    process.exit(1);
  });
}
