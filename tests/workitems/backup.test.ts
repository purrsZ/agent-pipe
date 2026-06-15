import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { createWorkitemsBackupJob } from '../../src/workitems/backup.js';
import { SystemClock } from '../../src/workitems/clock.js';
import { WorkitemsStore } from '../../src/workitems/store.js';
import type { WorkItem } from '../../src/workitems/types.js';

let tmpDir: string;
let dbPath: string;
let artifactsDir: string;
let backupsDir: string;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function item(id: string): WorkItem {
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
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-workitems-backup-test-'));
  dbPath = path.join(tmpDir, 'workitems.sqlite');
  artifactsDir = path.join(tmpDir, 'workitems');
  backupsDir = path.join(tmpDir, 'backups');
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createWorkitemsBackupJob', () => {
  it('backs up workitems.sqlite into a readable single-file sqlite copy', async () => {
    const store = new WorkitemsStore(dbPath, new SystemClock());
    store.insertWorkItem(item('wi-1'));
    const job = createWorkitemsBackupJob({ store, artifactsDir, backupsDir, logger });

    await job.run(new Date(2026, 0, 10, 1, 0, 0));
    store.close();

    const names = fs.readdirSync(backupsDir);
    expect(names).toContain('workitems-20260110-010000.sqlite');
    expect(names.some((n) => n.endsWith('-wal') || n.endsWith('-shm'))).toBe(false);

    const copy = new Database(path.join(backupsDir, 'workitems-20260110-010000.sqlite'), {
      readonly: true,
    });
    const count = (copy.prepare('SELECT COUNT(*) AS c FROM workitems').get() as { c: number }).c;
    copy.close();
    expect(count).toBe(1);
  });

  it('backs up the artifact directory as a tar.gz that includes git history', async () => {
    const store = new WorkitemsStore(dbPath, new SystemClock());
    const artifacts = new ArtifactStore(artifactsDir, logger);
    artifacts.initRepo('wi-1');
    artifacts.writeFile('wi-1', 'assignments/as-1/report.md', 'done', 'write report');
    const job = createWorkitemsBackupJob({ store, artifactsDir, backupsDir, logger });

    await job.run(new Date(2026, 0, 10, 1, 0, 0));
    store.close();

    const tarPath = path.join(backupsDir, 'workitems-files-20260110-010000.tar.gz');
    expect(fs.existsSync(tarPath)).toBe(true);
    const listing = execFileSync('tar', ['-tzf', tarPath], { encoding: 'utf8' });
    expect(listing).toContain('wi-1/.git/');
    expect(listing).toContain('wi-1/assignments/as-1/report.md');
  });

  it('isolates DB backup failures from artifact tar backup', async () => {
    const artifacts = new ArtifactStore(artifactsDir, logger);
    artifacts.initRepo('wi-1');
    const failingStore = {
      backup: vi.fn(async () => {
        throw new Error('db failed');
      }),
    } as unknown as WorkitemsStore;
    const job = createWorkitemsBackupJob({ store: failingStore, artifactsDir, backupsDir, logger });

    await job.run(new Date(2026, 0, 10, 1, 0, 0));

    expect(fs.existsSync(path.join(backupsDir, 'workitems-files-20260110-010000.tar.gz'))).toBe(
      true,
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'workitems.sqlite' }),
      'workitems backup failed',
    );
  });

  it('isolates artifact tar failures from DB backup', async () => {
    const store = new WorkitemsStore(dbPath, new SystemClock());
    store.insertWorkItem(item('wi-1'));
    const missingArtifactsDir = path.join(tmpDir, 'missing-workitems-dir');
    const job = createWorkitemsBackupJob({
      store,
      artifactsDir: missingArtifactsDir,
      backupsDir,
      logger,
    });

    await job.run(new Date(2026, 0, 10, 1, 0, 0));
    store.close();

    expect(fs.existsSync(path.join(backupsDir, 'workitems-20260110-010000.sqlite'))).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'workitems.files' }),
      'workitems backup failed',
    );
  });
});
