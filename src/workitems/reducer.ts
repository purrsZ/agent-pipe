import { randomUUID } from 'node:crypto';
import { OpenLimitError, TypeNotRegisteredError } from './errors.js';
import { recomputeRollup } from './projection.js';
import type { WorkTypeRegistry } from './registry.js';
import type { WorkitemsStore } from './store.js';
import type {
  Assignment,
  Clock,
  CreateInput,
  CreateResult,
  Decision,
  Effect,
  Transition,
  Wait,
  WorkItem,
  WorkItemEvent,
  WorkItemStatus,
  WorkType,
} from './types.js';
import type { WorkitemsConfig } from './config.js';

export interface PendingEvent {
  kind: string;
  payload?: unknown;
}

export type PostCommitAction =
  | { kind: 'abort_effect'; effectId: number; reason: string }
  | { kind: 'poke'; workitemId: string };

type LoggerLike = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export interface ReducerRuntimeDeps {
  store: WorkitemsStore;
  registry: WorkTypeRegistry;
  clock: Clock;
  cfg: WorkitemsConfig;
  logger?: LoggerLike;
  isRunClass?: (kind: string) => boolean;
  postCommit?: (actions: PostCommitAction[]) => void;
}

export class ReducerRuntime {
  private readonly queues = new Map<string, PendingEvent[]>();
  private readonly draining = new Set<string>();
  private pokeNeeded = false;

  constructor(private readonly deps: ReducerRuntimeDeps) {}

  enqueue(workitemId: string, ev: PendingEvent): void {
    const queue = this.queues.get(workitemId) ?? [];
    queue.push(ev);
    this.queues.set(workitemId, queue);
    if (this.draining.has(workitemId)) return;

    this.draining.add(workitemId);
    try {
      let next = queue.shift();
      while (next) {
        this.applyEvent(workitemId, next);
        next = queue.shift();
      }
    } finally {
      this.draining.delete(workitemId);
      if (queue.length === 0) {
        this.queues.delete(workitemId);
      }
    }
  }

  bootstrapApply(input: CreateInput): CreateResult {
    const type = this.deps.registry.get(input.type);
    if (!type) throw new TypeNotRegisteredError(input.type);

    try {
      return this.deps.store.tx(() => {
        if (input.dedupeKey) {
          const existing = this.deps.store.findByDedupe(input.type, input.dedupeKey);
          if (existing) return { created: false, item: existing };
        }

        if (this.deps.store.countNonTerminal() >= this.deps.cfg.maxOpen) {
          throw new OpenLimitError(this.deps.cfg.maxOpen);
        }

        const now = this.deps.clock.now();
        const draft: WorkItem = {
          id: `wi-${randomUUID()}`,
          type: input.type,
          title: input.title,
          status: 'open',
          statusDetail: null,
          phase: '',
          source: input.source,
          dedupeKey: input.dedupeKey ?? null,
          repos: input.repos ?? [],
          context: input.context ?? null,
          wakePending: false,
          discardStreak: 0,
          createdAt: now,
          updatedAt: now,
        };
        const item = { ...draft, phase: type.initialPhase(draft) };
        this.deps.store.insertWorkItem(item);

        const seq = this.deps.store.nextSeq(item.id);
        const payload = { source: input.source, title: input.title };
        const eventId = this.deps.store.appendEvent(item.id, seq, 'workitem_created', payload);
        const event: WorkItemEvent = {
          id: eventId,
          workitemId: item.id,
          seq,
          kind: 'workitem_created',
          payload,
          createdAt: now,
        };
        this.applyTransitionWrites(item, seq, type.onEvent(item, event));
        recomputeRollup(this.deps.store, item.id, now);
        return { created: true, item: this.deps.store.getWorkItem(item.id) ?? item };
      });
    } catch (err) {
      if (input.dedupeKey && isSqliteConstraint(err)) {
        const existing = this.deps.store.findByDedupe(input.type, input.dedupeKey);
        if (existing) return { created: false, item: existing };
      }
      throw err;
    }
  }

  private applyEvent(workitemId: string, pending: PendingEvent): void {
    const item = this.deps.store.getWorkItem(workitemId);
    if (!item) {
      throw new Error(`WorkItem not found: ${workitemId}`);
    }
    const type = this.deps.registry.get(item.type);
    if (!type) {
      throw new TypeNotRegisteredError(item.type);
    }

    const postCommit: PostCommitAction[] = [];
    this.pokeNeeded = false;
    this.deps.store.tx(() => {
      const now = this.deps.clock.now();
      const seq = this.deps.store.nextSeq(workitemId);
      if (isTerminalStatus(item.status)) {
        this.deps.store.appendEvent(workitemId, seq, pending.kind, pending.payload);
        return;
      }

      const decisionCheck = isRunConclusion(pending.kind)
        ? this.checkDecision(workitemId, pending.payload, type, seq)
        : undefined;
      if (decisionCheck && !decisionCheck.ok) {
        this.deps.store.appendEvent(
          workitemId,
          seq,
          'decision_discarded',
          discardPayload(decisionCheck),
        );
        this.finalizeDiscardedEffect(decisionCheck);
        this.closeDiscardedAssignment(pending.payload, decisionCheck.reason, now);
        this.handleDiscardedDecision(item, seq, decisionCheck, now);
        recomputeRollup(this.deps.store, workitemId, now);
        return;
      }

      const eventId = this.deps.store.appendEvent(workitemId, seq, pending.kind, pending.payload);
      const event: WorkItemEvent = {
        id: eventId,
        workitemId,
        seq,
        kind: pending.kind,
        payload: pending.payload ?? null,
        createdAt: now,
      };
      if (isRunConclusion(pending.kind)) {
        this.closeRunConclusion(pending.kind, pending.payload, now);
        this.deps.store.updateWorkItem(item.id, { discardStreak: 0, updatedAt: now });
      }
      const transition = mergeTransitions(
        this.containerTransition(event, now, postCommit),
        type.onEvent(item, event),
      );
      this.applyTransitionWrites(item, seq, transition);
      if (isRunConclusion(pending.kind) && item.wakePending) {
        this.releaseWakePending(item, seq, now);
      }
      recomputeRollup(this.deps.store, workitemId, now);
    });
    // Spec G-4.1/overview step 7: a freshly committed run effect is driven by a
    // post-commit poke — without it, dispatches whose apply was not triggered by
    // a concluding effect (recovery redispatch, stalled replacement) never start.
    if (this.pokeNeeded) {
      postCommit.push({ kind: 'poke', workitemId });
    }
    if (postCommit.length > 0) {
      this.deps.postCommit?.(postCommit);
    }
  }

  // All audit events appended *after* the triggering event within the same apply
  // must allocate their seq fresh — never `event.seq + 1` — so that multiple
  // container/type writes in one transaction (phase_changed, retry_exhausted,
  // thrash_escalated, wait_resolved, …) cannot collide on UNIQUE(workitem_id, seq)
  // and roll the whole apply back into a persisted poison state (v4 #1).
  private appendAudit(workitemId: string, kind: string, payload: unknown): number {
    return this.deps.store.appendEvent(
      workitemId,
      this.deps.store.nextSeq(workitemId),
      kind,
      payload,
    );
  }

  private applyTransitionWrites(item: WorkItem, seq: number, transition: Transition): void {
    const now = this.deps.clock.now();
    if (transition.phase) {
      const from = this.deps.store.getWorkItem(item.id)?.phase ?? item.phase;
      this.deps.store.updateWorkItem(item.id, {
        phase: transition.phase.to,
        updatedAt: now,
      });
      this.appendAudit(item.id, 'phase_changed', {
        from,
        to: transition.phase.to,
        reason: transition.phase.reason,
      });
    }
    if (transition.terminal) {
      this.deps.store.updateWorkItem(item.id, {
        status: transition.terminal,
        statusDetail: null,
        updatedAt: now,
      });
      // Consume leftover open waits / running assignments at the source so the
      // watchdog never sees a terminal item with an unresolved wait or running
      // assignment (v4 #3: otherwise it re-enqueues timer_fired/agent_stalled every
      // tick and the reducer's terminal short-circuit only appends audit forever).
      this.finalizeTerminalState(item, now);
      // A terminal transition is mutually exclusive with new work: a done/failed
      // item must never spawn dispatch/waits/effects — that would resurrect a zombie
      // run (drainOne/recovery would pick it up) and feed the watchdog's terminal
      // event loop. Drop + audit rather than silently honoring the contradiction
      // (v4 #4). A phase change alongside terminal is still allowed.
      const droppedDispatch = transition.dispatch?.length ?? 0;
      const droppedWaits = transition.waits?.length ?? 0;
      const droppedEffects = transition.effects?.length ?? 0;
      if (droppedDispatch || droppedWaits || droppedEffects) {
        this.deps.logger?.warn?.(
          { workitemId: item.id, terminal: transition.terminal },
          'dropped dispatch/waits/effects declared alongside a terminal transition',
        );
        this.appendAudit(item.id, 'terminal_work_dropped', {
          terminal: transition.terminal,
          dispatch: droppedDispatch,
          waits: droppedWaits,
          effects: droppedEffects,
        });
      }
      return;
    }
    for (const spec of transition.dispatch ?? []) {
      this.insertDispatchOrWake(item, seq, spec, now);
    }
    for (const spec of transition.waits ?? []) {
      validateWaitSpec(spec, this.deps.store);
      const wait: Wait = {
        id: `wt-${randomUUID()}`,
        workitemId: item.id,
        kind: spec.kind,
        originAssignmentId: spec.originAssignmentId ?? null,
        reason: spec.reason,
        deadlineAt: now + spec.deadlineTtlSec * 1000,
        renewedCount: 0,
        remindedAt: null,
        resolvedAt: null,
        resolvedBy: null,
        resolveReason: null,
        createdAt: now,
      };
      this.deps.store.insertWait(wait);
    }
    for (const effect of transition.effects ?? []) {
      this.deps.store.insertEffect({
        workitemId: item.id,
        seq,
        kind: effect.kind,
        payload: effect.payload ?? null,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  private finalizeTerminalState(item: WorkItem, now: number): void {
    let cleaned = 0;
    for (const wait of this.deps.store.listOpenWaits(item.id)) {
      this.deps.store.updateWait(wait.id, {
        resolvedAt: now,
        resolvedBy: 'container',
        resolveReason: 'workitem_terminal',
      });
      cleaned += 1;
    }
    for (const assignment of this.deps.store.listAssignments(item.id)) {
      if (assignment.status === 'running') {
        this.deps.store.updateAssignment(assignment.id, { status: 'superseded', endedAt: now });
        cleaned += 1;
      }
    }
    if (cleaned > 0) {
      this.appendAudit(item.id, 'terminal_cleanup', { resolved: cleaned });
    }
  }

  private containerTransition(
    event: WorkItemEvent,
    now: number,
    postCommit: PostCommitAction[],
  ): Transition {
    if (!isObject(event.payload)) return {};

    if (event.kind === 'wait_reminder') {
      const waitId = typeof event.payload.waitId === 'string' ? event.payload.waitId : undefined;
      const wait = waitId ? this.deps.store.getWait(waitId) : undefined;
      if (wait && wait.resolvedAt === null && wait.remindedAt === null) {
        this.deps.store.updateWait(wait.id, { remindedAt: now });
      }
      return {};
    }

    if (event.kind === 'timer_fired') {
      const waitId = typeof event.payload.waitId === 'string' ? event.payload.waitId : undefined;
      const wait = waitId ? this.deps.store.getWait(waitId) : undefined;
      if (wait && wait.kind === 'timer' && wait.resolvedAt === null) {
        this.deps.store.updateWait(wait.id, {
          resolvedAt: now,
          resolvedBy: 'container',
          resolveReason: 'timer_fired',
        });
      }
      return {};
    }

    if (event.kind === 'wait_resolved') {
      this.applyWaitResolved(event, now);
      return {};
    }

    if (event.kind === 'wait_renewed') {
      this.applyWaitRenewed(event);
      return {};
    }

    if (event.kind === 'assignment_stalled') {
      return this.handleStalledAssignment(event, now, postCommit);
    }

    if (event.kind !== 'effect_aborted') return {};

    const assignmentId =
      typeof event.payload.assignmentId === 'string' ? event.payload.assignmentId : undefined;
    if (!assignmentId) return {};

    const assignment = this.deps.store.getAssignment(assignmentId);
    if (assignment?.status !== 'running') return {};

    const reason = typeof event.payload.reason === 'string' ? event.payload.reason : 'aborted';
    return this.redispatchOrEscalate(assignment, now, reason);
  }

  private applyWaitResolved(event: WorkItemEvent, now: number): void {
    if (!isObject(event.payload)) return;

    const waitId = typeof event.payload.waitId === 'string' ? event.payload.waitId : undefined;
    const operator =
      typeof event.payload.operator === 'string' ? event.payload.operator : 'unknown';
    const reason = typeof event.payload.reason === 'string' ? event.payload.reason : 'unknown';
    const wait = waitId ? this.deps.store.getWait(waitId) : undefined;
    if (!wait || wait.kind === 'timer' || wait.resolvedAt !== null) return;

    this.deps.store.updateWait(wait.id, {
      resolvedAt: now,
      resolvedBy: operator,
      resolveReason: reason,
    });
  }

  private applyWaitRenewed(event: WorkItemEvent): void {
    if (!isObject(event.payload)) return;

    const waitId = typeof event.payload.waitId === 'string' ? event.payload.waitId : undefined;
    const newDeadlineAt =
      typeof event.payload.newDeadlineAt === 'number' ? event.payload.newDeadlineAt : undefined;
    const wait = waitId ? this.deps.store.getWait(waitId) : undefined;
    if (wait?.kind !== 'human' || wait.resolvedAt !== null) return;
    assertPositiveFinite(newDeadlineAt, 'newDeadlineAt');

    this.deps.store.renewWaitDeadline(wait.id, {
      deadlineAt: newDeadlineAt,
      renewedCount: wait.renewedCount + 1,
      remindedAt: null,
    });
  }

  private handleStalledAssignment(
    event: WorkItemEvent,
    now: number,
    postCommit: PostCommitAction[],
  ): Transition {
    if (!isObject(event.payload)) return {};

    const waitId = typeof event.payload.waitId === 'string' ? event.payload.waitId : undefined;
    const reason = typeof event.payload.reason === 'string' ? event.payload.reason : 'stalled';
    const assignmentId =
      typeof event.payload.assignmentId === 'string' ? event.payload.assignmentId : undefined;
    const assignment = assignmentId ? this.deps.store.getAssignment(assignmentId) : undefined;

    let transition: Transition = {};
    if (assignment?.status === 'running') {
      const runEffect = this.findInflightRunEffectForAssignment(
        assignment.workitemId,
        assignment.id,
      );
      if (runEffect) {
        postCommit.push({ kind: 'abort_effect', effectId: runEffect.id, reason });
      }
      transition = this.redispatchOrEscalate(assignment, now, reason);
    }

    // The wait's mission ended either way: the origin was already terminal, or the
    // stalled handling above just terminal-ized it (superseded/failed).
    if (waitId && reason === 'agent_wait_expired') {
      this.resolveOriginTerminalWait(waitId, now);
    }
    return transition;
  }

  private redispatchOrEscalate(assignment: Assignment, now: number, reason: string): Transition {
    if (assignment.retries >= this.deps.cfg.retryBudget) {
      this.deps.store.updateAssignment(assignment.id, {
        status: 'failed',
        endedAt: now,
      });
      this.appendAudit(assignment.workitemId, 'assignment_retry_exhausted', {
        assignmentId: assignment.id,
        reason,
      });
      return {
        waits: [
          {
            kind: 'human',
            reason: 'retry_exhausted',
            deadlineTtlSec: this.deps.cfg.humanWaitTtlSec,
            originAssignmentId: assignment.id,
          },
        ],
      };
    }

    this.deps.store.updateAssignment(assignment.id, {
      status: 'superseded',
      endedAt: now,
    });
    return {
      dispatch: [
        {
          role: assignment.role,
          repo: assignment.repo ?? undefined,
          // The replacement gets the original TTL re-counted from now — inheriting
          // the remaining time would hand a deadline_exceeded retry a ~1s deadline.
          deadlineTtlSec: originalDeadlineTtlSec(assignment),
          wallclockCapSec: assignment.wallclockCapSec,
          replacesAssignmentId: assignment.id,
          retries: assignment.retries + 1,
        },
      ],
    };
  }

  private resolveOriginTerminalWait(waitId: string, now: number): void {
    const wait = this.deps.store.getWait(waitId);
    if (!wait || wait.resolvedAt !== null) return;
    if (wait.kind !== 'agent' || !wait.originAssignmentId) return;

    const origin = this.deps.store.getAssignment(wait.originAssignmentId);
    if (
      origin?.status !== 'done' &&
      origin?.status !== 'failed' &&
      origin?.status !== 'superseded' &&
      origin?.status !== 'cancelled'
    ) {
      return;
    }

    this.deps.store.updateWait(wait.id, {
      resolvedAt: now,
      resolvedBy: 'container',
      resolveReason: 'origin_terminal',
    });
    this.appendAudit(wait.workitemId, 'wait_resolved', {
      waitId: wait.id,
      reason: 'origin_terminal',
      resolvedBy: 'container',
    });
  }

  private insertDispatchOrWake(
    item: WorkItem,
    seq: number,
    spec: NonNullable<Transition['dispatch']>[number],
    now: number,
  ): void {
    validateAssignmentSpec(spec);
    // Re-read status: a run conclusion can terminal-ize the item and still reach
    // releaseWakePending in the same apply — a terminal item must never receive a
    // fresh dispatch (v4 #4). This is the single chokepoint for every dispatch path.
    const current = this.deps.store.getWorkItem(item.id);
    if (current && isTerminalStatus(current.status)) {
      this.deps.logger?.warn?.({ workitemId: item.id }, 'skipped dispatch on terminal workitem');
      return;
    }
    if (
      !spec.replacesAssignmentId &&
      this.isRunClass('run') &&
      this.hasInflightRunEffect(item.id)
    ) {
      this.deps.store.updateWorkItem(item.id, { wakePending: true, updatedAt: now });
      return;
    }

    const assignmentId = `as-${randomUUID()}`;
    const assignment: Assignment = {
      id: assignmentId,
      workitemId: item.id,
      parentId: null,
      repo: spec.repo ?? null,
      role: spec.role,
      status: 'running',
      agentSessionId: null,
      replacesAssignmentId: spec.replacesAssignmentId ?? null,
      deadlineAt: now + spec.deadlineTtlSec * 1000,
      wallclockCapSec: spec.wallclockCapSec,
      retries: spec.retries ?? 0,
      basedOnSeq: seq,
      briefPath: spec.brief ? `assignments/${assignmentId}/brief.md` : null,
      reportPath: null,
      createdAt: now,
      startedAt: now,
      endedAt: null,
    };
    this.deps.store.insertAssignment(assignment);
    this.deps.store.insertEffect({
      workitemId: item.id,
      seq,
      kind: 'run',
      payload: { ...(isObject(spec.payload) ? spec.payload : {}), assignmentId },
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    } satisfies Omit<Effect, 'id'>);
    this.pokeNeeded = true;
  }

  private releaseWakePending(item: WorkItem, seq: number, now: number): void {
    this.deps.store.updateWorkItem(item.id, { wakePending: false, updatedAt: now });
    if (this.hasInflightRunEffect(item.id)) return;
    this.insertDispatchOrWake(item, seq, this.defaultDispatchSpec(), now);
  }

  private handleDiscardedDecision(
    item: WorkItem,
    seq: number,
    check: Extract<DecisionCheck, { ok: false }>,
    now: number,
  ): void {
    if (check.reason === 'effect_aborted') return;

    const streak = item.discardStreak + 1;
    if (streak >= 2) {
      const waitId = `wt-${randomUUID()}`;
      this.appendAudit(item.id, 'thrash_escalated', { streak, waitId });
      this.deps.store.insertWait({
        id: waitId,
        workitemId: item.id,
        kind: 'human',
        originAssignmentId: check.assignmentId ?? null,
        reason: 'thrash',
        deadlineAt: now + this.deps.cfg.humanWaitTtlSec * 1000,
        renewedCount: 0,
        remindedAt: null,
        resolvedAt: null,
        resolvedBy: null,
        resolveReason: null,
        createdAt: now,
      });
      this.deps.store.updateWorkItem(item.id, {
        discardStreak: 0,
        wakePending: false,
        updatedAt: now,
      });
      return;
    }

    this.deps.store.updateWorkItem(item.id, {
      discardStreak: streak,
      wakePending: false,
      updatedAt: now,
    });
    this.insertDispatchOrWake(item, seq, this.defaultDispatchSpec(), now);
  }

  private closeRunConclusion(kind: string, payload: unknown, now: number): void {
    if (!isObject(payload)) return;

    const effectId = typeof payload.effectId === 'number' ? payload.effectId : undefined;
    if (effectId !== undefined) {
      const effect = this.deps.store.getEffect(effectId);
      if (effect?.status !== 'aborted') {
        this.deps.store.setEffectStatus(effectId, kind === 'run_failed' ? 'aborted' : 'done');
      }
    }

    const assignmentId =
      typeof payload.assignmentId === 'string' ? payload.assignmentId : undefined;
    if (assignmentId !== undefined) {
      const reportPath =
        kind === 'run_completed' && typeof payload.reportPath === 'string'
          ? payload.reportPath
          : undefined;
      this.deps.store.updateAssignment(assignmentId, {
        status: kind === 'run_failed' ? 'failed' : 'done',
        endedAt: now,
        ...(reportPath === undefined ? {} : { reportPath }),
      });
    }
  }

  private checkDecision(
    workitemId: string,
    payload: unknown,
    type: WorkType,
    currentSeq: number,
  ): DecisionCheck {
    const details = conclusionDetails(payload);
    const structural = this.structuralCheck(details);
    if (!structural.ok) return structural;

    const eventsSince = this.deps.store.eventsSince(workitemId, details.basedOnSeq, currentSeq);
    if (type.isDecisionStale(details.decision, eventsSince)) {
      return { ...details, ok: false, reason: 'semantically_stale' };
    }
    return { ...details, ok: true };
  }

  private structuralCheck(details: ConclusionDetails): DecisionCheck {
    const effect =
      details.effectId === undefined ? undefined : this.deps.store.getEffect(details.effectId);
    if (effect?.status === 'aborted') {
      return { ...details, ok: false, reason: 'effect_aborted' };
    }

    const assignmentIds = [
      ...(details.assignmentId === undefined ? [] : [details.assignmentId]),
      ...(details.decision.refs?.assignmentIds ?? []),
    ];
    for (const assignmentId of assignmentIds) {
      const assignment = this.deps.store.getAssignment(assignmentId);
      if (!assignment) continue;
      if (assignment.status === 'superseded') {
        return { ...details, ok: false, reason: 'assignment_superseded', assignmentId };
      }
      if (
        assignmentId !== details.assignmentId &&
        (assignment.status === 'done' ||
          assignment.status === 'failed' ||
          assignment.status === 'cancelled')
      ) {
        return { ...details, ok: false, reason: 'assignment_terminal', assignmentId };
      }
    }

    for (const waitId of details.decision.refs?.waitIds ?? []) {
      const wait = this.deps.store.getWait(waitId);
      if (wait?.resolvedAt !== null && wait?.resolvedAt !== undefined) {
        return { ...details, ok: false, reason: 'wait_resolved', waitId };
      }
    }

    return { ...details, ok: true };
  }

  private closeDiscardedAssignment(payload: unknown, reason: DiscardReason, now: number): void {
    // effect_aborted discards are owned by the stalled/abort pipeline, which has
    // already terminal-ized the assignment (or deliberately left it alone).
    if (reason === 'effect_aborted') return;

    const originId = conclusionDetails(payload).assignmentId;
    if (originId === undefined) return;

    const origin = this.deps.store.getAssignment(originId);
    if (origin?.status !== 'running') return;
    this.deps.store.updateAssignment(originId, { status: 'superseded', endedAt: now });
  }

  private finalizeDiscardedEffect(check: DecisionCheck): void {
    if (check.ok || check.reason === 'effect_aborted' || check.effectId === undefined) return;

    const effect = this.deps.store.getEffect(check.effectId);
    if (effect?.status === 'pending' || effect?.status === 'running') {
      this.deps.store.setEffectStatus(check.effectId, 'done');
    }
  }

  private hasInflightRunEffect(workitemId: string): boolean {
    return this.deps.store
      .listInflightEffects(workitemId)
      .some((effect) => this.isRunClass(effect.kind));
  }

  private findInflightRunEffectForAssignment(
    workitemId: string,
    assignmentId: string,
  ): Effect | undefined {
    return this.deps.store.listInflightEffects(workitemId).find((effect) => {
      if (!this.isRunClass(effect.kind) || !isObject(effect.payload)) return false;
      return effect.payload.assignmentId === assignmentId;
    });
  }

  private isRunClass(kind: string): boolean {
    return this.deps.isRunClass?.(kind) ?? kind === 'run';
  }

  private defaultDispatchSpec(): NonNullable<Transition['dispatch']>[number] {
    return {
      role: 'solo',
      deadlineTtlSec: this.deps.cfg.defaultDeadlineTtlSec,
      wallclockCapSec: this.deps.cfg.defaultWallclockCapSec,
    };
  }
}

type DiscardReason =
  | 'assignment_superseded'
  | 'assignment_terminal'
  | 'wait_resolved'
  | 'semantically_stale'
  | 'effect_aborted';

interface ConclusionDetails {
  assignmentId?: string;
  effectId?: number;
  basedOnSeq: number;
  decision: Decision;
}

type DecisionCheck =
  | (ConclusionDetails & { ok: true })
  | (ConclusionDetails & {
      ok: false;
      reason: DiscardReason;
      assignmentId?: string;
      waitId?: string;
    });

function isSqliteConstraint(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    String((err as { code: unknown }).code).startsWith('SQLITE_CONSTRAINT')
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTerminalStatus(status: WorkItemStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

function isRunConclusion(kind: string): boolean {
  return kind === 'run_completed' || kind === 'run_failed';
}

function mergeTransitions(container: Transition, type: Transition): Transition {
  return {
    phase: type.phase,
    terminal: type.terminal,
    dispatch: [...(container.dispatch ?? []), ...(type.dispatch ?? [])],
    waits: [...(container.waits ?? []), ...(type.waits ?? [])],
    effects: [...(container.effects ?? []), ...(type.effects ?? [])],
  };
}

function validateAssignmentSpec(spec: NonNullable<Transition['dispatch']>[number]): void {
  assertPositiveFinite(spec.deadlineTtlSec, 'deadlineTtlSec');
  assertPositiveFinite(spec.wallclockCapSec, 'wallclockCapSec');
}

function validateWaitSpec(
  spec: NonNullable<Transition['waits']>[number],
  store: WorkitemsStore,
): void {
  if (spec.kind !== 'human' && spec.kind !== 'agent' && spec.kind !== 'timer') {
    throw new Error(`Invalid wait kind: ${String(spec.kind)}`);
  }
  assertPositiveFinite(spec.deadlineTtlSec, 'deadlineTtlSec');
  if (spec.kind === 'agent') {
    if (!spec.originAssignmentId || !store.getAssignment(spec.originAssignmentId)) {
      throw new Error('agent wait requires an existing originAssignmentId');
    }
  }
}

function originalDeadlineTtlSec(assignment: Assignment): number {
  // deadline_at is always derived as created_at + ttl*1000 at insert time, so the
  // original TTL can be recovered without persisting a separate column.
  return Math.max(1, Math.round((assignment.deadlineAt - assignment.createdAt) / 1000));
}

function assertPositiveFinite(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function conclusionDetails(payload: unknown): ConclusionDetails {
  if (!isObject(payload)) {
    return { basedOnSeq: 0, decision: {} };
  }

  const decision = isObject(payload.decision) ? (payload.decision as Decision) : {};
  return {
    assignmentId: typeof payload.assignmentId === 'string' ? payload.assignmentId : undefined,
    effectId: typeof payload.effectId === 'number' ? payload.effectId : undefined,
    basedOnSeq: typeof payload.basedOnSeq === 'number' ? payload.basedOnSeq : 0,
    decision,
  };
}

function discardPayload(check: Extract<DecisionCheck, { ok: false }>): Record<string, unknown> {
  return {
    reason: check.reason,
    assignmentId: check.assignmentId,
    waitId: check.waitId,
    effectId: check.effectId,
    basedOnSeq: check.basedOnSeq,
  };
}
