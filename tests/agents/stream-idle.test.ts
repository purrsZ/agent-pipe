import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StreamIdleWatchdog,
  streamIdleTimeoutError,
  streamIdleTimeoutMs,
} from '../../src/agents/claude/runner.js';

// VERIFY V3（#1 流空闲超时）：worker 卡在等模型 API 的流式 SSE（连接活着但流中途不来数据）→ 无新 stream
// 事件 → 卡片定格、用户误判卡死。runner 加流空闲看门狗：每条 stream 事件 kick，连续静默超阈值 → kill 子进程 +
// run 以 error 失败 → managed 路径 WS-8 首败自动重试。这里直测可测小件（假时钟）。

describe('streamIdleTimeoutMs（env 解析）', () => {
  it('默认 300000；env 可调；0 禁用；负/坏值回落默认', () => {
    expect(streamIdleTimeoutMs({})).toBe(300_000);
    expect(streamIdleTimeoutMs({ AGENT_STREAM_IDLE_TIMEOUT_MS: '120000' })).toBe(120_000);
    expect(streamIdleTimeoutMs({ AGENT_STREAM_IDLE_TIMEOUT_MS: '0' })).toBe(0); // 显式禁用
    expect(streamIdleTimeoutMs({ AGENT_STREAM_IDLE_TIMEOUT_MS: '-5' })).toBe(300_000);
    expect(streamIdleTimeoutMs({ AGENT_STREAM_IDLE_TIMEOUT_MS: 'abc' })).toBe(300_000);
  });
});

describe('streamIdleTimeoutError（错误串）', () => {
  it('含 stream idle timeout + 秒数 + 最后事件时刻；绝不含 write-guard fail-closed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 13, 5, 9));
    const msg = streamIdleTimeoutError(300_000, Date.now());
    vi.useRealTimers();
    expect(msg).toContain('stream idle timeout');
    expect(msg).toContain('300s');
    expect(msg).toContain('13:05:09');
    // 关键：不含 write-guard fail-closed，否则 onRunFailed 会弹病历而非 WS-8 首败重试。
    expect(msg).not.toContain('write-guard fail-closed');
  });
});

describe('StreamIdleWatchdog（流空闲看门狗）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('静默超阈值 → onTimeout 恰触发一次', () => {
    let fired = 0;
    const wd = new StreamIdleWatchdog(1000, () => {
      fired++;
    });
    wd.kick();
    vi.advanceTimersByTime(999);
    expect(fired).toBe(0); // 还没到阈值
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1); // 到点触发
    vi.advanceTimersByTime(5000);
    expect(fired).toBe(1); // 触发后计时器已清，不重复
  });

  it('持续 kick（事件持续）→ 永不超时', () => {
    let fired = 0;
    const wd = new StreamIdleWatchdog(1000, () => {
      fired++;
    });
    wd.kick();
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(500); // 每 500ms 一个事件，静默永不到 1000ms
      wd.kick();
    }
    expect(fired).toBe(0);
    wd.stop();
  });

  it('timeoutMs=0 → 禁用，永不装表也永不触发', () => {
    let fired = 0;
    const wd = new StreamIdleWatchdog(0, () => {
      fired++;
    });
    wd.kick();
    expect(wd.active).toBe(false); // 禁用不装表
    vi.advanceTimersByTime(10_000_000);
    expect(fired).toBe(0);
  });

  it('stop() 撤表 → 不再触发', () => {
    let fired = 0;
    const wd = new StreamIdleWatchdog(1000, () => {
      fired++;
    });
    wd.kick();
    expect(wd.active).toBe(true);
    wd.stop();
    expect(wd.active).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(fired).toBe(0);
  });
});
