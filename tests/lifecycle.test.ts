import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCrashGuard, startHeartbeat, HEARTBEAT_INTERVAL_MS } from '../src/lifecycle.js';
import type { Logger } from '../src/logger.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; fatal: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('startHeartbeat', () => {
  it('logs stats every interval and stops cleanly', () => {
    const logger = makeLogger();
    const stats = {
      uptimeSec: 1,
      rssMb: 100,
      runningTurns: 0,
      queuedMessages: 0,
      hotRunners: 2,
    };
    const stop = startHeartbeat(logger, () => stats);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(stats, 'heartbeat');

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(logger.info).toHaveBeenCalledTimes(2);

    stop();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it('a throwing stats provider downgrades to warn instead of crashing', () => {
    const logger = makeLogger();
    startHeartbeat(logger, () => {
      throw new Error('stats boom');
    });
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('installCrashGuard', () => {
  it('registers handlers for both fatal events and uninstall removes them', () => {
    const logger = makeLogger();
    const beforeUncaught = process.listenerCount('uncaughtException');
    const beforeUnhandled = process.listenerCount('unhandledRejection');

    const guard = installCrashGuard(logger, () => {});
    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(beforeUnhandled + 1);

    guard.uninstall();
    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught);
    expect(process.listenerCount('unhandledRejection')).toBe(beforeUnhandled);
  });

  it('on fatal error: logs fatal, runs cleanup, schedules exit (not immediate)', () => {
    const logger = makeLogger();
    const cleanup = vi.fn();
    const before = process.listeners('uncaughtException');
    const guard = installCrashGuard(logger, cleanup);
    const handler = process
      .listeners('uncaughtException')
      .find((l) => !before.includes(l))!;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    try {
      (handler as (err: unknown) => void)(new Error('boom'));
      expect(logger.fatal).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
      // exit is deferred to let pino's worker transport flush the fatal line
      expect(exitSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      guard.uninstall();
      vi.clearAllTimers();
    }
  });

  it('cleanup failure must not block the exit path', () => {
    const logger = makeLogger();
    const before = process.listeners('uncaughtException');
    const guard = installCrashGuard(logger, () => {
      throw new Error('cleanup boom');
    });
    const handler = process
      .listeners('uncaughtException')
      .find((l) => !before.includes(l))!;

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    try {
      expect(() => (handler as (err: unknown) => void)(new Error('boom'))).not.toThrow();
      vi.advanceTimersByTime(1000);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      guard.uninstall();
      vi.clearAllTimers();
    }
  });
});
