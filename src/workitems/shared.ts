import type { WorkItemStatus } from './types.js';

/**
 * Shared internal helpers for the workitems layer (v4 #15).
 *
 * These predicates and the LoggerLike shape were copy-pasted across reducer /
 * effects / watchdog / … and had started to drift — most dangerously isRunConclusion,
 * which must enumerate every run-conclusion kind in exactly one place so a new kind
 * can never be recognized by one module and missed by another.
 */

export type LoggerLike = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The kinds the EffectRuntime emits to conclude a run effect. Single source of truth. */
export function isRunConclusion(kind: string): boolean {
  return kind === 'run_completed' || kind === 'run_failed';
}

export function isTerminalStatus(status: WorkItemStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

export function assertPositiveFinite(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

// DELEGATE（审查修复）：授权之后人是否显式打回过同名 wait——人的更晚决定优先于睡前预授权，命中则该
// reason 在本次授权内不再自动过（重新 /delegate 即重置）。watchdog 扫描与桥层消费方共用一份判定，防漂移。
// 只看 decision.approved === false：decision 是容器 API（resolveWait）自己写进 wait_resolved 载荷的字段，
// 读回不算解释业务语义；委托自动通过只写 approved=true，容器清理不带 decision，故 false 必出自人。
// reason 匹配是 opaque 逐字节比较（同 grant.reasons）。事件按 seq 升序、createdAt 不回退——倒序扫到
// sinceTs 之前即可停。
export function humanDeclinedSince(
  events: ReadonlyArray<{ kind: string; payload: unknown; createdAt: number }>,
  reason: string,
  sinceTs: number,
  getWait: (id: string) => { reason: string } | undefined,
): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev) continue;
    if (ev.createdAt < sinceTs) break;
    if (ev.kind !== 'wait_resolved' || !isObject(ev.payload)) continue;
    const decision = ev.payload.decision;
    if (!isObject(decision) || decision.approved !== false) continue;
    const waitId = ev.payload.waitId;
    if (typeof waitId !== 'string') continue;
    if (getWait(waitId)?.reason === reason) return true;
  }
  return false;
}
