import { describe, expect, it } from 'vitest';
import { buildCodexArgs } from '../../src/agents/codex/runner.js';

describe('buildCodexArgs (WI-A)', () => {
  it('matches the legacy fresh-session vector byte-for-byte', () => {
    expect(buildCodexArgs({ model: 'gpt-5.1-codex', sessionId: null })).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--model',
      'gpt-5.1-codex',
      '--dangerously-bypass-approvals-and-sandbox',
      '-',
    ]);
  });

  it('matches the legacy resume vector byte-for-byte', () => {
    expect(buildCodexArgs({ model: 'gpt', sessionId: 'thread-1' })).toEqual([
      'exec',
      'resume',
      'thread-1',
      '--json',
      '--skip-git-repo-check',
      '--model',
      'gpt',
      '--dangerously-bypass-approvals-and-sandbox',
      '-',
    ]);
  });

  it('adds reasoning effort -c when present', () => {
    expect(buildCodexArgs({ model: 'gpt', sessionId: null, reasoningEffort: 'high' })).toContain(
      'model_reasoning_effort=high',
    );
  });

  it('omits --model when null', () => {
    expect(buildCodexArgs({ model: null, sessionId: null })).not.toContain('--model');
  });
});
