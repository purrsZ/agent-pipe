import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingCard } from '../src/feishu/stream-card.js';
import type { Sender } from '../src/feishu/sender.js';

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
