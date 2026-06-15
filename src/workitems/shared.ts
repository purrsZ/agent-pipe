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
