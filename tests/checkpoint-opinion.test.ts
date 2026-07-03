import { describe, expect, it } from 'vitest';
import { applyCheckpointOpinion } from '../src/index.js';

// 审查修复 T1（WS-5 意见回灌）：拍板/打回时把卡片输入框的意见作为 human_message 注入，供下一轮 run
// 消费。仅在 wait 仍 open 时注入（防双击），且调用方须在 resolveWait 之前调它（D-E 的 seq 保证）。

function fakeWorkitems(resolvedAt: number | null, injected: string[]) {
  return {
    store: { getWait: () => ({ resolvedAt }) },
    api: { injectHumanMessage: (_id: string, m: { text: string }) => injected.push(m.text) },
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
});
