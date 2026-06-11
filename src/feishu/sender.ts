import type * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../logger.js';

const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
  '.ico',
]);

function classifyFileType(
  filePath: string,
): 'pdf' | 'doc' | 'xls' | 'ppt' | 'mp4' | 'opus' | 'stream' {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'pdf';
    case '.doc':
    case '.docx':
      return 'doc';
    case '.xls':
    case '.xlsx':
      return 'xls';
    case '.ppt':
    case '.pptx':
      return 'ppt';
    case '.mp4':
      return 'mp4';
    case '.opus':
      return 'opus';
    default:
      return 'stream';
  }
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTS.has(path.extname(filePath).toLowerCase());
}

export class Sender {
  constructor(
    private client: lark.Client,
    private logger: Logger,
  ) {}

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

  private async loadForUpload(
    filePath: string,
    maxBytes: number,
    label: string,
  ): Promise<{ ok: true; buf: Buffer } | { ok: false; error: string }> {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return { ok: false, error: `文件不存在: ${filePath}` };
    }
    if (!stat.isFile()) return { ok: false, error: `不是普通文件: ${filePath}` };
    if (stat.size === 0) return { ok: false, error: `空${label}不支持上传: ${filePath}` };
    if (stat.size > maxBytes) {
      const mb = Math.floor(maxBytes / (1024 * 1024));
      return {
        ok: false,
        error: `${label}超过 ${mb}MB 上限 (${stat.size} bytes): ${filePath}`,
      };
    }
    try {
      const buf = await fsp.readFile(filePath);
      return { ok: true, buf };
    } catch (err) {
      return { ok: false, error: `读取失败: ${(err as Error).message}` };
    }
  }

  async replyFileFromPath(
    messageId: string,
    filePath: string,
  ): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    const loaded = await this.loadForUpload(filePath, MAX_FILE_BYTES, '文件');
    if (!loaded.ok) return loaded;
    try {
      const upResp: any = await this.client.im.file.create({
        data: {
          file_type: classifyFileType(filePath),
          file_name: path.basename(filePath),
          file: loaded.buf,
        },
      });
      const fileKey = upResp?.data?.file_key ?? upResp?.file_key;
      if (!fileKey) return { ok: false, error: 'upload returned no file_key' };
      const reply: any = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        } as any,
      });
      const replyId = reply?.data?.message_id ?? null;
      return { ok: true, messageId: replyId ?? undefined };
    } catch (err) {
      this.logger.error({ err, filePath, messageId }, 'replyFileFromPath failed');
      return { ok: false, error: (err as Error).message };
    }
  }

  async replyImageFromPath(
    messageId: string,
    filePath: string,
  ): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    const loaded = await this.loadForUpload(filePath, MAX_IMAGE_BYTES, '图片');
    if (!loaded.ok) return loaded;
    try {
      const upResp: any = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: loaded.buf,
        },
      });
      const imageKey = upResp?.data?.image_key ?? upResp?.image_key;
      if (!imageKey) return { ok: false, error: 'upload returned no image_key' };
      const reply: any = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        } as any,
      });
      const replyId = reply?.data?.message_id ?? null;
      return { ok: true, messageId: replyId ?? undefined };
    } catch (err) {
      this.logger.error({ err, filePath, messageId }, 'replyImageFromPath failed');
      return { ok: false, error: (err as Error).message };
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

  /** Fetch a message by id (for replied-message injection). Best-effort: null on failure. */
  async getMessage(messageId: string): Promise<{
    msgType: string;
    text: string;
    senderId: string;
    senderType: string;
    createTime: string;
    imageKey?: string;
    fileKey?: string;
    fileName?: string;
  } | null> {
    try {
      const resp: any = await this.client.im.message.get({
        path: { message_id: messageId },
      });
      const item = resp?.data?.items?.[0];
      if (!item) return null;
      const msgType: string = item.msg_type ?? '';
      let text = '';
      let imageKey: string | undefined;
      let fileKey: string | undefined;
      let fileName: string | undefined;
      try {
        const body = JSON.parse(item.body?.content ?? '{}');
        if (msgType === 'text') {
          text = String(body.text ?? '')
            .replace(/@_user_\w+/g, '')
            .trim();
        } else if (msgType === 'image') {
          imageKey = body.image_key;
        } else if (msgType === 'file') {
          fileKey = body.file_key;
          fileName = body.file_name;
        }
      } catch {
        /* non-JSON / unsupported body — leave text empty, type noted by caller */
      }
      return {
        msgType,
        text,
        senderId: item.sender?.id ?? '',
        senderType: item.sender?.sender_type ?? '',
        createTime: String(item.create_time ?? ''),
        imageKey,
        fileKey,
        fileName,
      };
    } catch (err) {
      this.logger.error({ err, messageId }, 'getMessage failed');
      return null;
    }
  }
}
