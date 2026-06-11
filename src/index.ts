import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { Store } from './store.js';
import { createFeishuClients } from './feishu/client.js';
import { createDispatcher } from './feishu/event-router.js';
import { Sender } from './feishu/sender.js';
import { CommandHandler, currentTaskKey } from './bridge/commands.js';
import { AgentPool } from './agents/pool.js';
import { createClaudeFactory } from './agents/claude/runner.js';
import { createCodexFactory } from './agents/codex/runner.js';
import { buildResultCard, buildProcessingCard, buildStatusCard } from './feishu/card.js';
import type { ProgressCallbacks } from './agents/types.js';
import type { Task } from './store.js';
import { StreamingCard } from './feishu/stream-card.js';
import { installCrashGuard, startHeartbeat } from './lifecycle.js';
import { scheduleDailyBackup } from './backup.js';

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

async function fetchBotOpenId(client: any, logger: Logger): Promise<string> {
  for (let i = 0; i < 3; i++) {
    try {
      const resp = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
      const openId = resp?.data?.bot?.open_id ?? resp?.bot?.open_id ?? '';
      if (openId) return openId;
    } catch (err) {
      logger.warn({ err, attempt: i + 1 }, 'fetch bot info failed, retrying');
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return '';
}

function ensureSingleInstance(pidPath: string, logger: Logger): void {
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
  const { client, wsClient } = createFeishuClients(config.feishu.appId, config.feishu.appSecret);
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
    { maxHot: config.maxHot },
    store,
    logger,
  );
  const runningTasks = new Set<string>();
  const botStartTime = Date.now();

  // Shared by graceful shutdown (exit 0) and the crash guard (exit 1) — the
  // supervisor restarts us only on non-zero exit.
  const releaseResources = () => {
    try {
      pool.killAll();
    } catch {
      /* ignore */
    }
    try {
      store.close();
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(pidPath);
    } catch {
      /* ignore */
    }
  };
  installCrashGuard(logger, releaseResources);
  scheduleDailyBackup(store, path.join(config.dataDir, 'backups'), logger);

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
    name.replace(/[/\\\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file';

  // ---- per-task serial execution: queue while busy, drain after each turn ----
  type TurnInput = { chatId: string; messageId: string; text: string; parentId?: string };
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
    v
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

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
        const dest = path.join(inboxDir, `replied-${parentId}-${sanitizeName(m.fileName ?? 'file')}`);
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
      const callbacks: ProgressCallbacks | undefined = streaming
        ? {
            onToolUse: (_id, t) => streaming.onToolUse(t.name),
            onText: (_id, full) => streaming.onText(full),
          }
        : undefined;

      let result;
      try {
        result = await pool.send(task, prompt, callbacks);
      } finally {
        await streaming?.stop();
      }

      const card = buildResultCard(task.display_name, result);
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
  );

  const dispatcher = createDispatcher(botOpenId, logger, botStartTime, async (msg) => {
    if (msg.chatType === 'group' && !msg.isMentioned) {
      return;
    }
    const isAdmin = config.allowedOpenIds.has(msg.userId);
    if (!isAdmin && !store.isAllowed(msg.userId)) {
      logger.warn(
        { userId: msg.userId, chatType: msg.chatType, text: msg.text.slice(0, 50) },
        'unauthorized sender, ignoring',
      );
      return;
    }

    if (msg.text.startsWith('/')) {
      await commands.dispatch(msg);
      return;
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
        task = store.getTask(currentId);
        if (task) {
          logger.info({ fallbackTo: task.id, chatId: msg.chatId }, 'routed to current task in chat');
        }
      }
    }
    if (!task) {
      task = store.mostRecentTaskInChat(msg.chatId);
      if (task) {
        logger.info({ fallbackTo: task.id, chatId: msg.chatId }, 'fallback to most recent task in chat');
      }
    }
    if (!task) {
      await sender.reply(msg.messageId, '本会话没有任务，用 /new <name> 新建一个。');
      return;
    }

    store.recordTaskMessage(task.id, msg.messageId);
    store.logEvent(task.id, 'user', undefined, { text: msg.text, attachments: msg.attachments });
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
  });

  await wsClient.start({ eventDispatcher: dispatcher });
  logger.info({ botOpenId, appId: config.feishu.appId, dataDir: config.dataDir }, 'agent-pipe ready');

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

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
