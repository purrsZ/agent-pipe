import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Store } from './store.js';

export const BACKUP_KEEP = 7;
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Startup backup is skipped when a recent one exists — a crash-looping process
// must not churn through the retention window and destroy older good copies.
export const STARTUP_BACKUP_MIN_AGE_MS = 12 * 60 * 60 * 1000;

/** Minimal surface runBackup needs — any store exposing an online `backup(dest)`. */
export interface BackupSource {
  backup(destPath: string): Promise<void>;
}

export interface BackupNameOptions {
  prefix?: string;
  ext?: string;
}

export interface SelectBackupsOptions extends BackupNameOptions {
  keep?: number;
}

export interface BackupJob {
  label: string;
  run(now: Date): Promise<string | undefined>;
}

interface BackupLogger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const DEFAULT_BACKUP_NAME_OPTIONS = {
  prefix: 'db',
  ext: '.sqlite',
} as const;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeNameOptions(options: BackupNameOptions = {}): Required<BackupNameOptions> {
  return {
    prefix: options.prefix ?? DEFAULT_BACKUP_NAME_OPTIONS.prefix,
    ext: options.ext ?? DEFAULT_BACKUP_NAME_OPTIONS.ext,
  };
}

function backupNameRe(options: BackupNameOptions = {}): RegExp {
  const { prefix, ext } = normalizeNameOptions(options);
  return new RegExp(
    `^${escapeRegex(prefix)}-(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})${escapeRegex(ext)}$`,
  );
}

export function backupFileName(now: Date, options: BackupNameOptions = {}): string {
  const { prefix, ext } = normalizeNameOptions(options);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${prefix}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${ext}`
  );
}

export function parseBackupTimestamp(name: string, options: BackupNameOptions = {}): Date | null {
  const m = backupNameRe(options).exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

/** Among `names`, return the backup files beyond the `keep` newest (to delete). */
export function selectBackupsToPrune(
  names: string[],
  keepOrOptions: number | SelectBackupsOptions = BACKUP_KEEP,
): string[] {
  const options =
    typeof keepOrOptions === 'number'
      ? { ...DEFAULT_BACKUP_NAME_OPTIONS, keep: keepOrOptions }
      : {
          ...DEFAULT_BACKUP_NAME_OPTIONS,
          ...keepOrOptions,
          keep: keepOrOptions.keep ?? BACKUP_KEEP,
        };
  const nameRe = backupNameRe(options);
  return names
    .filter((n) => nameRe.test(n))
    .sort() // timestamp-format names sort chronologically as strings
    .reverse()
    .slice(options.keep);
}

/** True when there is no backup newer than STARTUP_BACKUP_MIN_AGE_MS. */
export function shouldBackupNow(names: string[], now: Date): boolean {
  let newest: Date | null = null;
  for (const n of names) {
    const t = parseBackupTimestamp(n);
    if (t && (!newest || t > newest)) newest = t;
  }
  if (!newest) return true;
  return now.getTime() - newest.getTime() >= STARTUP_BACKUP_MIN_AGE_MS;
}

/** Online-backup the live DB into backupsDir and prune old copies. Returns the new file path. */
export async function runBackup(
  store: BackupSource,
  backupsDir: string,
  keep: number = BACKUP_KEEP,
  now: Date = new Date(),
  naming: BackupNameOptions = {},
): Promise<string> {
  fs.mkdirSync(backupsDir, { recursive: true });
  const dest = path.join(backupsDir, backupFileName(now, naming));
  await store.backup(dest);
  // The source DB is WAL-mode, so the copy may land with a sidecar -wal file.
  // Fold it in so the single .sqlite file alone is a complete restore artifact.
  const copy = new Database(dest);
  copy.pragma('wal_checkpoint(TRUNCATE)');
  copy.close();
  for (const sidecar of [`${dest}-wal`, `${dest}-shm`]) {
    try {
      fs.unlinkSync(sidecar);
    } catch {
      /* already gone */
    }
  }
  for (const stale of selectBackupsToPrune(fs.readdirSync(backupsDir), { ...naming, keep })) {
    for (const f of [stale, `${stale}-wal`, `${stale}-shm`]) {
      try {
        fs.unlinkSync(path.join(backupsDir, f));
      } catch {
        /* best-effort prune */
      }
    }
  }
  return dest;
}

/**
 * Backup once at startup (unless a recent copy exists) and then every 24h.
 * Failures are logged, never thrown — a broken backup must not take the bot down.
 * Returns a stop function; the timer is unref'd.
 */
export function scheduleDailyBackup(
  store: Store,
  backupsDir: string,
  logger: BackupLogger,
  extraJobs: BackupJob[] = [],
): () => void {
  const attempt = async (label: string) => {
    const now = new Date();
    try {
      const dest = await runBackup(store, backupsDir, BACKUP_KEEP, now);
      logger.info({ dest, label }, 'db backup done');
    } catch (err) {
      logger.error({ err, backupsDir, label }, 'db backup failed');
    }

    for (const job of extraJobs) {
      const jobLabel = `${label}:${job.label}`;
      try {
        const dest = await job.run(now);
        logger.info({ dest, label: jobLabel }, 'backup extra job done');
      } catch (err) {
        logger.error({ err, backupsDir, label: jobLabel }, 'backup extra job failed');
      }
    }
  };

  let existing: string[] = [];
  try {
    existing = fs.readdirSync(backupsDir);
  } catch {
    /* dir may not exist yet */
  }
  if (shouldBackupNow(existing, new Date())) void attempt('startup');

  const timer = setInterval(() => void attempt('daily'), BACKUP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
