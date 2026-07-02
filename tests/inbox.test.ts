import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

// WS-4 持久 inbox：入站消息落库（防进程内丢），INSERT OR IGNORE 权威去重，处理完标记，
// 未处理行启动补投，水位供断线补拉，已处理旧行每日清理。

let tmpDir: string;
let store: Store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-inbox-'));
  store = new Store(path.join(tmpDir, 'db.sqlite'));
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('persistent inbox (WS-4)', () => {
  it('records a new message and dedupes by message_id (payload not overwritten)', () => {
    expect(
      store.recordInbox({
        messageId: 'om_1',
        chatId: 'oc_a',
        createTime: 1000,
        payloadJson: '{"a":1}',
      }),
    ).toBe(true);
    // 同 id 再投 → false（权威去重）
    expect(
      store.recordInbox({
        messageId: 'om_1',
        chatId: 'oc_a',
        createTime: 2000,
        payloadJson: '{"a":2}',
      }),
    ).toBe(false);
    // 原 payload 不被覆盖
    expect(store.listInboxUnprocessed(200)[0]!.payload).toBe('{"a":1}');
  });

  it('lists unprocessed in insertion order and clears them on markInboxProcessed', () => {
    store.recordInbox({ messageId: 'om_1', chatId: 'oc_a', createTime: 1000, payloadJson: 'x' });
    store.recordInbox({ messageId: 'om_2', chatId: 'oc_a', createTime: 2000, payloadJson: 'y' });
    expect(store.listInboxUnprocessed(200).map((r) => r.message_id)).toEqual(['om_1', 'om_2']);

    store.markInboxProcessed('om_1');
    expect(store.listInboxUnprocessed(200).map((r) => r.message_id)).toEqual(['om_2']);
  });

  it('honors the limit on listInboxUnprocessed', () => {
    for (let i = 0; i < 5; i++) {
      store.recordInbox({ messageId: `om_${i}`, chatId: 'oc_a', createTime: i, payloadJson: 'x' });
    }
    expect(store.listInboxUnprocessed(3)).toHaveLength(3);
  });

  // C5（审查）：replayInbox 用游标分批 drain 全部未处理行（>200 也不漏），且跳过失败行不死循环。
  it('pages unprocessed rows by an id cursor (afterId)', () => {
    for (let i = 0; i < 5; i++) {
      store.recordInbox({ messageId: `om_${i}`, chatId: 'oc_a', createTime: i, payloadJson: 'x' });
    }
    const first = store.listInboxUnprocessed(2, 0);
    expect(first.map((r) => r.message_id)).toEqual(['om_0', 'om_1']);
    const next = store.listInboxUnprocessed(2, first[1]!.id);
    expect(next.map((r) => r.message_id)).toEqual(['om_2', 'om_3']);
    const last = store.listInboxUnprocessed(2, next[1]!.id);
    expect(last.map((r) => r.message_id)).toEqual(['om_4']);
  });

  it('tracks the latest create_time per chat (0 when none)', () => {
    expect(store.latestInboxCreateTime('oc_a')).toBe(0);
    store.recordInbox({ messageId: 'om_1', chatId: 'oc_a', createTime: 1000, payloadJson: 'x' });
    store.recordInbox({ messageId: 'om_2', chatId: 'oc_a', createTime: 5000, payloadJson: 'y' });
    store.recordInbox({ messageId: 'om_3', chatId: 'oc_b', createTime: 9000, payloadJson: 'z' });
    expect(store.latestInboxCreateTime('oc_a')).toBe(5000);
    expect(store.latestInboxCreateTime('oc_b')).toBe(9000);
  });

  it('purges only processed rows, keeping unprocessed ones', () => {
    store.recordInbox({ messageId: 'om_1', chatId: 'oc_a', createTime: 1000, payloadJson: 'x' });
    store.recordInbox({ messageId: 'om_2', chatId: 'oc_a', createTime: 2000, payloadJson: 'y' });
    store.markInboxProcessed('om_1');

    // cutoff 在未来 → 已处理行（om_1）全清；未处理行（om_2）保留
    store.purgeInboxBefore(Date.now() + 60_000);
    expect(store.listInboxUnprocessed(200).map((r) => r.message_id)).toEqual(['om_2']);
    // om_1 真被删：去重表已无该行，再 record 视为新
    expect(
      store.recordInbox({ messageId: 'om_1', chatId: 'oc_a', createTime: 1000, payloadJson: 'x' }),
    ).toBe(true);
  });
});
