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
  const operatorId =
    typeof operator.open_id === 'string'
      ? operator.open_id
      : typeof operator.operator_id === 'string'
        ? operator.operator_id
        : '';
  return {
    value: action.value,
    operatorId,
    token: typeof d.token === 'string' ? d.token : undefined,
    messageId:
      typeof d.open_message_id === 'string'
        ? d.open_message_id
        : typeof d.message_id === 'string'
          ? d.message_id
          : undefined,
  };
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
          Promise.resolve(onCardAction(action)).catch((err) => {
            logger.error({ err }, 'card action handler error');
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
        if (msgType !== 'text' && msgType !== 'file' && msgType !== 'image') return;

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
