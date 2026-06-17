import { describe, expect, it } from 'vitest';
import { WorkitemsApi } from '../../src/workitems/api.js';
import type { PendingEvent } from '../../src/workitems/reducer.js';

function makeApi() {
  const enqueued: Array<{ workitemId: string; ev: PendingEvent }> = [];
  const api = new WorkitemsApi({
    store: {} as never,
    registry: {} as never,
    reducer: {
      enqueue: (workitemId: string, ev: PendingEvent) => enqueued.push({ workitemId, ev }),
    } as never,
    artifacts: {} as never,
  });
  return { api, enqueued };
}

describe('WorkitemsApi inject (M1b WI-4/WI-5)', () => {
  it('injectClose enqueues a close_requested event with an empty payload', () => {
    const { api, enqueued } = makeApi();
    api.injectClose('wi-1');
    expect(enqueued).toEqual([
      { workitemId: 'wi-1', ev: { kind: 'close_requested', payload: {} } },
    ]);
  });

  it('injectHumanMessage enqueues a human_message carrying the follow-up payload', () => {
    const { api, enqueued } = makeApi();
    api.injectHumanMessage('wi-2', { text: '再看看 codex', feishuMsgId: 'm-9' });
    expect(enqueued).toEqual([
      {
        workitemId: 'wi-2',
        ev: { kind: 'human_message', payload: { text: '再看看 codex', feishuMsgId: 'm-9' } },
      },
    ]);
  });
});
