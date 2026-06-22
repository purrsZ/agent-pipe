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
  buildProcessingCard,
  buildQuestionAnsweredCard,
  buildQuestionCard,
  buildResultCard,
  buildStatusCard,
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
import { createWorkitemsContainer, type WorkitemsContainer } from './workitems/container.js';
import { OpenLimitError } from './workitems/errors.js';
import { isTerminalStatus } from './workitems/shared.js';
import type { WorkItem, WorkItemEvent } from './workitems/types.js';
import { createAgentRunHandler } from './worktypes/agent-run/run-handler.js';
import { registerProbe } from './worktypes/probe/index.js';
import { registerRequirement } from './worktypes/requirement/index.js';
import { createIntegrationCheckHandler } from './worktypes/requirement/integration.js';
import { createRequirementRunStrategy } from './worktypes/requirement/worker-handler.js';

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
  const botStartTime = Date.now();

  const releaseResources = createReleaseResources({ pool, workitems, store, pidPath });
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
        ? buildQuestionCard(task.display_name, pendingQuestion, {
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
        }),
      );
    }
    await sender.reply(msg.messageId, `已关闭调查 ${item.id}。`);
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
  );

  // Card button callbacks (R06/D-12) all arrive through one onCardAction; route by value.kind
  // so other kinds (requirement checkpoints) can be added alongside the AskUserQuestion path.
  async function handleCardAction(action: CardAction): Promise<void> {
    const value = (action.value ?? {}) as Record<string, unknown>;
    if (value.kind !== AUQ_ACTION_KIND) {
      logger.warn({ kind: value.kind }, 'unhandled card action kind');
      return;
    }
    if (!config.allowedOpenIds.has(action.operatorId) && !store.isAllowed(action.operatorId)) {
      logger.warn({ operatorId: action.operatorId }, 'unauthorized card action, ignoring');
      return;
    }
    const taskId = typeof value.taskId === 'string' ? value.taskId : '';
    const chatId = typeof value.chatId === 'string' ? value.chatId : '';
    const label = typeof value.label === 'string' ? value.label : '';
    const header = typeof value.header === 'string' ? value.header : '';
    if (!taskId || !label) {
      logger.warn({ taskId, label }, 'auq card action missing taskId/label');
      return;
    }
    const task = store.getTask(taskId);
    if (!task) {
      logger.warn({ taskId }, 'auq card action for unknown task');
      return;
    }
    // Patch the question card to a terminal "已选 X" so it can't be answered twice.
    if (action.messageId) {
      await sender.updateCard(
        action.messageId,
        buildQuestionAnsweredCard(task.display_name, label),
      );
    }
    // Feed the choice back as the next turn — same --resume path as a normal reply, since the
    // CLI no longer accepts a tool_result for the (already auto-closed) AskUserQuestion.
    const text = header ? `针对「${header}」，我选择：${label}` : label;
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

  const dispatcher = createDispatcher(
    botOpenId,
    logger,
    botStartTime,
    async (msg) => {
      if (msg.chatType === 'group' && !msg.isMentioned) {
        return;
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

      // WI-D/WI-5: consult the thread-claim registry BEFORE the bridge task fallback. A
      // thread claimed by the managed (workitems) layer must not be swallowed by the bridge's
      // root→task / recent-task fallback — the follow-up is routed into the owning work
      // item's next round instead.
      // 话题路由优先：话题里的追问带 thread_id（= 锚点卡创建话题时的 claim key）；回退到回复根。
      const threadRoot = msg.threadId ?? msg.rootId ?? msg.parentId;
      if (threadRoot) {
        const claim = store.getThreadClaim(threadRoot);
        if (claim?.owner_kind === 'managed') {
          const item = workitems.api.getWorkItem(claim.owner_id);
          if (item) {
            // WI-7 P1: a terminal item (e.g. failed) keeps its claim until /done. Injecting a
            // follow-up would hit the reducer terminal short-circuit (recorded, never
            // dispatched) — so reply honestly instead of "已转交…稍候进展", which would promise
            // a report that never comes. /done still releases the claim and closes the card.
            if (isTerminalStatus(item.status)) {
              await sender.reply(
                msg.messageId,
                '该调查已结束，回复 `/done` 关闭后可重新发起 `/probe`。',
              );
              return;
            }
            workitems.api.injectHumanMessage(item.id, {
              text: msg.text,
              feishuMsgId: msg.messageId,
            });
            await sender.reply(msg.messageId, '已转交给调查，稍候进展会在本话题更新。');
            return;
          }
          // Owner vanished but the claim lingered — release it and fall through to normal
          // bridge routing instead of swallowing the message forever.
          logger.warn({ threadRoot, ownerId: claim.owner_id }, 'managed claim with missing owner');
          store.releaseThreadClaim(threadRoot);
        }
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
  // M1b WI-7 → M2: outbound status bridge — subscribe to committed events and refresh the
  // anchor card per anchorAction. M2: the failure card is now the streaming card's own
  // onRunEnd(failed) terminal patch (ProgressCards, one card per run), so this observer no
  // longer replies its own error card — anchorAction collapses run_failed to update-only.
  // The anchor refresh can't fall back (updateCard needs the original message id) so it logs.
  postStatus = (workitemId, event) => {
    void (async () => {
      try {
        const item = workitems.api.getWorkItem(workitemId);
        if (!item) return;
        const { update } = anchorAction(event.kind, isTerminalStatus(item.status));
        if (!update) return;
        // WI-8: anchor refresh targets the anchor card's own message id, not the thread
        // root (which now keys routing / report replies).
        const anchorMsgId = deps.kernelStore.getThreadAnchorByOwner(workitemId);
        if (anchorMsgId) {
          await deps.sender.updateCard(
            anchorMsgId,
            buildAnchorCard({
              id: item.id,
              title: item.title,
              stage: item.phase,
              status: item.status,
            }),
          );
        } else {
          deps.logger.warn({ workitemId }, 'no anchor to refresh');
        }
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
  // keeps the default readonly strategy. strategyFor picks per workitem type.
  const requirementStrategy = createRequirementRunStrategy({
    worktreesDir: path.join(deps.config.dataDir, 'worktrees'),
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
  workitems.start();
  return workitems;
}

export function createReleaseResources(deps: {
  pool: Pick<AgentPool, 'killAll'>;
  workitems: Pick<WorkitemsContainer, 'stop'>;
  store: Pick<Store, 'close'>;
  pidPath: string;
  removePidFile?: typeof removeOwnPidFile;
}): () => void {
  return () => {
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
