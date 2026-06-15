import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { BACKUP_KEEP, backupFileName, type BackupJob, selectBackupsToPrune } from '../backup.js';
import type { WorkitemsStore } from './store.js';

const execFileAsync = promisify(execFile);

type LoggerLike = {
  info?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
};

export interface WorkitemsBackupDeps {
  store: Pick<WorkitemsStore, 'backup'>;
  artifactsDir: string;
  backupsDir: string;
  logger: LoggerLike;
  keep?: number;
}

export function createWorkitemsBackupJob(deps: WorkitemsBackupDeps): BackupJob {
  return {
    label: 'workitems',
    run: async (now: Date) => {
      fs.mkdirSync(deps.backupsDir, { recursive: true });
      await backupSqlite(deps, now);
      await backupArtifacts(deps, now);
      return undefined;
    },
  };
}

async function backupSqlite(deps: WorkitemsBackupDeps, now: Date): Promise<void> {
  const dest = path.join(
    deps.backupsDir,
    backupFileName(now, { prefix: 'workitems', ext: '.sqlite' }),
  );
  try {
    await deps.store.backup(dest);
    const copy = new Database(dest);
    copy.pragma('wal_checkpoint(TRUNCATE)');
    copy.close();
    removeSidecars(dest);
    prune(deps, { prefix: 'workitems', ext: '.sqlite' });
    deps.logger.info?.({ dest, label: 'workitems.sqlite' }, 'workitems backup done');
  } catch (err) {
    deps.logger.error?.(
      { err, backupsDir: deps.backupsDir, label: 'workitems.sqlite' },
      'workitems backup failed',
    );
  }
}

async function backupArtifacts(deps: WorkitemsBackupDeps, now: Date): Promise<void> {
  const dest = path.join(
    deps.backupsDir,
    backupFileName(now, { prefix: 'workitems-files', ext: '.tar.gz' }),
  );
  try {
    // Async spawn (v4 #13): a large artifact tree makes tar run for seconds; a
    // synchronous execFileSync would block the event loop that whole time, starving
    // the watchdog into missed ticks and false heartbeat_silent verdicts on healthy
    // runs — a perf cost escalating into supervisor mis-kills.
    await execFileAsync('tar', ['-czf', dest, '-C', deps.artifactsDir, '.']);
    prune(deps, { prefix: 'workitems-files', ext: '.tar.gz' });
    deps.logger.info?.({ dest, label: 'workitems.files' }, 'workitems backup done');
  } catch (err) {
    deps.logger.error?.(
      { err, backupsDir: deps.backupsDir, label: 'workitems.files' },
      'workitems backup failed',
    );
  }
}

function prune(deps: WorkitemsBackupDeps, options: { prefix: string; ext: string }): void {
  const keep = deps.keep ?? BACKUP_KEEP;
  for (const stale of selectBackupsToPrune(fs.readdirSync(deps.backupsDir), { ...options, keep })) {
    for (const f of [stale, `${stale}-wal`, `${stale}-shm`]) {
      try {
        fs.unlinkSync(path.join(deps.backupsDir, f));
      } catch {
        /* best-effort prune */
      }
    }
  }
}

function removeSidecars(dest: string): void {
  for (const sidecar of [`${dest}-wal`, `${dest}-shm`]) {
    try {
      fs.unlinkSync(sidecar);
    } catch {
      /* already gone */
    }
  }
}
