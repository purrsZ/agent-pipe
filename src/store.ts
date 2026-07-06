import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

export type TaskStatus = 'hot' | 'suspended' | 'done' | 'error';
export type TaskMode = 'project' | 'sandbox';
export type AgentKind = 'claude' | 'codex';
// Neutral owner dimension (no business vocabulary, kernel-layer safe). `managed` rows
// are shadow tasks borrowed by the non-bridge layer as a run channel; they stay invisible
// to every bridge-facing query (routing / list / rm / status). See M1b plan WI-1.
export type TaskOwnerKind = 'bridge' | 'managed';

export interface Task {
  id: string;
  display_name: string;
  agent_kind: AgentKind;
  owner_kind: TaskOwnerKind;
  mode: TaskMode;
  cwd: string;
  root_msg_id: string | null;
  root_chat_id: string | null;
  agent_session_id: string | null;
  status: TaskStatus;
  model: string | null;
  created_at: number;
  last_active_at: number;
}

export interface ThreadClaim {
  thread_root_id: string;
  owner_kind: TaskOwnerKind;
  owner_id: string;
  // WI-8: the anchor card's message id (updateCard target), kept apart from thread_root_id
  // (the routing/claim key). NULL for pre-WI-8 rows and bridge claims.
  anchor_msg_id: string | null;
  // WS-4: the chat this claim lives in — feeds 断线补拉's managed-chat list so we know which
  // chats to re-pull offline messages from. NULL for pre-WS-4 rows and claims without a chat.
  chat_id: string | null;
  // WS-4 (C7): the chat's type ('p2p'|'group'). im.message.list items don't carry chat_type, so
  // backfill reads it here to reshape p2p messages correctly (else a p2p probe's offline follow-up
  // gets defaulted to 'group', un-mentioned, and dropped by the group gate). NULL for old rows.
  chat_type: string | null;
  created_at: number;
}

// WS-4: persistent inbox row. Every inbound feishu message lands here first (INSERT OR IGNORE
// dedup), gets processed, then marked — so a crash between receive and process re-delivers on
// restart, and a chat's high-water create_time drives 断线补拉.
export interface InboxMessageRow {
  id: number;
  message_id: string;
  chat_id: string;
  create_time: number;
  payload: string;
  received_at: number;
  processed_at: number | null;
}

export interface EventRow {
  id: number;
  task_id: string;
  kind: string;
  tool: string | null;
  payload: string | null;
  created_at: number;
}

// INTAKE L0：代码项目登记表（跨单知识，与 inbox_messages 同级放 kernel store，命名中性）。立项抽取先查表
// 秒解析仓名→绝对路径（免 AI 快路径）；勘探（L1）拿它当搜索起点。name = basename 小写化，供包含匹配。
export interface RepoRegistryRow {
  path: string;
  name: string;
  last_used_at: number;
  source: string; // 'unit' | 'scout' | 'backfill'
}

export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id               TEXT PRIMARY KEY,
        display_name     TEXT NOT NULL,
        agent_kind       TEXT NOT NULL DEFAULT 'claude',
        owner_kind       TEXT NOT NULL DEFAULT 'bridge',
        mode             TEXT NOT NULL,
        cwd              TEXT NOT NULL,
        root_msg_id      TEXT UNIQUE,
        root_chat_id     TEXT,
        agent_session_id TEXT,
        status           TEXT NOT NULL,
        model            TEXT,
        created_at       INTEGER NOT NULL,
        last_active_at   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    TEXT NOT NULL,
        kind       TEXT NOT NULL,
        tool       TEXT,
        payload    TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, created_at);
      CREATE TABLE IF NOT EXISTS task_messages (
        feishu_msg_id TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_task_messages_task ON task_messages(task_id);
      CREATE TABLE IF NOT EXISTS state (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS whitelist (
        open_id    TEXT PRIMARY KEY,
        name       TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_claims (
        thread_root_id TEXT PRIMARY KEY,
        owner_kind     TEXT NOT NULL,
        owner_id       TEXT NOT NULL,
        anchor_msg_id  TEXT,
        chat_id        TEXT,
        chat_type      TEXT,
        created_at     INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox_messages (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id   TEXT NOT NULL UNIQUE,
        chat_id      TEXT NOT NULL,
        create_time  INTEGER NOT NULL,
        payload      TEXT NOT NULL,
        received_at  INTEGER NOT NULL,
        processed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_unprocessed
        ON inbox_messages(id) WHERE processed_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_inbox_chat ON inbox_messages(chat_id, create_time);
      CREATE TABLE IF NOT EXISTS repo_registry (
        path         TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        last_used_at INTEGER NOT NULL,
        source       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_repo_registry_name ON repo_registry(name);
    `);
    this.migrateTasksLegacy();
    this.migrateThreadClaimsLegacy();
    this.db.prepare("DELETE FROM state WHERE key = 'current_task_id'").run();
  }

  // Backward-compat: older DBs have `cc_session_id` column and no `agent_kind`.
  // ALTER TABLE ... RENAME COLUMN requires SQLite ≥ 3.25 (2018); better-sqlite3 ships
  // well above that, so we use it directly without a fallback.
  private migrateTasksLegacy(): void {
    const cols = this.db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{
      name: string;
    }>;
    const names = new Set(cols.map((c) => c.name));

    if (!names.has('agent_kind')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'claude'`);
    }
    // WI-1: owner_kind follows the agent_kind precedent — present in CREATE TABLE for
    // new DBs, back-filled here for old ones (this guarded ADD COLUMN is the real
    // migration mechanism; existing rows default to 'bridge', zero regression).
    if (!names.has('owner_kind')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'bridge'`);
    }
    if (names.has('cc_session_id') && !names.has('agent_session_id')) {
      this.db.exec(`ALTER TABLE tasks RENAME COLUMN cc_session_id TO agent_session_id`);
    } else if (!names.has('agent_session_id')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN agent_session_id TEXT`);
    }
  }

  // WI-8: thread_claims gained anchor_msg_id so the anchor card (updateCard target) is
  // stored apart from the thread root (the routing/claim key). Guarded ADD COLUMN back-fills
  // old DBs with NULL — those pre-existing claims simply can't refresh their anchor card,
  // zero regression.
  private migrateThreadClaimsLegacy(): void {
    const cols = this.db.prepare(`PRAGMA table_info(thread_claims)`).all() as Array<{
      name: string;
    }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('anchor_msg_id')) {
      this.db.exec(`ALTER TABLE thread_claims ADD COLUMN anchor_msg_id TEXT`);
    }
    // WS-4: chat_id follows the anchor_msg_id precedent — present in CREATE TABLE for new DBs,
    // guarded ADD COLUMN back-fills old ones with NULL (those claims just won't feed 补拉).
    if (!names.has('chat_id')) {
      this.db.exec(`ALTER TABLE thread_claims ADD COLUMN chat_id TEXT`);
    }
    // WS-4 (C7): chat_type for correct p2p/group reshape during 补拉.
    if (!names.has('chat_type')) {
      this.db.exec(`ALTER TABLE thread_claims ADD COLUMN chat_type TEXT`);
    }
  }

  isAllowed(openId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM whitelist WHERE open_id = ?').get(openId);
    return !!row;
  }

  addWhitelist(openId: string, name?: string): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO whitelist (open_id, name, created_at) VALUES (?, ?, ?)')
      .run(openId, name ?? null, Date.now());
    return result.changes > 0;
  }

  removeWhitelist(openId: string): boolean {
    const result = this.db.prepare('DELETE FROM whitelist WHERE open_id = ?').run(openId);
    return result.changes > 0;
  }

  listWhitelist(): Array<{
    open_id: string;
    name: string | null;
    created_at: number;
  }> {
    return this.db.prepare('SELECT * FROM whitelist ORDER BY created_at ASC').all() as Array<{
      open_id: string;
      name: string | null;
      created_at: number;
    }>;
  }

  whitelistCount(): number {
    return (
      this.db.prepare('SELECT COUNT(*) as c FROM whitelist').get() as {
        c: number;
      }
    ).c;
  }

  getState(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setState(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)').run(key, value);
  }

  deleteState(key: string): void {
    this.db.prepare('DELETE FROM state WHERE key = ?').run(key);
  }

  // WI-D: thread → owner claim registry. owner_kind is a neutral value (bridge | managed)
  // so this kernel-layer file carries no business vocabulary. Routing consults this before
  // the bridge task fallback so a managed thread is never swallowed by it (and vice versa).
  claimThread(
    rootId: string,
    ownerKind: 'bridge' | 'managed',
    ownerId: string,
    anchorMsgId: string | null = null,
    chatId: string | null = null,
    chatType: string | null = null,
  ): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO thread_claims (thread_root_id, owner_kind, owner_id, anchor_msg_id, chat_id, chat_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(rootId, ownerKind, ownerId, anchorMsgId, chatId, chatType, Date.now());
  }

  // WS-4: distinct chats a managed owner has claimed (立项群 + probe 话题所在群) — 断线补拉只对这些
  // 会话主动拉离线消息，不碰普通 bridge 会话（避免重启后乱回放旧消息）。空 chat_id 不计入。
  listManagedClaimChatIds(): string[] {
    return (
      this.db
        .prepare(
          "SELECT DISTINCT chat_id FROM thread_claims WHERE owner_kind = 'managed' AND chat_id IS NOT NULL",
        )
        .all() as Array<{ chat_id: string }>
    ).map((r) => r.chat_id);
  }

  // WS-4 (C7): the chat_type recorded for a managed chat, so 补拉 can reshape p2p messages correctly.
  // Newest non-null wins. undefined when unknown (→ backfill falls back to 'group').
  managedChatType(chatId: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT chat_type FROM thread_claims WHERE chat_id = ? AND owner_kind = 'managed' AND chat_type IS NOT NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(chatId) as { chat_type: string } | undefined;
    return row?.chat_type;
  }

  getThreadClaim(rootId: string): ThreadClaim | undefined {
    return this.db.prepare('SELECT * FROM thread_claims WHERE thread_root_id = ?').get(rootId) as
      | ThreadClaim
      | undefined;
  }

  // WS-4 持久 inbox. INSERT OR IGNORE 是权威去重：首见返回 true，重复（同 message_id）返回 false。
  // received_at 记落库时刻（供每日清理）；processed_at 由 markInboxProcessed 事后置。
  recordInbox(msg: {
    messageId: string;
    chatId: string;
    createTime: number;
    payloadJson: string;
  }): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO inbox_messages (message_id, chat_id, create_time, payload, received_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(msg.messageId, msg.chatId, msg.createTime, msg.payloadJson, Date.now());
    return res.changes > 0;
  }

  markInboxProcessed(messageId: string): void {
    this.db
      .prepare('UPDATE inbox_messages SET processed_at = ? WHERE message_id = ?')
      .run(Date.now(), messageId);
  }

  // 启动补投：处理完前崩溃的行（processed_at IS NULL）按落库顺序重放。afterId 游标（C5 审查修复）让
  // replayInbox 能分批 drain 全部未处理行（>limit 也不漏），并跨过本轮失败的行避免死循环（失败行 id
  // 仍推进，等下次重启再试）。
  listInboxUnprocessed(limit: number, afterId = 0): InboxMessageRow[] {
    return this.db
      .prepare(
        'SELECT * FROM inbox_messages WHERE processed_at IS NULL AND id > ? ORDER BY id ASC LIMIT ?',
      )
      .all(afterId, limit) as InboxMessageRow[];
  }

  // 断线补拉水位：该 chat 已见过的最新 create_time（无记录 → 0，调用方回看固定窗口）。
  latestInboxCreateTime(chatId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(create_time), 0) AS ts FROM inbox_messages WHERE chat_id = ?')
      .get(chatId) as { ts: number };
    return row.ts;
  }

  // 每日清理：只删已处理且 received_at 早于 cutoff 的行（未处理行永远保留，等补投）。
  purgeInboxBefore(cutoffMs: number): void {
    this.db
      .prepare('DELETE FROM inbox_messages WHERE processed_at IS NOT NULL AND received_at < ?')
      .run(cutoffMs);
  }

  // INTAKE L0：登记一个已知代码仓（幂等 upsert，path 为主键）。name 一律小写化落库（供包含匹配）；
  // 重复登记同 path 刷新 name/last_used_at/source（最后一次写为准，与 recordInbox 的去重语义并列）。
  upsertRepoRegistry(repoPath: string, name: string, now: number, source: string): void {
    this.db
      .prepare(
        `INSERT INTO repo_registry (path, name, last_used_at, source)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           name = excluded.name,
           last_used_at = excluded.last_used_at,
           source = excluded.source`,
      )
      .run(repoPath, name.toLowerCase(), now, source);
  }

  // INTAKE L0：最近使用的登记仓（last_used_at 降序，供抽取 prompt 织入「已知仓库登记表」小节）。
  listRepoRegistry(limit: number): RepoRegistryRow[] {
    return this.db
      .prepare('SELECT * FROM repo_registry ORDER BY last_used_at DESC LIMIT ?')
      .all(limit) as RepoRegistryRow[];
  }

  // INTAKE L0：按仓名线索小写包含匹配（返回全部命中——歧义交上层裁量/问人）。空线索 → 空数组。
  matchRepoRegistry(hint: string): RepoRegistryRow[] {
    const needle = hint.trim().toLowerCase();
    if (needle.length === 0) return [];
    return this.db
      .prepare(
        "SELECT * FROM repo_registry WHERE name LIKE '%' || ? || '%' ESCAPE '\\' ORDER BY last_used_at DESC",
      )
      .all(escapeLike(needle)) as RepoRegistryRow[];
  }

  releaseThreadClaim(rootId: string): void {
    this.db.prepare('DELETE FROM thread_claims WHERE thread_root_id = ?').run(rootId);
  }

  // M1b WI-6: reverse lookup — find the thread root a managed owner claimed, so the
  // outbound bridge can post a result back into that thread. Newest claim wins.
  getThreadRootByOwner(ownerId: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT thread_root_id FROM thread_claims WHERE owner_id = ? AND owner_kind = 'managed' ORDER BY created_at DESC LIMIT 1",
      )
      .get(ownerId) as { thread_root_id: string } | undefined;
    return row?.thread_root_id;
  }

  // M1b WI-8: reverse lookup the anchor card message id (updateCard target), kept apart from
  // the thread root (replyCard / routing key). Newest managed claim wins.
  getThreadAnchorByOwner(ownerId: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT anchor_msg_id FROM thread_claims WHERE owner_id = ? AND owner_kind = 'managed' ORDER BY created_at DESC LIMIT 1",
      )
      .get(ownerId) as { anchor_msg_id: string | null } | undefined;
    return row?.anchor_msg_id ?? undefined;
  }

  recordTaskMessage(taskId: string, feishuMsgId: string) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO task_messages (feishu_msg_id, task_id, created_at) VALUES (?, ?, ?)',
      )
      .run(feishuMsgId, taskId, Date.now());
  }

  getTaskByMessageId(feishuMsgId: string): Task | undefined {
    return this.db
      .prepare(
        `SELECT t.* FROM tasks t JOIN task_messages m ON m.task_id = t.id WHERE m.feishu_msg_id = ? AND t.owner_kind = 'bridge'`,
      )
      .get(feishuMsgId) as Task | undefined;
  }

  createTask(
    t: Omit<Task, 'created_at' | 'last_active_at' | 'owner_kind'> & { owner_kind?: TaskOwnerKind },
  ): Task {
    const now = Date.now();
    const row: Task = {
      ...t,
      owner_kind: t.owner_kind ?? 'bridge',
      created_at: now,
      last_active_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, display_name, agent_kind, owner_kind, mode, cwd, root_msg_id, root_chat_id, agent_session_id, status, model, created_at, last_active_at)
         VALUES (@id, @display_name, @agent_kind, @owner_kind, @mode, @cwd, @root_msg_id, @root_chat_id, @agent_session_id, @status, @model, @created_at, @last_active_at)`,
      )
      .run(row);
    return row;
  }

  // WI-1 (M1b): upsert a managed shadow task (a run channel owned by the non-bridge
  // layer). Reuses the bridge run primitive (pool keys on task.id) but stays
  // bridge-invisible via owner_kind. ON CONFLICT refreshes only cwd/last_active_at —
  // never clobbers a session/status the runner wrote mid-turn.
  upsertTask(t: Omit<Task, 'created_at' | 'last_active_at'>): Task {
    const now = Date.now();
    const row: Task = { ...t, created_at: now, last_active_at: now };
    this.db
      .prepare(
        `INSERT INTO tasks (id, display_name, agent_kind, owner_kind, mode, cwd, root_msg_id, root_chat_id, agent_session_id, status, model, created_at, last_active_at)
         VALUES (@id, @display_name, @agent_kind, @owner_kind, @mode, @cwd, @root_msg_id, @root_chat_id, @agent_session_id, @status, @model, @created_at, @last_active_at)
         ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, last_active_at = excluded.last_active_at`,
      )
      .run(row);
    return this.getTask(t.id)!;
  }

  // Unfiltered by owner_kind: the pool/runner key on task.id and must reach managed rows
  // to write back session/status (D6). Bridge-facing callers use getBridgeTask instead.
  getTask(id: string): Task | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  }

  // Bridge-facing lookup: never returns a managed shadow task, so /rm and current-task
  // resolution can't target a managed run channel (WI-1 isolation).
  getBridgeTask(id: string): Task | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ? AND owner_kind = 'bridge'").get(id) as
      | Task
      | undefined;
  }

  getTaskByRootMsg(rootMsgId: string): Task | undefined {
    return this.db
      .prepare("SELECT * FROM tasks WHERE root_msg_id = ? AND owner_kind = 'bridge'")
      .get(rootMsgId) as Task | undefined;
  }

  listTasks(): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE owner_kind = 'bridge' ORDER BY last_active_at DESC")
      .all() as Task[];
  }

  mostRecentTask(): Task | undefined {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE owner_kind = 'bridge' ORDER BY last_active_at DESC LIMIT 1",
      )
      .get() as Task | undefined;
  }

  mostRecentTaskInChat(chatId: string): Task | undefined {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE root_chat_id = ? AND owner_kind = 'bridge' ORDER BY last_active_at DESC LIMIT 1",
      )
      .get(chatId) as Task | undefined;
  }

  clearCurrentForTask(taskId: string): void {
    this.db.prepare("DELETE FROM state WHERE key LIKE 'current_task:%' AND value = ?").run(taskId);
  }

  setRootMsg(id: string, rootMsgId: string, rootChatId: string) {
    this.db
      .prepare('UPDATE tasks SET root_msg_id = ?, root_chat_id = ? WHERE id = ?')
      .run(rootMsgId, rootChatId, id);
  }

  setStatus(id: string, status: TaskStatus) {
    this.db
      .prepare('UPDATE tasks SET status = ?, last_active_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }

  setAgentSessionId(id: string, sessionId: string) {
    this.db.prepare('UPDATE tasks SET agent_session_id = ? WHERE id = ?').run(sessionId, id);
  }

  clearAgentSessionId(id: string) {
    this.db.prepare('UPDATE tasks SET agent_session_id = NULL WHERE id = ?').run(id);
  }

  setAgentKind(id: string, kind: AgentKind) {
    this.db.prepare('UPDATE tasks SET agent_kind = ? WHERE id = ?').run(kind, id);
  }

  setModel(id: string, model: string | null) {
    this.db.prepare('UPDATE tasks SET model = ? WHERE id = ?').run(model, id);
  }

  touchTask(id: string) {
    this.db.prepare('UPDATE tasks SET last_active_at = ? WHERE id = ?').run(Date.now(), id);
  }

  deleteTask(id: string) {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  logEvent(taskId: string, kind: string, tool?: string, payload?: unknown) {
    this.db
      .prepare(
        `INSERT INTO events (task_id, kind, tool, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        kind,
        tool ?? null,
        payload != null ? JSON.stringify(payload) : null,
        Date.now(),
      );
  }

  recentEvents(taskId: string, n = 50): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(taskId, n) as EventRow[];
  }

  /** Online backup via SQLite's backup API — safe while the DB is in use (WAL). */
  async backup(destPath: string): Promise<void> {
    await this.db.backup(destPath);
  }

  close() {
    this.db.close();
  }
}

// INTAKE L0：转义 SQL LIKE 的通配符（% _ \），防仓名里的下划线/百分号被当通配（配合 ESCAPE '\'）。
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
