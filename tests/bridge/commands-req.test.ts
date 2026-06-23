import { describe, expect, it } from 'vitest';
import { CommandHandler } from '../../src/bridge/commands.js';
import type { IncomingMessage } from '../../src/feishu/types.js';

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

function makeHandler() {
  const replies: string[] = [];
  const reqs: Array<{ description: string }> = [];
  const sender = {
    reply: async (_id: string, text: string) => {
      replies.push(text);
      return null;
    },
  };
  const handler = new CommandHandler(
    {} as never, // store
    sender as never,
    { allowedOpenIds: new Set<string>() } as never, // config
    { error: () => {}, info: () => {}, warn: () => {} } as never, // logger
    {} as never, // pool
    () => {}, // onCompact
    () => ({ aborted: false, dropped: 0 }), // onStop
    () => {}, // onDiagMcp
    () => {}, // onDiagReadonly
    () => {}, // onProbe
    () => {}, // onDone
    (_msg, opts) => reqs.push(opts), // onRequirement
  );
  return { handler, replies, reqs };
}

describe('/req dispatch (requirement 立项重塑, M-I2)', () => {
  it('把一句话需求转给 onRequirement（仓库不再内联，走立项群里收）', async () => {
    const { handler, reqs, replies } = makeHandler();
    await handler.dispatch(makeMsg('/req 给订单页加导出按钮'));
    expect(reqs).toEqual([{ description: '给订单页加导出按钮' }]);
    expect(replies).toHaveLength(0); // 不再当场报用法，建群后引导
  });

  it('兼容旧习惯：带 --repo 则剥离并忽略其值，剩下当描述', async () => {
    const { handler, reqs } = makeHandler();
    await handler.dispatch(makeMsg('/req --repo /tmp/web --repo /tmp/api 双端联调登录'));
    expect(reqs).toEqual([{ description: '双端联调登录' }]);
  });

  it('空描述也放行（建群后引导逐项填）', async () => {
    const { handler, reqs, replies } = makeHandler();
    await handler.dispatch(makeMsg('/req'));
    expect(reqs).toEqual([{ description: '' }]);
    expect(replies).toHaveLength(0);
  });

  it('--repo 夹在描述中间也只保留描述部分', async () => {
    const { handler, reqs } = makeHandler();
    await handler.dispatch(makeMsg('/req 给 --repo /tmp/x 订单加导出'));
    expect(reqs).toEqual([{ description: '给 订单加导出' }]);
  });
});
