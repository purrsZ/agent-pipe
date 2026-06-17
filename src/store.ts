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
  created_at: number;
}

export interface EventRow {
  id: number;
  task_id: string;
  kind: string;
  tool: string | null;
  payload: string | null;
  created_at: number;
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
        created_at     INTEGER NOT NULL
      );
    `);
    this.migrateTasksLegacy();
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
  claimThread(rootId: string, ownerKind: 'bridge' | 'managed', ownerId: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO thread_claims (thread_root_id, owner_kind, owner_id, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(rootId, ownerKind, ownerId, Date.now());
  }

  getThreadClaim(rootId: string): ThreadClaim | undefined {
    return this.db.prepare('SELECT * FROM thread_claims WHERE thread_root_id = ?').get(rootId) as
      | ThreadClaim
      | undefined;
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
