import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../logger.js';
import type { Attachment, IncomingMessage, MessageHandler } from './types.js';

const DEDUP_TTL_MS = 600_000;

export function createDispatcher(
  botOpenId: string,
  logger: Logger,
  botStartTime: number,
  onMessage: MessageHandler,
): lark.EventDispatcher {
  const seen = new Set<string>();

  return new lark.EventDispatcher({}).register({
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
