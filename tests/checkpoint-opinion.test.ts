import { describe, expect, it } from 'vitest';
import { applyCheckpointOpinion, withInFlightGuard } from '../src/index.js';

// 审查修复 T1（WS-5 意见回灌）：拍板/打回时把卡片输入框的意见作为 human_message 注入，供下一轮 run
// 消费。仅在 wait 仍 open 时注入（防双击），且调用方须在 resolveWait 之前调它（D-E 的 seq 保证）。

function fakeWorkitems(resolvedAt: number | null, injected: string[]) {
  return {
    store: { getWait: () => ({ resolvedAt }) },
    api: {
      injectHumanMessage: (_id: string, m: { text: string; silent?: boolean }) =>
        injected.push(m.text),
    },
  };
}

describe('applyCheckpointOpinion（审查修复 T1）', () => {
  it('opinion 非空 + wait open + 打回 → 注入带【打回意见】前缀', () => {
    const injected: string[] = [];
    const did = applyCheckpointOpinion({
      workitems: fakeWorkitems(null, injected),
      itemId: 'i',
      waitId: 'w',
      approved: false,
      opinion: '这里逻辑不对，改一下',
    });
    expect(did).toBe(true);
    expect(injected).toEqual(['【打回意见】这里逻辑不对，改一下']);
  });

  it('opinion 非空 + wait open + 拍板 → 前缀是【拍板意见】', () => {
    const injected: string[] = [];
    applyCheckpointOpinion({
      workitems: fakeWorkitems(null, injected),
      itemId: 'i',
      waitId: 'w',
      approved: true,
      opinion: '同意，就这么办',
    });
    expect(injected).toEqual(['【拍板意见】同意，就这么办']);
  });

  it('opinion 空 → 不注入', () => {
    const injected: string[] = [];
    const did = applyCheckpointOpinion({
      workitems: fakeWorkitems(null, injected),
      itemId: 'i',
      waitId: 'w',
      approved: false,
      opinion: '',
    });
    expect(did).toBe(false);
    expect(injected).toEqual([]);
  });

  it('wait 已 resolved（双击场景）→ 不注入', () => {
    const injected: string[] = [];
    const did = applyCheckpointOpinion({
      workitems: fakeWorkitems(123, injected),
      itemId: 'i',
      waitId: 'w',
      approved: false,
      opinion: '晚了',
    });
    expect(did).toBe(false);
    expect(injected).toEqual([]);
  });

  it('注入发生在 resolve 之前（时序：先意见回灌后 resolve）', () => {
    const calls: string[] = [];
    const wait = { resolvedAt: null as number | null };
    const workitems = {
      store: { getWait: () => wait },
      api: { injectHumanMessage: () => calls.push('inject') },
    };
    // 模拟 handleCheckpointAction 的调用序列：意见回灌 → resolve
    applyCheckpointOpinion({ workitems, itemId: 'i', waitId: 'w', approved: false, opinion: '改' });
    calls.push('resolve');
    wait.resolvedAt = 1;
    expect(calls).toEqual(['inject', 'resolve']);
  });

  // VERIFY V2（#3）：意见注入带 silent=true——供 owner run 当 followup 读到，但 onHumanMessage 见 silent 不自派
  // steer（避免一次点击双起 run）。
  it('注入的 human_message 带 silent=true（不自派 steer 的标记）', () => {
    const captured: Array<{ text: string; silent?: boolean }> = [];
    const workitems = {
      store: { getWait: () => ({ resolvedAt: null as number | null }) },
      api: {
        injectHumanMessage: (_id: string, m: { text: string; silent?: boolean }) =>
          captured.push(m),
      },
    };
    applyCheckpointOpinion({ workitems, itemId: 'i', waitId: 'w', approved: false, opinion: '改' });
    expect(captured).toEqual([{ text: '【打回意见】改', silent: true }]);
  });
});

// VERIFY V2（#4 发卡竞态守卫）：同一 key 的异步动作在飞行期间只跑一次——surfaceCheckpoints 的发灯卡经它收口，
// 防级联事件在首张卡回执落库前的并发窗口内重复发同一 waitId 的卡（真机三张）。
describe('withInFlightGuard（VERIFY V2 #4）', () => {
  it('并发 3 次同 key → fn 只跑一次，另两次拿到 undefined', async () => {
    const inFlight = new Set<string>();
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fn = async () => {
      calls++;
      await gate; // 卡在飞行中，模拟 replyCard 网络级慢
      return 'sent';
    };
    const ps = [
      withInFlightGuard('w1', inFlight, fn),
      withInFlightGuard('w1', inFlight, fn),
      withInFlightGuard('w1', inFlight, fn),
    ];
    release();
    const results = await Promise.all(ps);
    expect(calls).toBe(1); // 只发一张
    expect(results.filter((r) => r === 'sent')).toHaveLength(1);
    expect(results.filter((r) => r === undefined)).toHaveLength(2);
    expect(inFlight.size).toBe(0); // finally 注销干净
  });

  it('飞行结束后注销 → 可再次进入（下一轮事件/提醒重发）', async () => {
    const inFlight = new Set<string>();
    let calls = 0;
    const fn = async () => {
      calls++;
      return 'ok';
    };
    await withInFlightGuard('w1', inFlight, fn);
    await withInFlightGuard('w1', inFlight, fn);
    expect(calls).toBe(2);
  });

  it('不同 key 互不阻塞', async () => {
    const inFlight = new Set<string>();
    let calls = 0;
    const fn = async () => {
      calls++;
      return 'ok';
    };
    await Promise.all([withInFlightGuard('a', inFlight, fn), withInFlightGuard('b', inFlight, fn)]);
    expect(calls).toBe(2);
  });
});
