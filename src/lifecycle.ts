import * as fs from 'node:fs';
import type { Logger } from './logger.js';

// Exit codes contract with scripts/run-forever.sh: 0 = intentional stop (don't
// restart), non-zero = crash (supervisor restarts us).
export const EXIT_CRASH = 1;

/**
 * Remove the single-instance pid lock ONLY if it still records our own pid.
 *
 * WHY the guard: during a takeover restart, the NEW instance kills the old one
 * and immediately writes its own pid into the lock. The OLD instance's shutdown
 * then runs — an unconditional unlink would delete the NEW instance's lock,
 * orphaning it: later restarts find no lock, kill nothing, and two bots end up
 * sharing the Feishu WS connection (messages get split between old/new code —
 * observed live on 2026-06-11 as "/export 未知命令 but new card format").
 */
export function removeOwnPidFile(pidPath: string, pid: number = process.pid): boolean {
  try {
    if (fs.readFileSync(pidPath, 'utf-8').trim() !== String(pid)) return false;
    fs.unlinkSync(pidPath);
    return true;
  } catch {
    return false; // missing file / unreadable — nothing that belongs to us
  }
}

// Grace period before process.exit so pino's worker-thread transport can flush
// the fatal line; exiting synchronously loses the very log we crashed to write.
const CRASH_FLUSH_MS = 400;

export interface CrashGuardHandle {
  /** Remove the installed listeners (used by tests). */
  uninstall(): void;
}

/**
 * Last-resort safety net for a long-running daemon: any uncaught exception or
 * unhandled promise rejection gets logged with full context, resources are
 * cleaned up best-effort, and the process exits non-zero so the supervisor
 * (run-forever.sh / launchd / pm2) restarts a fresh instance. Without this,
 * Node either kills the process with nothing useful in our log, or worse,
 * leaves it alive in an undefined half-broken state.
 */
export function installCrashGuard(logger: Logger, cleanup: () => void): CrashGuardHandle {
  let crashing = false;

  const onFatal = (kind: string) => (err: unknown) => {
    if (crashing) {
      // double fault — cleanup itself crashed; bail immediately
      process.exit(EXIT_CRASH);
    }
    crashing = true;
    try {
      logger.fatal({ err, kind }, 'fatal error — exiting so supervisor can restart');
    } catch {
      /* logger itself may be broken; still proceed to exit */
    }
    try {
      cleanup();
    } catch {
      /* best-effort */
    }
    setTimeout(() => process.exit(EXIT_CRASH), CRASH_FLUSH_MS);
  };

  const onUncaught = onFatal('uncaughtException');
  const onUnhandled = onFatal('unhandledRejection');
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);

  return {
    uninstall() {
      process.removeListener('uncaughtException', onUncaught);
      process.removeListener('unhandledRejection', onUnhandled);
    },
  };
}

export interface HeartbeatStats {
  uptimeSec: number;
  rssMb: number;
  runningTurns: number;
  queuedMessages: number;
  hotRunners: number;
}

export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Periodic "I'm alive" line. A silent log can mean either "no traffic" or
 * "process wedged/dead" — the heartbeat makes the two distinguishable at a
 * glance and gives a coarse health timeline (memory, queue depth) for free.
 * Returns a stop function; the timer is unref'd so it never blocks exit.
 */
export function startHeartbeat(
  logger: Logger,
  getStats: () => HeartbeatStats,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): () => void {
  const tick = () => {
    try {
      logger.info(getStats(), 'heartbeat');
    } catch (err) {
      logger.warn({ err }, 'heartbeat stats collection failed');
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
