import { buildStreamingCard } from './card.js';
import type { Sender } from './sender.js';

const MIN_INTERVAL_MS = 900;

// 时钟心跳：渲染本是纯事件驱动(onText/onToolUse 才刷新)，agent 跑长 Bash /
// 长思考期间没有任何事件 → 卡片冻住，下个事件到来才"跳秒"。心跳让静默期
// elapsed 也持续走表。5s 一拍 = 每任务每分钟最多 12 次 PATCH，远低于飞书限频。
const CLOCK_TICK_MS = 5_000;

/**
 * Throttled in-progress card updater. Runners fire onToolUse / onText many times a
 * second; this collapses them into at most one `updateCard` per MIN_INTERVAL_MS.
 *
 * Design (mirrors ai-sentinel's StreamUpdateController, trimmed for this codebase):
 *   - leading + trailing throttle: fire immediately once the floor has passed, else
 *     schedule a single trailing flush for the remaining wait;
 *   - single in-flight PATCH: `active` holds the current flush promise so two
 *     updateCard calls never overlap (avoids out-of-order arrivals on Feishu);
 *   - signature dedup: skip the PATCH when the rendered card is byte-identical;
 *   - await stop(): wait out the in-flight PATCH so index.ts's final result card
 *     is guaranteed to land last instead of being clobbered by a late progress frame.
 */
export class StreamingCard {
  private toolCount = 0;
  private currentTool: string | null = null;
  private text = '';
  private readonly startedAt = Date.now();
  private lastSig = '';
  private lastSentAt = 0;
  private dirty = false;
  private active: Promise<void> | null = null;
  private trailing: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly ticker: ReturnType<typeof setInterval>;

  constructor(
    private sender: Sender,
    private messageId: string,
    private taskName: string,
    private agentKind: string,
  ) {
    this.ticker = setInterval(() => this.schedule(), CLOCK_TICK_MS);
    this.ticker.unref?.();
  }

  onToolUse(name: string): void {
    this.toolCount++;
    this.currentTool = name;
    this.schedule();
  }

  onText(fullText: string): void {
    this.text = fullText;
    this.schedule();
  }

  /** Stop emitting and wait out any in-flight PATCH; caller writes the final card next. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.ticker);
    if (this.trailing) {
      clearTimeout(this.trailing);
      this.trailing = null;
    }
    if (this.active) {
      try {
        await this.active;
      } catch {
        /* ignore */
      }
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.active) {
      this.dirty = true;
      return;
    }
    const wait = this.lastSentAt + MIN_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      this.active = this.flush();
      return;
    }
    this.dirty = true;
    if (!this.trailing) {
      this.trailing = setTimeout(() => {
        this.trailing = null;
        if (!this.active && !this.stopped) this.active = this.flush();
      }, wait);
      this.trailing.unref?.();
    }
  }

  private async flush(): Promise<void> {
    try {
      if (this.stopped) return;
      this.dirty = false;
      const card = buildStreamingCard(this.taskName, this.agentKind, {
        elapsedMs: Date.now() - this.startedAt,
        toolCount: this.toolCount,
        currentTool: this.currentTool,
        text: this.text,
      });
      const sig = JSON.stringify(card);
      if (sig === this.lastSig) return;
      this.lastSentAt = Date.now();
      try {
        const ok = await this.sender.updateCard(this.messageId, card);
        if (ok) this.lastSig = sig;
      } catch {
        /* ignore — the final result card overwrites this anyway */
      }
    } finally {
      this.active = null;
      if (this.dirty && !this.stopped) this.schedule();
    }
  }
}
