import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Store, AgentKind } from '../store.js';
import type { Sender } from '../feishu/sender.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { IncomingMessage } from '../feishu/types.js';
import type { AgentPool } from '../agents/pool.js';
import { buildTaskRootCard } from '../feishu/card.js';
import { isImagePath } from '../feishu/sender.js';

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;

const HELP_TEXT = [
  '命令:',
  '  /new <name> [--agent claude|codex] [--cwd <path>] [--model <m>]  新建任务（自动切为当前任务）',
  '  /list                                     任务列表（★ 标出本会话当前）',
  '  /use <name>                               切换本会话当前任务',
  '  /use                                      查看本会话当前任务',
  '  /agent <name> <claude|codex>              切换任务 agent（清空上下文，保留 cwd）',
  '  /agent <name>                             查看任务当前 agent',
  '  /model <name> <m>                         切换任务 model',
  '  /model <name>                             查看任务 model',
  '  /status                                   bot 状态',
  '  /stop <name>                              中止任务当前轮',
  '  /clear <name>                             清空任务会话上下文（下条消息开新会话）',
  '  /compact <name>                           压缩上下文为摘要后重置会话（保留要点）',
  '  /get <path>                               从本会话当前任务的 cwd 取文件/图片回发',
  '  /export [name]                            导出 resume 命令（在本地 CLI 接着聊；省略 name 用本会话当前任务）',
  '  /rm <name>                                删除任务',
  '  /wl                                       列出白名单',
  '  /wl add @某人 [@某人...]                   把 @ 的人加入白名单',
  '  /wl add <open_id>                         按 ID 加入',
  '  /wl rm @某人 / <open_id>                   移除',
  '  /help                                     本帮助',
  '',
  '普通消息（不带 /）：优先发给本会话当前任务；若无则发给本会话最近活跃。',
  '回复任务主帖/或任务历史消息：发给该任务。',
].join('\n');

export const currentTaskKey = (chatId: string): string => `current_task:${chatId}`;

export class CommandHandler {
  constructor(
    private store: Store,
    private sender: Sender,
    private config: Config,
    private logger: Logger,
    private pool: AgentPool,
    private onCompact: (taskId: string, replyMsgId: string) => void,
    private onStop: (taskId: string) => { aborted: boolean; dropped: number },
  ) {}

  private isAdmin(openId: string): boolean {
    return this.config.allowedOpenIds.has(openId);
  }

  async dispatch(msg: IncomingMessage): Promise<void> {
    const tokens = msg.text.trim().split(/\s+/);
    const cmd = tokens[0] ?? '';
    const rest = tokens.slice(1);
    try {
      switch (cmd) {
        case '/new':
          await this.handleNew(msg, rest);
          return;
        case '/list':
          await this.handleList(msg);
          return;
        case '/status':
          await this.handleStatus(msg);
          return;
        case '/stop':
          await this.handleStop(msg, rest);
          return;
        case '/clear':
          await this.handleClear(msg, rest);
          return;
        case '/compact':
          await this.handleCompact(msg, rest);
          return;
        case '/get':
          await this.handleGet(msg, rest);
          return;
        case '/export':
          await this.handleExport(msg, rest);
          return;
        case '/use':
          await this.handleUse(msg, rest);
          return;
        case '/agent':
          await this.handleAgent(msg, rest);
          return;
        case '/model':
          await this.handleModel(msg, rest);
          return;
        case '/wl':
          await this.handleWl(msg, rest);
          return;
        case '/rm':
          await this.handleRm(msg, rest);
          return;
        case '/help':
          await this.sender.reply(msg.messageId, HELP_TEXT);
          return;
        default:
          await this.sender.reply(msg.messageId, `未知命令: ${cmd}\n\n${HELP_TEXT}`);
      }
    } catch (err) {
      this.logger.error({ err, cmd }, 'command error');
      await this.sender.reply(msg.messageId, `命令执行失败: ${(err as Error).message}`);
    }
  }

  private async handleNew(msg: IncomingMessage, rest: string[]): Promise<void> {
    const { positional, flags } = parseArgs(rest);
    const name = positional[0];
    if (!name) {
      await this.sender.reply(
        msg.messageId,
        '用法: /new <name> [--agent claude|codex] [--cwd <path>] [--model <m>]',
      );
      return;
    }
    if (!SLUG_RE.test(name)) {
      await this.sender.reply(msg.messageId, 'name 只能用字母/数字/下划线/连字符，长度 ≤ 41');
      return;
    }
    if (this.store.getTask(name)) {
      await this.sender.reply(msg.messageId, `任务 ${name} 已存在`);
      return;
    }

    const agentArg = flags.agent;
    let agentKind: AgentKind = this.config.defaultAgent;
    if (agentArg) {
      if (agentArg !== 'claude' && agentArg !== 'codex') {
        await this.sender.reply(msg.messageId, `--agent 只支持 claude 或 codex，收到: ${agentArg}`);
        return;
      }
      agentKind = agentArg;
    }

    let mode: 'project' | 'sandbox' = 'sandbox';
    let cwd = path.join(this.config.sessionsDir, name);

    const rawCwd = flags.cwd;
    if (rawCwd) {
      const resolved = this.resolveCwd(rawCwd);
      if (typeof resolved !== 'string') {
        await this.sender.reply(msg.messageId, resolved.error);
        return;
      }
      mode = 'project';
      cwd = resolved;
    } else {
      fs.mkdirSync(cwd, { recursive: true });
    }

    const task = this.store.createTask({
      id: name,
      display_name: name,
      agent_kind: agentKind,
      mode,
      cwd,
      root_msg_id: null,
      root_chat_id: null,
      agent_session_id: null,
      status: 'suspended',
      model: flags.model ?? null,
    });

    const rootMsgId = await this.sender.sendCard(msg.chatId, buildTaskRootCard(task));
    if (!rootMsgId) {
      this.store.deleteTask(task.id);
      await this.sender.reply(msg.messageId, '任务主帖发送失败，已回滚');
      return;
    }
    this.store.setRootMsg(task.id, rootMsgId, msg.chatId);
    this.store.recordTaskMessage(task.id, rootMsgId);
    this.store.setState(currentTaskKey(msg.chatId), task.id);
  }

  private async handleList(msg: IncomingMessage): Promise<void> {
    const tasks = this.store.listTasks();
    if (tasks.length === 0) {
      await this.sender.reply(msg.messageId, '还没有任务。用 /new <name> 新建。');
      return;
    }
    const current = this.store.getState(currentTaskKey(msg.chatId));
    const lines = tasks.map((t) => {
      const age = humanDuration(Date.now() - t.last_active_at);
      const mark = t.id === current ? '★' : '•';
      return `${mark} ${t.display_name}  [${t.agent_kind}/${t.status}] (${t.mode})  ${age}前活跃\n    ${t.cwd}`;
    });
    await this.sender.reply(msg.messageId, `任务 ${tasks.length} 个 (★=本会话当前):\n${lines.join('\n')}`);
  }

  private async handleStatus(msg: IncomingMessage): Promise<void> {
    const tasks = this.store.listTasks();
    const hot = tasks.filter((t) => t.status === 'hot').length;
    const susp = tasks.filter((t) => t.status === 'suspended').length;
    const text = [
      'agent-pipe 运行中',
      `PID: ${process.pid}`,
      `Uptime: ${humanDuration(process.uptime() * 1000)}`,
      `任务: ${tasks.length}  (hot=${hot}, suspended=${susp})`,
      `Hot 槽位: ${this.pool.hotCount()}/${this.config.maxHot}`,
    ].join('\n');
    await this.sender.reply(msg.messageId, text);
  }

  private async handleUse(msg: IncomingMessage, rest: string[]): Promise<void> {
    const key = currentTaskKey(msg.chatId);
    const name = rest[0];
    if (!name) {
      const cur = this.store.getState(key);
      if (!cur) {
        await this.sender.reply(msg.messageId, '本会话未选中任务。用 /use <name> 切换。');
      } else {
        await this.sender.reply(msg.messageId, `本会话当前任务: ${cur}`);
      }
      return;
    }
    const task = this.store.getTask(name);
    if (!task) {
      await this.sender.reply(msg.messageId, `任务不存在: ${name}`);
      return;
    }
    this.store.setState(key, name);
    await this.sender.reply(msg.messageId, `本会话已切换当前任务 → ${name}`);
  }

  private async handleAgent(msg: IncomingMessage, rest: string[]): Promise<void> {
    const name = rest[0];
    if (!name) {
      await this.sender.reply(msg.messageId, '用法: /agent <name> [<claude|codex>]');
      return;
    }
    const task = this.store.getTask(name);
    if (!task) {
      await this.sender.reply(msg.messageId, `任务不存在: ${name}`);
      return;
    }
    const newKind = rest[1];
    if (!newKind) {
      await this.sender.reply(msg.messageId, `[${name}] 当前 agent: ${task.agent_kind}`);
      return;
    }
    if (newKind !== 'claude' && newKind !== 'codex') {
      await this.sender.reply(msg.messageId, `agent 只支持 claude / codex，收到: ${newKind}`);
      return;
    }
    if (newKind === task.agent_kind) {
      await this.sender.reply(msg.messageId, `[${name}] 已经是 ${newKind}，无需切换`);
      return;
    }
    if (this.pool.isBusy(name)) {
      await this.sender.reply(msg.messageId, `[${name}] 正忙，等当前消息处理完再切 agent`);
      return;
    }
    this.store.setAgentKind(name, newKind);
    this.store.clearAgentSessionId(name);
    this.pool.respawn(name);
    await this.sender.reply(
      msg.messageId,
      `[${name}] agent: ${task.agent_kind} → ${newKind}\n上下文已清空，工作目录保留 (${task.cwd})。`,
    );
  }

  private async handleModel(msg: IncomingMessage, rest: string[]): Promise<void> {
    const name = rest[0];
    if (!name) {
      await this.sender.reply(msg.messageId, '用法: /model <name> [<model>]');
      return;
    }
    const task = this.store.getTask(name);
    if (!task) {
      await this.sender.reply(msg.messageId, `任务不存在: ${name}`);
      return;
    }
    const newModel = rest.slice(1).join(' ').trim();
    if (!newModel) {
      await this.sender.reply(
        msg.messageId,
        `[${name}] 当前 model: ${task.model ?? '(默认)'}  agent: ${task.agent_kind}`,
      );
      return;
    }
    if (this.pool.isBusy(name)) {
      await this.sender.reply(msg.messageId, `[${name}] 正忙，等当前消息处理完再换 model`);
      return;
    }
    const factory = this.pool.factoryFor(task.agent_kind);
    this.store.setModel(name, newModel);
    if (factory.modelChangeRequiresRespawn()) {
      this.store.clearAgentSessionId(name);
      this.pool.respawn(name);
      await this.sender.reply(
        msg.messageId,
        `[${name}] model → ${newModel}\n注意：当前 agent (${task.agent_kind}) 切模型会清空会话上下文，下条消息开全新会话。`,
      );
    } else {
      await this.sender.reply(
        msg.messageId,
        `[${name}] model → ${newModel}  (${task.agent_kind} 切模型不影响上下文)`,
      );
    }
  }

  private resolveCwd(raw: string): string | { error: string } {
    const home = process.env.HOME ?? '';
    const expanded = raw.startsWith('~') ? path.join(home, raw.slice(1)) : raw;

    if (path.isAbsolute(expanded)) {
      const abs = path.resolve(expanded);
      const allowed = this.config.allowedCwdPrefixes.some(
        (p) => abs === p || abs.startsWith(p + path.sep),
      );
      if (!allowed) return { error: `cwd 不在 ALLOWED_CWD_PREFIXES 内: ${abs}` };
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        return { error: `cwd 不存在或不是目录: ${abs}` };
      }
      return abs;
    }

    const q = expanded.toLowerCase();
    const matches: string[] = [];
    for (const prefix of this.config.allowedCwdPrefixes) {
      try {
        const entries = fs.readdirSync(prefix, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          if (e.name.toLowerCase().includes(q)) {
            matches.push(path.join(prefix, e.name));
          }
        }
      } catch {
        /* prefix may not exist */
      }
    }
    if (matches.length === 0) {
      return { error: `没有找到匹配 "${raw}" 的目录（搜索范围: ${this.config.allowedCwdPrefixes.join(', ')}）` };
    }
    if (matches.length > 1) {
      const list = matches.map((m) => `  ${m}`).join('\n');
      return { error: `匹配多个，请用完整路径或更具体的关键词:\n${list}` };
    }
    return matches[0]!;
  }

  private async handleWl(msg: IncomingMessage, rest: string[]): Promise<void> {
    const sub = rest[0];

    if (!sub) {
      const list = this.store.listWhitelist();
      if (list.length === 0) {
        await this.sender.reply(msg.messageId, '白名单为空');
        return;
      }
      const lines = list.map(
        (w, i) => `${i + 1}. ${w.name ?? '(no name)'}  ${w.open_id}`,
      );
      await this.sender.reply(msg.messageId, `白名单 ${list.length} 人:\n${lines.join('\n')}`);
      return;
    }

    if (sub === 'add' || sub === 'rm') {
      if (!this.isAdmin(msg.userId)) {
        await this.sender.reply(msg.messageId, '只有管理员能修改白名单');
        return;
      }
      const targets: Array<{ openId: string; name?: string }> = [];
      for (const m of msg.mentions) targets.push({ openId: m.openId, name: m.name });
      for (const arg of rest.slice(1)) {
        if (arg.startsWith('ou_')) targets.push({ openId: arg });
      }
      if (targets.length === 0) {
        await this.sender.reply(
          msg.messageId,
          `用法: /wl ${sub} @某人  或  /wl ${sub} ou_xxx`,
        );
        return;
      }
      const results: string[] = [];
      for (const t of targets) {
        if (sub === 'add') {
          const ok = this.store.addWhitelist(t.openId, t.name);
          results.push(`${ok ? '+' : '='} ${t.name ?? t.openId}`);
        } else {
          const ok = this.store.removeWhitelist(t.openId);
          results.push(`${ok ? '-' : '×'} ${t.name ?? t.openId}`);
        }
      }
      await this.sender.reply(
        msg.messageId,
        `${sub === 'add' ? '加入' : '移除'} (+ 成功 / = 已存在 / - 移除 / × 不存在):\n${results.join('\n')}`,
      );
      return;
    }

    await this.sender.reply(msg.messageId, '用法: /wl [add|rm] @某人 / open_id');
  }

  private async handleStop(msg: IncomingMessage, rest: string[]): Promise<void> {
    const name = rest[0];
    if (!name) {
      await this.sender.reply(msg.messageId, '用法: /stop <name>');
      return;
    }
    const task = this.store.getTask(name);
    if (!task) {
      await this.sender.reply(msg.messageId, `任务不存在: ${name}`);
      return;
    }
    const { aborted, dropped } = this.onStop(name);
    const parts: string[] = [];
    if (aborted) parts.push('已中断当前轮');
    if (dropped > 0) parts.push(`清空排队 ${dropped} 条`);
    await this.sender.reply(
      msg.messageId,
      `[${name}] ${parts.length > 0 ? parts.join('，') : '没有运行中的进程，也没有排队消息'}`,
    );
  }

  private async handleClear(msg: IncomingMessage, rest: string[]): Promise<void> {
    const name = rest[0];
    if (!name) {
      await this.sender.reply(msg.messageId, '用法: /clear <name>');
      return;
    }
    const task = this.store.getTask(name);
    if (!task) {
      await this.sender.reply(msg.messageId, `任务不存在: ${name}`);
      return;
    }
    if (this.pool.isBusy(name)) {
      await this.sender.reply(msg.messageId, `[${name}] 正忙，等当前消息处理完再 clear`);
      return;
    }
    this.store.clearAgentSessionId(name);
    this.pool.respawn(name);
    await this.sender.reply(
      msg.messageId,
      `[${name}] 已清空会话上下文，下条消息开全新会话。`,
    );
  }

  private async handleCompact(msg: IncomingMessage, rest: string[]): Promise<void> {
    const name = rest[0];
    if (!name) {
      await this.sender.reply(msg.messageId, '用法: /compact <name>');
      return;
    }
    const task = this.store.getTask(name);
    if (!task) {
      await this.sender.reply(msg.messageId, `任务不存在: ${name}`);
      return;
    }
    // Busy handling + the summarize→reset turn run in index.ts (shares the task's
    // serial slot so /compact can't race an in-flight turn).
    this.onCompact(name, msg.messageId);
  }

  private resolveTaskForChat(chatId: string) {
    const currentId = this.store.getState(currentTaskKey(chatId));
    if (currentId) {
      const t = this.store.getTask(currentId);
      if (t) return t;
    }
    return this.store.mostRecentTaskInChat(chatId);
  }

  private async handleGet(msg: IncomingMessage, rest: string[]): Promise<void> {
    const raw = stripWrappingQuotes(rest.join(' ').trim());
    if (!raw) {
      await this.sender.reply(msg.messageId, '用法: /get <path>  (相对路径基于本会话当前任务的 cwd)');
      return;
    }
    const task = this.resolveTaskForChat(msg.chatId);
    if (!task) {
      await this.sender.reply(msg.messageId, '本会话没有任务，用 /new <name> 新建一个。');
      return;
    }
    const home = process.env.HOME ?? '';
    const expanded = raw.startsWith('~') ? path.join(home, raw.slice(1)) : raw;
    const candidate = path.resolve(path.isAbsolute(expanded) ? expanded : path.join(task.cwd, expanded));

    let realPath: string;
    let realCwd: string;
    try {
      realPath = fs.realpathSync(candidate);
      realCwd = fs.realpathSync(task.cwd);
    } catch (err) {
      await this.sender.reply(
        msg.messageId,
        `[${task.display_name}] 路径无法解析: ${(err as Error).message}`,
      );
      return;
    }
    const inside = realPath === realCwd || realPath.startsWith(realCwd + path.sep);
    if (!inside) {
      await this.sender.reply(
        msg.messageId,
        `[${task.display_name}] 路径不在任务 cwd 内（解析后）: ${realPath}\n  cwd: ${realCwd}`,
      );
      return;
    }
    const result = isImagePath(realPath)
      ? await this.sender.replyImageFromPath(msg.messageId, realPath)
      : await this.sender.replyFileFromPath(msg.messageId, realPath);
    if (!result.ok) {
      await this.sender.reply(msg.messageId, `[${task.display_name}] /get 失败: ${result.error}`);
      return;
    }
    if (result.messageId) {
      this.store.recordTaskMessage(task.id, result.messageId);
    }
    this.store.logEvent(task.id, 'sent_file', undefined, { path: realPath });
  }

  private async handleExport(msg: IncomingMessage, rest: string[]): Promise<void> {
    const name = rest[0];
    const task = name ? this.store.getTask(name) : this.resolveTaskForChat(msg.chatId);
    if (!task) {
      await this.sender.reply(
        msg.messageId,
        name ? `任务不存在: ${name}` : '本会话没有任务。先用 /new <name> 新建并跑过消息后再 /export。',
      );
      return;
    }
    if (!task.agent_session_id) {
      await this.sender.reply(
        msg.messageId,
        `[${task.display_name}] 还没有会话可导出（任务尚未跑过或刚被 /clear）。先发一条消息产生会话再 /export。`,
      );
      return;
    }
    const cwd = shellQuote(task.cwd);
    const sid = task.agent_session_id;
    // 任务设过自定义 model 就带上，本地接续不掉回默认模型；--model 与 runner 传参一致。
    const modelFlag = task.model ? ` --model ${shellQuote(task.model)}` : '';
    // claude: `--resume <id>`；codex: `resume <id>`（交互式接续同一 rollout）。
    const resume =
      task.agent_kind === 'codex'
        ? `cd ${cwd} && codex resume ${sid}${modelFlag}`
        : `cd ${cwd} && claude --resume ${sid}${modelFlag}`;
    await this.sender.reply(
      msg.messageId,
      `[${task.display_name}] resume 到本地 CLI（复制整行执行）:\n${resume}\n\n⚠️ 本地接续期间别再在飞书给该任务发消息，避免两端同时写同一会话。`,
    );
  }

  // Intentionally not isAdmin-gated: the whitelist itself is the trust boundary
  // for this bot, so any whitelisted user can rm/clear/agent-switch any task.
  // If you need finer-grained isolation, gate these on isAdmin or add per-task ownership.
  private async handleRm(msg: IncomingMessage, rest: string[]): Promise<void> {
    const name = rest[0];
    if (!name) {
      await this.sender.reply(msg.messageId, '用法: /rm <name>');
      return;
    }
    const task = this.store.getTask(name);
    if (!task) {
      await this.sender.reply(msg.messageId, `任务不存在: ${name}`);
      return;
    }
    this.pool.respawn(name);
    this.store.deleteTask(name);
    this.store.clearCurrentForTask(name);
    if (task.mode === 'sandbox') {
      try {
        fs.rmSync(task.cwd, { recursive: true, force: true });
      } catch (err) {
        this.logger.warn({ err, cwd: task.cwd }, 'failed to rm sandbox dir');
      }
    }
    const suffix = task.mode === 'sandbox' ? '（含 sandbox 目录）' : '（保留项目目录）';
    await this.sender.reply(msg.messageId, `已删除任务 ${name}${suffix}`);
  }
}

function parseArgs(tokens: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined) continue;
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(t);
    }
  }
  return { positional, flags };
}

// POSIX single-quote wrapping so cwds with spaces (or other shell metachars)
// paste safely. Embedded single quotes become the classic '\'' sequence.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function stripWrappingQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function humanDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}
