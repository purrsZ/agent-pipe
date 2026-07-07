import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, mcpModeOf, resolveMcpConfig } from '../../src/agents/claude/runner.js';

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

// VERIFY V4（#2）：MCP 三分语义——undefined=继承（无 config/无 strict）；[]=严格空（写空 config + strict）；
// 非空=严格指定集。此前 [] 与 undefined 同等对待 → managed worker 空数组也没收窄 → 继承用户全局 MCP。
describe('resolveMcpConfig / mcpModeOf 三分语义 (VERIFY V4)', () => {
  it('undefined → 继承：config=null（无 --mcp-config → 无 --strict-mcp-config）', () => {
    expect(resolveMcpConfig(undefined)).toBeNull();
    expect(mcpModeOf(undefined)).toBe('inherit');
    // 无 config path → buildClaudeArgs 不带 strict 标志。
    const args = buildClaudeArgs({ model: 'm', effort: 'high', sessionId: null });
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('显式 [] → 严格空：config={"mcpServers":{}}（有 config → 带 --strict-mcp-config）', () => {
    expect(resolveMcpConfig([])).toEqual({ mcpServers: {} });
    expect(mcpModeOf([])).toBe('strict-empty');
    // 有 config path → buildClaudeArgs 带 strict 标志（子进程不继承任何用户 MCP）。
    const args = buildClaudeArgs({
      model: 'm',
      effort: 'high',
      sessionId: null,
      mcpConfigPath: '/tmp/empty-mcp.json',
    });
    expect(args).toContain('--strict-mcp-config');
  });

  it('非空 → 严格指定集：config 含该 server（照旧）', () => {
    const cfg = resolveMcpConfig([
      { name: 'lark', command: 'lark-cli', args: ['serve'], env: { TOKEN: 'x' } },
    ]);
    expect(cfg).toEqual({
      mcpServers: { lark: { command: 'lark-cli', args: ['serve'], env: { TOKEN: 'x' } } },
    });
    expect(mcpModeOf([{ name: 'lark', command: 'lark-cli' }])).toBe('strict-set');
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

describe('buildClaudeArgs readableDirs (read-widening, any profile)', () => {
  it('readonly + readableDirs: --add-dir each repo so a multi-repo 包工头 can read beyond cwd', () => {
    const args = buildClaudeArgs({
      model: 'm',
      effort: 'high',
      sessionId: null,
      readonly: true,
      readableDirs: ['/repos/pos', '/repos/portal'],
    });
    // 仍是只读：写工具被 deny、无 blanket bypass。
    expect(args).toContain('--disallowedTools');
    expect(args).not.toContain('--dangerously-skip-permissions');
    // 每个仓都 --add-dir 进来。
    expect(
      args.findIndex((a, i) => a === '--add-dir' && args[i + 1] === '/repos/pos'),
    ).toBeGreaterThanOrEqual(0);
    expect(
      args.findIndex((a, i) => a === '--add-dir' && args[i + 1] === '/repos/portal'),
    ).toBeGreaterThanOrEqual(0);
  });

  it('no readableDirs → no extra --add-dir (zero regression)', () => {
    const args = buildClaudeArgs({ model: 'm', effort: 'high', sessionId: null, readonly: true });
    expect(args).not.toContain('--add-dir');
  });
});

describe('buildClaudeArgs write profile (D-04)', () => {
  it('adds --add-dir per writable dir + --settings, and NEVER --dangerously-skip-permissions', () => {
    const args = buildClaudeArgs({
      model: 'm',
      effort: 'high',
      sessionId: null,
      writableDirs: ['/wt/a', '/wt/b'],
      guardSettingsPath: '/tmp/guard.settings.json',
    });
    expect(args).not.toContain('--dangerously-skip-permissions'); // R04.AC-6: never full
    expect(args).not.toContain('--disallowedTools'); // hook is the constraint, not a deny list
    // both dirs declared
    const addDirIdxA = args.findIndex((a, i) => a === '--add-dir' && args[i + 1] === '/wt/a');
    const addDirIdxB = args.findIndex((a, i) => a === '--add-dir' && args[i + 1] === '/wt/b');
    expect(addDirIdxA).toBeGreaterThanOrEqual(0);
    expect(addDirIdxB).toBeGreaterThanOrEqual(0);
    const si = args.indexOf('--settings');
    expect(args[si + 1]).toBe('/tmp/guard.settings.json');
  });

  it('write composes with --mcp-config and --resume', () => {
    const args = buildClaudeArgs({
      model: 'm',
      effort: 'high',
      sessionId: 's1',
      mcpConfigPath: '/tmp/c.json',
      writableDirs: ['/wt/a'],
      guardSettingsPath: '/tmp/g.json',
    });
    expect(args).toContain('--add-dir');
    expect(args).toContain('--mcp-config');
    expect(args.slice(-2)).toEqual(['--resume', 's1']);
  });
});
