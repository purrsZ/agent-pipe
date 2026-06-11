import { type ChildProcess, spawn } from 'node:child_process';
import * as readline from 'node:readline';
import type { Task } from '../../store.js';
import type {
  AgentEvent,
  AgentFactory,
  AgentFactoryDeps,
  ProgressCallbacks,
  Runner,
  TurnResult,
} from '../types.js';
import { CodexParser } from './parser.js';

export interface CodexFactoryConfig {
  binPath: string;
  defaultModel: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

// Rough buckets — Codex doesn't expose context window via API, and OpenAI hasn't
// published a stable table per model. These are conservative estimates; the % shown
// on the result card is meant as an early-warning indicator, not an exact gauge.
function codexContextWindow(model: string | null | undefined): number {
  const m = (model ?? '').toLowerCase();
  if (!m) return 272_000;
  if (m.includes('mini') || m.includes('nano')) return 128_000;
  // gpt-5-codex / gpt-5.1-codex / gpt-5.3-codex etc.
  return 272_000;
}

export function createCodexFactory(cfg: CodexFactoryConfig): AgentFactory {
  return {
    kind: 'codex',
    modelChangeRequiresRespawn() {
      // Conservative: assume `codex exec resume <tid> --model <new>` locks to the
      // model that started the thread (as Claude's --resume does). If we later
      // confirm Codex honors --model on resume, flip this back to false to keep
      // context across model swaps. Until then, /model drops the thread_id and
      // forces a fresh conversation — losing context but guaranteeing the model
      // actually changes (avoids silent "model didn't switch" failure).
      return true;
    },
    defaultModel() {
      return cfg.defaultModel;
    },
    contextWindow(model) {
      return codexContextWindow(model ?? cfg.defaultModel);
    },
    createRunner(task, deps) {
      return new CodexRunner(task, deps, cfg);
    },
  };
}

interface InFlight {
  resolve: (r: TurnResult) => void;
  reject: (e: Error) => void;
  callbacks?: ProgressCallbacks;
  toolCount: number;
  proc: ChildProcess;
  parser: CodexParser;
  stderrBuf: string;
  doneEvent?: AgentEvent & { type: 'done' };
}

class CodexRunner implements Runner {
  readonly kind = 'codex';
  readonly taskId: string;
  private sessionId: string | null;
  private _lastActivity = Date.now();
  private inflight: InFlight | null = null;
  private disposed = false;

  constructor(
    private task: Task,
    private deps: AgentFactoryDeps,
    private cfg: CodexFactoryConfig,
  ) {
    this.taskId = task.id;
    this.sessionId = task.agent_session_id;
  }

  isBusy(): boolean {
    return this.inflight !== null;
  }

  isHot(): boolean {
    return false; // codex spawns per-turn; no hot process to evict
  }

  lastActivity(): number {
    return this._lastActivity;
  }

  setTask(task: Task): void {
    // Codex spawns per turn, so the next runTurn will pick up the new model/cwd.
    this.task = task;
  }

  async runTurn(text: string, callbacks?: ProgressCallbacks): Promise<TurnResult> {
    if (this.inflight) {
      throw new Error(`任务 ${this.taskId} 正在处理上一条消息`);
    }
    // NOTE: Codex tasks intentionally don't write status='hot'. The hot/suspended
    // dichotomy only models long-lived agent processes (Claude). A Codex task is
    // always between exec invocations — its DB status stays 'suspended' and the
    // /status hot count accurately reflects only Claude-style runners.
    this._lastActivity = Date.now();

    const model = this.task.model ?? this.cfg.defaultModel;
    const finalArgs: string[] = this.sessionId
      ? ['exec', 'resume', this.sessionId, '--json', '--skip-git-repo-check']
      : ['exec', '--json', '--skip-git-repo-check'];

    if (model) {
      finalArgs.push('--model', model);
    }
    if (this.cfg.reasoningEffort) {
      finalArgs.push('-c', `model_reasoning_effort=${this.cfg.reasoningEffort}`);
    }
    // dangerously auto-approve everything for unattended use
    finalArgs.push('--dangerously-bypass-approvals-and-sandbox');
    // prompt comes from stdin
    finalArgs.push('-');

    this.deps.logger.info(
      {
        taskId: this.taskId,
        cwd: this.task.cwd,
        hasResume: !!this.sessionId,
        model,
      },
      'spawning codex process',
    );

    const cleanEnv: Record<string, string | undefined> = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.ANTHROPIC_INNER;

    const proc = spawn(this.cfg.binPath, finalArgs, {
      cwd: this.task.cwd,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const parser = new CodexParser();
    const inflight: InFlight = {
      resolve: () => {},
      reject: () => {},
      callbacks,
      toolCount: 0,
      proc,
      parser,
      stderrBuf: '',
    };
    this.inflight = inflight;

    const startedAt = Date.now();

    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      this._lastActivity = Date.now();
      const events = parser.parseLine(line);
      for (const e of events) this.handleEvent(e);
    });

    proc.stderr?.on('data', (chunk) => {
      inflight.stderrBuf += chunk.toString();
      if (inflight.stderrBuf.length > 4096) {
        inflight.stderrBuf = inflight.stderrBuf.slice(-4096);
      }
    });

    proc.stdin?.on('error', (err) => {
      this.deps.logger.warn({ err, taskId: this.taskId }, 'codex stdin write error');
    });

    proc.on('error', (err) => {
      this.deps.logger.error({ err, taskId: this.taskId }, 'codex spawn error');
      if (this.inflight !== inflight) return;
      this.inflight = null;
      if (this.disposed) return;
      // status stays 'suspended' (see runTurn note)
      inflight.reject(err);
    });

    return new Promise<TurnResult>((resolve, reject) => {
      inflight.resolve = resolve;
      inflight.reject = reject;

      proc.on('close', (code) => {
        if (this.inflight !== inflight) return;
        this.inflight = null;
        if (this.disposed) return; // a newer runner already owns this taskId
        // status stays 'suspended' (see runTurn note); no setStatus needed here.

        const done = inflight.doneEvent;
        const durationMs = Date.now() - startedAt;
        if (!done) {
          this.deps.logger.warn(
            {
              taskId: this.taskId,
              code,
              stderr: inflight.stderrBuf.slice(-500),
            },
            'codex exited without done event',
          );
          if (code !== 0) {
            inflight.reject(new Error(`codex exited (${code}): ${inflight.stderrBuf.slice(-400)}`));
            return;
          }
        }
        const latest = parser.latestUsage;
        const result: TurnResult = {
          fullText: parser.fullText,
          sessionId: this.sessionId,
          durationMs,
          inputTokens: latest?.inputTokens ?? done?.inputTokens,
          outputTokens: latest?.outputTokens ?? done?.outputTokens,
          cacheReadInputTokens: latest?.cacheReadInputTokens ?? done?.cacheReadInputTokens,
          contextWindow: codexContextWindow(this.task.model ?? this.cfg.defaultModel),
          error: done?.error,
          toolCount: inflight.toolCount,
        };
        this.deps.store.logEvent(this.taskId, result.error ? 'error' : 'assistant', undefined, {
          fullText: result.fullText.slice(0, 2000),
          error: result.error,
        });
        inflight.resolve(result);
      });

      // write the prompt to stdin and close it (codex exec reads until EOF)
      const ok = proc.stdin?.write(text);
      if (ok === undefined) {
        this.inflight = null;
        reject(new Error('codex stdin unavailable'));
        return;
      }
      proc.stdin?.end();
    });
  }

  abort(): boolean {
    const inf = this.inflight;
    if (!inf?.proc.pid || inf.proc.killed) return false;
    this.deps.logger.info({ taskId: this.taskId }, 'sending SIGINT to codex');
    inf.proc.kill('SIGINT');
    return true;
  }

  dispose(): void {
    this.disposed = true;
    const inf = this.inflight;
    if (inf) {
      if (!inf.proc.killed) {
        try {
          inf.proc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
      // Reject so the caller's promise resolves instead of waiting on a process
      // we just SIGTERMed. close-handler's `inflight !== this.inflight` check
      // prevents a double-reject when proc.close fires later.
      inf.reject(new Error('runner disposed'));
      this.inflight = null;
    }
  }

  private handleEvent(e: AgentEvent): void {
    const inflight = this.inflight;
    if (!inflight) return;
    switch (e.type) {
      case 'session':
        this.sessionId = e.sessionId;
        this.deps.store.setAgentSessionId(this.taskId, e.sessionId);
        break;
      case 'ready':
        break;
      case 'text':
        // CodexParser replaces fullText wholesale on agent_message (one-shot, not
        // incremental). Relay it so the streaming card shows the answer a beat before
        // the final result card lands.
        inflight.callbacks?.onText?.(this.taskId, inflight.parser.fullText);
        break;
      case 'tool_use':
        inflight.toolCount++;
        this.deps.store.logEvent(this.taskId, 'tool_start', e.name, {
          input: e.input,
        });
        inflight.callbacks?.onToolUse?.(this.taskId, {
          name: e.name,
          input: e.input,
        });
        break;
      case 'tool_result':
        this.deps.store.logEvent(this.taskId, 'tool_end', undefined, {
          id: e.id,
          isError: e.isError,
        });
        inflight.callbacks?.onToolResult?.(this.taskId, { isError: e.isError });
        break;
      case 'usage':
        // captured by parser.latestUsage
        break;
      case 'done':
        inflight.doneEvent = e;
        // Codex usually exits on its own right after turn.completed / turn.failed.
        // If it lingers (e.g. transient stream "error" with no exit), force-kill so
        // runTurn doesn't hang on proc.on('close').
        setTimeout(() => {
          if (this.inflight !== inflight) return;
          if (!inflight.proc.killed) {
            try {
              inflight.proc.kill('SIGTERM');
            } catch {
              /* ignore */
            }
          }
        }, 3000).unref();
        break;
    }
  }
}
