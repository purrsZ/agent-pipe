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

interface Deferred {
  promise: Promise<boolean>;
  resolve: (v: boolean) => void;
  reject: (e: unknown) => void;
}

// 冻卡修复系列用：每次 updateCard 返回一个可手控 deferred（不 resolve = 挂起，用于逼超时；
// resolve(true) = 成功，用于验证熔断解除/僵尸帧交接）。
function makeDeferredSender() {
  const deferreds: Deferred[] = [];
  const updateCard = vi.fn((_id: string, _card: object) => {
    let resolve!: (v: boolean) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<boolean>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    deferreds.push({ promise, resolve, reject });
    return promise;
  });
  return { sender: { updateCard } as unknown as Sender, updateCard, deferreds };
}

// PATCH_TIMEOUT_MS / FAIL_PAUSE_AFTER / FAIL_PAUSE_MS in stream-card.ts（不导出，测试里写死镜像）。
const PATCH_TIMEOUT = 3_000;
const FAIL_PAUSE = 30_000;

// 连续挂起帧逼到熔断（≥3 次超时 → pausedUntil 置位）。每轮 onText 触发一帧，推进 PATCH_TIMEOUT
// 逼其超时；跑 4 轮稳妥越过 FAIL_PAUSE_AFTER=3。用于「熔断/探针/恢复」诸用例的前置。
async function driveToPaused(card: StreamingCard): Promise<void> {
  for (let i = 0; i < 4; i++) {
    card.onText(`fail-${i}`);
    await vi.advanceTimersByTimeAsync(PATCH_TIMEOUT);
  }
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

// 冻卡修复（单帧超时 + 熔断 + 僵尸帧交接 + onToolUse 立即帧）：对齐 ai-sentinel 被裁掉的防护。
describe('StreamingCard 防冻结（单帧超时 + 熔断）', () => {
  it('挂起的 PATCH 不再冻卡：超时放弃后队列继续吃新帧', async () => {
    const { sender, updateCard } = makeDeferredSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    card.onText('v1'); // 首帧发出（deferred 永不 resolve = 模拟挂起）
    await vi.advanceTimersByTimeAsync(0);
    expect(updateCard).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PATCH_TIMEOUT); // 3s 单帧超时 → 放弃该帧，释放队列
    card.onText('v2'); // 新内容
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updateCard).toHaveBeenCalledTimes(2); // 队列没被挂起帧堵死
    // 不 stop（挂起帧永不 settle，stop 会等僵尸帧——本用例只验队列不堵）。
  });

  it('连续超时计失败 → 熔断期心跳静默（推进一拍 tick 不再发帧）', async () => {
    const { sender, updateCard } = makeDeferredSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    await driveToPaused(card); // 连续超时逼入熔断
    const before = updateCard.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000); // 一个心跳 tick——熔断期应静默
    expect(updateCard.mock.calls.length).toBe(before);
  });

  it('onToolUse 无视熔断（探针帧照发）', async () => {
    const { sender, updateCard } = makeDeferredSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    await driveToPaused(card);
    const before = updateCard.mock.calls.length;
    card.onToolUse('Bash'); // 熔断期内工具帧——探针，无视暂停
    await vi.advanceTimersByTimeAsync(0);
    expect(updateCard.mock.calls.length).toBe(before + 1);
  });

  it('探针帧成功 → 解除熔断，之后普通帧恢复正常发送', async () => {
    const { sender, updateCard, deferreds } = makeDeferredSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    await driveToPaused(card);
    card.onToolUse('Probe'); // 探针帧
    await vi.advanceTimersByTimeAsync(0);
    deferreds[deferreds.length - 1]!.resolve(true); // 探针成功 → consecutiveFailures=0, pausedUntil=0
    await vi.advanceTimersByTimeAsync(0);
    const before = updateCard.mock.calls.length;
    card.onText('恢复输出'); // 熔断已解除，普通帧应正常发
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(updateCard.mock.calls.length).toBeGreaterThan(before);
  });

  it('熔断到期自动恢复（推进 30s+一拍 → 心跳帧再次发出）', async () => {
    const { sender, updateCard } = makeDeferredSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    await driveToPaused(card);
    const before = updateCard.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FAIL_PAUSE + 5_000); // 暂停到期后的第一拍重新驱动
    expect(updateCard.mock.calls.length).toBeGreaterThan(before);
  });

  it('stop() 等僵尸帧全部 settle 才返回（终态卡永远最后落地）', async () => {
    const { sender, deferreds } = makeDeferredSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    card.onText('v1');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PATCH_TIMEOUT); // 首帧超时被放弃，真实请求仍 pending（僵尸帧）
    let stopped = false;
    const stopP = card.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false); // stop 卡在等僵尸帧 settle
    deferreds[0]!.resolve(true); // 僵尸帧终于落地
    await vi.advanceTimersByTimeAsync(0);
    await stopP;
    expect(stopped).toBe(true);
  });

  it('onToolUse 是立即帧：不等 900ms 节流地板', async () => {
    const { sender, updateCard, deferreds } = makeDeferredSender();
    const card = new StreamingCard(sender, 'om_1', 'task', 'claude');
    card.onText('start');
    await vi.advanceTimersByTimeAsync(0);
    deferreds[0]!.resolve(true); // 首帧成功
    await vi.advanceTimersByTimeAsync(0);
    expect(updateCard).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100); // 距上帧仅 100ms（< 900ms 地板）
    card.onToolUse('Bash');
    await vi.advanceTimersByTimeAsync(0);
    expect(updateCard).toHaveBeenCalledTimes(2); // 立即发，未等地板
  });
});
