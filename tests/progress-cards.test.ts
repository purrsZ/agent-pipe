import { describe, expect, it } from 'vitest';
import { ProgressCards } from '../src/feishu/progress-cards.js';

// Flush both microtasks and the macrotask queue so the fire-and-forget card posts settle.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fakeSender() {
  const replies: Array<{ to: string; card: object }> = [];
  const threadReplies: Array<{ to: string; card: object }> = [];
  const sends: Array<{ to: string; card: object }> = [];
  const updates: Array<{ id: string; card: object }> = [];
  let nextId = 1;
  let replyImpl: (to: string, card: object) => Promise<string | null> = async (to, card) => {
    const id = `card-${nextId++}`;
    replies.push({ to, card });
    return id;
  };
  let threadReplyImpl: (
    to: string,
    card: object,
  ) => Promise<{ messageId: string; threadId: string | null } | null> = async (to, card) => {
    const id = `thread-card-${nextId++}`;
    threadReplies.push({ to, card });
    return { messageId: id, threadId: 'omt_topic' };
  };
  const sender = {
    replyCard: (to: string, card: object) => replyImpl(to, card),
    replyCardInThread: (to: string, card: object) => threadReplyImpl(to, card),
    sendCard: async (to: string, card: object) => {
      const id = `chat-${nextId++}`;
      sends.push({ to, card });
      return id;
    },
    updateCard: async (id: string, card: object) => {
      updates.push({ id, card });
      return true;
    },
  };
  return {
    sender,
    replies,
    threadReplies,
    sends,
    updates,
    setReplyImpl: (f: (to: string, card: object) => Promise<string | null>) => {
      replyImpl = f;
    },
    setThreadReplyImpl: (
      f: (
        to: string,
        card: object,
      ) => Promise<{ messageId: string; threadId: string | null } | null>,
    ) => {
      threadReplyImpl = f;
    },
  };
}

const json = (card: object): string => JSON.stringify(card);

// onRunStart locator shapes（run-handler 从 workitem.source 提取后携带）。
const THREAD = { threadId: 'omt_topic1', anchorMsgId: 'om_anchor1' }; // 群聊话题
const P2P = { anchorMsgId: 'om_anchor1' }; // p2p：仅锚点卡

describe('ProgressCards (M2 progress visibility)', () => {
  it('thread mode: posts the streaming card into the thread via replyCardInThread(anchor)', async () => {
    const f = fakeSender();
    const pc = new ProgressCards({ sender: f.sender });
    pc.onRunStart({ workitemId: 'wi', assignmentId: 'a1', title: '看看 runner', ...THREAD });
    await flush();
    expect(f.threadReplies).toHaveLength(1);
    expect(f.threadReplies[0]!.to).toBe('om_anchor1');
    expect(f.replies).toHaveLength(0);
    expect(json(f.threadReplies[0]!.card)).toContain('处理中');
  });

  it('p2p mode: replies the streaming card under the anchor card', async () => {
    const f = fakeSender();
    const pc = new ProgressCards({ sender: f.sender });
    pc.onRunStart({ workitemId: 'wi', assignmentId: 'a1', title: 'T', ...P2P });
    await flush();
    expect(f.replies).toHaveLength(1);
    expect(f.replies[0]!.to).toBe('om_anchor1');
    expect(f.threadReplies).toHaveLength(0);
  });

  it('fallback: sendCard(chatId) when only chatId is known', async () => {
    const f = fakeSender();
    const pc = new ProgressCards({ sender: f.sender });
    pc.onRunStart({ workitemId: 'wi', assignmentId: 'a1', title: 'T', chatId: 'c1' });
    await flush();
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]!.to).toBe('c1');
    expect(f.replies).toHaveLength(0);
    expect(f.threadReplies).toHaveLength(0);
  });

  it('no locator at all → no card; onRunEnd stays safe', async () => {
    const f = fakeSender();
    const pc = new ProgressCards({ sender: f.sender });
    pc.onRunStart({ workitemId: 'wi', assignmentId: 'a1', title: 'T' });
    await flush();
    expect(f.replies).toHaveLength(0);
    expect(f.threadReplies).toHaveLength(0);
    expect(f.sends).toHaveLength(0);
    await pc.onRunEnd({ assignmentId: 'a1', outcome: 'success', report: 'R' });
    expect(f.updates).toHaveLength(0);
  });

  // 第一帧节流地板是 0（lastSentAt=0）→ 立即 flush，无需等 900ms。onText 与 onToolUse 各自
  // 单测，避免第二帧被 900ms 节流推迟（那是 StreamingCard 的正常限频，非本组件职责）。
  it('onText updates the streaming card with the streamed text', async () => {
    const f = fakeSender();
    const pc = new ProgressCards({ sender: f.sender });
    pc.onRunStart({ workitemId: 'wi', assignmentId: 'a1', title: 'T', ...THREAD });
    await flush();

    pc.onText({ assignmentId: 'a1', fullText: 'hello world' });
    await flush();
    expect(f.updates.length).toBeGreaterThanOrEqual(1);
    expect(json(f.updates.at(-1)!.card)).toContain('hello world');
    expect(f.updates.every((u) => u.id === 'thread-card-1')).toBe(true);
  });

  it('onToolUse updates the streaming card with the current tool', async () => {
    const f = fakeSender();
    const pc = new ProgressCards({ sender: f.sender });
    pc.onRunStart({ workitemId: 'wi', assignmentId: 'a1', title: 'T', ...THREAD });
    await flush();

    pc.onToolUse({ assignmentId: 'a1', toolName: 'Bash' });
    await flush();
    expect(f.updates.length).toBeGreaterThanOrEqual(1);
    expect(json(f.updates.at(-1)!.card)).toContain('Bash');
  });

  it('onRunEnd(success) patches the streaming card into the report card and clears the entry', async () => {
    const f = fakeSender();
    const pc = new ProgressCards({ sender: f.sender });
    pc.onRunStart({ workitemId: 'wi', assignmentId: 'a1', title: '看看 runner', ...THREAD });
    await flush();

    await pc.onRunEnd({ assignmentId: 'a1', outcome: 'success', report: 'FINAL REPORT' });
    const last = f.updates.at(-1)!;
    expect(last.id).toBe('thread-card-1');
    expect(json(last.card)).toContain('调查报告');
    expect(json(last.card)).toContain('FINAL REPORT');

    // entry cleared → later stray events are no-ops (no further updates).
    const before = f.updates.length;
    pc.onText({ assignmentId: 'a1', fullText: 'late' });
    await pc.onRunEnd({ assignmentId: 'a1', outcome: 'success', report: 'again' });
    await flush();
    expect(f.updates.length).toBe(before);
  });

  it('onRunEnd(failed) patches into the error card', async () => {
    const f = fakeSender();
    const pc = new ProgressCards({ sender: f.sender });
    pc.onRunStart({ workitemId: 'wi', assignmentId: 'a1', title: 'T', ...THREAD });
    await flush();
    await pc.onRunEnd({ assignmentId: 'a1', outcome: 'failed', error: 'boom: spawn failed' });
    expect(json(f.updates.at(-1)!.card)).toContain('调查失败');
    expect(json(f.updates.at(-1)!.card)).toContain('boom: spawn failed');
  });

  it('onRunEnd(aborted) patches into the 中断 card', async () => {
    const f = fakeSender();
    const pc = new ProgressCards({ sender: f.sender });
    pc.onRunStart({ workitemId: 'wi', assignmentId: 'a1', title: 'T', ...THREAD });
    await flush();
    await pc.onRunEnd({ assignmentId: 'a1', outcome: 'aborted' });
    expect(json(f.updates.at(-1)!.card)).toContain('调查中断');
  });

  it('P0 race: a run that ends before its card posts still lands its terminal card (no 处理中 orphan)', async () => {
    const f = fakeSender();
    let resolveReply!: (id: string) => void;
    f.setThreadReplyImpl(
      () =>
        new Promise((r) => {
          resolveReply = (id: string) => r({ messageId: id, threadId: 'omt_x' });
        }),
    );
    const pc = new ProgressCards({ sender: f.sender });
    pc.onRunStart({ workitemId: 'wi', assignmentId: 'a1', title: 'T', ...THREAD });

    // run ends while the card post is still in flight.
    let ended = false;
    const endP = pc.onRunEnd({ assignmentId: 'a1', outcome: 'success', report: 'R' }).then(() => {
      ended = true;
    });
    await flush();
    // onRunEnd is parked on `await entry.ready` — no terminal card yet.
    expect(ended).toBe(false);
    expect(f.updates).toHaveLength(0);

    // card post lands → onRunEnd resumes and patches the terminal card onto it.
    resolveReply('thread-card-1');
    await endP;
    expect(ended).toBe(true);
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0]!.id).toBe('thread-card-1');
    expect(json(f.updates[0]!.card)).toContain('调查报告');
  });

  it('unknown assignmentId on onText / onRunEnd is a safe no-op', async () => {
    const f = fakeSender();
    const pc = new ProgressCards({ sender: f.sender });
    pc.onText({ assignmentId: 'nope', fullText: 'x' });
    await pc.onRunEnd({ assignmentId: 'nope', outcome: 'success', report: 'r' });
    await flush();
    expect(f.replies).toHaveLength(0);
    expect(f.threadReplies).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it('WS-9 onAskUser: 在流式卡同一 loc 并行贴问题表单卡（auq-wi）', async () => {
    const f = fakeSender();
    const pc = new ProgressCards({ sender: f.sender });
    pc.onRunStart({ workitemId: 'wi', assignmentId: 'a1', title: 'T', ...P2P });
    await flush();
    pc.onAskUser({
      assignmentId: 'a1',
      workitemId: 'wi',
      title: 'T',
      questions: [{ question: 'A 还是 B？', options: [{ label: 'A' }, { label: 'B' }] }],
    });
    await flush();
    // p2p：问题卡也 replyCard(anchor)。第一张流式卡，第二张问题卡。
    expect(f.replies.length).toBeGreaterThanOrEqual(2);
    const qCard = json(f.replies[f.replies.length - 1]!.card);
    expect(qCard).toContain('auq-wi');
    expect(qCard).toContain('A 还是 B？');
    expect(qCard).toContain('wi'); // workitemId 随提交 value
  });

  it('WS-9 onAskUser: 未知 run（未 onRunStart）→ 安全 no-op', async () => {
    const f = fakeSender();
    const pc = new ProgressCards({ sender: f.sender });
    pc.onAskUser({ assignmentId: 'unknown', workitemId: 'wi', title: 'T', questions: [] });
    await flush();
    expect(f.replies).toHaveLength(0);
    expect(f.sends).toHaveLength(0);
  });
});
