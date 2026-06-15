import type { WorkitemsConfig } from './config.js';
import type { Clock } from './types.js';
import type { ReducerRuntime } from './reducer.js';
import type { WorkitemsStore } from './store.js';

type LoggerLike = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

type BeatSource = {
  lastBeat(assignmentId: string): number | undefined;
};

export interface WatchdogDeps {
  store: WorkitemsStore;
  reducer: ReducerRuntime;
  effects: BeatSource;
  clock: Clock;
  logger?: LoggerLike;
  cfg: WorkitemsConfig;
}

type StalledReason =
  | 'agent_wait_expired'
  | 'heartbeat_silent'
  | 'wallclock_exceeded'
  | 'deadline_exceeded';

interface StalledCandidate {
  workitemId: string;
  assignmentId: string;
  reason: StalledReason;
  priority: number;
  waitId?: string;
}

export class Watchdog {
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: WatchdogDeps) {}

  tick(): void {
    const now = this.deps.clock.now();
    const stalled = new Map<string, StalledCandidate>();

    for (const wait of this.deps.store.listOpenWaits()) {
      if (wait.deadlineAt > now) continue;

      if (wait.kind === 'human') {
        if (wait.remindedAt === null) {
          this.safeEnqueue(wait.workitemId, {
            kind: 'wait_reminder',
            payload: { waitId: wait.id },
          });
        }
        continue;
      }

      if (wait.kind === 'timer') {
        this.safeEnqueue(wait.workitemId, {
          kind: 'timer_fired',
          payload: { waitId: wait.id },
        });
        continue;
      }

      if (wait.originAssignmentId) {
        const assignment = this.deps.store.getAssignment(wait.originAssignmentId);
        // Emit even when the origin is no longer running: the reducer's stalled
        // handling is idempotent and must still resolve the expired wait (ADR-8),
        // otherwise it dangles forever and the workitem stays waiting(agent).
        if (assignment) {
          setCandidate(stalled, {
            workitemId: assignment.workitemId,
            assignmentId: assignment.id,
            reason: 'agent_wait_expired',
            priority: 1,
            waitId: wait.id,
          });
        }
      }
    }

    for (const assignment of this.deps.store.listRunningAssignments()) {
      const startedAt = assignment.startedAt ?? assignment.createdAt;
      const beat = this.deps.effects.lastBeat(assignment.id) ?? startedAt;

      if (now - startedAt >= assignment.wallclockCapSec * 1000) {
        setCandidate(stalled, {
          workitemId: assignment.workitemId,
          assignmentId: assignment.id,
          reason: 'wallclock_exceeded',
          priority: 4,
        });
      } else if (now - beat >= this.deps.cfg.heartbeatTimeoutSec * 1000) {
        setCandidate(stalled, {
          workitemId: assignment.workitemId,
          assignmentId: assignment.id,
          reason: 'heartbeat_silent',
          priority: 3,
        });
      } else if (now >= assignment.deadlineAt) {
        setCandidate(stalled, {
          workitemId: assignment.workitemId,
          assignmentId: assignment.id,
          reason: 'deadline_exceeded',
          priority: 2,
        });
      }
    }

    for (const candidate of stalled.values()) {
      this.safeEnqueue(candidate.workitemId, {
        kind: 'assignment_stalled',
        payload: {
          assignmentId: candidate.assignmentId,
          reason: candidate.reason,
          ...(candidate.waitId === undefined ? {} : { waitId: candidate.waitId }),
        },
      });
    }
  }

  // A single poisoned workitem (constraint clash, handler throw, SQLITE_FULL, …)
  // must never crash the 1Hz tick — that would take the whole bridge down and
  // re-trigger from the same persisted state on every restart. Isolate per
  // workitem: log and move on, leaving the rest of the sweep intact.
  private safeEnqueue(workitemId: string, event: { kind: string; payload?: unknown }): void {
    try {
      this.deps.reducer.enqueue(workitemId, event);
    } catch (err) {
      this.deps.logger?.error?.({ err, workitemId, kind: event.kind }, 'watchdog enqueue failed');
    }
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), this.deps.cfg.watchdogIntervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = undefined;
  }
}

function setCandidate(
  candidates: Map<string, StalledCandidate>,
  candidate: StalledCandidate,
): void {
  const existing = candidates.get(candidate.assignmentId);
  if (!existing || candidate.priority > existing.priority) {
    candidates.set(candidate.assignmentId, candidate);
  }
}
