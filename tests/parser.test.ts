import { describe, expect, it } from 'vitest';
import { ClaudeParser } from '../src/agents/claude/parser.js';

function toolUseLine(name: string, input: unknown, id = 'toolu_1'): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  });
}

describe('ClaudeParser AskUserQuestion → ask_user', () => {
  it('emits a structured ask_user event alongside the plain tool_use', () => {
    const parser = new ClaudeParser();
    const input = {
      questions: [
        {
          question: '在重构上更偏好哪种？',
          header: '重构策略',
          multiSelect: false,
          options: [
            { label: '激进重写', description: 'x'.repeat(600) },
            { label: '渐进迁移', description: '保持旧系统运行' },
          ],
        },
      ],
    };
    const events = parser.parseLine(toolUseLine('AskUserQuestion', input, 'toolu_abc'));
    // The progress card still gets a tool_use; the choices ride a separate ask_user event.
    expect(events.some((e) => e.type === 'tool_use')).toBe(true);
    const ask = events.find((e) => e.type === 'ask_user');
    if (ask?.type !== 'ask_user') throw new Error('expected an ask_user event');
    expect(ask.toolUseId).toBe('toolu_abc');
    expect(ask.questions).toHaveLength(1);
    expect(ask.questions[0]!.header).toBe('重构策略');
    expect(ask.questions[0]!.options.map((o) => o.label)).toEqual(['激进重写', '渐进迁移']);
    // Untruncated: the 600-char description survives (unlike the 500-char tool_use input).
    expect(ask.questions[0]!.options[0]!.description).toHaveLength(600);
  });

  it('does not emit ask_user for other tools', () => {
    const parser = new ClaudeParser();
    const events = parser.parseLine(toolUseLine('Bash', { command: 'ls' }));
    expect(events.some((e) => e.type === 'ask_user')).toBe(false);
    expect(events.some((e) => e.type === 'tool_use')).toBe(true);
  });

  it('skips ask_user when there are no renderable questions', () => {
    const parser = new ClaudeParser();
    expect(
      parser
        .parseLine(toolUseLine('AskUserQuestion', { questions: [] }))
        .some((e) => e.type === 'ask_user'),
    ).toBe(false);
    expect(
      parser.parseLine(toolUseLine('AskUserQuestion', {})).some((e) => e.type === 'ask_user'),
    ).toBe(false);
  });

  it('drops options without a label but keeps the question', () => {
    const parser = new ClaudeParser();
    const input = {
      questions: [{ question: 'q?', options: [{ description: 'no label' }, { label: 'ok' }] }],
    };
    const ask = parser
      .parseLine(toolUseLine('AskUserQuestion', input))
      .find((e) => e.type === 'ask_user');
    if (ask?.type !== 'ask_user') throw new Error('expected an ask_user event');
    expect(ask.questions[0]!.options.map((o) => o.label)).toEqual(['ok']);
  });
});
