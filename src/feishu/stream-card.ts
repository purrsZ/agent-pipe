import { buildStreamingCard } from './card.js';
import type { Sender } from './sender.js';

const MIN_INTERVAL_MS = 900;

// 时钟心跳：渲染本是纯事件驱动(onText/onToolUse 才刷新)，agent 跑长 Bash /
// 长思考期间没有任何事件 → 卡片冻住，下个事件到来才"跳秒"。心跳让静默期
// elapsed 也持续走表。5s 一拍 = 每任务每分钟最多 12 次 PATCH，远低于飞书限频。
const CLOCK_TICK_MS = 5_000;

// VERIFY V3（#1）：流长时间无「真实事件」（onText/onToolUse）→ 卡上如实标注「已 N 分钟无新输出…超时将自动
// 重试」，让用户分清「还在跑 / 流断了」，不再对着定格的卡误判卡死。stale 判定必须由**真实最后事件时刻**驱动，
// 绝不做独立于真实进度的心跳（ai-sentinel「假活」教训）。阈值要大于长工具的静默窗口（跑测试/装依赖分钟级）。
const STALE_AFTER_MS = 90_000; // 超过 90s 无新输出 → 进入 stale 标注
const STALE_REPATCH_MS = 300_000; // 同一 stale 期至多每 5 分钟刷一次（防飞书 API 刷屏）

// 冻卡修复：单帧 PATCH 超时（对齐 ai-sentinel update_timeout_seconds=3s）。超时 = 放弃该帧
// ——释放单飞行队列让后续帧继续；被放弃的真实请求（僵尸帧）由 client.ts 的 SDK 全局 30s
// 超时兜底 settle，stop() 靠这一点做交接。两处改动是配套的，不可拆开。
const PATCH_TIMEOUT_MS = 3_000;
// 连续失败熔断：≥3 次（含超时）→ 暂停 30s。暂停期 tick/onText 帧跳过（网络断着白费）；
// onToolUse 帧无视暂停（低频、信息量大、兼当恢复探针——一旦成功立即清零解除暂停）。
const FAIL_PAUSE_AFTER = 3;
const FAIL_PAUSE_MS = 30_000;

function hhmmss(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderStaleNote(silentMs: number, lastEventAt: number): string {
  const mins = Math.max(1, Math.round(silentMs / 60_000));
  return `⏳ 已 ${mins} 分钟无新输出（最后活动 ${hhmmss(lastEventAt)}）——等待模型响应中，超时将自动重试`;
}

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
  // VERIFY V3（#1）：真实最后事件时刻（onText/onToolUse 驱动，**不**含时钟心跳）+ 当前 stale 标注 + 上次标注
  // 时刻（5 分钟刷屏节流）。
  private lastEventAt = Date.now();
  private staleNote: string | null = null;
  private staleNotedAt = 0;
  // 冻卡修复：连续失败计数 + 熔断到期时刻。
  private consecutiveFailures = 0;
  private pausedUntil = 0;
  // 超时放弃后仍在网络上飞着的真实请求（僵尸帧）。stop() 必须等它们全部 settle 再返回，
  // 让调用方随后发的终态卡是最后一帧——否则迟到的进行中帧会覆盖完成卡且再无人纠正。
  private readonly outstanding = new Set<Promise<unknown>>();

  constructor(
    private sender: Pick<Sender, 'updateCard'>,
    private messageId: string,
    private taskName: string,
    private agentKind: string,
    // 可选：不传则静默（兼容既有测试/构造点渐进接线）。
    private logger?: { warn?: (obj: object, msg: string) => void },
  ) {
    // 时钟心跳兼任 stale 巡检：每拍先按真实事件时刻判 stale，再走原有 elapsed 刷新（组件生命周期内，stop 清理）。
    this.ticker = setInterval(() => this.tick(), CLOCK_TICK_MS);
    this.ticker.unref?.();
  }

  onToolUse(name: string): void {
    this.toolCount++;
    this.currentTool = name;
    this.markEvent();
    this.scheduleImmediate();
  }

  onText(fullText: string): void {
    this.text = fullText;
    this.markEvent();
    this.schedule();
  }

  // 真实事件到来：记时刻并清 stale 标注（恢复）——下一帧 flush 渲染不带 stale 文案，覆盖掉停更提示。
  private markEvent(): void {
    this.lastEventAt = Date.now();
    if (this.staleNote) {
      this.staleNote = null;
      this.staleNotedAt = 0;
    }
  }

  // 时钟心跳每拍：先按真实最后事件时刻判 stale（超阈值且距上次标注过了刷屏间隔 → 更新 stale 文案），再刷新。
  private tick(): void {
    if (this.stopped) return;
    const silent = Date.now() - this.lastEventAt;
    if (silent >= STALE_AFTER_MS && Date.now() - this.staleNotedAt >= STALE_REPATCH_MS) {
      this.staleNote = renderStaleNote(silent, this.lastEventAt);
      this.staleNotedAt = Date.now();
    }
    if (Date.now() < this.pausedUntil) return; // 熔断期：心跳帧静默跳过（不置 dirty，防空转）
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
    // 僵尸帧交接：等全部 settle（SDK 全局超时保证有限时间，最坏 ~30s），保证终态卡最后落地。
    if (this.outstanding.size > 0) await Promise.allSettled([...this.outstanding]);
  }

  private schedule(): void {
    if (this.stopped) return;
    if (Date.now() < this.pausedUntil) {
      // 熔断期普通帧不发：置 dirty 即可，暂停到期后的第一个 tick/事件会重新驱动。
      this.dirty = true;
      return;
    }
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

  // onToolUse 专用：绕过节流地板 + 无视熔断。工具帧低频且信息量大（N tools 实时性
  // 就是靠它），失败也只计一次失败。
  private scheduleImmediate(): void {
    if (this.stopped) return;
    if (this.trailing) {
      clearTimeout(this.trailing);
      this.trailing = null;
    }
    if (this.active) {
      this.dirty = true;
      return;
    }
    this.active = this.flush(true);
  }

  private async flush(force = false): Promise<void> {
    try {
      if (this.stopped) return;
      if (!force && Date.now() < this.pausedUntil) {
        this.dirty = true;
        return;
      }
      this.dirty = false;
      const card = buildStreamingCard(this.taskName, this.agentKind, {
        elapsedMs: Date.now() - this.startedAt,
        toolCount: this.toolCount,
        currentTool: this.currentTool,
        text: this.text,
        staleNote: this.staleNote ?? undefined,
      });
      const sig = JSON.stringify(card);
      if (sig === this.lastSig) return;
      this.lastSentAt = Date.now();

      // 超时 ≠ 取消：race 输了只是放弃等待，真实请求继续飞（僵尸帧），入 outstanding 供 stop() 交接。
      const real = this.sender.updateCard(this.messageId, card);
      this.outstanding.add(real);
      real.finally(() => this.outstanding.delete(real)).catch(() => {});

      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        real.then((ok) => (ok ? 'ok' : 'error')).catch(() => 'error' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), PATCH_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);

      if (outcome === 'ok') {
        this.lastSig = sig;
        this.consecutiveFailures = 0;
        this.pausedUntil = 0;
      } else {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= FAIL_PAUSE_AFTER) {
          this.pausedUntil = Date.now() + FAIL_PAUSE_MS;
        }
        this.logger?.warn?.(
          { messageId: this.messageId, outcome, consecutiveFailures: this.consecutiveFailures },
          'stream card patch failed',
        );
      }
    } finally {
      this.active = null;
      if (this.dirty && !this.stopped) this.schedule();
    }
  }
}
