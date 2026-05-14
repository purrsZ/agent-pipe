import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../logger.js';

export class Sender {
  constructor(private client: lark.Client, private logger: Logger) {}

  async sendText(chatId: string, text: string): Promise<string | null> {
    try {
      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      return (resp as any)?.data?.message_id ?? null;
    } catch (err) {
      this.logger.error({ err }, 'sendText failed');
      return null;
    }
  }

  async sendCard(chatId: string, card: object): Promise<string | null> {
    try {
      const resp = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      return (resp as any)?.data?.message_id ?? null;
    } catch (err) {
      this.logger.error({ err }, 'sendCard failed');
      return null;
    }
  }

  async replyCard(messageId: string, card: object): Promise<string | null> {
    try {
      const resp = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
        } as any,
      });
      return (resp as any)?.data?.message_id ?? null;
    } catch (err) {
      this.logger.error({ err, messageId }, 'replyCard failed');
      return null;
    }
  }

  async updateCard(messageId: string, card: object): Promise<boolean> {
    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) } as any,
      });
      return true;
    } catch (err) {
      this.logger.error({ err, messageId }, 'updateCard failed');
      return false;
    }
  }

  async downloadAttachment(
    messageId: string,
    fileKey: string,
    type: 'file' | 'image',
    destPath: string,
  ): Promise<boolean> {
    try {
      const resp: any = await this.client.im.messageResource.get({
        params: { type },
        path: { message_id: messageId, file_key: fileKey },
      });
      await resp.writeFile(destPath);
      return true;
    } catch (err) {
      this.logger.error({ err, messageId, fileKey, type }, 'downloadAttachment failed');
      return false;
    }
  }

  async reply(messageId: string, text: string): Promise<string | null> {
    try {
      const resp = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
        } as any,
      });
      return (resp as any)?.data?.message_id ?? null;
    } catch (err) {
      this.logger.error({ err, messageId }, 'reply failed');
      return null;
    }
  }
}
