import type { WorkitemsConfig } from './config.js';
import type { ReducerRuntime } from './reducer.js';
import type { WorkTypeRegistry } from './registry.js';
import type { LoggerLike } from './shared.js';
import type { WorkitemsStore } from './store.js';
import type { Clock } from './types.js';

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
  // WS-1.2: 活性看门需按 worktype 的 liveness() 声明判定是否豁免。容器调 worktype 方法不算解释业务语义。
  registry: WorkTypeRegistry;
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
  // WS-1.2 防抖：workitemId → 首次观测到活性违反的时刻。恢复正常即删除；持续 ≥ grace 才报警。
  private readonly livenessViolations = new Map<string, number>();

  constructor(private readonly deps: WatchdogDeps) {}

  tick(): void {
    // The 1Hz sweep must never throw out of its setInterval callback — an uncaught error
    // there crashes the whole bridge and re-fires from the same persisted state on every
    // restart. Per-workitem enqueue failures are isolated by safeEnqueue; this outer
    // guard additionally contains a throwing scan query (SQLITE_BUSY, a corrupt row's
    // decode, …) so one bad read just skips this tick and retries next interval.
    try {
      this.runTick();
    } catch (err) {
      this.deps.logger?.error?.({ err }, 'watchdog tick failed (isolated, retrying next interval)');
    }
  }

  private runTick(): void {
    const now = this.deps.clock.now();
    const stalled = new Map<string, StalledCandidate>();

    for (const wait of this.deps.store.listOpenWaits()) {
      // WS-3: human wait 提醒不再看 deadline——系统在等人时必须会催。首催在 createdAt +
      // waitRemindAfterSec（默认 4h），之后每 waitRemindRepeatSec（默认 24h）复催。applyWaitReminder
      // 每次都刷新 remindedAt，故 due 随之滚动；deadline 过期自然被复催窗口覆盖（不再单独处理）。
      if (wait.kind === 'human') {
        const due =
          wait.remindedAt === null
            ? wait.createdAt + this.deps.cfg.waitRemindAfterSec * 1000
            : wait.remindedAt + this.deps.cfg.waitRemindRepeatSec * 1000;
        if (now >= due) {
          this.safeEnqueue(wait.workitemId, {
            kind: 'wait_reminder',
            payload: { waitId: wait.id },
          });
        }
        continue;
      }

      // timer/agent wait 仍按 deadline 到期触发。
      if (wait.deadlineAt > now) continue;

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

    this.scanLiveness(now);
  }

  // WS-1.2 活性不变式看门（D-D）：把「漏一个事件×相位分支 = 静默卡死」整类 bug 从真机暴露变成系统自曝。
  // 对每个 must-progress 单，若持续「无 running assignment ∧ 无 pending/running effect ∧ 无 open wait」
  // ≥ livenessGraceSec，enqueue liveness_stalled 让 worktype 自处理（requirement：raise stalled_no_path
  // 病历）。防抖 Map 记首次违反时刻，恢复正常即清除。注意 wakePending 不算活路——owner-workers 停在
  // wakePending 且无 running/effect/wait 就是死状态（WS-1.4 补派修好后有 parked 行也会被补派掉）。
  private scanLiveness(now: number): void {
    for (const item of this.deps.store.listNonTerminal()) {
      const type = this.deps.registry.get(item.type);
      if (type?.liveness?.(item) !== 'must-progress') {
        this.livenessViolations.delete(item.id);
        continue;
      }
      const alive =
        this.deps.store.listAssignments(item.id).some((a) => a.status === 'running') ||
        this.deps.store.listInflightEffects(item.id).length > 0 ||
        this.deps.store.listOpenWaits(item.id).length > 0;
      if (alive) {
        this.livenessViolations.delete(item.id);
        continue;
      }
      const firstAt = this.livenessViolations.get(item.id);
      if (firstAt === undefined) {
        this.livenessViolations.set(item.id, now);
        continue;
      }
      if (now - firstAt < this.deps.cfg.livenessGraceSec * 1000) continue;
      // 已 open 的 stalled_no_path 病历天然使 alive=true（上面已 return），故到此处必是首次报警；worktype
      // 侧再靠 openWaitReasons 幂等兜一层。报警后本 tick reducer 同步 raise 病历 → 下 tick alive → 自动清除。
      this.safeEnqueue(item.id, { kind: 'liveness_stalled', payload: {} });
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
