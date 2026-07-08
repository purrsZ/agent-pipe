import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkitemsStore } from '../../src/workitems/store.js';
import type { Assignment, Clock, Wait, WorkItem } from '../../src/workitems/types.js';

let tmpDir: string;
let dbPath: string;
const clock: Clock = { now: () => 1000 };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-workitems-store-test-'));
  dbPath = path.join(tmpDir, 'workitems.sqlite');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function item(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    type: 'noop',
    title: id,
    status: 'open',
    statusDetail: null,
    phase: 'noop:idle',
    source: { kind: 'test' },
    dedupeKey: null,
    repos: [],
    context: null,
    wakePending: false,
    discardStreak: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function assignment(
  id: string,
  workitemId: string,
  overrides: Partial<Assignment> = {},
): Assignment {
  return {
    id,
    workitemId,
    parentId: null,
    repo: null,
    role: 'solo',
    status: 'running',
    agentSessionId: null,
    replacesAssignmentId: null,
    deadlineAt: 10_000,
    wallclockCapSec: 60,
    retries: 0,
    basedOnSeq: 1,
    briefPath: null,
    reportPath: null,
    createdAt: 1000,
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

function waitRow(id: string, workitemId: string, overrides: Partial<Wait> = {}): Wait {
  return {
    id,
    workitemId,
    kind: 'human',
    originAssignmentId: null,
    reason: 'test',
    deadlineAt: 10_000,
    renewedCount: 0,
    remindedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    resolveReason: null,
    cardMsgId: null,
    createdAt: 1000,
    ...overrides,
  };
}

function tableNames(db: Database.Database): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workitem%' ORDER BY name",
    )
    .all()
    .map((r) => (r as { name: string }).name);
}

describe('WorkitemsStore migration', () => {
  it('creates an independent WAL sqlite database with the seven workitem tables', () => {
    const store = new WorkitemsStore(dbPath, clock);
    store.close();

    const db = new Database(dbPath);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      7,
    );
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_assignments_running'",
        )
        .get(),
    ).toMatchObject({ name: 'idx_assignments_running' });
    // v3 requirement increment: role-aware running index + parent-chain index.
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_assignments_running_role'",
        )
        .get(),
    ).toMatchObject({ name: 'idx_assignments_running_role' });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_assignments_parent'",
        )
        .get(),
    ).toMatchObject({ name: 'idx_assignments_parent' });
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe(
      'wal',
    );
    expect(tableNames(db)).toEqual([
      'workitem_assignments',
      'workitem_delegations',
      'workitem_effects',
      'workitem_events',
      'workitem_parked',
      'workitem_waits',
      'workitems',
    ]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get(),
    ).toBe(undefined);
    db.close();
  });

  it('adds card_msg_id column to workitem_waits (v5) and reopening is idempotent', () => {
    // WS-3: 卡片消息 id 持久化——发过卡的 wait 记 card_msg_id，重启不重发。迁移幂等（老库重开不炸）。
    new WorkitemsStore(dbPath, clock).close();
    new WorkitemsStore(dbPath, clock).close();

    const db = new Database(dbPath);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      7,
    );
    const cols = (db.prepare('PRAGMA table_info(workitem_waits)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('card_msg_id');
    db.close();
  });

  it('creates workitem_delegations (v6) and reopening an old库 twice is idempotent (DELEGATE D1)', () => {
    // 老库（拿掉 delegations 表 + 回退版本号模拟 v5 库）重开两次——guarded 迁移幂等不炸。
    new WorkitemsStore(dbPath, clock).close();
    const old = new Database(dbPath);
    old.exec('DROP TABLE workitem_delegations; PRAGMA user_version = 5;');
    old.close();

    new WorkitemsStore(dbPath, clock).close();
    new WorkitemsStore(dbPath, clock).close();

    const db = new Database(dbPath);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      7,
    );
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='workitem_delegations'",
        )
        .get(),
    ).toMatchObject({ name: 'workitem_delegations' });
    db.close();
  });
});

describe('WorkitemsStore delegations (DELEGATE D1)', () => {
  // 全程用 opaque reason 字符串（'r-a' 等），证明容器对内容零解释。
  const grant = (over: Partial<Parameters<WorkitemsStore['upsertDelegation']>[1]> = {}) => ({
    reasons: ['r-a', 'r-b'],
    grantNote: '/delegate 8h',
    expiresAt: 1000 + 8 * 3_600 * 1000,
    createdBy: 'u-1',
    ...over,
  });

  it('upsertDelegation 覆盖旧行：每单至多一条生效授权', () => {
    const store = new WorkitemsStore(dbPath, clock);
    store.insertWorkItem(item('wi-1'));
    store.upsertDelegation('wi-1', grant());
    store.upsertDelegation('wi-1', grant({ reasons: ['r-c'], grantNote: '/delegate 2h' }));

    const active = store.activeDelegation('wi-1', 2000)!;
    expect(active.reasons).toEqual(['r-c']);
    expect(active.grantNote).toBe('/delegate 2h');
    // 旧行被撤销而非删除（留痕可审计）：总行数 2，生效 1。
    const db = new Database(dbPath);
    const rows = db
      .prepare('SELECT revoked_at FROM workitem_delegations WHERE workitem_id = ?')
      .all('wi-1') as Array<{ revoked_at: number | null }>;
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.revoked_at === null)).toHaveLength(1);
    db.close();
    store.close();
  });

  it('activeDelegation 过滤：正常命中 / 已撤销不命中 / 已到期不命中 / 不串单', () => {
    const store = new WorkitemsStore(dbPath, clock);
    store.insertWorkItem(item('wi-1'));
    store.insertWorkItem(item('wi-2'));
    store.upsertDelegation('wi-1', grant({ expiresAt: 5000 }));

    expect(store.activeDelegation('wi-1', 4999)?.createdBy).toBe('u-1');
    expect(store.activeDelegation('wi-1', 5000)).toBeUndefined(); // 到期即失效（expires_at > now）
    expect(store.activeDelegation('wi-2', 2000)).toBeUndefined(); // 不串单

    store.upsertDelegation('wi-1', grant({ expiresAt: 9000 }));
    expect(store.revokeDelegation('wi-1')).toBe(1);
    expect(store.activeDelegation('wi-1', 2000)).toBeUndefined(); // 已撤销
    expect(store.revokeDelegation('wi-1')).toBe(0); // 再撤无生效行
    store.close();
  });
});

describe('WorkitemsStore workitems', () => {
  it('roundtrips workitems and enforces UNIQUE(type, dedupe_key) while allowing NULL keys', () => {
    const store = new WorkitemsStore(dbPath, clock);

    store.insertWorkItem(item('wi-1', { dedupeKey: 'same' }));
    expect(store.getWorkItem('wi-1')!.source).toEqual({ kind: 'test' });
    expect(store.findByDedupe('noop', 'same')!.id).toBe('wi-1');
    expect(() => store.insertWorkItem(item('wi-2', { dedupeKey: 'same' }))).toThrow();

    store.insertWorkItem(item('wi-3'));
    store.insertWorkItem(item('wi-4'));
    expect(store.countNonTerminal()).toBe(3);

    store.updateWorkItem('wi-1', { status: 'done', statusDetail: null, updatedAt: 2000 });
    expect(store.countNonTerminal()).toBe(2);
    expect(
      store
        .listNonTerminal()
        .map((row) => row.id)
        .sort(),
    ).toEqual(['wi-3', 'wi-4']);
    store.close();
  });
});

describe('WorkitemsStore assignments and waits', () => {
  it('enforces assignment replaces and wait origin foreign keys', () => {
    const store = new WorkitemsStore(dbPath, clock);
    store.insertWorkItem(item('wi-1'));
    store.insertAssignment(assignment('as-1', 'wi-1'));
    store.insertAssignment(
      assignment('as-2', 'wi-1', { replacesAssignmentId: 'as-1', retries: 1 }),
    );
    expect(store.getAssignment('as-2')!.replacesAssignmentId).toBe('as-1');
    expect(() =>
      store.insertAssignment(assignment('as-bad', 'wi-1', { replacesAssignmentId: 'missing' })),
    ).toThrow();

    store.insertWait(waitRow('wt-1', 'wi-1', { kind: 'agent', originAssignmentId: 'as-1' }));
    expect(store.getWait('wt-1')!.originAssignmentId).toBe('as-1');
    expect(() =>
      store.insertWait(waitRow('wt-bad', 'wi-1', { kind: 'agent', originAssignmentId: 'missing' })),
    ).toThrow();

    store.updateWait('wt-1', {
      resolvedAt: 2000,
      resolvedBy: 'container',
      resolveReason: 'test',
    });
    expect(store.listOpenWaits('wi-1')).toHaveLength(0);
    store.close();
  });

  it('roundtrips card_msg_id through insert/updateWait/getWait', () => {
    const store = new WorkitemsStore(dbPath, clock);
    store.insertWorkItem(item('wi-1'));
    store.insertWait(waitRow('wt-1', 'wi-1'));
    expect(store.getWait('wt-1')!.cardMsgId).toBeNull();

    store.updateWait('wt-1', { cardMsgId: 'om_card_1' });
    expect(store.getWait('wt-1')!.cardMsgId).toBe('om_card_1');
    store.close();
  });
});

describe('WorkitemsStore events', () => {
  it('appends events with unique per-item seq and rejects update/delete bypasses', () => {
    const store = new WorkitemsStore(dbPath, clock);
    store.insertWorkItem(item('wi-1'));
    store.insertWorkItem(item('wi-2'));

    expect(store.nextSeq('wi-1')).toBe(1);
    const id1 = store.appendEvent('wi-1', 1, 'created', { ok: true });
    store.appendEvent('wi-1', 2, 'second');
    store.appendEvent('wi-2', 1, 'created');
    expect(id1).toBeGreaterThan(0);
    expect(store.nextSeq('wi-1')).toBe(3);
    expect(store.listEvents('wi-1').map((ev) => ev.seq)).toEqual([1, 2]);
    expect(store.eventsSince('wi-1', 1)).toHaveLength(1);
    expect(() => store.appendEvent('wi-1', 2, 'duplicate')).toThrow();
    store.close();

    const raw = new Database(dbPath);
    expect(() =>
      raw.prepare("UPDATE workitem_events SET kind='mutated' WHERE id=?").run(id1),
    ).toThrow();
    expect(() => raw.prepare('DELETE FROM workitem_events WHERE id=?').run(id1)).toThrow();
    raw.close();
  });
});

describe('WorkitemsStore.listAllRepos (INTAKE L0.2)', () => {
  it('去重展开全部单元 repos，跳过空/坏值', () => {
    const store = new WorkitemsStore(dbPath, clock);
    store.insertWorkItem(item('wi-1', { repos: ['/a', '/b'] }));
    store.insertWorkItem(item('wi-2', { repos: ['/b', '/c'] })); // /b 重复
    store.insertWorkItem(item('wi-3', { repos: [] })); // 空
    const all = store.listAllRepos().sort();
    expect(all).toEqual(['/a', '/b', '/c']);
    store.close();
  });

  it('无单元 → 空数组', () => {
    const store = new WorkitemsStore(dbPath, clock);
    expect(store.listAllRepos()).toEqual([]);
    store.close();
  });
});
