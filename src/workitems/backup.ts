import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  BACKUP_KEEP,
  backupFileName,
  type BackupJob,
  runBackup,
  selectBackupsToPrune,
} from '../backup.js';
import type { LoggerLike } from './shared.js';
import type { WorkitemsStore } from './store.js';

const execFileAsync = promisify(execFile);

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
  try {
    // Reuse the kernel online-backup primitive (v4 #15): online backup + WAL
    // checkpoint(TRUNCATE) + sidecar fold + naming-scoped prune were duplicated here.
    const dest = await runBackup(deps.store, deps.backupsDir, deps.keep ?? BACKUP_KEEP, now, {
      prefix: 'workitems',
      ext: '.sqlite',
    });
    deps.logger.info?.({ dest, label: 'workitems.sqlite' }, 'workitems backup done');
  } catch (err) {
    deps.logger.error?.(
      { err, backupsDir: deps.backupsDir, label: 'workitems.sqlite' },
      'workitems backup failed',
    );
  }
}

async function backupArtifacts(deps: WorkitemsBackupDeps, now: Date): Promise<void> {
  // Nothing to archive until the first workitem creates its artifact repo — skip
  // quietly rather than letting `tar` fail with "could not chdir" on a fresh install.
  if (!fs.existsSync(deps.artifactsDir)) {
    deps.logger.info?.(
      { artifactsDir: deps.artifactsDir },
      'no artifacts dir yet, skip files backup',
    );
    return;
  }
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
