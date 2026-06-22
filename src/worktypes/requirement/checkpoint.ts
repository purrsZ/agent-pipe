import type { Decision, Transition, WorkItem, WorkItemEvent } from '../../workitems/types.js';
import { CHECKPOINT_REQUIRED_BEFORE } from './phases.js';

// Checkpoint = a phase-boundary human wait (D-03, single-track). Interception lives in the
// worktype (not the container): when an event would cross a requiredBefore boundary whose
// gate is not yet resolved, onEvent returns waits:[human] INSTEAD of a phase change, so the
// container never touches phase (mergeTransitions only takes the worktype's phase).
//
// This file is pure (worktypes layer): no async/await/fs. The stale check itself is the
// container's checkDecision path + the worktype's isDecisionStale (contract-engine, Stage 4);
// here we only own the raise / advance / rollback shape.

export function crossesCheckpoint(toPhase: string): boolean {
  return CHECKPOINT_REQUIRED_BEFORE.includes(toPhase);
}

// The human wait's reason encodes which gate it guards, so the workbench can label the card
// and the adapter can route a p板 back to the right wait (`checkpoint:<boundary phase>`).
export function checkpointReason(toPhase: string): string {
  return `checkpoint:${toPhase}`;
}

export function checkpointBoundaryOf(reason: string | undefined): string | undefined {
  if (typeof reason !== 'string' || !reason.startsWith('checkpoint:')) return undefined;
  return reason.slice('checkpoint:'.length);
}

// A checkpoint p板 rides a wait_resolved that carries a `decision`. Plain wait resolves
// (retry救场, cancel-confirm) carry none and are handled separately.
export function checkpointDecisionOf(
  ev: WorkItemEvent,
): { approved: boolean; payload?: unknown } | undefined {
  if (ev.kind !== 'wait_resolved') return undefined;
  const p = ev.payload;
  if (typeof p !== 'object' || p === null) return undefined;
  const decision = (p as { decision?: unknown }).decision;
  if (typeof decision !== 'object' || decision === null) return undefined;
  const approved = (decision as { approved?: unknown }).approved;
  if (typeof approved !== 'boolean') return undefined;
  return { approved, payload: (decision as { payload?: unknown }).payload };
}

// Raise the gate's human wait. No phase change — we stay put until a p板 arrives. The
// wait's reason carries the boundary. (A pure worktype cannot append a custom event; the
// triggering event already lands on the stream for the anchor card, and the checkpoint_*
// events are emitted by the checkpoint effect handler — Stage 4 / D-15.)
export function raiseCheckpoint(toPhase: string, deadlineTtlSec: number): Transition {
  return { waits: [{ kind: 'human', reason: checkpointReason(toPhase), deadlineTtlSec }] };
}

// Build the decision.data the p板 carries forward (contract fingerprint固化, D-05). For the
// skeleton this just echoes the boundary; Stage 4 (contract-engine) adds the fingerprint.
export function checkpointDecisionData(
  boundary: string,
  extra?: Record<string, unknown>,
): Decision['data'] {
  return { boundary, ...(extra ?? {}) };
}

// Per-item ttl knobs, mirroring noop's context parsing. Pure.
export function ttlsOf(item: WorkItem): { deadlineTtlSec: number; wallclockCapSec: number } {
  const c = item.context;
  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
  const ctx = typeof c === 'object' && c !== null ? (c as Record<string, unknown>) : {};
  return {
    deadlineTtlSec: num(ctx.deadlineTtlSec, 3600),
    wallclockCapSec: num(ctx.wallclockCapSec, 1800),
  };
}
