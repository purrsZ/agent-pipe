import { describe, expect, it } from 'vitest';
import {
  buildWriteSettings,
  decideWriteGuard,
  renderWriteGuardScript,
} from '../../src/agents/claude/write-guard.js';

const DIRS = ['/work/wt-a', '/work/wt-b'];

describe('decideWriteGuard (PreToolUse path guard, D-04)', () => {
  it('allows Write inside a writable dir', () => {
    expect(decideWriteGuard('Write', { file_path: '/work/wt-a/src/x.ts' }, DIRS).allow).toBe(true);
  });

  it('denies Write outside every writable dir', () => {
    const v = decideWriteGuard('Write', { file_path: '/etc/passwd' }, DIRS);
    expect(v.allow).toBe(false);
    expect(v.reason).toContain('/etc/passwd');
  });

  it('denies Edit just outside the dir boundary (no prefix-escape)', () => {
    // /work/wt-abc must NOT count as inside /work/wt-a
    expect(decideWriteGuard('Edit', { file_path: '/work/wt-abc/x' }, DIRS).allow).toBe(false);
  });

  it('handles NotebookEdit via notebook_path', () => {
    expect(
      decideWriteGuard('NotebookEdit', { notebook_path: '/work/wt-b/n.ipynb' }, DIRS).allow,
    ).toBe(true);
  });

  it('denies a Bash redirect to an absolute path outside the dirs (DEFER-1 literal case)', () => {
    expect(decideWriteGuard('Bash', { command: 'echo x > /etc/evil' }, DIRS).allow).toBe(false);
  });

  it('allows a Bash redirect inside a writable dir', () => {
    expect(decideWriteGuard('Bash', { command: 'echo x > /work/wt-a/out.txt' }, DIRS).allow).toBe(
      true,
    );
  });

  it('allows relative-path commands (resolve against the worktree cwd)', () => {
    expect(decideWriteGuard('Bash', { command: 'echo x > out.txt' }, DIRS).allow).toBe(true);
  });

  it('allows read tools unconditionally', () => {
    expect(decideWriteGuard('Read', { file_path: '/etc/passwd' }, DIRS).allow).toBe(true);
    expect(decideWriteGuard('Grep', {}, DIRS).allow).toBe(true);
  });
});

describe('write-guard rendering', () => {
  it('bakes the dirs and embeds decideWriteGuard verbatim into the script', () => {
    const script = renderWriteGuardScript(DIRS);
    expect(script).toContain('WRITABLE_DIRS');
    expect(script).toContain('decideWriteGuard'); // single source of truth, embedded
    expect(script).toContain('permissionDecision');
    expect(script).toContain('node:path');
  });

  it('settings wire the guard for the path-bearing tools', () => {
    const settings = buildWriteSettings('/tmp/guard.mjs');
    const hook = settings.hooks.PreToolUse[0]!;
    expect(hook.matcher).toContain('Write');
    expect(hook.matcher).toContain('Bash');
    expect(hook.hooks[0]!.command).toContain('/tmp/guard.mjs');
  });
});
