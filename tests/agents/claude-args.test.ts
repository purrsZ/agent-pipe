import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../../src/agents/claude/runner.js';

describe('buildClaudeArgs (WI-A)', () => {
  it('matches the legacy arg vector byte-for-byte with no options (zero regression)', () => {
    expect(buildClaudeArgs({ model: 'claude-opus', effort: 'high', sessionId: null })).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'claude-opus',
      '--effort',
      'high',
      '--dangerously-skip-permissions',
    ]);
  });

  it('appends --resume <id> last when a session exists (legacy)', () => {
    const args = buildClaudeArgs({ model: 'm', effort: 'high', sessionId: 'sess-1' });
    expect(args.slice(-2)).toEqual(['--resume', 'sess-1']);
  });

  it('injects --mcp-config (+ --strict-mcp-config) before --resume', () => {
    const args = buildClaudeArgs({
      model: 'm',
      effort: 'high',
      sessionId: 'sess-1',
      mcpConfigPath: '/tmp/cfg.json',
    });
    expect(args).toContain('--mcp-config');
    expect(args).toContain('/tmp/cfg.json');
    expect(args).toContain('--strict-mcp-config');
    expect(args.indexOf('--mcp-config')).toBeLessThan(args.indexOf('--resume'));
  });

  it('omits --mcp-config when no path is given (zero regression)', () => {
    expect(buildClaudeArgs({ model: 'm', effort: 'high', sessionId: null })).not.toContain(
      '--mcp-config',
    );
  });
});

describe('buildClaudeArgs readonly profile (WI-B)', () => {
  it('full (default) keeps --dangerously-skip-permissions and no deny list', () => {
    const args = buildClaudeArgs({ model: 'm', effort: 'high', sessionId: null });
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--disallowedTools');
  });

  it('readonly drops the blanket bypass and denies write tools deterministically', () => {
    const args = buildClaudeArgs({ model: 'm', effort: 'high', sessionId: null, readonly: true });
    expect(args).not.toContain('--dangerously-skip-permissions');
    const i = args.indexOf('--disallowedTools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('Write Edit MultiEdit NotebookEdit');
  });

  it('readonly still composes with --mcp-config and --resume', () => {
    const args = buildClaudeArgs({
      model: 'm',
      effort: 'high',
      sessionId: 's1',
      mcpConfigPath: '/tmp/c.json',
      readonly: true,
    });
    expect(args).toContain('--disallowedTools');
    expect(args).toContain('--mcp-config');
    expect(args.slice(-2)).toEqual(['--resume', 's1']);
  });
});
