import { describe, expect, it } from 'vitest';
import {
  adaptListMessageToEventData,
  isBotBackfillMessage,
  parseIncomingMessage,
} from '../../src/feishu/event-router.js';

// WS-4：把 im.message.receive_v1 的「原始 data → IncomingMessage」解析段抽成导出纯函数，
// dispatcher（推送）与断线补拉（im.message.list 拉回）共用同一份解析，避免两份漂移。

const BOT = 'ou_bot';

function receiveData(over: {
  msgType?: string;
  content?: unknown;
  chatType?: 'p2p' | 'group';
  mentions?: Array<{ id?: { open_id?: string }; name?: string }>;
  senderOpenId?: string;
  createTime?: string;
  extra?: Record<string, unknown>;
}): unknown {
  return {
    message: {
      message_id: 'om_1',
      chat_id: 'oc_a',
      chat_type: over.chatType ?? 'group',
      message_type: over.msgType ?? 'text',
      content: typeof over.content === 'string' ? over.content : JSON.stringify(over.content ?? {}),
      create_time: over.createTime ?? '1700000000000',
      parent_id: '',
      root_id: '',
      thread_id: '',
      mentions: over.mentions ?? [],
      ...(over.extra ?? {}),
    },
    sender: { sender_id: { open_id: over.senderOpenId ?? 'ou_user' } },
  };
}

describe('parseIncomingMessage', () => {
  it('parses a group text mentioning the bot and strips @ tokens', () => {
    const msg = parseIncomingMessage(
      receiveData({
        content: { text: '@_user_1 后端字段改成 orderNo' },
        mentions: [{ id: { open_id: BOT }, name: 'bot' }],
      }),
      BOT,
    );
    expect(msg).not.toBeNull();
    expect(msg!.text).toBe('后端字段改成 orderNo');
    expect(msg!.isMentioned).toBe(true);
    expect(msg!.chatId).toBe('oc_a');
    expect(msg!.userId).toBe('ou_user');
  });

  it('marks a group text NOT mentioning the bot as not mentioned', () => {
    const msg = parseIncomingMessage(receiveData({ content: { text: '闲聊' } }), BOT);
    expect(msg!.isMentioned).toBe(false);
    expect(msg!.mentions).toEqual([]);
  });

  it('treats every p2p text as mentioned', () => {
    const msg = parseIncomingMessage(
      receiveData({ chatType: 'p2p', content: { text: '你好' } }),
      BOT,
    );
    expect(msg!.isMentioned).toBe(true);
  });

  it('flattens a post message to plain text', () => {
    const post = { title: 'T', content: [[{ tag: 'text', text: '正文' }]] };
    const msg = parseIncomingMessage(receiveData({ msgType: 'post', content: post }), BOT);
    expect(msg!.text).toContain('正文');
  });

  it('carries a file attachment', () => {
    const msg = parseIncomingMessage(
      receiveData({ msgType: 'file', content: { file_key: 'fk_1', file_name: 'a.pdf' } }),
      BOT,
    );
    expect(msg!.attachments).toEqual([{ kind: 'file', fileKey: 'fk_1', name: 'a.pdf' }]);
    expect(msg!.text).toBe('');
  });

  it('carries an image attachment', () => {
    const msg = parseIncomingMessage(
      receiveData({ msgType: 'image', content: { image_key: 'ik_1' } }),
      BOT,
    );
    expect(msg!.attachments[0]).toMatchObject({ kind: 'image', fileKey: 'ik_1' });
  });

  it('returns null on missing message/sender', () => {
    expect(parseIncomingMessage({ sender: {} }, BOT)).toBeNull();
    expect(parseIncomingMessage({ message: {} }, BOT)).toBeNull();
  });

  it('returns null on unsupported chat_type / message_type', () => {
    expect(parseIncomingMessage(receiveData({ chatType: 'weird' as 'group' }), BOT)).toBeNull();
    expect(parseIncomingMessage(receiveData({ msgType: 'sticker' }), BOT)).toBeNull();
  });

  it('returns null on empty text / missing file_key / bad JSON (never throws)', () => {
    expect(parseIncomingMessage(receiveData({ content: { text: '   ' } }), BOT)).toBeNull();
    expect(parseIncomingMessage(receiveData({ msgType: 'file', content: {} }), BOT)).toBeNull();
    expect(parseIncomingMessage(receiveData({ content: 'not-json{' }), BOT)).toBeNull();
  });

  // C1（审查）：缺/非数字 create_time → createTime=NaN，若不拦会撞 inbox 的 NOT NULL 约束被 OR IGNORE
  // 静默吞成「重复」永久丢。缺 message_id/chat_id 同理。这些消息一律判无效 → null。
  it('returns null on missing/non-numeric create_time or missing message_id/chat_id', () => {
    expect(parseIncomingMessage(receiveData({ createTime: '' }), BOT)).toBeNull();
    expect(parseIncomingMessage(receiveData({ createTime: 'abc' }), BOT)).toBeNull();
    expect(parseIncomingMessage(receiveData({ extra: { message_id: undefined } }), BOT)).toBeNull();
    expect(parseIncomingMessage(receiveData({ extra: { chat_id: '' } }), BOT)).toBeNull();
  });
});

describe('adaptListMessageToEventData', () => {
  it('reshapes an im.message.list item into receive_v1 data that parses', () => {
    const listItem = {
      message_id: 'om_9',
      chat_id: 'oc_b',
      msg_type: 'text',
      create_time: '1700000009000',
      root_id: 'om_root',
      parent_id: '',
      thread_id: '',
      body: { content: JSON.stringify({ text: '补拉进来的话' }) },
      mentions: [{ id: BOT, name: 'bot' }], // list 侧 id 是字符串 open_id
      sender: { id: 'ou_user2', sender_type: 'user' },
    };
    const msg = parseIncomingMessage(adaptListMessageToEventData(listItem), BOT);
    expect(msg).not.toBeNull();
    expect(msg!.messageId).toBe('om_9');
    expect(msg!.chatId).toBe('oc_b');
    expect(msg!.text).toBe('补拉进来的话');
    expect(msg!.userId).toBe('ou_user2');
    expect(msg!.isMentioned).toBe(true); // list mention id=BOT → reshaped 到 {open_id: BOT}
    expect(msg!.createTime).toBe(1700000009000);
  });

  // C7（审查）：im.message.list item 不带 chat_type。p2p managed（DM 发起的 probe）补拉时必须传真实
  // chatType，否则默认 group + 无 @ → handleIncoming 群门丢弃。传 'p2p' → isMentioned 恒 true 不被丢。
  it('honors an explicit chatType so p2p backfill is not mislabeled as group', () => {
    const listItem = {
      message_id: 'om_p2p',
      chat_id: 'oc_dm',
      msg_type: 'text',
      create_time: '1700000009000',
      body: { content: JSON.stringify({ text: '私聊追问' }) },
      mentions: [],
      sender: { id: 'ou_user2', sender_type: 'user' },
    };
    const asGroup = parseIncomingMessage(adaptListMessageToEventData(listItem), BOT);
    expect(asGroup!.chatType).toBe('group');
    expect(asGroup!.isMentioned).toBe(false); // 默认 group + 无 @ → 会被群门丢

    const asP2p = parseIncomingMessage(adaptListMessageToEventData(listItem, 'p2p'), BOT);
    expect(asP2p!.chatType).toBe('p2p');
    expect(asP2p!.isMentioned).toBe(true);
  });
});

describe('isBotBackfillMessage', () => {
  it('flags app-sent and bot-self messages, passes normal user messages', () => {
    expect(isBotBackfillMessage({ sender: { id: 'app_x', sender_type: 'app' } }, BOT)).toBe(true);
    expect(isBotBackfillMessage({ sender: { id: BOT, sender_type: 'user' } }, BOT)).toBe(true);
    expect(isBotBackfillMessage({ sender: { id: 'ou_user2', sender_type: 'user' } }, BOT)).toBe(
      false,
    );
  });
});
