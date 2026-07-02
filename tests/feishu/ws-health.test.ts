import { describe, expect, it, vi } from 'vitest';
import { createWsHealthLogger } from '../../src/feishu/ws-health.js';
import type { Logger } from '../../src/logger.js';

const noopLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
} as unknown as Logger;

// WS-4：WS 从 unhealthy 恢复 healthy 时触发一次补拉。onRecovered 只在「真·恢复」（曾经 healthy 过、
// 断开后再次 healthy）触发，首次建连不触发（否则启动就误补拉一个不存在的离线区间）。

describe('createWsHealthLogger onRecovered (WS-4)', () => {
  it('does not fire onRecovered on the first healthy transition', () => {
    const onRecovered = vi.fn();
    const { sdkLogger, health } = createWsHealthLogger(noopLogger, { onRecovered });
    sdkLogger.info('ws client ready');
    expect(health.healthy).toBe(true);
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it('fires onRecovered once when healthy returns after a disconnect', () => {
    const onRecovered = vi.fn();
    const { sdkLogger, health } = createWsHealthLogger(noopLogger, { onRecovered });
    sdkLogger.info('ws client ready'); // 首次 healthy：不触发
    sdkLogger.warn('ws client closed'); // 断开
    expect(health.healthy).toBe(false);
    sdkLogger.info('reconnect success'); // 恢复：触发一次
    expect(health.healthy).toBe(true);
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it('does not re-fire on repeated healthy logs while already healthy', () => {
    const onRecovered = vi.fn();
    const { sdkLogger } = createWsHealthLogger(noopLogger, { onRecovered });
    sdkLogger.info('ws client ready');
    sdkLogger.warn('ws client closed');
    sdkLogger.info('reconnect success');
    sdkLogger.info('ws client ready'); // 已 healthy，守卫拦截，不重复
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });

  it('works without an onRecovered callback (back-compat)', () => {
    const { sdkLogger, health } = createWsHealthLogger(noopLogger);
    expect(() => sdkLogger.info('ws client ready')).not.toThrow();
    expect(health.healthy).toBe(true);
  });
});
