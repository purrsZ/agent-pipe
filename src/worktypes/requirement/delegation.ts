import type { WorkItemEvent } from '../../workitems/types.js';
import { checkpointReason } from './checkpoint.js';
import { PHASE } from './phases.js';

// DELEGATE 委托域（worktypes 层纯核心，单一来源）。
//
// 白名单与 guard 同址同源（审查修复）：DELEGABLE_WAIT_REASONS 直接取自 guard 声明表的键——往白名单
// 加 reason 必须同时声明它的机器信号 guard（同一个对象字面量），两者结构上不可能漂移；未声明 guard 的
// reason 恒不放行（fail-closed）。此前 guard 写在桥层 src/index.ts、白名单在本目录，跨文件只有约定耦合。

// WS-7.7：交付相位「等人关单」的 human wait reason（灯④）——可点关单卡 / 可催 / 活性看门可见。
export const AWAITING_CLOSE_REASON = 'awaiting_close';

// 灯③ guard 的机器信号：最后一条 integration_check_passed 的解读（单一来源，审查修复——此前
// deliverGateNote 与委托 guard 各自倒扫事件、各自解释 payload.reason，语义已有细微分叉）。
//   checked=false            → 从无 integration_check_passed 事件
//   genuine=true             → payload 为对象且无 reason 字段 = 静态对账真通过（interfaceCount 顺带取出）
//   genuine=false + reason   → 静态对账未生效（no_contract / no_claims / 未来新 reason）
//   genuine=false 无 reason  → payload 异形（非对象/坏行/null reason）——保守面：无法解读 ≠ 通过
export interface IntegrationCheckOutcome {
  checked: boolean;
  genuine: boolean;
  reason?: string;
  interfaceCount?: number;
}

export function integrationCheckOutcome(events: WorkItemEvent[]): IntegrationCheckOutcome {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.kind !== 'integration_check_passed') continue;
    const p = ev.payload;
    if (typeof p !== 'object' || p === null) return { checked: true, genuine: false };
    const r = (p as { reason?: unknown }).reason;
    if (r === undefined) {
      const n = (p as { interfaceCount?: unknown }).interfaceCount;
      return {
        checked: true,
        genuine: true,
        ...(typeof n === 'number' && n > 0 ? { interfaceCount: n } : {}),
      };
    }
    return { checked: true, genuine: false, ...(typeof r === 'string' ? { reason: r } : {}) };
  }
  return { checked: false, genuine: false };
}

// DELEGATE D-2 + D-4：可委托 reason → 机器信号 guard 声明表。**只含推进型三灯，永不扩到事故类**；
// /delegate 命令入口只接受这份列表（容器对语义零感知，只做 opaque 字符串匹配）。
//   灯②（拆解拍板，split→implement 边界的 checkpoint）——注意：PIVOT 后主线该边界不设 checkpoint
//   （reconcile_passed 直进并行实现），此 reason 的 wait 当前不会出现；保留声明属前向保护，灯② 若长回来
//   自动被覆盖，平时是死而无害的一行。无 guard（拆解结论有对账 effect 兜底）。
//   灯③（验收，integrate→deliver 的 checkpoint）——**只认机器信号，不认 AI 报告**（AI 质检/参谋报告
//   只进人眼，E5 D-1）：静态对账真通过才放行；no_contract/no_claims/异形 payload 均不放行、等人
//   （推论：lite 单仓的灯③ 永不自动过，设计上有意保守）。
//   灯④（awaiting_close 关单）——关单前灯③已人批或真通过，无需 guard。
// 硬排除（D-2，勿重开）：立项 gate（checkpointReason(PHASE.split)，料没收齐自动过无意义）、监工判大
// gatekeeper_big（自动放行=监工白判）、一切病历（run_failed / reconcile_conflict / integration_unresolved /
// retry_exhausted / thrash / stalled_no_path / steer_escalated——「已处理·继续」意味着人做过处置，自动点=
// 空转）、cancel_confirm（破坏性）。守护断言钉死于 tests/workitems/requirement-delegation.test.ts。
const DELEGATION_GUARDS: Record<string, (events: WorkItemEvent[]) => boolean> = {
  [checkpointReason(PHASE.implement)]: () => true,
  [checkpointReason(PHASE.deliver)]: (events) => {
    const oc = integrationCheckOutcome(events);
    return oc.checked && oc.genuine;
  },
  [AWAITING_CLOSE_REASON]: () => true,
};

export const DELEGABLE_WAIT_REASONS: readonly string[] = Object.keys(DELEGATION_GUARDS);

// 委托 guard：白名单内按声明表判定；未声明（含一切非白名单 reason）恒 false——fail-closed 双保险，
// 白名单本身已在命令入口约束。watchdog（container 调 worktype 方法不算解释业务语义，先例 liveness()）
// 与桥层消费方 runDelegationDue 共用同一函数。纯函数。
export function delegationGuardFor(reason: string, events: WorkItemEvent[]): boolean {
  const guard = DELEGATION_GUARDS[reason];
  return guard ? guard(events) : false;
}
