import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, type Task } from '../src/store.js';

let tmpDir: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-managed-iso-'));
  dbPath = path.join(tmpDir, 'db.sqlite');
  store = new Store(dbPath);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function bridgeTask(id: string, overrides: Partial<Task> = {}): void {
  store.createTask({
    id,
    display_name: id,
    agent_kind: 'claude',
    mode: 'project',
    cwd: '/tmp/x',
    root_msg_id: overrides.root_msg_id ?? null,
    root_chat_id: overrides.root_chat_id ?? null,
    agent_session_id: null,
    status: 'hot',
    model: null,
  });
}

function managedTask(id: string, overrides: Partial<Task> = {}): Task {
  return store.upsertTask({
    id,
    display_name: id,
    agent_kind: 'claude',
    owner_kind: 'managed',
    mode: 'project',
    cwd: overrides.cwd ?? '/tmp/repo',
    root_msg_id: null,
    root_chat_id: overrides.root_chat_id ?? null,
    agent_session_id: overrides.agent_session_id ?? null,
    status: overrides.status ?? 'suspended',
    model: null,
  });
}

describe('managed shadow task isolation (WI-1)', () => {
  it('createTask defaults owner_kind to bridge', () => {
    bridgeTask('t1');
    expect(store.getTask('t1')?.owner_kind).toBe('bridge');
  });

  it('upsertTask creates a managed row, getTask reaches it but getBridgeTask does not (D6)', () => {
    managedTask('managed:a');
    expect(store.getTask('managed:a')?.owner_kind).toBe('managed');
    expect(store.getBridgeTask('managed:a')).toBeUndefined();
  });

  it('listTasks excludes managed shadow tasks', () => {
    bridgeTask('b1');
    managedTask('managed:a');
    const ids = store.listTasks().map((t) => t.id);
    expect(ids).toContain('b1');
    expect(ids).not.toContain('managed:a');
  });

  it('routing exits never surface a managed task', () => {
    managedTask('managed:r', { root_chat_id: 'chat-1' });
    store.recordTaskMessage('managed:r', 'msg-1');
    // mostRecentTaskInChat / getTaskByMessageId / getTaskByRootMsg are all bridge-only.
    expect(store.mostRecentTaskInChat('chat-1')).toBeUndefined();
    expect(store.getTaskByMessageId('msg-1')).toBeUndefined();
    expect(store.getTaskByRootMsg('msg-1')).toBeUndefined();
  });

  it('a bridge task in the same chat is still routed', () => {
    bridgeTask('b2', { root_chat_id: 'chat-2' });
    managedTask('managed:x', { root_chat_id: 'chat-2' });
    expect(store.mostRecentTaskInChat('chat-2')?.id).toBe('b2');
  });

  it('upsert ON CONFLICT refreshes cwd but preserves a runner-written session', () => {
    managedTask('managed:s', { cwd: '/tmp/old' });
    store.setAgentSessionId('managed:s', 'sess-runner'); // runner writes mid-turn
    managedTask('managed:s', { cwd: '/tmp/new', agent_session_id: null }); // re-upsert
    const row = store.getTask('managed:s');
    expect(row?.cwd).toBe('/tmp/new');
    expect(row?.agent_session_id).toBe('sess-runner'); // NOT clobbered
  });
});

describe('owner_kind migration (WI-1, old DB back-fill)', () => {
  it('ADD COLUMN back-fills existing rows to bridge and keeps them visible', () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-legacy-'));
    const legacyPath = path.join(legacyDir, 'db.sqlite');
    // Hand-craft an old-schema tasks table WITHOUT owner_kind, insert a row.
    const raw = new Database(legacyPath);
    raw.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, agent_kind TEXT NOT NULL DEFAULT 'claude',
        mode TEXT NOT NULL, cwd TEXT NOT NULL, root_msg_id TEXT, root_chat_id TEXT,
        agent_session_id TEXT, status TEXT NOT NULL, model TEXT,
        created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL
      );
    `);
    raw
      .prepare(
        `INSERT INTO tasks (id, display_name, agent_kind, mode, cwd, status, created_at, last_active_at)
         VALUES ('legacy', 'legacy', 'claude', 'project', '/tmp', 'hot', 1, 1)`,
      )
      .run();
    raw.close();

    const migrated = new Store(legacyPath);
    const row = migrated.getTask('legacy');
    expect(row?.owner_kind).toBe('bridge');
    expect(migrated.listTasks().map((t) => t.id)).toContain('legacy');
    migrated.close();
    fs.rmSync(legacyDir, { recursive: true, force: true });
  });
});
