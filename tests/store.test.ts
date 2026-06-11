import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store, type Task } from '../src/store.js';

let tmpDir: string;
let dbPath: string;

const taskFixture = (
  id: string,
  overrides: Partial<Task> = {},
): Omit<Task, 'created_at' | 'last_active_at'> => ({
  id,
  display_name: id,
  agent_kind: 'claude',
  mode: 'sandbox',
  cwd: `/tmp/${id}`,
  root_msg_id: null,
  root_chat_id: null,
  agent_session_id: null,
  status: 'suspended',
  model: null,
  ...overrides,
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-store-test-'));
  dbPath = path.join(tmpDir, 'db.sqlite');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Store: tasks', () => {
  it('createTask → getTask roundtrip preserves all fields', () => {
    const store = new Store(dbPath);
    store.createTask(
      taskFixture('t1', {
        agent_kind: 'codex',
        mode: 'project',
        model: 'gpt-5.1-codex',
      }),
    );
    const got = store.getTask('t1');
    expect(got).toBeDefined();
    expect(got!.display_name).toBe('t1');
    expect(got!.agent_kind).toBe('codex');
    expect(got!.mode).toBe('project');
    expect(got!.model).toBe('gpt-5.1-codex');
    expect(got!.status).toBe('suspended');
    store.close();
  });

  it('session id set / clear', () => {
    const store = new Store(dbPath);
    store.createTask(taskFixture('t1'));
    store.setAgentSessionId('t1', 'sess-abc');
    expect(store.getTask('t1')!.agent_session_id).toBe('sess-abc');
    store.clearAgentSessionId('t1');
    expect(store.getTask('t1')!.agent_session_id).toBeNull();
    store.close();
  });

  it('root msg binding + lookup by root / by recorded message', () => {
    const store = new Store(dbPath);
    store.createTask(taskFixture('t1'));
    store.setRootMsg('t1', 'om_root', 'oc_chat');
    expect(store.getTaskByRootMsg('om_root')!.id).toBe('t1');
    store.recordTaskMessage('t1', 'om_reply');
    expect(store.getTaskByMessageId('om_reply')!.id).toBe('t1');
    expect(store.getTaskByMessageId('om_unknown')).toBeUndefined();
    store.close();
  });

  it('deleteTask cascades events and task_messages', () => {
    const store = new Store(dbPath);
    store.createTask(taskFixture('t1'));
    store.logEvent('t1', 'user', undefined, { text: 'hi' });
    store.recordTaskMessage('t1', 'om_1');
    store.deleteTask('t1');
    expect(store.getTask('t1')).toBeUndefined();
    expect(store.getTaskByMessageId('om_1')).toBeUndefined();
    expect(store.recentEvents('t1')).toHaveLength(0);
    store.close();
  });

  it('mostRecentTaskInChat picks the latest active task of that chat only', () => {
    // last_active_at comes from Date.now(); pin it so ordering can't tie
    vi.useFakeTimers();
    try {
      const store = new Store(dbPath);
      vi.setSystemTime(1_000);
      store.createTask(taskFixture('old'));
      store.setRootMsg('old', 'om_a', 'oc_1');
      vi.setSystemTime(2_000);
      store.createTask(taskFixture('other-chat'));
      store.setRootMsg('other-chat', 'om_b', 'oc_2');
      vi.setSystemTime(3_000);
      store.createTask(taskFixture('fresh'));
      store.setRootMsg('fresh', 'om_c', 'oc_1');
      expect(store.mostRecentTaskInChat('oc_1')!.id).toBe('fresh');
      expect(store.mostRecentTaskInChat('oc_2')!.id).toBe('other-chat');
      expect(store.mostRecentTaskInChat('oc_none')).toBeUndefined();
      // touching the older task flips the answer
      vi.setSystemTime(4_000);
      store.touchTask('old');
      expect(store.mostRecentTaskInChat('oc_1')!.id).toBe('old');
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Store: state & whitelist', () => {
  it('state set / overwrite / delete', () => {
    const store = new Store(dbPath);
    store.setState('k', 'v1');
    expect(store.getState('k')).toBe('v1');
    store.setState('k', 'v2');
    expect(store.getState('k')).toBe('v2');
    store.deleteState('k');
    expect(store.getState('k')).toBeUndefined();
    store.close();
  });

  it('whitelist add is idempotent, remove reports actual change', () => {
    const store = new Store(dbPath);
    expect(store.addWhitelist('ou_1', 'alice')).toBe(true);
    expect(store.addWhitelist('ou_1', 'alice')).toBe(false);
    expect(store.isAllowed('ou_1')).toBe(true);
    expect(store.isAllowed('ou_2')).toBe(false);
    expect(store.whitelistCount()).toBe(1);
    expect(store.removeWhitelist('ou_1')).toBe(true);
    expect(store.removeWhitelist('ou_1')).toBe(false);
    store.close();
  });

  it('clearCurrentForTask removes only that task’s current_task bindings', () => {
    const store = new Store(dbPath);
    store.setState('current_task:oc_1', 't1');
    store.setState('current_task:oc_2', 't1');
    store.setState('current_task:oc_3', 't2');
    store.clearCurrentForTask('t1');
    expect(store.getState('current_task:oc_1')).toBeUndefined();
    expect(store.getState('current_task:oc_2')).toBeUndefined();
    expect(store.getState('current_task:oc_3')).toBe('t2');
    store.close();
  });
});

describe('Store: legacy migration', () => {
  it('renames cc_session_id → agent_session_id and backfills agent_kind', () => {
    // Build an old-schema DB by hand (pre-agent_kind, cc_session_id era).
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE tasks (
        id             TEXT PRIMARY KEY,
        display_name   TEXT NOT NULL,
        mode           TEXT NOT NULL,
        cwd            TEXT NOT NULL,
        root_msg_id    TEXT UNIQUE,
        root_chat_id   TEXT,
        cc_session_id  TEXT,
        status         TEXT NOT NULL,
        model          TEXT,
        created_at     INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      );
    `);
    raw
      .prepare(
        `INSERT INTO tasks (id, display_name, mode, cwd, cc_session_id, status, created_at, last_active_at)
         VALUES ('legacy', 'legacy', 'sandbox', '/tmp/legacy', 'old-session', 'suspended', 1, 1)`,
      )
      .run();
    raw.close();

    const store = new Store(dbPath);
    const t = store.getTask('legacy');
    expect(t).toBeDefined();
    expect(t!.agent_session_id).toBe('old-session');
    expect(t!.agent_kind).toBe('claude');
    store.close();
  });

  it('drops the obsolete global current_task_id state key on open', () => {
    const store1 = new Store(dbPath);
    store1.close();
    const raw = new Database(dbPath);
    raw.prepare(`INSERT INTO state (key, value) VALUES ('current_task_id', 'stale')`).run();
    raw.close();
    const store2 = new Store(dbPath);
    expect(store2.getState('current_task_id')).toBeUndefined();
    store2.close();
  });

  it('reopening a current-schema DB is a no-op (idempotent migrate)', () => {
    const store1 = new Store(dbPath);
    store1.createTask(taskFixture('t1'));
    store1.close();
    const store2 = new Store(dbPath);
    expect(store2.getTask('t1')).toBeDefined();
    store2.close();
  });
});

describe('Store: events', () => {
  it('logEvent + recentEvents returns newest first with JSON payload', () => {
    const store = new Store(dbPath);
    store.createTask(taskFixture('t1'));
    store.logEvent('t1', 'user', undefined, { text: 'first' });
    store.logEvent('t1', 'tool', 'Bash', { cmd: 'ls' });
    const events = store.recentEvents('t1', 10);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.task_id === 't1')).toBe(true);
    const kinds = events.map((e) => e.kind).sort();
    expect(kinds).toEqual(['tool', 'user']);
    const tool = events.find((e) => e.kind === 'tool')!;
    expect(JSON.parse(tool.payload!)).toEqual({ cmd: 'ls' });
    store.close();
  });
});
