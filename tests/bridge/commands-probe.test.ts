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
  const probes: Array<{ repo?: string; description: string }> = [];
  const dones: string[] = [];
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
    (_msg, opts) => probes.push(opts), // onProbe
    (_msg, threadRoot) => dones.push(threadRoot), // onDone
  );
  return { handler, replies, probes, dones };
}

describe('/probe + /done dispatch (M1b WI-4)', () => {
  it('/probe parses --repo and the trailing description into onProbe', async () => {
    const { handler, probes, replies } = makeHandler();
    await handler.dispatch(makeMsg('/probe --repo /tmp/x 看看 runner 有几个'));
    expect(probes).toEqual([{ repo: '/tmp/x', description: '看看 runner 有几个' }]);
    expect(replies).toHaveLength(0);
  });

  it('/probe without --repo passes undefined repo and the full description', async () => {
    const { handler, probes } = makeHandler();
    await handler.dispatch(makeMsg('/probe 这个仓库有没有死锁'));
    expect(probes).toEqual([{ repo: undefined, description: '这个仓库有没有死锁' }]);
  });

  it('/probe without a description replies usage and does not call onProbe', async () => {
    const { handler, probes, replies } = makeHandler();
    await handler.dispatch(makeMsg('/probe'));
    expect(probes).toHaveLength(0);
    expect(replies[0]).toContain('用法');
  });

  it('/done inside a thread forwards the thread root to onDone', async () => {
    const { handler, dones, replies } = makeHandler();
    await handler.dispatch(makeMsg('/done', { rootId: 'anchor-1' }));
    expect(dones).toEqual(['anchor-1']);
    expect(replies).toHaveLength(0);
  });

  it('/done inside a feishu thread prefers thread_id (= claim key) over rootId', async () => {
    const { handler, dones } = makeHandler();
    await handler.dispatch(makeMsg('/done', { threadId: 'omt_x', rootId: 'r1' }));
    expect(dones).toEqual(['omt_x']);
  });

  it('/done falls back to parentId when rootId is absent', async () => {
    const { handler, dones } = makeHandler();
    await handler.dispatch(makeMsg('/done', { parentId: 'anchor-2' }));
    expect(dones).toEqual(['anchor-2']);
  });

  it('/done outside any thread replies a hint and does not call onDone', async () => {
    const { handler, dones, replies } = makeHandler();
    await handler.dispatch(makeMsg('/done'));
    expect(dones).toHaveLength(0);
    expect(replies[0]).toContain('话题');
  });
});
