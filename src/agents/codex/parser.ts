import type { AgentEvent } from '../types.js';

/**
 * Parses `codex exec --json` JSONL stream into normalized AgentEvents.
 *
 * Top-level events (one JSON object per stdout line):
 *   - thread.started     { thread_id }
 *   - turn.started       { }
 *   - turn.completed     { usage: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens } }
 *   - turn.failed        { error: { message } }
 *   - item.started       { item: { id, type, ... } }
 *   - item.completed     { item: { id, type, ... } }
 *   - item.updated       { item: { id, type, ... } }
 *   - error              { message }
 *
 * Item subtypes we map to tool_use / tool_result:
 *   command_execution, file_change, mcp_tool_call, web_search
 * Item subtypes we map to text:
 *   agent_message (text in `item.text`)
 *   reasoning is silently dropped from card text but still surfaces as tool_use for visibility.
 */
export class CodexParser {
  private _fullText = '';
  private _latestUsage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
      }
    | null = null;

  get fullText(): string {
    return this._fullText;
  }

  get latestUsage() {
    return this._latestUsage;
  }

  reset(): void {
    this._fullText = '';
    this._latestUsage = null;
  }

  parseLine(line: string): AgentEvent[] {
    const s = line.trim();
    if (!s || s[0] !== '{') return [];
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      return [];
    }
    return this.parseObject(obj as Record<string, unknown>);
  }

  private parseObject(obj: Record<string, unknown>): AgentEvent[] {
    const type = obj.type as string | undefined;
    if (!type) return [];

    if (type === 'thread.started') {
      const tid = (obj.thread_id ?? obj.threadId) as string | undefined;
      const events: AgentEvent[] = [];
      if (tid) events.push({ type: 'session', sessionId: tid });
      events.push({ type: 'ready' });
      return events;
    }

    if (type === 'turn.started') {
      return [];
    }

    if (type === 'turn.completed') {
      const usage = obj.usage as Record<string, unknown> | undefined;
      const inputTotal = usage?.input_tokens as number | undefined;
      const cachedInput = usage?.cached_input_tokens as number | undefined;
      const outputTokens = usage?.output_tokens as number | undefined;
      // ASSUMPTION (unverified on a real codex run as of this commit):
      //   OpenAI Responses API convention has `input_tokens` as the TOTAL prompt
      //   tokens, with `cached_input_tokens` being the subset that hit the cache.
      //   So `input_tokens` already INCLUDES `cached_input_tokens`.
      // Card formula is `inputTokens + cacheReadInputTokens`, so we subtract here
      // to expose the disjoint (fresh) portion as inputTokens, matching the
      // Anthropic-style fields the card was originally designed around.
      // If Codex CLI actually emits disjoint values (input excludes cached), this
      // under-counts ctx%. Verify against `OPENAI_LOG=info` + dashboard on first
      // real run; if disjoint, drop the subtraction and assign inputTotal directly.
      const inputTokens =
        inputTotal !== undefined && cachedInput !== undefined
          ? Math.max(0, inputTotal - cachedInput)
          : inputTotal;
      if (inputTokens !== undefined || outputTokens !== undefined) {
        this._latestUsage = {
          inputTokens,
          outputTokens,
          cacheReadInputTokens: cachedInput,
        };
      }
      return [
        {
          type: 'usage',
          inputTokens,
          outputTokens,
          cacheReadInputTokens: cachedInput,
        },
        { type: 'done', inputTokens, outputTokens, cacheReadInputTokens: cachedInput },
      ];
    }

    if (type === 'turn.failed') {
      const err = obj.error as Record<string, unknown> | undefined;
      const msg = (err?.message as string | undefined) ?? 'turn failed';
      return [{ type: 'done', error: msg }];
    }

    if (type === 'error') {
      const msg = obj.message as string | undefined;
      if (msg && /^Reconnecting\.\.\./i.test(msg)) return []; // transient
      return [{ type: 'done', error: msg ?? 'codex stream error' }];
    }

    if (type === 'item.started' || type === 'item.completed' || type === 'item.updated') {
      const item = obj.item as Record<string, unknown> | undefined;
      if (!item) return [];
      return this.parseItem(type, item);
    }

    return [];
  }

  private parseItem(eventType: string, item: Record<string, unknown>): AgentEvent[] {
    const id = String(item.id ?? '');
    const itype = item.type as string | undefined;
    if (!itype) return [];

    const isStart = eventType === 'item.started';
    const isDone = eventType === 'item.completed';

    if (itype === 'agent_message') {
      // emit text only when fully completed (item.text is the final assistant message)
      if (!isDone) return [];
      const text = (item.text as string | undefined) ?? '';
      if (!text) return [];
      // codex usually emits exactly one agent_message per turn; replace existing buffer
      // to avoid double-printing if reasoning was previously appended.
      this._fullText = text;
      return [{ type: 'text', delta: text }];
    }

    if (itype === 'reasoning') {
      // Do not pollute the text buffer; surface as a lightweight tool_use marker on start.
      if (isStart) return [{ type: 'tool_use', id, name: 'reasoning' }];
      if (isDone) return [{ type: 'tool_result', id }];
      return [];
    }

    if (itype === 'command_execution') {
      if (isStart) {
        const command = item.command as string | string[] | undefined;
        const input =
          command === undefined
            ? undefined
            : Array.isArray(command)
              ? command.join(' ').slice(0, 500)
              : String(command).slice(0, 500);
        return [{ type: 'tool_use', id, name: 'bash', input }];
      }
      if (isDone) {
        const status = item.status as string | undefined;
        const exitCode = item.exit_code as number | undefined;
        const isError = status === 'failed' || (exitCode !== undefined && exitCode !== 0);
        return [{ type: 'tool_result', id, isError }];
      }
      return [];
    }

    if (itype === 'file_change') {
      if (isStart) {
        const changes = item.changes as Array<{ path?: string; kind?: string }> | undefined;
        const input = changes
          ? changes
              .map((c) => `${c.kind ?? '?'} ${c.path ?? ''}`.trim())
              .join(', ')
              .slice(0, 500)
          : undefined;
        return [{ type: 'tool_use', id, name: 'file_change', input }];
      }
      if (isDone) {
        const isError = (item.status as string | undefined) === 'failed';
        return [{ type: 'tool_result', id, isError }];
      }
      return [];
    }

    if (itype === 'mcp_tool_call') {
      if (isStart) {
        const name = (item.tool_name as string | undefined) ?? (item.name as string | undefined) ?? 'mcp_tool';
        return [{ type: 'tool_use', id, name }];
      }
      if (isDone) {
        const isError = (item.status as string | undefined) === 'failed';
        return [{ type: 'tool_result', id, isError }];
      }
      return [];
    }

    if (itype === 'web_search') {
      if (isStart) {
        const q = item.query as string | undefined;
        return [{ type: 'tool_use', id, name: 'web_search', input: q?.slice(0, 500) }];
      }
      if (isDone) return [{ type: 'tool_result', id }];
      return [];
    }

    if (itype === 'todo_list') {
      // ignore; not actionable for our UI
      return [];
    }

    if (itype === 'error') {
      if (isDone) {
        const msg = (item.message as string | undefined) ?? 'codex item error';
        return [{ type: 'tool_result', id, isError: true }, { type: 'done', error: msg }];
      }
      return [];
    }

    // unknown item type — surface as a generic tool entry so the user at least sees activity.
    if (isStart) return [{ type: 'tool_use', id, name: itype }];
    if (isDone) return [{ type: 'tool_result', id }];
    return [];
  }
}
