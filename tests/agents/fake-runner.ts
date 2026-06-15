import type { ProgressCallbacks, RunOptions, Runner, TurnResult } from '../../src/agents/types.js';
import type { AgentKind, Task } from '../../src/store.js';

/**
 * Minimal in-memory Runner for pool tests (WI-A rebuild, WI-C scheduling). Records the
 * text + options of every runTurn and whether it was disposed, so tests can assert the
 * pool's rebuild/reuse decisions without spawning a real process.
 */
export class FakeRunner implements Runner {
  readonly taskId: string;
  readonly kind: AgentKind;
  disposed = false;
  busy = false;
  readonly calls: Array<{ text: string; options?: RunOptions }> = [];
  private activity = 0;

  constructor(taskId: string, kind: AgentKind) {
    this.taskId = taskId;
    this.kind = kind;
  }

  isBusy(): boolean {
    return this.busy;
  }

  isHot(): boolean {
    return !this.disposed;
  }

  setTask(_task: Task): void {}

  async runTurn(
    text: string,
    _callbacks?: ProgressCallbacks,
    options?: RunOptions,
  ): Promise<TurnResult> {
    this.calls.push({ text, options });
    return { fullText: '', sessionId: null, toolCount: 0 };
  }

  abort(): boolean {
    return false;
  }

  dispose(): void {
    this.disposed = true;
  }

  lastActivity(): number {
    return this.activity;
  }
}
