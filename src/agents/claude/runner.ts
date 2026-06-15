import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { Task } from '../../store.js';
import type {
  AgentEvent,
  AgentFactory,
  AgentFactoryDeps,
  ProgressCallbacks,
  RunOptions,
  Runner,
  TurnResult,
} from '../types.js';
import { ClaudeParser } from './parser.js';

export interface ClaudeFactoryConfig {
  binPath: string;
  defaultModel: string;
  effort: string;
}

/**
 * Pure args builder (WI-A). Extracted from spawn() so the no-options path can be
 * asserted byte-for-byte (zero regression) and the --mcp-config injection point is
 * testable in isolation. The readonly permission profile is added in WI-B; here the
 * runner always launches full (--dangerously-skip-permissions), exactly as before.
 */
// Write tools denied in the readonly profile (WI-B). Deterministic deny via
// --disallowedTools (yields a rejected tool_result, not an interactive approval → no
// hang). This is a WEAK readonly: it does not block network egress or Bash — strong
// readonly (OS sandbox, no network) is Codex-only and deferred (§6 D1).
const READONLY_DENIED_TOOLS = 'Write Edit MultiEdit NotebookEdit';

export function buildClaudeArgs(p: {
  model: string;
  effort: string;
  sessionId: string | null;
  mcpConfigPath?: string;
  readonly?: boolean;
}): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    p.model,
    '--effort',
    p.effort,
  ];
  // Permission profile (WI-B). readonly: drop the blanket bypass and deny write tools
  // deterministically. full (default): legacy --dangerously-skip-permissions, unchanged.
  if (p.readonly) {
    args.push('--disallowedTools', READONLY_DENIED_TOOLS);
  } else {
    args.push('--dangerously-skip-permissions');
  }
  if (p.mcpConfigPath) args.push('--mcp-config', p.mcpConfigPath, '--strict-mcp-config');
  if (p.sessionId) args.push('--resume', p.sessionId);
  return args;
}

export function createClaudeFactory(cfg: ClaudeFactoryConfig): AgentFactory {
  return {
    kind: 'claude',
    modelChangeRequiresRespawn() {
      return true;
    },
    defaultModel() {
      return cfg.defaultModel;
    },
    contextWindow(model) {
      return /\[1m\]/i.test(model ?? '') ? 1_000_000 : 200_000;
    },
    createRunner(task, deps) {
      return new ClaudeRunner(task, deps, cfg);
    },
  };
}

interface InFlight {
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
  callbacks?: ProgressCallbacks;
  toolCount: number;
}

class ClaudeRunner implements Runner {
  readonly kind = 'claude';
  readonly taskId: string;
  private proc: ChildProcess | null = null;
  private parser = new ClaudeParser();
  private sessionId: string | null;
  private state: 'cold' | 'starting' | 'idle' | 'busy' = 'cold';
  private _lastActivity = Date.now();
  private inflight: InFlight | null = null;
  private stderrBuf = '';
  private disposed = false;
  // WI-A: per-process MCP config temp file. Bound to the proc lifecycle — cleaned on
  // dispose() AND proc close/error (crash/normal exit skip dispose), never on turn end
  // (the proc spans many turns; deleting per-turn would drop the config on turn 2).
  private mcpConfigPath: string | null = null;
  private mcpSeq = 0;

  constructor(
    private task: Task,
    private deps: AgentFactoryDeps,
    private cfg: ClaudeFactoryConfig,
  ) {
    this.taskId = task.id;
    this.sessionId = task.agent_session_id;
  }

  isBusy(): boolean {
    return this.state === 'busy' || this.state === 'starting';
  }

  isHot(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  lastActivity(): number {
    return this._lastActivity;
  }

  setTask(task: Task): void {
    // Claude's long-lived proc was spawned with a fixed --model; updating the snapshot
    // here doesn't affect the running process. /model on Claude always respawns, so by
    // the time setTask matters this runner will already have been disposed.
    this.task = task;
  }

  async runTurn(
    text: string,
    callbacks?: ProgressCallbacks,
    options?: RunOptions,
  ): Promise<TurnResult> {
    if (this.state === 'busy') {
      throw new Error(`任务 ${this.taskId} 正在处理上一条消息`);
    }
    if (!this.proc || this.proc.killed) {
      this.spawn(options);
    }
    this.state = 'busy';
    this.parser.reset();
    this.inflight = {
      resolve: () => {},
      reject: () => {},
      callbacks,
      toolCount: 0,
    };
    this._lastActivity = Date.now();
    this.deps.store.setStatus(this.taskId, 'hot');

    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });

    return new Promise<TurnResult>((resolve, reject) => {
      this.inflight!.resolve = resolve;
      this.inflight!.reject = reject;
      const ok = this.proc!.stdin?.write(`${payload}\n`);
      if (ok === undefined) {
        this.state = 'idle';
        this.inflight = null;
        reject(new Error('claude process stdin unavailable'));
      }
    });
  }

  abort(): boolean {
    if (!this.proc || this.proc.killed || !this.proc.pid) return false;
    this.deps.logger.info({ taskId: this.taskId }, 'sending SIGINT to claude');
    this.proc.kill('SIGINT');
    return true;
  }

  dispose(): void {
    this.disposed = true;
    // Reject any in-flight turn so the caller's promise resolves instead of leaking.
    // All current callers (/clear, /model, /agent, evictLRU, killAll) check isBusy()
    // first so this should only fire in defensive paths or future-added flows.
    if (this.inflight) {
      this.inflight.reject(new Error('runner disposed'));
      this.inflight = null;
    }
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    this.proc = null;
    this.state = 'cold';
    this.cleanupMcpConfig();
  }

  private writeMcpConfig(options?: RunOptions): string | null {
    if (!options?.mcpServers?.length) return null;
    const servers: Record<string, unknown> = {};
    for (const s of options.mcpServers) {
      servers[s.name] = { command: s.command, args: s.args ?? [], env: s.env ?? {} };
    }
    const file = path.join(os.tmpdir(), `agent-pipe-mcp-${this.taskId}-${this.mcpSeq++}.json`);
    fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
    return file;
  }

  private cleanupMcpConfig(): void {
    if (!this.mcpConfigPath) return;
    try {
      fs.unlinkSync(this.mcpConfigPath);
    } catch {
      /* best-effort: temp file may already be gone */
    }
    this.mcpConfigPath = null;
  }

  private spawn(options?: RunOptions): void {
    const model = this.task.model ?? this.cfg.defaultModel;
    this.mcpConfigPath = this.writeMcpConfig(options);
    const readonly = options?.permission?.mode === 'readonly';
    const args = buildClaudeArgs({
      model,
      effort: this.cfg.effort,
      sessionId: this.sessionId,
      mcpConfigPath: this.mcpConfigPath ?? undefined,
      readonly,
    });

    const cleanEnv: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(cleanEnv)) {
      if (k.startsWith('CLAUDE') || k === 'ANTHROPIC_INNER') delete cleanEnv[k];
    }

    // Observability (WI-B 顺带): surface the injected MCP servers + permission profile
    // server-side, so per-run injection is visible in logs, not only the agent's output.
    this.deps.logger.info(
      {
        taskId: this.taskId,
        cwd: this.task.cwd,
        hasResume: !!this.sessionId,
        model,
        mcpServers: (options?.mcpServers ?? []).map((s) => s.name),
        permission: readonly ? 'readonly' : 'full',
      },
      'spawning claude process',
    );

    const proc = spawn(this.cfg.binPath, args, {
      cwd: this.task.cwd,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.state = 'starting';
    this._lastActivity = Date.now();
    this.stderrBuf = '';

    proc.stdin?.on('error', (err) => {
      this.deps.logger.warn({ err, taskId: this.taskId }, 'stdin write error');
    });

    const readyTimeout = setTimeout(() => {
      if (this.state === 'starting') {
        this.deps.logger.warn({ taskId: this.taskId }, 'ready timeout (30s), marking idle');
        this.state = 'idle';
      }
    }, 30_000);
    readyTimeout.unref();

    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      this._lastActivity = Date.now();
      const events = this.parser.parseLine(line);
      for (const e of events) this.handleEvent(e);
    });

    proc.stderr?.on('data', (chunk) => {
      this.stderrBuf += chunk.toString();
      if (this.stderrBuf.length > 4096) this.stderrBuf = this.stderrBuf.slice(-4096);
    });

    proc.on('close', (code) => {
      this.deps.logger.warn(
        { taskId: this.taskId, code, stderr: this.stderrBuf.slice(-500) },
        'claude exited',
      );
      // Crash/normal exit lands here, not in dispose() — clean the MCP temp file on
      // every proc end so it can't leak (WI-A / review #6).
      this.cleanupMcpConfig();
      // If we were disposed (e.g. by /clear, /model, /agent or LRU eviction) a fresh
      // runner may already own this taskId. Don't touch shared store state in that case.
      if (this.disposed) return;
      if (this.sessionId) this.deps.store.setAgentSessionId(this.taskId, this.sessionId);
      if (this.inflight) {
        this.inflight.reject(new Error(`claude exited (${code}): ${this.stderrBuf.slice(-400)}`));
        this.inflight = null;
      }
      this.proc = null;
      this.state = 'cold';
      this.deps.store.setStatus(this.taskId, 'suspended');
    });

    proc.on('error', (err) => {
      this.deps.logger.error({ err, taskId: this.taskId }, 'claude spawn error');
      this.cleanupMcpConfig();
      if (this.inflight) {
        this.inflight.reject(err);
        this.inflight = null;
      }
      this.proc = null;
      this.state = 'cold';
    });
  }

  private handleEvent(e: AgentEvent): void {
    const inflight = this.inflight;
    switch (e.type) {
      case 'session':
        this.sessionId = e.sessionId;
        this.deps.store.setAgentSessionId(this.taskId, e.sessionId);
        break;
      case 'ready':
        if (this.state === 'starting') {
          this.state = 'idle';
          this.deps.logger.info({ taskId: this.taskId, sessionId: this.sessionId }, 'claude ready');
        }
        break;
      case 'text':
        // parser already appended this delta to fullText; relay the running total
        // so the streaming card can show assistant text as it arrives.
        inflight?.callbacks?.onText?.(this.taskId, this.parser.fullText);
        break;
      case 'tool_use':
        if (inflight) inflight.toolCount++;
        this.deps.store.logEvent(this.taskId, 'tool_start', e.name, {
          input: e.input,
        });
        inflight?.callbacks?.onToolUse?.(this.taskId, {
          name: e.name,
          input: e.input,
        });
        break;
      case 'tool_result':
        this.deps.store.logEvent(this.taskId, 'tool_end', undefined, {
          id: e.id,
          isError: e.isError,
        });
        inflight?.callbacks?.onToolResult?.(this.taskId, {
          isError: e.isError,
        });
        break;
      case 'usage':
        // already captured by parser.latestUsage
        break;
      case 'done': {
        if (!inflight) return;
        const latest = this.parser.latestUsage;
        const result: TurnResult = {
          fullText: this.parser.fullText,
          sessionId: this.sessionId,
          costUsd: e.costUsd,
          durationMs: e.durationMs,
          inputTokens: latest?.inputTokens ?? e.inputTokens,
          outputTokens: latest?.outputTokens ?? e.outputTokens,
          cacheCreationInputTokens: latest?.cacheCreationInputTokens ?? e.cacheCreationInputTokens,
          cacheReadInputTokens: latest?.cacheReadInputTokens ?? e.cacheReadInputTokens,
          contextWindow: /\[1m\]/i.test(this.task.model ?? this.cfg.defaultModel)
            ? 1_000_000
            : 200_000,
          error: e.error,
          toolCount: inflight.toolCount,
        };
        this.state = 'idle';
        this.deps.store.logEvent(this.taskId, e.error ? 'error' : 'assistant', undefined, {
          fullText: result.fullText.slice(0, 2000),
          costUsd: e.costUsd,
          error: e.error,
        });
        const resolve = inflight.resolve;
        this.inflight = null;
        resolve(result);
        break;
      }
    }
  }
}
