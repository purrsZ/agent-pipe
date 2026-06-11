import type { AgentEvent } from '../types.js';

export class ClaudeParser {
  private _fullText = '';
  private _latestUsage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  } | null = null;

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
    if (!line.trim()) return [];
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return [];
    }
    return this.parseObject(obj as Record<string, unknown>);
  }

  private parseObject(obj: Record<string, unknown>): AgentEvent[] {
    const type = obj.type;
    const events: AgentEvent[] = [];

    if (type === 'system' && obj.subtype === 'init') {
      const sid = obj.session_id as string | undefined;
      if (sid) events.push({ type: 'session', sessionId: sid });
      events.push({ type: 'ready' });
      return events;
    }

    if (type === 'assistant') {
      const message = obj.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage) {
        this._latestUsage = {
          inputTokens: usage.input_tokens as number | undefined,
          outputTokens: usage.output_tokens as number | undefined,
          cacheCreationInputTokens: usage.cache_creation_input_tokens as number | undefined,
          cacheReadInputTokens: usage.cache_read_input_tokens as number | undefined,
        };
        events.push({ type: 'usage', ...this._latestUsage });
      }
      const content = message?.content as unknown[] | undefined;
      if (!Array.isArray(content)) return events;
      for (const raw of content) {
        const block = raw as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') {
          this._fullText += block.text;
          events.push({ type: 'text', delta: block.text });
        } else if (block.type === 'tool_use') {
          const input = block.input;
          events.push({
            type: 'tool_use',
            id: String(block.id ?? ''),
            name: String(block.name ?? ''),
            input: input !== undefined ? JSON.stringify(input).slice(0, 500) : undefined,
          });
        }
      }
      return events;
    }

    if (type === 'user') {
      const message = obj.message as Record<string, unknown> | undefined;
      const content = message?.content as unknown[] | undefined;
      if (!Array.isArray(content)) return events;
      for (const raw of content) {
        const block = raw as Record<string, unknown>;
        if (block.type === 'tool_result') {
          events.push({
            type: 'tool_result',
            id: String(block.tool_use_id ?? ''),
            isError: block.is_error === true,
          });
        }
      }
      return events;
    }

    if (type === 'result') {
      const usage = obj.usage as Record<string, unknown> | undefined;
      const sid = obj.session_id as string | undefined;
      if (sid) events.push({ type: 'session', sessionId: sid });
      events.push({
        type: 'done',
        costUsd: (obj.total_cost_usd as number | undefined) ?? (obj.cost_usd as number | undefined),
        durationMs: obj.duration_ms as number | undefined,
        inputTokens: usage?.input_tokens as number | undefined,
        outputTokens: usage?.output_tokens as number | undefined,
        cacheCreationInputTokens: usage?.cache_creation_input_tokens as number | undefined,
        cacheReadInputTokens: usage?.cache_read_input_tokens as number | undefined,
        error: obj.is_error === true ? String(obj.result ?? 'error') : undefined,
      });
      return events;
    }

    return events;
  }
}
