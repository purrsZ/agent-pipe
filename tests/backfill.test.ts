import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backfillClaimedChats, ingestMessage } from '../src/index.js';
import { Store } from '../src/store.js';
import type { IncomingMessage } from '../src/feishu/types.js';

// WS-4 断线补拉：对 managed 认领过的 chat 主动拉 im.message.list，只投未见过的、跳过 bot 自己的、
// 水位（latestInboxCreateTime）推进后续起点。伪 sender = 内存消息数组。

let tmpDir: string;
let store: Store;
const BOT = 'ou_bot';
const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-backfill-'));
  store = new Store(path.join(tmpDir, 'db.sqlite'));
  vi.clearAllMocks();
});
afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function listItem(over: {
  id: string;
  text?: string;
  senderId?: string;
  senderType?: string;
  createTime?: string;
  chatId?: string;
}): unknown {
  return {
    message_id: over.id,
    chat_id: over.chatId ?? 'oc_intake',
    msg_type: 'text',
    create_time: over.createTime ?? '1700000000000',
    root_id: '',
    parent_id: '',
    thread_id: '',
    body: { content: JSON.stringify({ text: over.text ?? '话' }) },
    mentions: [],
    sender: { id: over.senderId ?? 'ou_user', sender_type: over.senderType ?? 'user' },
  };
}

describe('backfillClaimedChats (WS-4)', () => {
  it('ingests only new, non-bot messages and skips already-recorded ones', async () => {
    store.claimThread('oc_intake', 'managed', 'wi-1', null, 'oc_intake');
    const messages = [
      listItem({ id: 'om_1', text: '用户话1' }),
      listItem({ id: 'om_bot', text: '包工头回话', senderId: 'app_x', senderType: 'app' }),
      listItem({ id: 'om_2', text: '用户话2' }),
    ];
    const listMessages = vi.fn(async () => messages);
    const handled: string[] = [];
    const handle = async (m: IncomingMessage) => {
      handled.push(m.messageId);
    };

    const r1 = await backfillClaimedChats({
      store,
      listMessages,
      botOpenId: BOT,
      handle,
      logger,
      now: () => 1700000100000,
      reason: 'test',
    });

    expect(handled).toEqual(['om_1', 'om_2']); // 跳过 bot 自己的 om_bot
    expect(r1.ingested).toBe(2);

    // 第二轮：同样的消息已在 inbox → recordInbox 去重 → 不再投递
    const r2 = await backfillClaimedChats({
      store,
      listMessages,
      botOpenId: BOT,
      handle,
      logger,
      now: () => 1700000200000,
      reason: 'test',
    });
    expect(handled).toEqual(['om_1', 'om_2']); // 未新增
    expect(r2.ingested).toBe(0);
  });

  it('uses max(inbox watermark, now-lookback) minus 60s overlap as the list start_time', async () => {
    store.claimThread('oc_intake', 'managed', 'wi-1', null, 'oc_intake');
    // 已见过一条 create_time=1700000050000（ms）
    store.recordInbox({
      messageId: 'om_seen',
      chatId: 'oc_intake',
      createTime: 1700000050000,
      payloadJson: '{}',
    });
    store.markInboxProcessed('om_seen');

    const seenStart: number[] = [];
    const listMessages = vi.fn(async (_chatId: string, startTimeSec: number) => {
      seenStart.push(startTimeSec);
      return [];
    });
    await backfillClaimedChats({
      store,
      listMessages,
      botOpenId: BOT,
      handle: async () => {},
      logger,
      now: () => 1700000100000, // now 比水位新，但 now-24h 更早 → 取水位
      reason: 'test',
    });
    // since = max(1700000050000, now-24h) = 1700000050000（ms）→ floor(/1000)-60 = 1700000050-60
    expect(seenStart[0]).toBe(1700000050 - 60);
  });

  it('skips chats when listMessages throws, without aborting the whole sweep', async () => {
    store.claimThread('oc_bad', 'managed', 'wi-1', null, 'oc_bad');
    store.claimThread('oc_ok', 'managed', 'wi-2', null, 'oc_ok');
    const handled: string[] = [];
    const listMessages = vi.fn(async (chatId: string) => {
      if (chatId === 'oc_bad') throw new Error('list boom');
      return [listItem({ id: 'om_ok', chatId: 'oc_ok', text: 'ok' })];
    });
    const r = await backfillClaimedChats({
      store,
      listMessages,
      botOpenId: BOT,
      handle: async (m) => {
        handled.push(m.messageId);
      },
      logger,
      now: () => 1700000100000,
      reason: 'test',
    });
    expect(handled).toContain('om_ok'); // 好 chat 照常
    expect(r.ingested).toBe(1);
    expect(logger.error).toHaveBeenCalled(); // 坏 chat 记 error 但不抛
  });
});

describe('ingestMessage (WS-4)', () => {
  const msg: IncomingMessage = {
    messageId: 'om_x',
    chatId: 'oc_a',
    chatType: 'group',
    userId: 'ou_user',
    text: 'hi',
    isMentioned: true,
    mentions: [],
    attachments: [],
    createTime: 1000,
  };

  it('records, handles, marks — dedupes the second delivery', async () => {
    const handle = vi.fn(async () => {});
    expect(await ingestMessage({ store, handle, logger }, msg)).toBe('ingested');
    expect(await ingestMessage({ store, handle, logger }, msg)).toBe('duplicate');
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('does not mark processed when the handler throws (retryable on restart)', async () => {
    const handle = vi.fn(async () => {
      throw new Error('handler boom');
    });
    expect(await ingestMessage({ store, handle, logger }, msg)).toBe('error');
    // 未标记 → 仍在未处理列表里（重启补投）
    expect(store.listInboxUnprocessed(10).map((r) => r.message_id)).toEqual(['om_x']);
  });
});
