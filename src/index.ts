import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { Store } from './store.js';
import { createFeishuClients } from './feishu/client.js';
import { createDispatcher } from './feishu/event-router.js';
import { Sender } from './feishu/sender.js';
import { CommandHandler, CURRENT_TASK_KEY } from './bridge/commands.js';
import { AgentPool } from './agents/pool.js';
import { createClaudeFactory } from './agents/claude/runner.js';
import { createCodexFactory } from './agents/codex/runner.js';
import { buildResultCard, buildProcessingCard } from './feishu/card.js';

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
  const commands = new CommandHandler(store, sender, config, logger, pool);
  const runningTasks = new Set<string>();
  const botStartTime = Date.now();

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
      const currentId = store.getState(CURRENT_TASK_KEY);
      if (currentId) {
        task = store.getTask(currentId);
        if (task) {
          logger.info({ fallbackTo: task.id }, 'routed to current task');
        }
      }
    }
    if (!task) {
      task = store.mostRecentTask();
      if (task) {
        logger.info({ fallbackTo: task.id }, 'fallback to most recent task');
      }
    }
    if (!task) {
      await sender.reply(msg.messageId, '没有任何任务，用 /new <name> 新建一个。');
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

    if (runningTasks.has(task.id)) {
      await sender.reply(msg.messageId, `[${task.display_name}] 正忙，请等当前消息处理完`);
      return;
    }
    runningTasks.add(task.id);
    try {
      const ackCardId = await sender.replyCard(
        msg.messageId,
        buildProcessingCard(task.display_name, task.agent_kind),
      );
      if (ackCardId) store.recordTaskMessage(task.id, ackCardId);
      const pendingPaths = drainPending(msg.chatId);
      const prompt =
        pendingPaths.length > 0
          ? `[已附加文件，请读取以下路径后继续处理]\n${pendingPaths.map((p) => `- ${p}`).join('\n')}\n\n${msg.text}`
          : msg.text;
      const result = await pool.send(task, prompt);
      const card = buildResultCard(task.display_name, result);
      if (ackCardId) {
        const ok = await sender.updateCard(ackCardId, card);
        if (!ok) {
          const replyId = await sender.replyCard(msg.messageId, card);
          if (replyId) store.recordTaskMessage(task.id, replyId);
        }
      } else {
        const replyId = await sender.replyCard(msg.messageId, card);
        if (replyId) store.recordTaskMessage(task.id, replyId);
      }
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'task execution failed');
      const failId = await sender.reply(
        msg.messageId,
        `[${task.display_name}] 执行失败: ${(err as Error).message}`,
      );
      if (failId) store.recordTaskMessage(task.id, failId);
    } finally {
      runningTasks.delete(task.id);
    }
  });

  await wsClient.start({ eventDispatcher: dispatcher });
  logger.info({ botOpenId, appId: config.feishu.appId, dataDir: config.dataDir }, 'agent-pipe ready');

  const shutdown = () => {
    logger.info('shutting down');
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
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
