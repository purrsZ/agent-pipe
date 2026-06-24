import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../logger.js';
import type {
  Attachment,
  CardAction,
  CardActionHandler,
  IncomingMessage,
  MessageHandler,
} from './types.js';

const DEDUP_TTL_MS = 600_000;

/**
 * Pull the neutral fields out of a raw card-action event. The button `value` is passed
 * through untouched (opaque) — the kernel never reads inside it (R06.AC-2 red-line).
 */
export function parseCardAction(data: unknown): CardAction | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const action = (d.action ?? {}) as Record<string, unknown>;
  const operator = (d.operator ?? {}) as Record<string, unknown>;
  // WS card.action.trigger nests the message/chat ids under `context`; older/HTTP shapes put
  // them at the top level. Read context first, then fall back to the flat names — otherwise
  // messageId comes back empty and a downstream reply hits `/messages//reply` → 404.
  const context = (d.context ?? {}) as Record<string, unknown>;
  const operatorId =
    typeof operator.open_id === 'string'
      ? operator.open_id
      : typeof operator.operator_id === 'string'
        ? operator.operator_id
        : '';
  const pick = (...vals: unknown[]): string | undefined =>
    vals.find((v): v is string => typeof v === 'string' && v !== '');
  // Form submits carry per-component values under action.form_value (some shapes top-level).
  // Optional — button-callback cards (checkpoint) have none, so this is undefined for them and
  // their handler path is unchanged.
  const rawForm = (action.form_value ?? d.form_value) as unknown;
  const formValue =
    rawForm && typeof rawForm === 'object' ? (rawForm as Record<string, unknown>) : undefined;
  return {
    value: action.value,
    operatorId,
    token: typeof d.token === 'string' ? d.token : undefined,
    messageId: pick(context.open_message_id, d.open_message_id, d.message_id),
    formValue,
  };
}

/**
 * 把飞书富文本（post）消息正文拍平成纯文本。受信 post 一般是 {title, content:[[{tag,text/href}]]}；
 * 防御性兼容语言键包裹 {zh_cn:{...}} 形态。text 段取文字、链接(a)取「文字（URL）」，@/图片等忽略。
 * 永不抛：坏结构当空内容。让群里粘带格式/文档链接的收料消息也能进（否则 post 类型被入站直接丢弃）。
 */
export function extractPostText(raw: any): string {
  const post =
    raw && typeof raw === 'object'
      ? Array.isArray(raw.content) || typeof raw.title === 'string'
        ? raw
        : (raw.zh_cn ?? raw.en_us ?? {})
      : {};
  const title = typeof post.title === 'string' ? post.title.trim() : '';
  const body = Array.isArray(post.content) ? post.content : [];
  const lines: string[] = [];
  for (const para of body) {
    if (!Array.isArray(para)) continue;
    const parts: string[] = [];
    for (const el of para) {
      if (!el || typeof el !== 'object') continue;
      if (el.tag === 'text' && typeof el.text === 'string') parts.push(el.text);
      else if (el.tag === 'a') {
        const t = typeof el.text === 'string' ? el.text : '';
        const href = typeof el.href === 'string' ? el.href : '';
        parts.push(t && href ? `${t}（${href}）` : t || href);
      }
    }
    if (parts.length > 0) lines.push(parts.join(''));
  }
  return [title, ...lines].filter((s) => s.length > 0).join('\n');
}

export function createDispatcher(
  botOpenId: string,
  logger: Logger,
  botStartTime: number,
  onMessage: MessageHandler,
  onCardAction?: CardActionHandler,
): lark.EventDispatcher {
  const seen = new Set<string>();

  return new lark.EventDispatcher({}).register({
    // R06/D-12: card button callbacks ride the same ws connection. Ack with a fast toast
    // (≤3s requirement) and run the real action async — the upper adapter decodes value.
    'card.action.trigger': async (data: any) => {
      try {
        const action = parseCardAction(data);
        if (action && onCardAction) {
          // 卡回调有 3s 超时。点「立项完成/灯卡拍板」会同步触发落立项书 + 建 worktree 等 git 操作，
          // 可能 >3s 阻塞事件循环 → 飞书「目标回调服务超时未响应」。把实际处理推到下一轮 event loop，
          // 让本函数立刻返回 toast（动作照常执行，只是不再卡回调响应）。
          setImmediate(() => {
            Promise.resolve(onCardAction(action)).catch((err) => {
              logger.error({ err }, 'card action handler error');
            });
          });
        }
      } catch (err) {
        logger.error({ err }, 'card action dispatch error');
      }
      return { toast: { type: 'info', content: '已收到，处理中…' } };
    },
    'im.message.receive_v1': async (data: any) => {
      try {
        const message = data?.message;
        const sender = data?.sender;
        if (!message || !sender) return;

        const createTime = Number.parseInt(message.create_time, 10);
        if (createTime && createTime < botStartTime) return;

        const msgId = String(message.message_id);
        if (seen.has(msgId)) return;
        seen.add(msgId);
        setTimeout(() => seen.delete(msgId), DEDUP_TTL_MS);

        const chatType = message.chat_type as 'p2p' | 'group';
        if (chatType !== 'p2p' && chatType !== 'group') return;
        const msgType = message.message_type as string;
        if (
          msgType !== 'text' &&
          msgType !== 'post' &&
          msgType !== 'file' &&
          msgType !== 'image'
        )
          return;

        const rawMentions = (message.mentions ?? []) as Array<{
          id?: { open_id?: string };
          name?: string;
        }>;
        let isMentioned = chatType === 'p2p';
        if (chatType === 'group' && botOpenId) {
          isMentioned = rawMentions.some((m) => m.id?.open_id === botOpenId);
        }
        const mentions = rawMentions
          .filter((m) => m.id?.open_id && m.id.open_id !== botOpenId)
          .map((m) => ({ openId: m.id!.open_id!, name: m.name ?? '' }));

        const content = JSON.parse(message.content);
        let text = '';
        const attachments: Attachment[] = [];

        if (msgType === 'text') {
          text = (content.text ?? '').replace(/@_user_\w+/g, '').trim();
          if (!text) return;
        } else if (msgType === 'post') {
          // 富文本（post）：拍平正文为纯文本（含链接 URL），让群里粘带格式/文档链接的收料也能进。
          text = extractPostText(content).replace(/@_user_\w+/g, '').trim();
          if (!text) return;
        } else if (msgType === 'file') {
          const fk = content.file_key;
          if (!fk) return;
          attachments.push({
            kind: 'file',
            fileKey: fk,
            name: content.file_name ?? `file-${message.message_id}`,
          });
        } else if (msgType === 'image') {
          const ik = content.image_key;
          if (!ik) return;
          attachments.push({
            kind: 'image',
            fileKey: ik,
            name: `image-${message.message_id}.png`,
          });
        }

        const incoming: IncomingMessage = {
          messageId: message.message_id,
          chatId: message.chat_id,
          chatType,
          userId: sender.sender_id?.open_id ?? '',
          text,
          parentId: message.parent_id || undefined,
          rootId: message.root_id || undefined,
          threadId: message.thread_id || undefined,
          isMentioned,
          mentions,
          attachments,
          createTime,
        };

        Promise.resolve(onMessage(incoming)).catch((err) => {
          logger.error({ err }, 'message handler error');
        });
      } catch (err) {
        logger.error({ err }, 'event dispatch error');
      }
    },
  } as any);
}
