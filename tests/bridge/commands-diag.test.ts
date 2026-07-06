import { describe, expect, it } from 'vitest';
import { CommandHandler } from '../../src/bridge/commands.js';
import type { IncomingMessage } from '../../src/feishu/types.js';

// 审查修复 F5：/diag-claim 手动登记 managed claim 时要带上 chat_id/chat_type，否则
// listManagedClaimChatIds 枚举不到、断线补拉漏掉该会话。

function makeMsg(text: string, over: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'm-1',
    chatId: 'c-1',
    chatType: 'p2p',
    userId: 'u-1',
    text,
    isMentioned: false,
    mentions: [],
    attachments: [],
    createTime: 1,
    ...over,
  };
}

function makeHandler(claims: unknown[][]) {
  const store = {
    claimThread: (...args: unknown[]) => {
      claims.push(args);
    },
  };
  const sender = { reply: async () => null };
  return new CommandHandler(
    store as never,
    sender as never,
    { allowedOpenIds: new Set(['u-1']) } as never, // u-1 是 admin
    { error: () => {}, info: () => {}, warn: () => {} } as never,
    {} as never, // pool
    () => {}, // onCompact
    () => ({ aborted: false, dropped: 0 }), // onStop
    () => {}, // onDiagMcp
    () => {}, // onDiagReadonly
    () => {}, // onProbe
    () => {}, // onDone
    () => {}, // onRequirement
    () => {}, // onCancelUnit
    () => {}, // onScout
    () => {}, // onDelegate
  );
}

describe('/diag-claim（审查修复 F5）', () => {
  it('登记时把 chat_id/chat_type 一并存进（进补拉枚举）', async () => {
    const claims: unknown[][] = [];
    const handler = makeHandler(claims);
    await handler.dispatch(
      makeMsg('/diag-claim root-1 managed', { chatId: 'c-42', chatType: 'group' }),
    );
    expect(claims).toHaveLength(1);
    // claimThread(rootId, ownerKind, ownerId, anchorMsgId, chatId, chatType)
    expect(claims[0]).toEqual(['root-1', 'managed', 'u-1', undefined, 'c-42', 'group']);
  });

  it('非管理员 → 拒绝，不登记', async () => {
    const claims: unknown[][] = [];
    const handler = makeHandler(claims);
    await handler.dispatch(makeMsg('/diag-claim root-1 managed', { userId: 'not-admin' }));
    expect(claims).toHaveLength(0);
  });
});
