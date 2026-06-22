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
  const reqs: Array<{ repos?: string[]; description: string }> = [];
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

describe('/req dispatch (requirement worktype, T1)', () => {
  it('parses a single --repo and the trailing description into onRequirement', async () => {
    const { handler, reqs, replies } = makeHandler();
    await handler.dispatch(makeMsg('/req --repo /tmp/app 给订单页加导出按钮'));
    expect(reqs).toEqual([{ repos: ['/tmp/app'], description: '给订单页加导出按钮' }]);
    expect(replies).toHaveLength(0);
  });

  it('collects repeated --repo flags (multi-end) and keeps order', async () => {
    const { handler, reqs } = makeHandler();
    await handler.dispatch(makeMsg('/req --repo /tmp/web --repo /tmp/api 双端联调登录'));
    expect(reqs).toEqual([{ repos: ['/tmp/web', '/tmp/api'], description: '双端联调登录' }]);
  });

  it('passes undefined repos when none are given (index falls back to default cwd)', async () => {
    const { handler, reqs } = makeHandler();
    await handler.dispatch(makeMsg('/req 把首页改成暗色'));
    expect(reqs).toEqual([{ repos: undefined, description: '把首页改成暗色' }]);
  });

  it('joins the description even when --repo sits between description tokens', async () => {
    const { handler, reqs } = makeHandler();
    await handler.dispatch(makeMsg('/req 给 --repo /tmp/x 订单加导出'));
    expect(reqs).toEqual([{ repos: ['/tmp/x'], description: '给 订单加导出' }]);
  });

  it('without a description replies usage and does not call onRequirement', async () => {
    const { handler, reqs, replies } = makeHandler();
    await handler.dispatch(makeMsg('/req --repo /tmp/x'));
    expect(reqs).toHaveLength(0);
    expect(replies[0]).toContain('用法');
  });
});
