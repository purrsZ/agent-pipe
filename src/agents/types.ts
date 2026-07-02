import type { Logger } from '../logger.js';
import type { Store, Task } from '../store.js';

export type AgentKind = 'claude' | 'codex';

/** A single selectable choice in an AskUserQuestion question. */
export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

/** One question (with its choices) from Claude's AskUserQuestion tool. */
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskUserQuestionOption[];
}

/**
 * Structured payload for an AskUserQuestion tool call surfaced mid-turn. The headless CLI
 * auto-closes this tool with an error (no interactive UI), so the turn ends normally; a
 * consumer renders these choices and feeds the picked answer back as the next --resume
 * message rather than as a tool_result (which the CLI no longer accepts at that point).
 */
export interface AskUserQuestion {
  toolUseId: string;
  questions: AskUserQuestionItem[];
}

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
  /**
   * Fired the moment a session id is first observed (the runner's `session` event), so an
   * upper layer can persist it immediately. The kernel store already records it against the
   * task; this lets a consumer mirror it into its own state BEFORE a crash, which is the
   * precondition for a real `--resume` on recovery (D-30). Neutral signature.
   */
  onSession?: (taskId: string, sessionId: string) => void;
  /**
   * WI-9 liveness tick — invoked on EVERY stdout line (before parsing), so a turn that
   * streams anything (thinking deltas, SSE pings, tool noise) keeps signalling "alive" even
   * when it produces no assistant text. A consumer bridges this to a liveness heartbeat so a
   * silence judgement can mean "stdout fully silent for N s" (= true wedge), not
   * "no visible output" — long/thinking turns no longer false-stall. (cf. ai-sentinel tmux
   * stuck-detector: any pane change resets the stuck counter; only a frozen pane is a wedge.)
   */
  onActivity?: (taskId: string) => void;
  /**
   * Fired when the agent invokes a question/choice tool mid-turn (Claude's AskUserQuestion).
   * Carries the full, untruncated questions so a consumer can render an interactive choice
   * card. The same tool_use also fires onToolUse (for the progress card); this is the
   * structured channel for the choices themselves.
   */
  onAskUser?: (taskId: string, q: AskUserQuestion) => void;
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
  | { type: 'ask_user'; toolUseId: string; questions: AskUserQuestionItem[] }
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
  runTurn(text: string, callbacks?: ProgressCallbacks, options?: RunOptions): Promise<TurnResult>;
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

/**
 * Per-run launch options (WI-A / WI-B). `undefined` ≡ current behavior (full
 * permissions, no tool injection) so the bridge's default path is a zero regression.
 */
export interface PermissionProfile {
  // 'write' is the requirement-worker profile: --add-dir scope + a PreToolUse path guard
  // (the real constraint), never --dangerously-skip-permissions. Mapping write→full would
  // drop the dir limit entirely and is a bug (D-04).
  mode: 'full' | 'readonly' | 'write';
}

export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RunOptions {
  permission?: PermissionProfile;
  mcpServers?: McpServerSpec[];
  // Write profile only: the directories the agent may write to. The agents layer knows
  // only paths, never "repo" (kernel neutrality, D-04). Same source as the run's cwd
  // (worktreePathFor), so cwd + writableDirs always move together (R05.AC-7).
  writableDirs?: string[];
  // Any profile: extra directories the agent may READ (--add-dir, read-widening only). A
  // readonly 包工头 spanning multiple repos passes every repo here so it can read them all,
  // not just cwd. Never grants write — readonly still --disallowedTools, write still guarded.
  readableDirs?: string[];
}

/**
 * Stable serialization of RunOptions for the pool's per-process rebuild decision
 * (§2.1). Default options collapse to '' so the no-options bridge path never triggers
 * a rebuild — this is the zero-regression guarantee the pool relies on. writableDirs
 * MUST be in the fingerprint (D-21): a changed dir set with an unchanged fingerprint
 * would keep a stale --add-dir pointing at the old worktree.
 */
export function runOptionsFingerprint(o?: RunOptions): string {
  const permission = o?.permission?.mode ?? 'full';
  const servers = (o?.mcpServers ?? [])
    .map((s) => ({ name: s.name, command: s.command, args: s.args ?? [], env: s.env ?? {} }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const writableDirs = [...(o?.writableDirs ?? [])].sort();
  if (permission === 'full' && servers.length === 0 && writableDirs.length === 0) return '';
  return JSON.stringify({ permission, servers, writableDirs });
}
