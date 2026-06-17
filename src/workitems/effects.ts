import type { ArtifactStore } from './artifacts.js';
import type { ReducerRuntime } from './reducer.js';
import type { WorkTypeRegistry } from './registry.js';
import { isObject, isRunConclusion, type LoggerLike } from './shared.js';
import type { WorkitemsStore } from './store.js';
import type { Assignment, Clock, Effect, WorkItem, WorkItemEvent } from './types.js';

export interface EffectHandler {
  kind: string;
  recovery: 'rerun' | 'resume-or-redispatch';
  run(ctx: EffectContext): Promise<void>;
  canResume?(payload: unknown, assignment: Assignment | undefined, workitem: WorkItem): boolean;
  resume?(ctx: EffectContext): Promise<void>;
}

export interface EffectContext {
  effect: Effect;
  workitem: WorkItem;
  assignment?: Assignment;
  signal: AbortSignal;
  clock: Clock;
  logger: LoggerLike;
  batchFromSeq: number;
  heartbeat(): void;
  eventsSince(afterSeq: number): WorkItemEvent[];
  setAgentSessionId(id: string): void;
  writeArtifact(relPath: string, content: string, message: string): void;
  readArtifact(relPath: string): string | undefined;
  emit(kind: string, payload: unknown): void;
}

export interface EffectRuntimeDeps {
  store: WorkitemsStore;
  reducer: ReducerRuntime;
  registry: WorkTypeRegistry;
  artifacts: ArtifactStore;
  clock: Clock;
  logger?: LoggerLike;
}

interface InflightEffect {
  effectId: number;
  controller: AbortController;
}

export class EffectRuntime {
  private readonly handlers = new Map<string, EffectHandler>();
  private readonly inflight = new Map<string, InflightEffect>();
  private readonly beats = new Map<string, number>();
  private intakeOpen = true;

  constructor(private readonly deps: EffectRuntimeDeps) {}

  registerHandler(handler: EffectHandler): void {
    if (this.handlers.has(handler.kind)) {
      throw new Error(`Effect handler already registered: ${handler.kind}`);
    }
    this.handlers.set(handler.kind, handler);
  }

  isRunClass(kind: string): boolean {
    return this.handlers.get(kind)?.recovery === 'resume-or-redispatch';
  }

  poke(workitemId: string): void {
    if (!this.intakeOpen || this.inflight.has(workitemId)) return;
    // drainOne is fire-and-forget; a synchronous throw (store/handler error) or a
    // rejected promise would otherwise surface as an unhandledRejection and crash
    // the process. Swallow to the log — the effect stays inflight/pending and is
    // retried on the next poke or restart.
    this.drainOne(workitemId).catch((err) => {
      this.deps.logger?.error?.({ err, workitemId }, 'effect drain failed');
    });
  }

  recoverRunning(effectId: number): void {
    const effect = this.deps.store.getEffect(effectId);
    if (effect?.status !== 'running' || this.inflight.has(effect.workitemId)) return;
    if (this.isTerminalWorkitem(effect.workitemId)) {
      this.abort(effectId, 'workitem_terminal');
      return;
    }

    const handler = this.handlers.get(effect.kind);
    if (!handler) {
      this.abort(effectId, 'missing_handler');
      return;
    }
    void this.executeEffect(effect, handler);
  }

  recoverRun(effectId: number): void {
    const effect = this.deps.store.getEffect(effectId);
    if (effect?.status !== 'running' || this.inflight.has(effect.workitemId)) return;
    if (this.isTerminalWorkitem(effect.workitemId)) {
      this.abort(effectId, 'workitem_terminal');
      return;
    }

    const handler = this.handlers.get(effect.kind);
    if (!handler) {
      this.abort(effectId, 'missing_handler');
      return;
    }

    const assignment = assignmentForEffect(this.deps.store, effect);
    // The stalled/abort pipeline may have already superseded/failed this assignment
    // (committed) while the post-commit abort_effect never ran before the crash.
    // Resuming would re-process a stall that is already handled (double wake / false
    // thrash). Abort the orphaned run instead of resuming a non-running owner (v4 #8).
    if (assignment && assignment.status !== 'running') {
      this.abort(effectId, 'assignment_not_running');
      return;
    }

    const workitem = this.deps.store.getWorkItem(effect.workitemId);
    if (workitem && handler.canResume?.(effect.payload, assignment, workitem) === true) {
      void this.executeEffect(effect, handler, (ctx) => handler.resume?.(ctx) ?? handler.run(ctx));
      return;
    }

    this.abort(effectId, 'recovery_redispatch');
  }

  lastBeat(assignmentId: string): number | undefined {
    return this.beats.get(assignmentId);
  }

  abort(effectId: number, reason: string): void {
    const effect = this.deps.store.getEffect(effectId);
    if (!effect) return;

    // Signal any in-flight handler to unwind cooperatively (idempotent).
    this.findInflight(effectId)?.controller.abort();

    // Already settled — nothing to abort; re-emitting effect_aborted would be noise.
    if (effect.status === 'done' || effect.status === 'aborted') return;

    // abort() only signals + enqueues. Flipping the effect to aborted is deferred to
    // the effect_aborted apply so that the status change, the audit event, and the
    // replacement dispatch all land in ONE transaction. The previous two-phase form
    // (standalone setEffectStatus, then a separate enqueue) left an aborted-but-
    // unaudited effect with a still-running assignment and no replacement when the
    // process died in between — recoverable only via the watchdog heartbeat (v4 #9).
    const assignment = assignmentForEffect(this.deps.store, effect);
    this.deps.reducer.enqueue(effect.workitemId, {
      kind: 'effect_aborted',
      payload: {
        effectId,
        assignmentId: assignment?.id,
        basedOnSeq: effect.seq,
        reason,
      },
    });
  }

  stopIntake(): void {
    this.intakeOpen = false;
  }

  abortInflight(): void {
    for (const entry of this.inflight.values()) {
      entry.controller.abort();
    }
  }

  private async drainOne(workitemId: string): Promise<void> {
    if (!this.intakeOpen || this.inflight.has(workitemId)) return;
    // Never run a handler for a terminal workitem — a leftover pending effect on a
    // done/failed item must not resurrect a zombie run (v4 #4). It stays parked;
    // terminal-ization (reducer) abandons such effects rather than executing them.
    if (this.isTerminalWorkitem(workitemId)) return;

    const inflightRows = this.deps.store.listInflightEffects(workitemId);
    if (inflightRows.some((effect) => effect.status === 'running')) return;

    const pending = inflightRows.find((effect) => effect.status === 'pending');
    if (!pending) return;

    const handler = this.handlers.get(pending.kind);
    if (!handler) {
      this.deps.store.setEffectStatus(pending.id, 'aborted');
      this.deps.logger?.error?.(
        { effectId: pending.id, kind: pending.kind },
        'missing effect handler',
      );
      this.poke(workitemId);
      return;
    }

    this.deps.store.setEffectStatus(pending.id, 'running');
    const effect = this.deps.store.getEffect(pending.id) ?? pending;
    await this.executeEffect(effect, handler);
  }

  private async executeEffect(
    effect: Effect,
    handler: EffectHandler,
    invoke: (ctx: EffectContext) => Promise<void> = (ctx) => handler.run(ctx),
  ): Promise<void> {
    const workitemId = effect.workitemId;
    const assignment = assignmentForEffect(this.deps.store, effect);
    const controller = new AbortController();
    this.inflight.set(workitemId, { effectId: effect.id, controller });

    try {
      await invoke(this.contextFor(effect, assignment, controller));
      if (controller.signal.aborted) return;

      if (this.isRunClass(effect.kind)) {
        const report = this.validateRunReport(effect, assignment);
        if (report.ok) {
          this.emitRunConclusion('run_completed', effect, assignment, undefined, report.reportPath);
        } else {
          this.emitRunConclusion('run_failed', effect, assignment, new Error('artifact_missing'));
        }
      } else {
        this.deps.store.setEffectStatus(effect.id, 'done');
      }
    } catch (err) {
      if (controller.signal.aborted) return;

      if (this.isRunClass(effect.kind)) {
        this.emitRunConclusion('run_failed', effect, assignment, err);
      } else {
        this.deps.store.setEffectStatus(effect.id, 'aborted');
      }
    } finally {
      this.inflight.delete(workitemId);
      // The assignment is terminal by now (conclusion emitted above, or aborted), so
      // its heartbeat entry is dead weight — drop it to keep the beats map bounded
      // across long-lived bridges and retry chains (v4 #14).
      if (assignment) this.beats.delete(assignment.id);
      // Poke even after an abort: abort() applies its decision synchronously
      // (effect_aborted + replacement rows committed) before this handler
      // unwinds, so draining the next pending cannot bypass any decision —
      // skipping it instead strands the replacement until the next restart.
      this.poke(workitemId);
    }
  }

  private contextFor(
    effect: Effect,
    assignment: Assignment | undefined,
    controller: AbortController,
  ): EffectContext {
    const workitem = this.deps.store.getWorkItem(effect.workitemId);
    if (!workitem) {
      throw new Error(`WorkItem not found for effect ${effect.id}: ${effect.workitemId}`);
    }
    const runKinds = [...this.handlers.values()]
      .filter((handler) => handler.recovery === 'resume-or-redispatch')
      .map((handler) => handler.kind);
    const batchFromSeq = this.deps.store.lastRunEffectSeqBefore(
      effect.workitemId,
      effect.id,
      runKinds,
    );

    return {
      effect,
      workitem,
      assignment,
      signal: controller.signal,
      clock: this.deps.clock,
      logger: this.deps.logger ?? {},
      batchFromSeq,
      heartbeat: () => {
        if (assignment) this.beats.set(assignment.id, this.deps.clock.now());
      },
      eventsSince: (afterSeq) =>
        this.deps.store
          .eventsSince(effect.workitemId, afterSeq)
          .filter((event) => event.seq <= effect.seq),
      setAgentSessionId: (id) => {
        if (!assignment) return;
        this.deps.store.updateAssignment(assignment.id, { agentSessionId: id });
      },
      writeArtifact: (relPath, content, message) => {
        this.deps.artifacts.writeFile(effect.workitemId, relPath, content, message);
      },
      readArtifact: (relPath) => this.deps.artifacts.readFile(effect.workitemId, relPath),
      emit: (kind, payload) => {
        if (controller.signal.aborted) return;
        // Run conclusions are the EffectRuntime's exclusive vocabulary: they alone
        // carry the report.md obligation gate (validateRunReport / emitRunConclusion).
        // No handler — run-class or not — may forge one through ctx.emit and bypass
        // that check; the only legitimate emitter is emitRunConclusion itself.
        if (isRunConclusion(kind)) return;
        this.deps.reducer.enqueue(effect.workitemId, { kind, payload });
      },
    };
  }

  private validateRunReport(
    effect: Effect,
    assignment: Assignment | undefined,
  ): { ok: true; reportPath?: string } | { ok: false } {
    const workitem = this.deps.store.getWorkItem(effect.workitemId);
    const type = workitem ? this.deps.registry.get(workitem.type) : undefined;
    if (type?.artifacts.reportRequired !== true) {
      return { ok: true };
    }
    if (!assignment) return { ok: false };

    const reportPath = `assignments/${assignment.id}/report.md`;
    const content = this.deps.artifacts.readFile(effect.workitemId, reportPath);
    if (content === undefined || content.trim().length === 0) {
      return { ok: false };
    }
    return { ok: true, reportPath };
  }

  private emitRunConclusion(
    kind: 'run_completed' | 'run_failed',
    effect: Effect,
    assignment: Assignment | undefined,
    err?: unknown,
    reportPath?: string,
  ): void {
    this.deps.reducer.enqueue(effect.workitemId, {
      kind,
      payload: {
        assignmentId: assignment?.id,
        effectId: effect.id,
        basedOnSeq: effect.seq,
        assignmentRetries: assignment?.retries ?? 0,
        ...(err === undefined ? {} : { error: errorMessage(err) }),
        ...(reportPath === undefined ? {} : { reportPath }),
      },
    });
  }

  private findInflight(effectId: number): InflightEffect | undefined {
    for (const entry of this.inflight.values()) {
      if (entry.effectId === effectId) return entry;
    }
    return undefined;
  }

  private isTerminalWorkitem(workitemId: string): boolean {
    const item = this.deps.store.getWorkItem(workitemId);
    return (
      item !== undefined &&
      (item.status === 'done' || item.status === 'failed' || item.status === 'cancelled')
    );
  }
}

function assignmentForEffect(store: WorkitemsStore, effect: Effect): Assignment | undefined {
  if (!isObject(effect.payload) || typeof effect.payload.assignmentId !== 'string') {
    return undefined;
  }
  return store.getAssignment(effect.payload.assignmentId);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
