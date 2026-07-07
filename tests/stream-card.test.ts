import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sender } from '../src/feishu/sender.js';
import { StreamingCard } from '../src/feishu/stream-card.js';

// MIN_INTERVAL_MS in stream-card.ts
const INTERVAL = 900;

function makeSender(result: boolean | Error = true) {
  const calls: object[] = [];
  const updateCard = vi.fn(async (_id: string, card: object) => {
    calls.push(card);
    if (result instanceof Error) throw result;
    return result;
  });
  return { sender: { updateCard } as unknown as Sender, updateCard, calls };
}

function previewOf(card: object): string {
  return JSON.stringify(card);
}

beforeEach(() => {
  vi.useFakeTimers();
  // start well past epoch so the leading-edge fire (lastSentAt=0) is allowed
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StreamingCard throttle', () => {
  it('first update fires immediately (leading edge)', async () => {
    const { sender, updateCard } = makeSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    card.onText('hello');
    await vi.advanceTimersByTimeAsync(0);
    expect(updateCard).toHaveBeenCalledTimes(1);
    await card.stop();
  });

  it('a burst collapses into one trailing flush carrying the LATEST state', async () => {
    const { sender, updateCard, calls } = makeSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    card.onText('v1');
    await vi.advanceTimersByTimeAsync(0); // leading flush with v1
    expect(updateCard).toHaveBeenCalledTimes(1);

    card.onText('v2');
    card.onText('v3');
    card.onText('v4'); // three updates inside the throttle window
    await vi.advanceTimersByTimeAsync(0);
    expect(updateCard).toHaveBeenCalledTimes(1); // still throttled

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(updateCard).toHaveBeenCalledTimes(2); // single trailing flush
    expect(previewOf(calls[1]!)).toContain('v4');
    expect(previewOf(calls[1]!)).not.toContain('v3');
    await card.stop();
  });

  it('tool activity is rendered and counted through the same throttle', async () => {
    const { sender, updateCard, calls } = makeSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    card.onToolUse('Bash');
    await vi.advanceTimersByTimeAsync(0);
    expect(updateCard).toHaveBeenCalledTimes(1);
    expect(previewOf(calls[0]!)).toContain('Bash');
    await card.stop();
  });

  it('stop() blocks further flushes — final result card cannot be clobbered', async () => {
    const { sender, updateCard } = makeSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    card.onText('v1');
    await vi.advanceTimersByTimeAsync(0);
    card.onText('v2'); // queued behind the throttle
    await card.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(updateCard).toHaveBeenCalledTimes(1); // trailing flush was cancelled
    card.onText('v3'); // late events after stop are ignored
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(updateCard).toHaveBeenCalledTimes(1);
  });

  it('silent period: clock ticker keeps the card fresh without any agent events', async () => {
    const { sender, updateCard, calls } = makeSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    card.onText('working on something long');
    await vi.advanceTimersByTimeAsync(0); // leading flush at 0:00
    expect(updateCard).toHaveBeenCalledTimes(1);

    // agent goes silent (long Bash / long thinking) — elapsed must keep moving
    await vi.advanceTimersByTimeAsync(5_000);
    expect(updateCard).toHaveBeenCalledTimes(2);
    expect(previewOf(calls[1]!)).toContain('0:05');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(updateCard.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(previewOf(calls[calls.length - 1]!)).toContain('0:15');
    await card.stop();
  });

  it('stop() also kills the clock ticker', async () => {
    const { sender, updateCard } = makeSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    card.onText('v1');
    await vi.advanceTimersByTimeAsync(0);
    await card.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(updateCard).toHaveBeenCalledTimes(1); // no zombie ticks after stop
  });

  it('updateCard rejection is swallowed — a flaky PATCH must not crash the turn', async () => {
    const { sender, updateCard } = makeSender(new Error('feishu 5xx'));
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    card.onText('v1');
    await vi.advanceTimersByTimeAsync(0);
    expect(updateCard).toHaveBeenCalledTimes(1);
    // and the throttle keeps working afterwards
    card.onText('v2');
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(updateCard).toHaveBeenCalledTimes(2);
    await card.stop();
  });
});

// VERIFY V3（#1）：流长时间无「真实事件」（onText/onToolUse）→ 卡片如实标注「已 N 分钟无新输出…超时将自动
// 重试」，让用户分清「还在跑 / 流断了」，不再对着定格卡误判卡死。stale 由真实最后事件时刻驱动（非心跳）。
describe('StreamingCard 停更标注（VERIFY V3 #1）', () => {
  const lastCard = (calls: object[]): string => previewOf(calls[calls.length - 1]!);

  it('90s 内有输出 → 不标注；连续静默越过 90s → 出「无新输出」如实标注', async () => {
    const { sender, calls } = makeSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    card.onText('跑长任务中');
    await vi.advanceTimersByTimeAsync(0); // leading flush
    // 60s 静默：还没到 90s 阈值 → 不该有停更标注（心跳仍在刷 elapsed）。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lastCard(calls)).not.toContain('无新输出');
    // 再 40s（累计 100s）→ 越过 90s → 出停更标注（含「超时将自动重试」，不假装处理中）。
    await vi.advanceTimersByTimeAsync(40_000);
    expect(lastCard(calls)).toContain('无新输出');
    expect(lastCard(calls)).toContain('超时将自动重试');
    await card.stop();
  });

  it('恢复事件到来 → 真实事件驱动清掉停更标注（下一帧不再带 stale 文案）', async () => {
    const { sender, calls } = makeSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    card.onText('起步');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100_000); // 进入 stale
    expect(lastCard(calls)).toContain('无新输出');
    // 模型又开始产出 → 真实事件 → lastEventAt 更新 + 清 stale。
    card.onText('恢复输出了');
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(lastCard(calls)).not.toContain('无新输出'); // 停更标注被覆盖
    expect(lastCard(calls)).toContain('恢复输出了');
    await card.stop();
  });

  it('时钟心跳本身不算「真实事件」→ 不会自我复位 stale（不做假活心跳）', async () => {
    const { sender, calls } = makeSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    card.onText('起步');
    await vi.advanceTimersByTimeAsync(0);
    // 纯靠心跳走 200s（无任何 onText/onToolUse）→ 必须一直是 stale（心跳刷 elapsed 但不清 stale）。
    await vi.advanceTimersByTimeAsync(200_000);
    expect(lastCard(calls)).toContain('无新输出');
    await card.stop();
  });
});
