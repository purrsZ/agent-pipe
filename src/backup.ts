import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from './logger.js';
import type { Store } from './store.js';

export const BACKUP_KEEP = 7;
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Startup backup is skipped when a recent one exists — a crash-looping process
// must not churn through the retention window and destroy older good copies.
export const STARTUP_BACKUP_MIN_AGE_MS = 12 * 60 * 60 * 1000;

const BACKUP_NAME_RE = /^db-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.sqlite$/;

export function backupFileName(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `db-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.sqlite`
  );
}

export function parseBackupTimestamp(name: string): Date | null {
  const m = BACKUP_NAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
}

/** Among `names`, return the backup files beyond the `keep` newest (to delete). */
export function selectBackupsToPrune(names: string[], keep: number = BACKUP_KEEP): string[] {
  return names
    .filter((n) => BACKUP_NAME_RE.test(n))
    .sort() // timestamp-format names sort chronologically as strings
    .reverse()
    .slice(keep);
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
  store: Store,
  backupsDir: string,
  keep: number = BACKUP_KEEP,
  now: Date = new Date(),
): Promise<string> {
  fs.mkdirSync(backupsDir, { recursive: true });
  const dest = path.join(backupsDir, backupFileName(now));
  await store.backup(dest);
  for (const stale of selectBackupsToPrune(fs.readdirSync(backupsDir), keep)) {
    try {
      fs.unlinkSync(path.join(backupsDir, stale));
    } catch {
      /* best-effort prune */
    }
  }
  return dest;
}

/**
 * Backup once at startup (unless a recent copy exists) and then every 24h.
 * Failures are logged, never thrown — a broken backup must not take the bot down.
 * Returns a stop function; the timer is unref'd.
 */
export function scheduleDailyBackup(store: Store, backupsDir: string, logger: Logger): () => void {
  const attempt = async (label: string) => {
    try {
      const dest = await runBackup(store, backupsDir);
      logger.info({ dest, label }, 'db backup done');
    } catch (err) {
      logger.error({ err, backupsDir, label }, 'db backup failed');
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
