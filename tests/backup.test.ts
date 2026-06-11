import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  backupFileName,
  parseBackupTimestamp,
  runBackup,
  STARTUP_BACKUP_MIN_AGE_MS,
  selectBackupsToPrune,
  shouldBackupNow,
} from '../src/backup.js';
import { Store } from '../src/store.js';

describe('backup naming', () => {
  it('backupFileName is zero-padded and parseable back to the same instant', () => {
    const d = new Date(2026, 0, 5, 3, 7, 9); // 2026-01-05 03:07:09 local
    const name = backupFileName(d);
    expect(name).toBe('db-20260105-030709.sqlite');
    expect(parseBackupTimestamp(name)!.getTime()).toBe(d.getTime());
  });

  it('parseBackupTimestamp rejects foreign filenames', () => {
    expect(parseBackupTimestamp('db.sqlite')).toBeNull();
    expect(parseBackupTimestamp('db-2026-junk.sqlite')).toBeNull();
    expect(parseBackupTimestamp('notes.txt')).toBeNull();
  });
});

describe('selectBackupsToPrune', () => {
  it('keeps the newest N and returns the rest, ignoring foreign files', () => {
    const names = [
      'db-20260601-010101.sqlite',
      'db-20260603-010101.sqlite',
      'db-20260602-010101.sqlite',
      'db.sqlite', // live DB must never be pruned
      'README.md',
    ];
    expect(selectBackupsToPrune(names, 2)).toEqual(['db-20260601-010101.sqlite']);
    expect(selectBackupsToPrune(names, 3)).toEqual([]);
  });
});

describe('shouldBackupNow', () => {
  const now = new Date(2026, 5, 11, 12, 0, 0);

  it('true when no backups exist', () => {
    expect(shouldBackupNow([], now)).toBe(true);
    expect(shouldBackupNow(['unrelated.txt'], now)).toBe(true);
  });

  it('false when a recent backup exists (crash-loop churn protection)', () => {
    const fresh = backupFileName(new Date(now.getTime() - 60_000));
    expect(shouldBackupNow([fresh], now)).toBe(false);
  });

  it('true when the newest backup is older than the threshold', () => {
    const stale = backupFileName(new Date(now.getTime() - STARTUP_BACKUP_MIN_AGE_MS - 1000));
    expect(shouldBackupNow([stale], now)).toBe(true);
  });
});

describe('runBackup (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-backup-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces a readable sqlite copy containing the data, and prunes old copies', async () => {
    const store = new Store(path.join(tmpDir, 'db.sqlite'));
    store.createTask({
      id: 't1',
      display_name: 't1',
      agent_kind: 'claude',
      mode: 'sandbox',
      cwd: tmpDir,
      root_msg_id: null,
      root_chat_id: null,
      agent_session_id: null,
      status: 'suspended',
      model: null,
    });

    const backupsDir = path.join(tmpDir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    // pre-seed stale backups beyond the keep window
    for (let day = 1; day <= 9; day++) {
      const name = backupFileName(new Date(2026, 0, day, 1, 0, 0));
      fs.writeFileSync(path.join(backupsDir, name), 'stale');
    }

    const dest = await runBackup(store, backupsDir, 7, new Date(2026, 0, 10, 1, 0, 0));
    store.close();

    // List BEFORE opening the copy — merely opening a WAL-mode sqlite file
    // (even readonly) recreates -shm/-wal sidecars and would pollute the check.
    const all = fs.readdirSync(backupsDir);
    // backups must be self-contained single files — no WAL/SHM sidecars left over
    expect(all.some((n) => n.endsWith('-wal') || n.endsWith('-shm'))).toBe(false);
    const left = all.filter((n) => /^db-\d{8}-\d{6}\.sqlite$/.test(n)).sort();
    expect(left).toHaveLength(7);
    // the oldest seeds are gone, the new backup is present
    expect(left).not.toContain('db-20260101-010000.sqlite');
    expect(left).not.toContain('db-20260102-010000.sqlite');
    expect(left).toContain('db-20260110-010000.sqlite');

    const copy = new Database(dest, { readonly: true });
    const count = (copy.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c;
    copy.close();
    expect(count).toBe(1);
  });
});
