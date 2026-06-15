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
import { makeWorkItem } from '../helpers/workitems.js';

let tmpDir: string;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-storage-flow-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('workitems storage flow', () => {
  it('creates a workitem, writes artifacts, records events, and backs up DB plus git history', async () => {
    const dbPath = path.join(tmpDir, 'workitems.sqlite');
    const artifactsDir = path.join(tmpDir, 'workitems');
    const backupsDir = path.join(tmpDir, 'backups');
    const store = new WorkitemsStore(dbPath, new SystemClock());
    const artifacts = new ArtifactStore(artifactsDir, logger);

    store.insertWorkItem(makeWorkItem('wi-flow'));
    artifacts.initRepo('wi-flow');
    artifacts.writeFile('wi-flow', 'brief.md', 'flow brief', 'write brief');
    store.appendEvent('wi-flow', 1, 'workitem_created', { source: 'test' });
    store.appendEvent('wi-flow', 2, 'artifact_written', { path: 'brief.md' });

    const job = createWorkitemsBackupJob({ store, artifactsDir, backupsDir, logger });
    await job.run(new Date(2026, 0, 10, 1, 0, 0));
    store.close();

    expect(fs.existsSync(path.join(artifactsDir, 'wi-flow', '.git'))).toBe(true);
    expect(artifacts.readFile('wi-flow', 'brief.md')).toBe('flow brief');
    expect(storeClosedDbRows(path.join(backupsDir, 'workitems-20260110-010000.sqlite'))).toEqual({
      itemCount: 1,
      eventCount: 2,
    });

    const tarPath = path.join(backupsDir, 'workitems-files-20260110-010000.tar.gz');
    const listing = execFileSync('tar', ['-tzf', tarPath], { encoding: 'utf8' });
    expect(listing).toContain('wi-flow/.git/');
    expect(listing).toContain('wi-flow/brief.md');
  });
});

function storeClosedDbRows(dbPath: string): { itemCount: number; eventCount: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    const itemCount = (db.prepare('SELECT COUNT(*) AS c FROM workitems').get() as { c: number }).c;
    const eventCount = (
      db.prepare('SELECT COUNT(*) AS c FROM workitem_events').get() as { c: number }
    ).c;
    return { itemCount, eventCount };
  } finally {
    db.close();
  }
}
