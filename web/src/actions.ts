import type { BoardData, Requirement } from './types.js';
import { isInflight } from './types.js';

// 原型 resolveDecision() 的纯函数移植：本地（seed 模式）拍板通过灯② —— 更新灯、解阻工人、写台账、
// 清人工待办、补一条系统待办。接真 API 后，这步改为 POST /api/.../resolve 再重拉看板数据。
export function resolveDecisionLocal(data: BoardData, id: string): BoardData {
  const reqs: Requirement[] = data.reqs.map((r) => {
    if (r.id !== id || !isInflight(r)) return r;

    const lights = [...r.lights];
    lights[1] = 'passed';
    if (lights[2] === 'pending') lights[2] = 'active-agent';

    const workers = r.workers.map((w) =>
      w.state === 'paused'
        ? { ...w, state: 'running' as const, selftest: 'green' as const }
        : w.state === 'blocked'
          ? { ...w, state: 'running' as const, selftest: 'amber' as const }
          : w,
    );

    const decisions = [
      {
        type: '拍板' as const,
        text: '灯② 契约确认通过 — 接受 payment-core 破坏性变更',
        who: '你 · 刚刚',
      },
      ...r.decisions,
    ];

    return {
      ...r,
      lights,
      workers,
      waitOnHuman: false,
      health: 'ok',
      summary: '契约已确认，各仓恢复实现',
      decisions,
      humanWaits: [],
      agentWaits: [
        {
          title: '各仓恢复实现',
          desc: 'payment-core / settlement-job 已恢复，按新契约继续实现并自测。',
          age: '刚刚',
        },
      ],
    };
  });

  return { ...data, reqs };
}
