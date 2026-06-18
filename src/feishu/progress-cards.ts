import { buildCancelledCard, buildErrorCard, buildReportCard, buildStreamingCard } from './card.js';
import type { Sender } from './sender.js';
import { StreamingCard } from './stream-card.js';

// 项目只接 Claude runner（M1a），流式卡按 Claude 渲染。
const AGENT_KIND = 'claude';

// 流式卡的出站定位（threadId/anchorMsgId/chatId）由 onRunStart 直接携带（run-handler 从
// 上游 source 提取，runProbe 在创建工作项前已写入），故本组件不反查任何 store，
// 也就不存在「claim 登记晚于发卡」的时序竞态。
interface CardLocator {
  chatId?: string;
  threadId?: string;
  anchorMsgId?: string;
}

interface ProgressLogger {
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

export interface ProgressCardsDeps {
  sender: Pick<Sender, 'replyCard' | 'sendCard' | 'updateCard' | 'replyCardInThread'>;
  logger?: ProgressLogger;
}

/**
 * Per-run live state. `ready` is the in-flight post of the streaming card; `streaming` and
 * `cardId` are null until that post lands. onRunEnd awaits `ready` before finalizing, which is
 * what makes a run that ends faster than its card posts still patch its terminal card (instead
 * of dropping the terminal patch and leaving a "处理中" orphan).
 */
interface RunEntry {
  ready: Promise<void>;
  cardId: string | null;
  streaming: StreamingCard | null;
  title: string;
}

/**
 * M2 进度可见性：feishu 层组件，实现 run-handler 暴露的中性 RunProgressSink（鸭子类型，不
 * import worktypes 层以守住 kernel 依赖边界）。内聚管理每轮 run 的一张实时流式卡：
 *   onRunStart → 在 thread 下贴一张流式卡（缺 threadRoot 时回落 source chat）
 *   onText/onToolUse → 节流刷新该卡（计时 / 工具次数 / 当前动作 / 流式正文）
 *   onRunEnd → stop() 等净 in-flight PATCH，再原地 updateCard 成报告/失败/中断卡
 * 与桥 runOneTurn 的 processing→streaming→result 完全同构。所有飞书 IO 都 fire-and-forget +
 * try/catch：任何失败只 log，绝不影响 run 本体。
 */
export class ProgressCards {
  private readonly runs = new Map<string, RunEntry>();

  constructor(private readonly deps: ProgressCardsDeps) {}

  onRunStart(info: {
    workitemId: string;
    assignmentId: string;
    title: string;
    chatId?: string;
    threadId?: string;
    anchorMsgId?: string;
  }): void {
    const title = info.title.trim() || info.assignmentId;
    const loc: CardLocator = {
      chatId: info.chatId,
      threadId: info.threadId,
      anchorMsgId: info.anchorMsgId,
    };
    // ★同步占位：先于任何 onText/onRunEnd 落 Map，消灭「run 结束早于发卡」竞态。
    const entry: RunEntry = { ready: Promise.resolve(), cardId: null, streaming: null, title };
    this.runs.set(info.assignmentId, entry);
    // 异步发卡，句柄存进 entry.ready 供 onRunEnd 等待。
    entry.ready = this.postStreamingCard(entry, info.workitemId, loc);
  }

  private async postStreamingCard(
    entry: RunEntry,
    workitemId: string,
    loc: CardLocator,
  ): Promise<void> {
    try {
      const initial = buildStreamingCard(entry.title, AGENT_KIND, {
        elapsedMs: 0,
        toolCount: 0,
        currentTool: null,
        text: '',
      });
      const cardId = await this.postInitial(loc, initial);
      if (cardId) {
        entry.cardId = cardId;
        entry.streaming = new StreamingCard(this.deps.sender, cardId, entry.title, AGENT_KIND);
      } else {
        this.deps.logger?.warn?.(
          { workitemId },
          'progress card: no thread/chat to post streaming card',
        );
      }
    } catch (err) {
      this.deps.logger?.error?.({ err }, 'progress card: post streaming card failed');
    }
  }

  /**
   * 发流式卡，定位全部来自 onRunStart 携带的 locator（无 store 反查）：
   *   threadId + anchorMsgId → 群聊话题：reply 锚点卡 + reply_in_thread，流式卡进同一话题；
   *   仅 anchorMsgId        → p2p：reply 锚点卡（主流）；
   *   仅 chatId             → 极端兜底：直发会话。
   */
  private async postInitial(loc: CardLocator, initial: object): Promise<string | null> {
    if (loc.threadId && loc.anchorMsgId) {
      const res = await this.deps.sender.replyCardInThread(loc.anchorMsgId, initial);
      return res?.messageId ?? null;
    }
    if (loc.anchorMsgId) return this.deps.sender.replyCard(loc.anchorMsgId, initial);
    if (loc.chatId) return this.deps.sender.sendCard(loc.chatId, initial);
    return null;
  }

  onText(info: { assignmentId: string; fullText: string }): void {
    // streaming=null（发卡未就绪/失败）时安全 no-op；onText 是全量快照，后续帧自愈无损。
    this.runs.get(info.assignmentId)?.streaming?.onText(info.fullText);
  }

  onToolUse(info: { assignmentId: string; toolName: string }): void {
    this.runs.get(info.assignmentId)?.streaming?.onToolUse(info.toolName);
  }

  // 返回 Promise（仍结构兼容 RunProgressSink 的 void）：run-handler fire-and-forget（不 await，
  // 与 postReport/postStatus 一致），但单测可 await 以确定性断言收尾顺序。finalize 全包 try/finally
  // 不会 reject，故忽略返回值绝不产生未处理 rejection。
  async onRunEnd(info: {
    assignmentId: string;
    outcome: 'success' | 'failed' | 'aborted';
    report?: string;
    error?: string;
  }): Promise<void> {
    const entry = this.runs.get(info.assignmentId);
    if (!entry) return; // 未知 run（已收尾或从未 onRunStart）→ 安全 no-op。
    try {
      await entry.ready; // ★P0：等发卡落地，run 结束早于发卡时也绝不丢终态卡。
      if (entry.streaming) await entry.streaming.stop(); // 等净 in-flight PATCH，终态卡落最后。
      if (entry.cardId) {
        const card =
          info.outcome === 'success'
            ? buildReportCard(entry.title, info.report ?? '')
            : info.outcome === 'failed'
              ? buildErrorCard(entry.title, info.error ?? '')
              : buildCancelledCard(entry.title);
        await this.deps.sender.updateCard(entry.cardId, card);
      }
      // cardId=null（发卡失败）：该轮无流式卡，仅靠锚点；此处无可更新，静默跳过。
    } catch (err) {
      this.deps.logger?.error?.({ err }, 'progress card: finalize failed');
    } finally {
      this.runs.delete(info.assignmentId); // ★放 finally：stop()/updateCard 异常也不泄漏 entry。
    }
  }
}
