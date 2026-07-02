import type { Logger } from '../logger.js';
import type { AgentKind, Store, Task } from '../store.js';
import {
  type AgentFactory,
  type ProgressCallbacks,
  type RunOptions,
  type Runner,
  type TurnResult,
  runOptionsFingerprint,
} from './types.js';

export type RunPriority = 'high' | 'normal';

export interface AgentPoolConfig {
  maxHot: number;
  // WI-C: global cap on concurrent runTurns. Defaults to maxHot, clamped ≤ maxHot
  // (more in-flight than hot slots would re-introduce "over hot cap").
  maxConcurrent?: number;
  // R07/D-18: slots that low-priority (worker) runs may not occupy, so a high-priority
  // (owner) run is never starved at the back of the FIFO. Default 0 ⇒ pure FIFO, the
  // bridge path is byte-for-byte unchanged. Clamped to ≤ cap-1 so the pool can't deadlock.
  reservedHighPrioritySlots?: number;
}

// WI-C: global concurrency gate. Bounds how many runTurns run at once; excess send()
// calls queue and resume as slots free. The slot is held across runTurn and released in
// finally (§2.1). R07: priority-aware — high-priority waiters are served before normal
// ones, and `reserved` slots are off-limits to normal runs so a high-priority run always
// has somewhere to land (no preemption needed; deadlock-free because owner→worker dispatch
// does not acquire inside the owner run — D-18).
class Semaphore {
  private active = 0;
  private lowActive = 0;
  private readonly highWaiters: Array<() => void> = [];
  private readonly lowWaiters: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly reserved = 0,
  ) {}

  private lowCap(): number {
    return Math.max(0, this.max - this.reserved);
  }

  tryAcquire(high = false): boolean {
    if (high) {
      if (this.active < this.max) {
        this.active++;
        return true;
      }
      return false;
    }
    if (this.active < this.max && this.lowActive < this.lowCap()) {
      this.active++;
      this.lowActive++;
      return true;
    }
    return false;
  }

  acquire(high = false): Promise<void> {
    if (this.tryAcquire(high)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      (high ? this.highWaiters : this.lowWaiters).push(resolve);
    });
  }

  release(high = false): void {
    this.active = Math.max(0, this.active - 1);
    if (!high) this.lowActive = Math.max(0, this.lowActive - 1);
    this.pump();
  }

  private pump(): void {
    // High-priority first — may use any free slot up to the full cap.
    while (this.active < this.max && this.highWaiters.length > 0) {
      const next = this.highWaiters.shift();
      if (!next) break;
      this.active++;
      next();
    }
    // Then normal — bounded by both the full cap and the reduced low cap.
    while (this.active < this.max && this.lowActive < this.lowCap() && this.lowWaiters.length > 0) {
      const next = this.lowWaiters.shift();
      if (!next) break;
      this.active++;
      this.lowActive++;
      next();
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.highWaiters.length + this.lowWaiters.length;
  }
}

export class AgentPool {
  private runners = new Map<string, Runner>();
  // WI-A: last per-run options fingerprint per task — a change forces a rebuild (§2.1).
  private fingerprints = new Map<string, string>();
  // WI-C: global concurrency gate (≤ maxHot).
  private readonly slots: Semaphore;

  constructor(
    private factories: Record<AgentKind, AgentFactory>,
    private cfg: AgentPoolConfig,
    private store: Store,
    private logger: Logger,
  ) {
    // Defense-in-depth: a non-finite / non-positive cap (e.g. a misparsed config that
    // slipped through) would make Semaphore.tryAcquire's `active < max` always false and
    // deadlock every send(). Clamp to a floor of 1 so a bad value degrades to serial
    // execution, never a permanent hang. config.ts validation is the primary guard.
    const rawCap = Math.min(cfg.maxConcurrent ?? cfg.maxHot, cfg.maxHot);
    const cap = Number.isFinite(rawCap) && rawCap >= 1 ? Math.floor(rawCap) : 1;
    // Reserve at most cap-1 slots for high priority — reserving all would starve normal
    // runs and could deadlock. Default 0 keeps the legacy pure-FIFO behaviour.
    const rawReserved = cfg.reservedHighPrioritySlots ?? 0;
    const reserved = Number.isFinite(rawReserved)
      ? Math.max(0, Math.min(Math.floor(rawReserved), cap - 1))
      : 0;
    this.slots = new Semaphore(cap, reserved);
  }

  factoryFor(kind: AgentKind): AgentFactory {
    const f = this.factories[kind];
    if (!f) throw new Error(`未配置 agent: ${kind}`);
    return f;
  }

  isBusy(taskId: string): boolean {
    return this.runners.get(taskId)?.isBusy() ?? false;
  }

  hotCount(): number {
    let n = 0;
    for (const r of this.runners.values()) if (r.isHot()) n++;
    return n;
  }

  totalRunners(): number {
    return this.runners.size;
  }

  // WI-C: /diag-slots observability.
  activeRuns(): number {
    return this.slots.activeCount;
  }

  queuedRuns(): number {
    return this.slots.queuedCount;
  }

  async send(
    task: Task,
    text: string,
    callbacks?: ProgressCallbacks,
    options?: RunOptions,
    onQueued?: () => void,
    // R07/D-18: 'high' lets an owner run jump the queue + use a reserved slot. Neutral —
    // the pool never reads task.owner_kind (owner & worker are both 'managed'); the caller
    // maps its role to a priority. Default 'normal' keeps the bridge path unchanged.
    priority: RunPriority = 'normal',
  ): Promise<TurnResult> {
    // §2.1 step 1: drop the cached runner when the kind changed (/agent switch) OR the
    // per-run options fingerprint changed (WI-A) — Claude bakes its args at spawn, so a
    // changed profile/tool-set needs a fresh process. Default options collapse to ''
    // (runOptionsFingerprint), so the no-options bridge path never rebuilds (zero regression).
    const fingerprint = runOptionsFingerprint(options);
    let runner = this.runners.get(task.id);
    if (runner) {
      const kindChanged = runner.kind !== task.agent_kind;
      const optionsChanged = (this.fingerprints.get(task.id) ?? '') !== fingerprint;
      if (kindChanged || optionsChanged) {
        this.logger.info(
          { taskId: task.id, kindChanged, optionsChanged },
          'disposing runner before rebuild (kind/options changed)',
        );
        runner.dispose();
        this.runners.delete(task.id);
        runner = undefined;
      }
    }

    // §2.1 step 2 (WI-C): acquire a global slot BEFORE createRunner — otherwise N sends
    // each build a runner (mutual evict thrash) and squat a maxHot slot while waiting.
    // Full → onQueued once, then priority wait. Released in finally below.
    const high = priority === 'high';
    if (!this.slots.tryAcquire(high)) {
      onQueued?.();
      await this.slots.acquire(high);
    }
    try {
      if (!runner) {
        // Resolve the factory BEFORE evicting — a corrupt/unknown agent_kind on the
        // task row shouldn't punish a healthy hot Claude runner by booting it.
        const factory = this.factoryFor(task.agent_kind);
        if (this.hotCount() >= this.cfg.maxHot) this.evictLRU();
        runner = factory.createRunner(task, {
          store: this.store,
          logger: this.logger,
        });
        this.runners.set(task.id, runner);
      } else {
        // refresh snapshot — model/agent_kind/cwd may have changed between turns
        runner.setTask(task);
      }
      this.fingerprints.set(task.id, fingerprint);

      if (runner.isBusy()) {
        throw new Error(`任务 ${task.id} 正在处理上一条消息`);
      }
      return await runner.runTurn(text, callbacks, options);
    } finally {
      this.slots.release(high);
      // A runner that disposed/killed itself mid-turn (e.g. the D-04 fail-closed probe abort) is a
      // dead shell: not hot, so evictLRU (which only scans hot runners) never reclaims it → it would
      // linger in the map forever AND could be re-selected by a same-taskId send as a stale
      // disposed runner. Drop dead shells here so the next send rebuilds cleanly. Hot (reusable) and
      // busy runners are left untouched — zero impact on the normal hot-reuse / LRU path.
      const r = this.runners.get(task.id);
      if (r && !r.isHot() && !r.isBusy()) {
        this.runners.delete(task.id);
        this.fingerprints.delete(task.id);
      }
    }
  }

  respawn(taskId: string): boolean {
    const r = this.runners.get(taskId);
    if (!r) return false;
    this.logger.info({ taskId }, 'disposing runner (model/agent change)');
    r.dispose();
    this.runners.delete(taskId);
    this.store.setStatus(taskId, 'suspended');
    return true;
  }

  abort(taskId: string): boolean {
    const r = this.runners.get(taskId);
    if (!r) return false;
    return r.abort();
  }

  killAll(): void {
    for (const r of this.runners.values()) {
      try {
        r.dispose();
      } catch {
        /* ignore */
      }
    }
    this.runners.clear();
  }

  private evictLRU(): void {
    let victim: Runner | null = null;
    for (const r of this.runners.values()) {
      if (!r.isHot() || r.isBusy()) continue;
      if (!victim || r.lastActivity() < victim.lastActivity()) victim = r;
    }
    if (!victim) {
      const busy = Array.from(this.runners.values())
        .filter((r) => r.isHot())
        .map((r) => `${r.taskId}:${r.isBusy() ? 'busy' : 'idle'}`);
      this.logger.warn(
        { size: this.runners.size, hot: busy },
        'no idle hot runner to evict; over hot cap until one finishes',
      );
      return;
    }
    this.logger.info({ taskId: victim.taskId }, 'evicting LRU runner');
    this.store.setStatus(victim.taskId, 'suspended');
    victim.dispose();
    this.runners.delete(victim.taskId);
  }
}
