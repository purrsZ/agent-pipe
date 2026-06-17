import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logger.js';
import { createWsHealthLogger, startWsReconnectGuard } from '../src/feishu/ws-health.js';

function fakeBase() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };
}

describe('ws health logger', () => {
  it('starts unhealthy and flips healthy on ready', () => {
    const base = fakeBase();
    const { sdkLogger, health } = createWsHealthLogger(base as unknown as Logger);
    expect(health.healthy).toBe(false);
    sdkLogger.info('[ws]', 'ws client ready');
    expect(health.healthy).toBe(true);
  });

  it('flips unhealthy on reconnect / connect failed / unable to connect', () => {
    const base = fakeBase();
    const { sdkLogger, health } = createWsHealthLogger(base as unknown as Logger);
    sdkLogger.info('[ws]', 'ws client ready');
    sdkLogger.info('[ws]', 'reconnect');
    expect(health.healthy).toBe(false);
    sdkLogger.info('[ws]', 'ws client ready');
    sdkLogger.info('ws', 'unable to connect to the server after trying 1 times")');
    expect(health.healthy).toBe(false);
  });

  it("treats 'reconnect success' as healthy, not caught by the reconnect rule", () => {
    const base = fakeBase();
    const { sdkLogger, health } = createWsHealthLogger(base as unknown as Logger);
    sdkLogger.info('[ws]', 'reconnect');
    expect(health.healthy).toBe(false);
    sdkLogger.debug('[ws]', 'reconnect success');
    expect(health.healthy).toBe(true);
  });

  it('forwards every log to the base logger', () => {
    const base = fakeBase();
    const { sdkLogger } = createWsHealthLogger(base as unknown as Logger);
    sdkLogger.info('[ws]', 'reconnect');
    expect(base.info).toHaveBeenCalledTimes(1);
  });

  it('updates `since` only on transitions, not on repeats', () => {
    const base = fakeBase();
    const { sdkLogger, health } = createWsHealthLogger(base as unknown as Logger);
    sdkLogger.info('[ws]', 'ws client ready');
    const t1 = health.since;
    sdkLogger.info('[ws]', 'ws client ready'); // already healthy → no transition
    expect(health.since).toBe(t1);
  });
});

describe('ws reconnect guard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reconnects once the ws stays unhealthy past the grace window', async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const base = fakeBase();
    const health = { healthy: false, since: Date.now() };
    const stop = startWsReconnectGuard({
      reconnect,
      health,
      logger: base as unknown as Logger,
      checkIntervalMs: 1000,
      graceMs: 2000,
      cooldownMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(1000); // within grace
    expect(reconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000); // past grace
    expect(reconnect).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not reconnect while healthy', async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const base = fakeBase();
    const health = { healthy: true, since: Date.now() };
    const stop = startWsReconnectGuard({
      reconnect,
      health,
      logger: base as unknown as Logger,
      checkIntervalMs: 1000,
      graceMs: 1000,
      cooldownMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconnect).not.toHaveBeenCalled();
    stop();
  });

  it('respects cooldown between forced reconnects', async () => {
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const base = fakeBase();
    const health = { healthy: false, since: Date.now() };
    const stop = startWsReconnectGuard({
      reconnect,
      health,
      logger: base as unknown as Logger,
      checkIntervalMs: 1000,
      graceMs: 0,
      cooldownMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(1000); // first forced reconnect
    expect(reconnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000); // still within cooldown
    expect(reconnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000); // past cooldown → second
    expect(reconnect).toHaveBeenCalledTimes(2);
    stop();
  });
});
