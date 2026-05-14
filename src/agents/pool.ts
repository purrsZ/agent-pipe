import type { Logger } from '../logger.js';
import type { Store, Task, AgentKind } from '../store.js';
import type {
  AgentFactory,
  ProgressCallbacks,
  Runner,
  TurnResult,
} from './types.js';

export interface AgentPoolConfig {
  maxHot: number;
}

export class AgentPool {
  private runners = new Map<string, Runner>();

  constructor(
    private factories: Record<AgentKind, AgentFactory>,
    private cfg: AgentPoolConfig,
    private store: Store,
    private logger: Logger,
  ) {}

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

  async send(
    task: Task,
    text: string,
    callbacks?: ProgressCallbacks,
  ): Promise<TurnResult> {
    let runner = this.runners.get(task.id);

    // If the cached runner is for a different kind (after /agent switch), drop it.
    if (runner && runner.kind !== task.agent_kind) {
      this.logger.info(
        { taskId: task.id, was: runner.kind, now: task.agent_kind },
        'agent kind changed, disposing old runner',
      );
      runner.dispose();
      this.runners.delete(task.id);
      runner = undefined;
    }

    if (!runner) {
      // Resolve the factory BEFORE evicting — a corrupt/unknown agent_kind on the
      // task row shouldn't punish a healthy hot Claude runner by booting it.
      const factory = this.factoryFor(task.agent_kind);
      if (this.hotCount() >= this.cfg.maxHot) this.evictLRU();
      runner = factory.createRunner(task, { store: this.store, logger: this.logger });
      this.runners.set(task.id, runner);
    } else {
      // refresh snapshot — model/agent_kind/cwd may have changed between turns
      runner.setTask(task);
    }

    if (runner.isBusy()) {
      throw new Error(`任务 ${task.id} 正在处理上一条消息`);
    }
    return runner.runTurn(text, callbacks);
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
