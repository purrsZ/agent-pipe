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

export interface AgentPoolConfig {
  maxHot: number;
  // WI-C: global cap on concurrent runTurns. Defaults to maxHot, clamped ≤ maxHot
  // (more in-flight than hot slots would re-introduce "over hot cap").
  maxConcurrent?: number;
}

// WI-C: global concurrency gate. Bounds how many runTurns run at once; excess send()
// calls queue FIFO and resume in order as slots free. The slot is held across runTurn and
// released in finally (§2.1). Replaces the old "busy → spawn over maxHot" behavior.
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  tryAcquire(): boolean {
    if (this.active < this.max) {
      this.active++;
      return true;
    }
    return false;
  }

  acquire(): Promise<void> {
    if (this.tryAcquire()) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    // Hand the slot straight to the next waiter (active unchanged); only drop the count
    // when nobody is queued.
    const next = this.waiters.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiters.length;
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
    this.slots = new Semaphore(cap);
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
    // Full → onQueued once, then FIFO wait. Released in finally below.
    if (!this.slots.tryAcquire()) {
      onQueued?.();
      await this.slots.acquire();
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
      this.slots.release();
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
