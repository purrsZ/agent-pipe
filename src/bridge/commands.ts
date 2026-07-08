import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Store, AgentKind } from '../store.js';
import type { Sender } from '../feishu/sender.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { IncomingMessage } from '../feishu/types.js';
import type { AgentPool } from '../agents/pool.js';
import { buildTaskRootCard, shortenHome } from '../feishu/card.js';
import { isImagePath } from '../feishu/sender.js';

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
// 别名放开点号（pos2.0 这类版本味短名）。首字符仍限字母数字——删除哨兵 '-' 与路径样式（/ ~ .）
// 永远不可能是合法别名，简写糖的分词不会歧义。
const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

const HELP_TEXT = [
  '命令:',
  '  /new <name> [仓库] [--agent claude|codex] [--cwd <path>] [--model <m>]  新建任务（自动切为当前任务）',
  '      仓库 = 别名 / 仓名线索 / 路径，见 /repo；不给则开 sandbox 空目录',
  '  /repo                                     已登记仓库列表（[别名] 可直接用于 /new）',
  '  /repo <别名> <线索|路径>                   给仓库起别名（可加点号）；/repo <别名> - 删除',
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
  '  /probe [--repo <path>] <问题>             只读代码调查：缺省查默认目录、--repo 指定项目，过程+报告回贴到话题',
  '  /done                                     关闭当前调查（在其话题里回复）',
  '  /req [需求一句话]                          发起需求：建专属群，群内引导式收齐前置料(仓库/PRD/UI/验收)再开干',
  '  /cancel                                   在需求群里发起终止需求（需确认）',
  '  /scout <线索>                             立项群里让 AI 去本地找仓（给仓名/项目名，找到自动填入）',
  '  /delegate 8h                              开启本单委托（三灯到点自动通过）；/delegate off 撤销',
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
    private onDiagMcp: (taskId: string, replyMsgId: string) => void,
    private onDiagReadonly: (taskId: string, replyMsgId: string) => void,
    private onProbe: (msg: IncomingMessage, opts: { repo?: string; description: string }) => void,
    private onDone: (msg: IncomingMessage, threadRoot: string) => void,
    private onRequirement: (msg: IncomingMessage, opts: { description: string }) => void,
    // WS-10.8：/cancel 在需求群里发起终止需求（kernel 中性，与 onRequirement/onProbe 同型）。
    private onCancelUnit: (msg: IncomingMessage) => void,
    // INTAKE L1：/scout <线索> 在立项群里让 AI 找仓（kernel 中性，线索原文透传，业务处理在 index 侧）。
    private onScout: (msg: IncomingMessage, hints: string) => void,
    // DELEGATE D2.2：/delegate 在需求群里开启/撤销本单委托。参数原样透传（时长解析在 index 侧，
    // 本文件 kernel 中性、不掺业务语义）。
    private onDelegate: (msg: IncomingMessage, args: string[]) => void,
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
        case '/repo':
          await this.handleRepo(msg, rest);
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
        case '/diag-mcp':
          await this.handleDiagMcp(msg, rest);
          return;
        case '/diag-readonly':
          await this.handleDiagReadonly(msg, rest);
          return;
        case '/diag-slots':
          await this.handleDiagSlots(msg);
          return;
        case '/diag-claim':
          await this.handleDiagClaim(msg, rest);
          return;
        case '/diag-unclaim':
          await this.handleDiagUnclaim(msg, rest);
          return;
        case '/probe':
          await this.handleProbe(msg, rest);
          return;
        case '/done':
          await this.handleDone(msg);
          return;
        case '/req':
          await this.handleRequirement(msg, rest);
          return;
        case '/cancel':
          // WS-10.8：需求群里终止需求（需二次确认）。需求侧收到 /cancel 留言后升起取消确认。
          this.onCancelUnit(msg);
          return;
        case '/scout':
          // INTAKE L1：立项群里让 AI 找仓（线索 = /scout 之后的原文，透传给 index 侧解析）。
          await this.handleScout(msg, rest);
          return;
        case '/delegate':
          // DELEGATE D2.2：需求群里开启/撤销本单委托（睡前放权）。
          this.onDelegate(msg, rest);
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
        '用法: /new <name> [仓库] [--agent claude|codex] [--cwd <path>] [--model <m>]\n仓库 = 别名 / 仓名线索 / 路径（见 /repo）；不给则开 sandbox。',
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

    // 仓库寻址二选一：第二位置参数（别名/线索/路径，手机友好）或 --cwd（老逃生门）。都给拒收，
    // 避免静默采信其一。
    const repoHint = positional[1];
    const rawCwd = flags.cwd;
    if (repoHint && rawCwd) {
      await this.sender.reply(msg.messageId, '仓库参数和 --cwd 只能给一个');
      return;
    }
    const target = rawCwd ?? repoHint;
    if (target) {
      const resolved = rawCwd ? this.resolveCwd(rawCwd) : this.resolveRepoTarget(target);
      if (typeof resolved !== 'string') {
        await this.sender.reply(msg.messageId, resolved.error);
        return;
      }
      mode = 'project';
      cwd = resolved;
      this.registerRepoUse(cwd);
    } else {
      fs.mkdirSync(cwd, { recursive: true });
      // sandbox 空目录 git init：真机暴露过「not a git repository」会被 agent 当环境异常信号
      // （worktree 类工具也直接报错）。git 缺失不阻塞——sandbox 照常可用。
      try {
        execFileSync('git', ['init', '-q'], { cwd });
      } catch (err) {
        this.logger.warn({ err, cwd }, 'sandbox git init failed');
      }
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

    const repoAlias = mode === 'project' ? this.store.getRepoByPath(cwd)?.alias : undefined;
    const rootMsgId = await this.sender.sendCard(
      msg.chatId,
      buildTaskRootCard(task, repoAlias ?? undefined),
    );
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
      // 有别名的仓显示别名（路径缩 ~ 收进括号），手机上一眼认出任务落在哪个项目。
      const alias = this.store.getRepoByPath(t.cwd)?.alias;
      const loc = alias ? `${alias} (${shortenHome(t.cwd)})` : shortenHome(t.cwd);
      return `${mark} ${t.display_name}  [${t.agent_kind}/${t.status}] (${t.mode})  ${age}前活跃\n    ${loc}`;
    });
    await this.sender.reply(
      msg.messageId,
      `任务 ${tasks.length} 个 (★=本会话当前):\n${lines.join('\n')}`,
    );
  }

  // WI-A temporary diagnostic (admin-only): inject a per-run MCP echo server and run
  // one turn, so an admin can confirm per-run tool injection reaches a real Claude
  // process. Removed/replaced in M1b. Stays within kernel vocabulary (no business terms).
  private async handleDiagMcp(msg: IncomingMessage, rest: string[]): Promise<void> {
    if (!this.isAdmin(msg.userId)) {
      await this.sender.reply(msg.messageId, '/diag-mcp 仅管理员可用。');
      return;
    }
    const taskId = rest[0] ?? this.store.getState(currentTaskKey(msg.chatId)) ?? undefined;
    const task = taskId ? this.store.getTask(taskId) : undefined;
    if (!task) {
      await this.sender.reply(msg.messageId, '用法: /diag-mcp [task]（未指定则用本会话当前任务）');
      return;
    }
    this.onDiagMcp(task.id, msg.messageId);
  }

  // WI-B temporary diagnostic (admin-only): run one turn under the readonly profile so
  // an admin can confirm the deterministic write-tool deny and its real behavior
  // (reject vs hang, D6). Removed/replaced in M1b.
  private async handleDiagReadonly(msg: IncomingMessage, rest: string[]): Promise<void> {
    if (!this.isAdmin(msg.userId)) {
      await this.sender.reply(msg.messageId, '/diag-readonly 仅管理员可用。');
      return;
    }
    const taskId = rest[0] ?? this.store.getState(currentTaskKey(msg.chatId)) ?? undefined;
    const task = taskId ? this.store.getTask(taskId) : undefined;
    if (!task) {
      await this.sender.reply(
        msg.messageId,
        '用法: /diag-readonly [task]（未指定则用本会话当前任务）',
      );
      return;
    }
    this.onDiagReadonly(task.id, msg.messageId);
  }

  // WI-C temporary diagnostic (admin-only): print the global concurrency gate state.
  private async handleDiagSlots(msg: IncomingMessage): Promise<void> {
    if (!this.isAdmin(msg.userId)) {
      await this.sender.reply(msg.messageId, '/diag-slots 仅管理员可用。');
      return;
    }
    await this.sender.reply(
      msg.messageId,
      `pool: active=${this.pool.activeRuns()} queued=${this.pool.queuedRuns()} hot=${this.pool.hotCount()} total=${this.pool.totalRunners()}`,
    );
  }

  // WI-D temporary diagnostic (admin-only): claim/release a thread so routing can be
  // verified to consult the registry before the bridge fallback. Neutral params (no
  // business vocabulary, kernel-layer safe). Removed/replaced in M1b.
  private async handleDiagClaim(msg: IncomingMessage, rest: string[]): Promise<void> {
    if (!this.isAdmin(msg.userId)) {
      await this.sender.reply(msg.messageId, '/diag-claim 仅管理员可用。');
      return;
    }
    const rootId = rest[0];
    const kind = rest[1];
    if (!rootId || (kind !== 'managed' && kind !== 'bridge')) {
      await this.sender.reply(msg.messageId, '用法: /diag-claim <root_id> managed|bridge');
      return;
    }
    // 带上 chat_id/chat_type，手动登记的 managed claim 才进 listManagedClaimChatIds 补拉枚举。
    this.store.claimThread(rootId, kind, msg.userId, undefined, msg.chatId, msg.chatType);
    await this.sender.reply(msg.messageId, `已登记认领: ${rootId} → ${kind}`);
  }

  private async handleDiagUnclaim(msg: IncomingMessage, rest: string[]): Promise<void> {
    if (!this.isAdmin(msg.userId)) {
      await this.sender.reply(msg.messageId, '/diag-unclaim 仅管理员可用。');
      return;
    }
    const rootId = rest[0];
    if (!rootId) {
      await this.sender.reply(msg.messageId, '用法: /diag-unclaim <root_id>');
      return;
    }
    this.store.releaseThreadClaim(rootId);
    await this.sender.reply(msg.messageId, `已释放认领: ${rootId}`);
  }

  // M1b WI-4: create a managed (upper-layer) read-only investigation from Feishu. Parsing
  // and basic validation only — the create + anchor card + thread claim happen in index.ts
  // via onProbe (this kernel-layer file stays free of upper-layer vocabulary).
  private async handleProbe(msg: IncomingMessage, rest: string[]): Promise<void> {
    const { positional, flags } = parseArgs(rest);
    const description = positional.join(' ').trim();
    if (!description) {
      await this.sender.reply(msg.messageId, '用法: /probe [--repo <path>] <要调查的问题>');
      return;
    }
    this.onProbe(msg, { repo: flags.repo, description });
  }

  // INTAKE L1：/scout <线索> —— 立项群里让 AI 找仓。线索 = /scout 之后的原文（透传给 index 侧 onScout）。
  private async handleScout(msg: IncomingMessage, rest: string[]): Promise<void> {
    const hints = rest.join(' ').trim();
    if (!hints) {
      await this.sender.reply(
        msg.messageId,
        '用法: /scout <仓名或项目名线索>（在立项群里让我去本地找仓）',
      );
      return;
    }
    this.onScout(msg, hints);
  }

  // M1b WI-4: close the investigation owning the current thread. The thread root resolves
  // the owner inside index.ts (onDone); here we only locate the thread anchor.
  private async handleDone(msg: IncomingMessage): Promise<void> {
    // 与入站追问路由同源：话题里的 /done 带 thread_id（= claim key），回退到回复根。
    const threadRoot = msg.threadId ?? msg.rootId ?? msg.parentId;
    if (!threadRoot) {
      await this.sender.reply(msg.messageId, '请在某个调查话题（锚点卡）下回复 /done 来关闭它。');
      return;
    }
    this.onDone(msg, threadRoot);
  }

  // /req: 从飞书发起一个需求。立项重塑后这里只做最薄解析——仓库不再内联（走立项群里收），尾随文字
  // 是一句话需求（可空：不带也放行，建群后引导逐项填）。兼容旧习惯：仍带 --repo 则剥离并忽略其值。
  // 真正的「问群名 → 建群 → 建单(立项) → 清单卡」都在 index.ts 的 onRequirement 里（本文件 kernel 中性）。
  private async handleRequirement(msg: IncomingMessage, rest: string[]): Promise<void> {
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === undefined) continue;
      if (t === '--repo') {
        i++; // 跳过 --repo 及其值（仓库走立项收，这里不再解析）
        continue;
      }
      positional.push(t);
    }
    this.onRequirement(msg, { description: positional.join(' ').trim() });
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

  // /repo：仓库登记表的用户面。list 给手机上可抄的别名清单；alias 起短名（唯一），之后
  // `/new <name> <别名>` 秒开项目任务。不设 admin 门——白名单即信任边界（与 /rm 同一先例）。
  private async handleRepo(msg: IncomingMessage, rest: string[]): Promise<void> {
    const sub = rest[0];
    if (!sub || sub === 'list') {
      const rows = this.store.listRepoRegistry(50);
      if (rows.length === 0) {
        await this.sender.reply(
          msg.messageId,
          '登记表为空。/repo alias <别名> <路径> 手动登记，或开过项目任务后自动登记。',
        );
        return;
      }
      const lines = rows.map((r) => {
        const age = humanDuration(Date.now() - r.last_used_at);
        const aliasCol = r.alias ? `[${r.alias}]` : '·';
        return `${aliasCol} ${r.name}  ${shortenHome(r.path)}  (${age}前)`;
      });
      await this.sender.reply(
        msg.messageId,
        `已登记仓库 ${rows.length} 个（[别名] 可直接 /new <name> <别名> 开任务）:\n${lines.join('\n')}`,
      );
      return;
    }
    if (sub === 'alias') {
      await this.handleRepoAlias(msg, rest[1], rest.slice(2).join(' ').trim());
      return;
    }
    // 简写糖：/repo <别名> <线索|路径>（省掉 alias 关键词——真机上用户的第一反应写法）。两个及
    // 以上参数才当简写；单个未知词仍回用法（避免手滑单词被误当起名）。将来加新子命令时注意
    // 保留字判断在此糖之前。
    if (rest.length >= 2) {
      await this.handleRepoAlias(msg, sub, rest.slice(1).join(' ').trim());
      return;
    }
    await this.sender.reply(
      msg.messageId,
      '用法: /repo [list] | /repo <别名> <线索|路径> | /repo <别名> -（alias 关键词可省）',
    );
  }

  // 起/删别名（/repo alias … 与 /repo <别名> … 简写共用）。别名比任务名多放开一个点号
  // （pos2.0 这类版本味短名），任务名规则不动（SLUG_RE）。
  private async handleRepoAlias(
    msg: IncomingMessage,
    alias: string | undefined,
    target: string,
  ): Promise<void> {
    if (!alias || !target) {
      await this.sender.reply(
        msg.messageId,
        '用法: /repo <别名> <线索|路径>；删除: /repo <别名> -',
      );
      return;
    }
    if (!ALIAS_RE.test(alias)) {
      await this.sender.reply(msg.messageId, '别名只能用字母/数字/点/下划线/连字符，长度 ≤ 41');
      return;
    }
    const normalized = alias.toLowerCase();
    if (target === '-') {
      const ok = this.store.clearRepoAlias(normalized);
      await this.sender.reply(
        msg.messageId,
        ok ? `已删除别名 ${normalized}` : `别名不存在: ${normalized}`,
      );
      return;
    }
    const resolved = this.resolveRepoTarget(target);
    if (typeof resolved !== 'string') {
      await this.sender.reply(msg.messageId, resolved.error);
      return;
    }
    const existing = this.store.getRepoByAlias(normalized);
    if (existing && existing.path !== resolved) {
      await this.sender.reply(
        msg.messageId,
        `别名 ${normalized} 已指向 ${shortenHome(existing.path)}，先 /repo ${normalized} - 解绑`,
      );
      return;
    }
    this.store.setRepoAlias(resolved, normalized, Date.now());
    await this.sender.reply(
      msg.messageId,
      `别名已设置: ${normalized} → ${shortenHome(resolved)}\n开任务: /new <name> ${normalized}`,
    );
  }

  // 仓库寻址三合一：路径样式（/ 或 ~ 开头）直接走 resolveCwd；否则别名精确命中 → 登记表包含匹配
  // （唯一开、多命中列清单让人换别名或更准线索）→ 都不中再退回 resolveCwd 的一级目录扫描（未登记
  // 的顶层目录仍可用）。登记行可能指向已删目录——命中后仍过 resolveCwd 的前缀+存在性校验，别名
  // 只是寻址、不绕安全门。
  private resolveRepoTarget(raw: string): string | { error: string } {
    if (raw.startsWith('/') || raw.startsWith('~')) return this.resolveCwd(raw);
    const byAlias = this.store.getRepoByAlias(raw);
    if (byAlias) return this.resolveCwd(byAlias.path);
    const hits = this.store.matchRepoRegistry(raw);
    if (hits.length === 1) return this.resolveCwd(hits[0]!.path);
    if (hits.length > 1) {
      const list = hits
        .slice(0, 8)
        .map((r) => `  ${r.alias ? `[${r.alias}]` : '·'} ${r.name}  ${shortenHome(r.path)}`)
        .join('\n');
      return {
        error: `登记表里匹配到多个，用别名或更准的线索:\n${list}\n（起别名: /repo alias <别名> <线索>）`,
      };
    }
    return this.resolveCwd(raw);
  }

  // 项目模式开任务 = 一次真实使用：已登记 → 只刷 last_used_at（不动 name/source/alias）；未登记
  // 且是 git 仓 → 顺手登记（source='task'）。非 git 目录不进登记表——登记表是代码仓知识（INTAKE
  // 免勘探快路径），别拿文档目录污染它。
  private registerRepoUse(cwd: string): void {
    const now = Date.now();
    if (this.store.touchRepoRegistry(cwd, now)) return;
    if (fs.existsSync(path.join(cwd, '.git'))) {
      this.store.upsertRepoRegistry(cwd, path.basename(cwd), now, 'task');
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
      return {
        error: `没有找到匹配 "${raw}" 的目录（搜索范围: ${this.config.allowedCwdPrefixes.join(', ')}）`,
      };
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
      const lines = list.map((w, i) => `${i + 1}. ${w.name ?? '(no name)'}  ${w.open_id}`);
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
        await this.sender.reply(msg.messageId, `用法: /wl ${sub} @某人  或  /wl ${sub} ou_xxx`);
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
    await this.sender.reply(msg.messageId, `[${name}] 已清空会话上下文，下条消息开全新会话。`);
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
      const t = this.store.getBridgeTask(currentId);
      if (t) return t;
    }
    return this.store.mostRecentTaskInChat(chatId);
  }

  private async handleGet(msg: IncomingMessage, rest: string[]): Promise<void> {
    const raw = stripWrappingQuotes(rest.join(' ').trim());
    if (!raw) {
      await this.sender.reply(
        msg.messageId,
        '用法: /get <path>  (相对路径基于本会话当前任务的 cwd)',
      );
      return;
    }
    const task = this.resolveTaskForChat(msg.chatId);
    if (!task) {
      await this.sender.reply(
        msg.messageId,
        '本会话还没绑定任务。/use <name> 绑定已有任务，或 /new <name> 新建。',
      );
      return;
    }
    const home = process.env.HOME ?? '';
    const expanded = raw.startsWith('~') ? path.join(home, raw.slice(1)) : raw;
    const candidate = path.resolve(
      path.isAbsolute(expanded) ? expanded : path.join(task.cwd, expanded),
    );

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
        name
          ? `任务不存在: ${name}`
          : '本会话没有任务。先用 /new <name> 新建并跑过消息后再 /export。',
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
    // getBridgeTask (not getTask): a managed shadow task must not be deletable via /rm.
    const task = this.store.getBridgeTask(name);
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
