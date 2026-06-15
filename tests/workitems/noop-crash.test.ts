import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tmpDir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-noop-crash-test-'));
});

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stopChild(child, 'SIGTERM')));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('noop process crash recovery', () => {
  it('recovers a pending effect after SIGKILL and reconciles dirty artifacts', async () => {
    const dataDir = path.join(tmpDir, 'pending');
    const child = spawnFixture(dataDir, {
      WINDOW: 'pending',
      MAKE_DIRTY: '1',
      NOOP_PARAMS: JSON.stringify({ delayMs: 0, timerWaitSec: 1 }),
    });
    await waitForReady(dataDir, 'ready.json');
    await waitForDb(dataDir, (db) => effectStatuses(db).includes('pending'));

    await stopChild(child, 'SIGKILL');

    const restarted = spawnFixture(dataDir, { CREATE_ON_START: '0' }, 'ready-restart.json');
    await waitForReady(dataDir, 'ready-restart.json');
    await waitForDb(dataDir, (db) => workitemStatuses(db).includes('done'));

    const seqs = withDb(dataDir, (db) =>
      db
        .prepare('SELECT seq FROM workitem_events ORDER BY seq')
        .all()
        .map((row) => (row as { seq: number }).seq),
    );
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    expect(effectStatuses(withPath(dataDir))).toEqual(['done']);
    const itemId = firstWorkitemId(dataDir);
    const repo = path.join(dataDir, 'workitems', itemId);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe(
      '',
    );
    expect(execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' })).toContain(
      'reconcile',
    );
    await stopChild(restarted, 'SIGTERM');
  }, 20_000);

  it.each([
    ['resumable', true, 1],
    ['redispatched', false, 2],
  ] as const)(
    'recovers a running effect via %s path',
    async (_label, simulateResumable, assignmentCount) => {
      const dataDir = path.join(tmpDir, `running-${simulateResumable}`);
      const child = spawnFixture(dataDir, {
        NOOP_PARAMS: JSON.stringify({ delayMs: 500, timerWaitSec: 1, simulateResumable }),
      });
      await waitForReady(dataDir, 'ready.json');
      await waitForDb(dataDir, (db) => {
        const row = db
          .prepare('SELECT status FROM workitem_effects ORDER BY id DESC LIMIT 1')
          .get() as { status: string } | undefined;
        const session = db
          .prepare(
            'SELECT agent_session_id FROM workitem_assignments ORDER BY created_at DESC LIMIT 1',
          )
          .get() as { agent_session_id: string | null } | undefined;
        return row?.status === 'running' && session?.agent_session_id?.startsWith('noop:') === true;
      });

      await stopChild(child, 'SIGKILL');

      const restarted = spawnFixture(dataDir, { CREATE_ON_START: '0' }, 'ready-restart.json');
      await waitForReady(dataDir, 'ready-restart.json');
      await waitForDb(dataDir, (db) => workitemStatuses(db).includes('done'));

      const assignments = withDb(
        dataDir,
        (db) =>
          db
            .prepare(
              'SELECT status, replaces_assignment_id FROM workitem_assignments ORDER BY created_at, id',
            )
            .all() as Array<{ status: string; replaces_assignment_id: string | null }>,
      );
      expect(assignments).toHaveLength(assignmentCount);
      if (!simulateResumable) {
        expect(assignments[0]).toMatchObject({ status: 'superseded' });
        expect(assignments[1]!.replaces_assignment_id).toBeTruthy();
      }
      const seqs = withDb(dataDir, (db) =>
        db
          .prepare('SELECT seq FROM workitem_events ORDER BY seq')
          .all()
          .map((row) => (row as { seq: number }).seq),
      );
      expect(seqs).toEqual(seqs.map((_, index) => index + 1));
      await stopChild(restarted, 'SIGTERM');
    },
    20_000,
  );
});

function spawnFixture(
  dataDir: string,
  env: Record<string, string>,
  readyName = 'ready.json',
): ChildProcess {
  // Spawn node directly (not the tsx bin wrapper): the wrapper re-spawns node as
  // a grandchild, so SIGKILL would kill only the wrapper and leave an orphaned
  // fixture running against the shared DB — masking recovery-liveness bugs.
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(process.cwd(), 'tests/fixtures/workitems-app.ts')],
    {
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        READY_FILE: path.join(dataDir, readyName),
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  return child;
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill(signal);
  });
}

async function waitForReady(dataDir: string, name: string): Promise<void> {
  await waitFor(() => expect(fs.existsSync(path.join(dataDir, name))).toBe(true), 5000);
}

async function waitForDb(
  dataDir: string,
  predicate: (db: Database.Database) => boolean,
): Promise<void> {
  await waitFor(() => {
    const dbPath = withPath(dataDir);
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(predicate(db)).toBe(true);
    } finally {
      db.close();
    }
  }, 8000);
}

async function waitFor(assertion: () => void, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('waitFor timed out');
}

function withPath(dataDir: string): string {
  return path.join(dataDir, 'workitems.sqlite');
}

function withDb<T>(dataDir: string, fn: (db: Database.Database) => T): T {
  const db = new Database(withPath(dataDir), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function effectStatuses(dbOrPath: Database.Database | string): string[] {
  if (typeof dbOrPath === 'string') {
    return withDb(path.dirname(dbOrPath), (db) => effectStatuses(db));
  }
  return dbOrPath
    .prepare('SELECT status FROM workitem_effects ORDER BY id')
    .all()
    .map((row) => (row as { status: string }).status);
}

function workitemStatuses(db: Database.Database): string[] {
  return db
    .prepare('SELECT status FROM workitems ORDER BY id')
    .all()
    .map((row) => (row as { status: string }).status);
}

function firstWorkitemId(dataDir: string): string {
  return withDb(dataDir, (db) => {
    const row = db.prepare('SELECT id FROM workitems ORDER BY created_at LIMIT 1').get() as {
      id: string;
    };
    return row.id;
  });
}
