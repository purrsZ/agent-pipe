import type { WorkitemsConfig } from './config.js';
import type { ReducerRuntime } from './reducer.js';
import type { WorkTypeRegistry } from './registry.js';
import { humanDeclinedSince, type LoggerLike } from './shared.js';
import type { WorkitemsStore } from './store.js';
import type { Clock, Delegation } from './types.js';

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
  // DELEGATE D1.3 节流：waitId → 上次「到点深检查」的时刻（enqueue 成功或被深检查拦下都算）。深检查与
  // 重发都以 delegationDelaySec 为窗口，而非每 tick（事件流与查询都不被灌爆）；enqueue 本身失败（瞬时 DB
  // 错误）不刷新，下 tick 立即重试（审查修复——原先先刷后发，一次瞬时故障白等一个窗口）。重启丢失只是
  // 提早重扫一次，消费方幂等无害。wait 关闭后条目随 tick 清扫。
  private readonly delegationNotified = new Map<string, number>();

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
    const openHumanWaitIds = new Set<string>();

    for (const wait of this.deps.store.listOpenWaits()) {
      // WS-3: human wait 提醒不再看 deadline——系统在等人时必须会催。首催在 createdAt +
      // waitRemindAfterSec（默认 4h），之后每 waitRemindRepeatSec（默认 24h）复催。applyWaitReminder
      // 每次都刷新 remindedAt，故 due 随之滚动；deadline 过期自然被复催窗口覆盖（不再单独处理）。
      if (wait.kind === 'human') {
        openHumanWaitIds.add(wait.id);
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
        // DELEGATE D1.3：委托到点扫描（与催办同一循环，二者独立——催办照常）。纯机械判定：有生效授权行
        // ∧ wait.reason ∈ 授权行的 reasons 字符串列表（opaque 逐字节匹配，零语义）∧ wait 年龄 ≥ 冷静期
        // → enqueue 中性事件 delegation_due。业务判断（guard/白名单）全在桥层消费方。
        this.scanDelegation(wait, now);
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

    // 已关闭/消失的 wait 的节流条目清扫（与 livenessViolations 的 O1 清扫同理，防慢性泄漏）。
    for (const id of [...this.delegationNotified.keys()]) {
      if (!openHumanWaitIds.has(id)) this.delegationNotified.delete(id);
    }

    this.scanLiveness(now);
  }

  // DELEGATE D1.3：单条 human wait 的委托到点判定。首发 due = max(wait 挂起, 授权下达) + delegationDelaySec
  // （冷静期，D-3：灯卡先发、人在场可抢先手动——审查修复：原先只锚 wait.createdAt，灯先亮、人睡前才
  // /delegate 时下一 tick 即秒过，承诺的反悔窗口为零）；之后每 delegationDelaySec 重扫一次（节流，消费
  // 失败自愈）。到点后过一遍深检查（delegationBlocked），任一不过 → 刷新节流静默跳过，下窗口再看（局面
  // 可能已变）；全过才 enqueue 中性事件 delegation_due，业务收尾在桥层消费方。
  private scanDelegation(
    wait: { id: string; workitemId: string; reason: string; createdAt: number },
    now: number,
  ): void {
    const grant = this.deps.store.activeDelegation(wait.workitemId, now);
    if (!grant?.reasons.includes(wait.reason)) return;
    const last = this.delegationNotified.get(wait.id);
    const due =
      (last ?? Math.max(wait.createdAt, grant.createdAt)) + this.deps.cfg.delegationDelaySec * 1000;
    if (now < due) return;
    if (this.delegationBlocked(wait, grant)) {
      this.delegationNotified.set(wait.id, now);
      return;
    }
    if (
      this.safeEnqueue(wait.workitemId, { kind: 'delegation_due', payload: { waitId: wait.id } })
    ) {
      this.delegationNotified.set(wait.id, now);
    }
  }

  // 委托到点的深检查（每 delegationDelaySec 窗口一次，不进 1Hz 热路径）。三条都是机械判定，不解释业务语义：
  private delegationBlocked(
    wait: { id: string; workitemId: string; reason: string },
    grant: Delegation,
  ): boolean {
    // (a) 同单还有授权未覆盖的 open human wait（取消确认/病历/判大…）→ 人有未决事项，预授权不覆盖当下
    // 局面，先不自动过（审查修复——原先自动关单会把进行中的 /cancel 确认与未处理病历随终态静默埋掉）。
    // reason 匹配同 grant.reasons 的 opaque 逐字节比较。
    const others = this.deps.store
      .listOpenWaits(wait.workitemId)
      .some((o) => o.kind === 'human' && o.id !== wait.id && !grant.reasons.includes(o.reason));
    if (others) return true;
    const events = this.deps.store.listEvents(wait.workitemId);
    // (b) 授权之后人显式打回过同名 wait → 人的更晚决定优先，该 reason 在本次授权内不再自动过（审查修复——
    // 原先「暂不关单」10 分钟后被系统整单 done 推翻）。重新 /delegate 即重置（grant.createdAt 更新）。
    if (
      humanDeclinedSince(events, wait.reason, grant.createdAt, (id) => this.deps.store.getWait(id))
    )
      return true;
    // (c) worktype 业务 guard（机器信号）不过 → 不 enqueue（审查修复——原先永拦的灯③事件每窗口重发，
    // 整夜空转刷锚点卡）。容器调 worktype 方法不算解释业务语义（先例 liveness()）。缺省恒放行，桥层兜底。
    const item = this.deps.store.getWorkItem(wait.workitemId);
    const type = item ? this.deps.registry.get(item.type) : undefined;
    if (type?.delegationGuard && !type.delegationGuard(wait.reason, events)) return true;
    return false;
  }

  // WS-1.2 活性不变式看门（D-D）：把「漏一个事件×相位分支 = 静默卡死」整类 bug 从真机暴露变成系统自曝。
  // 对每个 must-progress 单，若持续「无 running assignment ∧ 无 pending/running effect ∧ 无 open wait」
  // ≥ livenessGraceSec，enqueue liveness_stalled 让 worktype 自处理（requirement：raise stalled_no_path
  // 病历）。防抖 Map 记首次违反时刻，恢复正常即清除。注意 wakePending 不算活路——owner-workers 停在
  // wakePending 且无 running/effect/wait 就是死状态（WS-1.4 补派修好后有 parked 行也会被补派掉）。
  private scanLiveness(now: number): void {
    const items = this.deps.store.listNonTerminal();
    // O1：终态单不再出现在 listNonTerminal，其防抖条目再也走不到下面的 delete → 每轮按本轮存活集合清扫
    // 一次陈旧 key（微量内存，无正确性影响，但顺手清干净）。
    const liveIds = new Set(items.map((i) => i.id));
    for (const id of [...this.livenessViolations.keys()]) {
      if (!liveIds.has(id)) this.livenessViolations.delete(id);
    }
    for (const item of items) {
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
  // workitem: log and move on, leaving the rest of the sweep intact. Returns
  // whether the enqueue committed (delegation throttling only refreshes on success).
  private safeEnqueue(workitemId: string, event: { kind: string; payload?: unknown }): boolean {
    try {
      this.deps.reducer.enqueue(workitemId, event);
      return true;
    } catch (err) {
      this.deps.logger?.error?.({ err, workitemId, kind: event.kind }, 'watchdog enqueue failed');
      return false;
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
