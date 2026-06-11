import type { Logger } from '../logger.js';
import type { Store, Task } from '../store.js';

export type AgentKind = 'claude' | 'codex';

/**
 * Live progress hooks invoked by runners during a turn. index.ts subscribes these
 * to drive an incrementally-updated "处理中" card (tool activity + streamed text).
 * onText carries the full assistant text so far — Claude streams it incrementally,
 * Codex delivers it once when the agent_message completes.
 */
export interface ProgressCallbacks {
  onToolUse?: (taskId: string, tool: { name: string; input?: string }) => void;
  onToolResult?: (taskId: string, r: { isError?: boolean }) => void;
  onText?: (taskId: string, fullText: string) => void;
}

export interface TurnResult {
  fullText: string;
  sessionId: string | null;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  contextWindow?: number;
  error?: string;
  toolCount: number;
}

export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'ready' }
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input?: string }
  | { type: 'tool_result'; id: string; isError?: boolean }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
    }
  | {
      type: 'done';
      costUsd?: number;
      durationMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
      error?: string;
    };

export interface Runner {
  readonly taskId: string;
  readonly kind: AgentKind;
  isBusy(): boolean;
  /** Is the runner holding a hot/long-lived process? Used by pool LRU eviction. */
  isHot(): boolean;
  /** Refresh the task snapshot held by the runner — pool calls this before runTurn. */
  setTask(task: Task): void;
  runTurn(text: string, callbacks?: ProgressCallbacks): Promise<TurnResult>;
  abort(): boolean;
  dispose(): void;
  lastActivity(): number;
}

export interface AgentFactoryDeps {
  store: Store;
  logger: Logger;
}

export interface AgentFactory {
  readonly kind: AgentKind;
  /** Does switching the model require respawn + context clear? Claude yes, Codex no. */
  modelChangeRequiresRespawn(): boolean;
  defaultModel(): string;
  /** Context window in tokens for a given model name. */
  contextWindow(model: string | null | undefined): number;
  createRunner(task: Task, deps: AgentFactoryDeps): Runner;
}
