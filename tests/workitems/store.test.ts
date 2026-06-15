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
  it('creates an independent WAL sqlite database with the five workitem tables', () => {
    const store = new WorkitemsStore(dbPath, clock);
    store.close();

    const db = new Database(dbPath);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      1,
    );
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe(
      'wal',
    );
    expect(tableNames(db)).toEqual([
      'workitem_assignments',
      'workitem_effects',
      'workitem_events',
      'workitem_waits',
      'workitems',
    ]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get(),
    ).toBe(undefined);
    db.close();
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
