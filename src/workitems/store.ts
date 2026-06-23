import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type {
  Assignment,
  AssignmentStatus,
  Clock,
  Effect,
  EffectStatus,
  Wait,
  WorkItem,
  WorkItemEvent,
  WorkItemStatus,
} from './types.js';

type SqlValue = string | number | null;

type DbWorkItem = {
  id: string;
  type: string;
  title: string;
  status: WorkItemStatus;
  status_detail: WorkItem['statusDetail'];
  phase: string;
  source_json: string;
  dedupe_key: string | null;
  repos_json: string | null;
  context_json: string | null;
  wake_pending: 0 | 1;
  discard_streak: number;
  created_at: number;
  updated_at: number;
};

type DbAssignment = {
  id: string;
  workitem_id: string;
  parent_id: string | null;
  repo: string | null;
  role: Assignment['role'];
  status: AssignmentStatus;
  agent_session_id: string | null;
  replaces_assignment_id: string | null;
  deadline_at: number;
  wallclock_cap_sec: number;
  retries: number;
  based_on_seq: number;
  brief_path: string | null;
  report_path: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
};

type DbWait = {
  id: string;
  workitem_id: string;
  kind: Wait['kind'];
  origin_assignment_id: string | null;
  reason: string;
  deadline_at: number;
  renewed_count: number;
  reminded_at: number | null;
  resolved_at: number | null;
  resolved_by: string | null;
  resolve_reason: string | null;
  created_at: number;
};

type DbEffect = {
  id: number;
  workitem_id: string;
  seq: number;
  kind: string;
  payload_json: string | null;
  status: EffectStatus;
  created_at: number;
  updated_at: number;
};

type DbEvent = {
  id: number;
  workitem_id: string;
  seq: number;
  kind: string;
  payload_json: string | null;
  created_at: number;
};

type WaitPatch = Partial<
  Pick<Wait, 'resolvedAt' | 'resolvedBy' | 'resolveReason' | 'renewedCount' | 'remindedAt'>
>;

type WaitRenewalPatch = Pick<Wait, 'deadlineAt' | 'renewedCount' | 'remindedAt'>;

const TERMINAL_STATUSES: WorkItemStatus[] = ['done', 'failed', 'cancelled'];

function encodeJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function decodeJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function toWorkItem(row: DbWorkItem): WorkItem {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    status: row.status,
    statusDetail: row.status_detail,
    phase: row.phase,
    source: JSON.parse(row.source_json),
    dedupeKey: row.dedupe_key,
    repos: (decodeJson(row.repos_json) as string[] | null) ?? [],
    context: decodeJson(row.context_json),
    wakePending: row.wake_pending === 1,
    discardStreak: row.discard_streak,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAssignment(row: DbAssignment): Assignment {
  return {
    id: row.id,
    workitemId: row.workitem_id,
    parentId: row.parent_id,
    repo: row.repo,
    role: row.role,
    status: row.status,
    agentSessionId: row.agent_session_id,
    replacesAssignmentId: row.replaces_assignment_id,
    deadlineAt: row.deadline_at,
    wallclockCapSec: row.wallclock_cap_sec,
    retries: row.retries,
    basedOnSeq: row.based_on_seq,
    briefPath: row.brief_path,
    reportPath: row.report_path,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function toWait(row: DbWait): Wait {
  return {
    id: row.id,
    workitemId: row.workitem_id,
    kind: row.kind,
    originAssignmentId: row.origin_assignment_id,
    reason: row.reason,
    deadlineAt: row.deadline_at,
    renewedCount: row.renewed_count,
    remindedAt: row.reminded_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolveReason: row.resolve_reason,
    createdAt: row.created_at,
  };
}

function toEffect(row: DbEffect): Effect {
  return {
    id: row.id,
    workitemId: row.workitem_id,
    seq: row.seq,
    kind: row.kind,
    payload: decodeJson(row.payload_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: DbEvent): WorkItemEvent {
  return {
    id: row.id,
    workitemId: row.workitem_id,
    seq: row.seq,
    kind: row.kind,
    payload: decodeJson(row.payload_json),
    createdAt: row.created_at,
  };
}

function setClauses(
  patch: Record<string, unknown>,
  mapping: Record<string, string>,
): { clause: string; values: Record<string, SqlValue> } {
  const clauses: string[] = [];
  const values: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(patch)) {
    const column = mapping[key];
    if (!column) continue;
    clauses.push(`${column} = @${key}`);
    values[key] = typeof value === 'boolean' ? (value ? 1 : 0) : (value as SqlValue);
  }
  return { clause: clauses.join(', '), values };
}

export class WorkitemsStore {
  private db: Database.Database;
  // better-sqlite3 does not cache prepared statements; re-preparing the same SQL on
  // every call (hot paths: nextSeq, listInflightEffects, getWorkItem) re-parses each
  // time. Cache by SQL text — Statements are reusable and bounded by the static query
  // set (dynamic UPDATEs vary only by column subset) (v4 #14).
  private readonly statements = new Map<string, Database.Statement>();

  constructor(
    dbPath: string,
    private readonly clock: Clock,
  ) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private stmt(sql: string): Database.Statement {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private migrate(): void {
    const version = (this.stmt('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE workitems (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open'
            CHECK (status IN ('open','active','waiting','done','failed','cancelled')),
          status_detail TEXT CHECK (status_detail IN ('human','agent','timer')),
          phase TEXT NOT NULL,
          source_json TEXT NOT NULL,
          dedupe_key TEXT,
          repos_json TEXT,
          context_json TEXT,
          wake_pending INTEGER NOT NULL DEFAULT 0 CHECK (wake_pending IN (0,1)),
          discard_streak INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(type, dedupe_key)
        );
        CREATE INDEX idx_workitems_status ON workitems(status);

        CREATE TABLE workitem_assignments (
          id TEXT PRIMARY KEY,
          workitem_id TEXT NOT NULL REFERENCES workitems(id) ON DELETE CASCADE,
          parent_id TEXT REFERENCES workitem_assignments(id),
          repo TEXT,
          role TEXT NOT NULL CHECK (role IN ('owner','worker','solo')),
          status TEXT NOT NULL CHECK (status IN ('running','done','failed','superseded','cancelled')),
          agent_session_id TEXT,
          replaces_assignment_id TEXT REFERENCES workitem_assignments(id),
          deadline_at INTEGER NOT NULL,
          wallclock_cap_sec INTEGER NOT NULL,
          retries INTEGER NOT NULL DEFAULT 0,
          based_on_seq INTEGER NOT NULL,
          brief_path TEXT,
          report_path TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          ended_at INTEGER
        );
        CREATE INDEX idx_assignments_item ON workitem_assignments(workitem_id, status);

        CREATE TABLE workitem_waits (
          id TEXT PRIMARY KEY,
          workitem_id TEXT NOT NULL REFERENCES workitems(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('human','agent','timer')),
          origin_assignment_id TEXT REFERENCES workitem_assignments(id),
          reason TEXT NOT NULL,
          deadline_at INTEGER NOT NULL,
          renewed_count INTEGER NOT NULL DEFAULT 0,
          reminded_at INTEGER,
          resolved_at INTEGER,
          resolved_by TEXT,
          resolve_reason TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_waits_open ON workitem_waits(workitem_id) WHERE resolved_at IS NULL;

        CREATE TABLE workitem_effects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workitem_id TEXT NOT NULL REFERENCES workitems(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending','running','done','aborted')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_effects_inflight ON workitem_effects(workitem_id, status, seq, id);

        CREATE TABLE workitem_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workitem_id TEXT NOT NULL REFERENCES workitems(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT,
          created_at INTEGER NOT NULL,
          UNIQUE(workitem_id, seq)
        );
        CREATE INDEX idx_events_item_seq ON workitem_events(workitem_id, seq);

        CREATE TRIGGER workitem_events_no_update
        BEFORE UPDATE ON workitem_events
        BEGIN
          SELECT RAISE(ABORT, 'workitem_events are append-only');
        END;

        CREATE TRIGGER workitem_events_no_delete
        BEFORE DELETE ON workitem_events
        BEGIN
          SELECT RAISE(ABORT, 'workitem_events are append-only');
        END;

        PRAGMA user_version = 1;
      `);
    }
    if (version < 2) {
      // Partial index for the watchdog's 1Hz running-assignment scan (v4 #12): the
      // base index idx_assignments_item leads with workitem_id, so a status-only
      // filter degraded to a full SCAN + temp B-tree sort on an append-only table.
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_assignments_running
          ON workitem_assignments(workitem_id) WHERE status = 'running';
        PRAGMA user_version = 2;
      `);
    }
    if (version < 3) {
      // requirement worktype structural increment (R24.AC-4). No new columns — role,
      // parent_id, agent_session_id all exist from v1; the new kinds write workitem_events
      // (no CHECK). Only indexes:
      //  - idx_assignments_running_role: countRunningByRole drives the owner-workers
      //    single-flight gate (owner) and the worker concurrency cap (worker).
      //  - idx_assignments_parent: parent-chain reverse lookup (batch attribution /
      //    cascade abort) without a full table SCAN.
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_assignments_running_role
          ON workitem_assignments(workitem_id, role) WHERE status = 'running';
        CREATE INDEX IF NOT EXISTS idx_assignments_parent
          ON workitem_assignments(parent_id) WHERE parent_id IS NOT NULL;
        PRAGMA user_version = 3;
      `);
    }
  }

  insertWorkItem(row: WorkItem): void {
    this.db
      .prepare(
        `INSERT INTO workitems (
          id, type, title, status, status_detail, phase, source_json, dedupe_key, repos_json,
          context_json, wake_pending, discard_streak, created_at, updated_at
        ) VALUES (
          @id, @type, @title, @status, @statusDetail, @phase, @sourceJson, @dedupeKey, @reposJson,
          @contextJson, @wakePending, @discardStreak, @createdAt, @updatedAt
        )`,
      )
      .run({
        id: row.id,
        type: row.type,
        title: row.title,
        status: row.status,
        statusDetail: row.statusDetail,
        phase: row.phase,
        sourceJson: JSON.stringify(row.source),
        dedupeKey: row.dedupeKey,
        reposJson: JSON.stringify(row.repos),
        contextJson: encodeJson(row.context),
        wakePending: row.wakePending ? 1 : 0,
        discardStreak: row.discardStreak,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
  }

  getWorkItem(id: string): WorkItem | undefined {
    const row = this.stmt('SELECT * FROM workitems WHERE id = ?').get(id) as DbWorkItem | undefined;
    return row ? toWorkItem(row) : undefined;
  }

  findByDedupe(type: string, key: string): WorkItem | undefined {
    const row = this.db
      .prepare('SELECT * FROM workitems WHERE type = ? AND dedupe_key = ?')
      .get(type, key) as DbWorkItem | undefined;
    return row ? toWorkItem(row) : undefined;
  }

  countNonTerminal(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM workitems WHERE status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(',')})`,
      )
      .get(...TERMINAL_STATUSES) as { c: number };
    return row.c;
  }

  listNonTerminal(): WorkItem[] {
    return this.db
      .prepare(
        `SELECT * FROM workitems WHERE status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(',')}) ORDER BY created_at, id`,
      )
      .all(...TERMINAL_STATUSES)
      .map((row) => toWorkItem(row as DbWorkItem));
  }

  updateWorkItem(id: string, patch: Partial<WorkItem>): void {
    const { clause, values } = setClauses(patch, {
      title: 'title',
      status: 'status',
      statusDetail: 'status_detail',
      phase: 'phase',
      dedupeKey: 'dedupe_key',
      wakePending: 'wake_pending',
      discardStreak: 'discard_streak',
      updatedAt: 'updated_at',
    });
    if (!clause) return;
    this.stmt(`UPDATE workitems SET ${clause} WHERE id = @id`).run({ ...values, id });
  }

  // repos 提升（repos_json 是 JSON 数组列，setClauses 不序列化数组，故专列一法）。worker 拆分 /
  // spec-design repo 候选都读 workitem.repos，而 /req 不再带 --repo——仓库走立项收齐后提升到这里。
  setRepos(id: string, repos: string[]): void {
    this.stmt('UPDATE workitems SET repos_json = @repos, updated_at = @now WHERE id = @id').run({
      repos: JSON.stringify(repos),
      now: this.clock.now(),
      id,
    });
  }

  insertAssignment(row: Assignment): void {
    this.db
      .prepare(
        `INSERT INTO workitem_assignments (
          id, workitem_id, parent_id, repo, role, status, agent_session_id, replaces_assignment_id,
          deadline_at, wallclock_cap_sec, retries, based_on_seq, brief_path, report_path,
          created_at, started_at, ended_at
        ) VALUES (
          @id, @workitemId, @parentId, @repo, @role, @status, @agentSessionId, @replacesAssignmentId,
          @deadlineAt, @wallclockCapSec, @retries, @basedOnSeq, @briefPath, @reportPath,
          @createdAt, @startedAt, @endedAt
        )`,
      )
      .run(row);
  }

  updateAssignment(id: string, patch: Partial<Assignment>): void {
    const { clause, values } = setClauses(patch, {
      status: 'status',
      agentSessionId: 'agent_session_id',
      retries: 'retries',
      briefPath: 'brief_path',
      reportPath: 'report_path',
      startedAt: 'started_at',
      endedAt: 'ended_at',
    });
    if (!clause) return;
    this.db
      .prepare(`UPDATE workitem_assignments SET ${clause} WHERE id = @id`)
      .run({ ...values, id });
  }

  getAssignment(id: string): Assignment | undefined {
    const row = this.stmt('SELECT * FROM workitem_assignments WHERE id = ?').get(id) as
      | DbAssignment
      | undefined;
    return row ? toAssignment(row) : undefined;
  }

  listAssignments(workitemId: string): Assignment[] {
    return this.db
      .prepare('SELECT * FROM workitem_assignments WHERE workitem_id = ? ORDER BY created_at, id')
      .all(workitemId)
      .map((row) => toAssignment(row as DbAssignment));
  }

  // Strongly-consistent in-flight counts for the owner-workers single-flight gate
  // (R01.AC-4 / internal-apis §2.2). Counts DB rows by status+role inside the apply
  // tx — never the effect-layer inflight Map (post-commit, would over-release on the
  // same frame). Within one transaction each just-inserted 'running' assignment is
  // visible to the next count, so a batch dispatch auto-accumulates without a separate
  // in-memory counter.
  countRunningByRole(workitemId: string, role: Assignment['role']): number {
    const row = this.stmt(
      "SELECT COUNT(*) AS c FROM workitem_assignments WHERE workitem_id = ? AND status = 'running' AND role = ?",
    ).get(workitemId, role) as { c: number };
    return row.c;
  }

  countRunningWorkers(workitemId: string): number {
    return this.countRunningByRole(workitemId, 'worker');
  }

  // Parent-chain reverse lookup (D-19 consumption side): list a parent assignment's
  // children for batch attribution / cascade abort.
  listAssignmentsByParent(parentId: string): Assignment[] {
    return this.db
      .prepare('SELECT * FROM workitem_assignments WHERE parent_id = ? ORDER BY created_at, id')
      .all(parentId)
      .map((row) => toAssignment(row as DbAssignment));
  }

  listRunningAssignments(): Assignment[] {
    // Watchdog-only scan: exclude assignments whose workitem is already terminal so
    // the 1Hz sweep never re-stalls a done item (v4 #3).
    return this.db
      .prepare(
        `SELECT a.* FROM workitem_assignments a
         JOIN workitems i ON i.id = a.workitem_id
         WHERE a.status = 'running' AND i.status NOT IN ('done','failed','cancelled')
         ORDER BY a.created_at, a.id`,
      )
      .all()
      .map((row) => toAssignment(row as DbAssignment));
  }

  insertWait(row: Wait): void {
    this.db
      .prepare(
        `INSERT INTO workitem_waits (
          id, workitem_id, kind, origin_assignment_id, reason, deadline_at, renewed_count,
          reminded_at, resolved_at, resolved_by, resolve_reason, created_at
        ) VALUES (
          @id, @workitemId, @kind, @originAssignmentId, @reason, @deadlineAt, @renewedCount,
          @remindedAt, @resolvedAt, @resolvedBy, @resolveReason, @createdAt
        )`,
      )
      .run(row);
  }

  updateWait(id: string, patch: WaitPatch): void {
    const { clause, values } = setClauses(patch, {
      resolvedAt: 'resolved_at',
      resolvedBy: 'resolved_by',
      resolveReason: 'resolve_reason',
      renewedCount: 'renewed_count',
      remindedAt: 'reminded_at',
    });
    if (!clause) return;
    this.stmt(`UPDATE workitem_waits SET ${clause} WHERE id = @id`).run({ ...values, id });
  }

  renewWaitDeadline(id: string, patch: WaitRenewalPatch): void {
    const { clause, values } = setClauses(patch, {
      deadlineAt: 'deadline_at',
      renewedCount: 'renewed_count',
      remindedAt: 'reminded_at',
    });
    this.stmt(`UPDATE workitem_waits SET ${clause} WHERE id = @id`).run({ ...values, id });
  }

  getWait(id: string): Wait | undefined {
    const row = this.stmt('SELECT * FROM workitem_waits WHERE id = ?').get(id) as
      | DbWait
      | undefined;
    return row ? toWait(row) : undefined;
  }

  listOpenWaits(workitemId?: string): Wait[] {
    const rows =
      workitemId === undefined
        ? // Watchdog-only global scan: exclude waits on terminal workitems so a
          // dangling timer/agent wait on a done item can't drive 1Hz event spam
          // (v4 #3). The per-workitem variant stays unfiltered — projection/recovery
          // recompute the rollup for items that may already be terminal.
          this.db
            .prepare(
              `SELECT w.* FROM workitem_waits w
               JOIN workitems i ON i.id = w.workitem_id
               WHERE w.resolved_at IS NULL AND i.status NOT IN ('done','failed','cancelled')
               ORDER BY w.deadline_at, w.id`,
            )
            .all()
        : this.db
            .prepare(
              'SELECT * FROM workitem_waits WHERE workitem_id = ? AND resolved_at IS NULL ORDER BY deadline_at, id',
            )
            .all(workitemId);
    return rows.map((row) => toWait(row as DbWait));
  }

  insertEffect(row: Omit<Effect, 'id'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO workitem_effects (
          workitem_id, seq, kind, payload_json, status, created_at, updated_at
        ) VALUES (@workitemId, @seq, @kind, @payloadJson, @status, @createdAt, @updatedAt)`,
      )
      .run({
        workitemId: row.workitemId,
        seq: row.seq,
        kind: row.kind,
        payloadJson: encodeJson(row.payload),
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    return Number(result.lastInsertRowid);
  }

  setEffectStatus(id: number, status: EffectStatus): void {
    this.db
      .prepare('UPDATE workitem_effects SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, this.clock.now(), id);
  }

  getEffect(id: number): Effect | undefined {
    const row = this.stmt('SELECT * FROM workitem_effects WHERE id = ?').get(id) as
      | DbEffect
      | undefined;
    return row ? toEffect(row) : undefined;
  }

  listInflightEffects(workitemId?: string): Effect[] {
    const rows =
      workitemId === undefined
        ? this.db
            .prepare(
              "SELECT * FROM workitem_effects WHERE status IN ('pending','running') ORDER BY seq, id",
            )
            .all()
        : this.db
            .prepare(
              "SELECT * FROM workitem_effects WHERE workitem_id = ? AND status IN ('pending','running') ORDER BY seq, id",
            )
            .all(workitemId);
    return rows.map((row) => toEffect(row as DbEffect));
  }

  lastRunEffectSeqBefore(workitemId: string, effectId: number, runKinds: string[]): number {
    if (runKinds.length === 0) return 0;
    const placeholders = runKinds.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT seq FROM workitem_effects
         WHERE workitem_id = ? AND id < ? AND kind IN (${placeholders})
         ORDER BY id DESC LIMIT 1`,
      )
      .get(workitemId, effectId, ...runKinds) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  appendEvent(workitemId: string, seq: number, kind: string, payload?: unknown): number {
    const result = this.db
      .prepare(
        `INSERT INTO workitem_events (workitem_id, seq, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(workitemId, seq, kind, encodeJson(payload), this.clock.now());
    return Number(result.lastInsertRowid);
  }

  nextSeq(workitemId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM workitem_events WHERE workitem_id = ?')
      .get(workitemId) as { seq: number };
    return row.seq;
  }

  eventsSince(workitemId: string, afterSeq: number, beforeSeq?: number): WorkItemEvent[] {
    const rows =
      beforeSeq === undefined
        ? this.db
            .prepare('SELECT * FROM workitem_events WHERE workitem_id = ? AND seq > ? ORDER BY seq')
            .all(workitemId, afterSeq)
        : this.db
            .prepare(
              'SELECT * FROM workitem_events WHERE workitem_id = ? AND seq > ? AND seq < ? ORDER BY seq',
            )
            .all(workitemId, afterSeq, beforeSeq);
    return rows.map((row) => toEvent(row as DbEvent));
  }

  listEvents(workitemId: string): WorkItemEvent[] {
    return this.db
      .prepare('SELECT * FROM workitem_events WHERE workitem_id = ? ORDER BY seq')
      .all(workitemId)
      .map((row) => toEvent(row as DbEvent));
  }

  // Existence-only probe for the rollup (v4 #12): the previous projection loaded and
  // JSON-parsed every event just to test `.some(seq > 1)` — O(N) per apply, O(N²) over
  // a long-lived workitem's lifecycle. An indexed EXISTS short-circuits at the first row.
  hasEventsBeyondCreation(workitemId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM workitem_events WHERE workitem_id = ? AND seq > 1 LIMIT 1')
      .get(workitemId);
    return row !== undefined;
  }

  async backup(destPath: string): Promise<void> {
    await this.db.backup(destPath);
  }

  close(): void {
    this.db.close();
  }
}
