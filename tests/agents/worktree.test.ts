import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  worktreeAdd,
  worktreeIsDirty,
  worktreePathFor,
  worktreePrune,
  worktreeRemove,
  worktreeReset,
} from '../../src/agents/worktree.js';

let tmpDir: string;
let repoPath: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-worktree-'));
  repoPath = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 't@t']);
  git(repoPath, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'base\n');
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-m', 'base']);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('worktree lifecycle (D-27)', () => {
  it('worktreePathFor is deterministic, neutral, and sanitises the repo key', () => {
    const p1 = worktreePathFor('/base', 'scope1', 'run1', 'git@host:org/repo.git');
    const p2 = worktreePathFor('/base', 'scope1', 'run1', 'git@host:org/repo.git');
    expect(p1).toBe(p2);
    expect(p1.startsWith(path.join('/base', 'scope1'))).toBe(true);
    expect(p1.endsWith('run1')).toBe(true);
    expect(p1).not.toContain(':'); // sanitised
  });

  it('adds a worktree on a fresh branch off base, detects dirty, resets, and removes (branch kept)', () => {
    const wt = worktreePathFor(tmpDir, 'scope1', 'run1', 'repo');
    worktreeAdd(repoPath, wt, 'feature/x', 'main');
    expect(fs.existsSync(path.join(wt, 'README.md'))).toBe(true);
    expect(worktreeIsDirty(wt)).toBe(false);

    // dirty: an untracked produced file + a tracked edit.
    fs.mkdirSync(path.join(wt, 'out'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'out', 'artifact.txt'), 'produced');
    fs.writeFileSync(path.join(wt, 'README.md'), 'edited\n');
    expect(worktreeIsDirty(wt)).toBe(true);

    // reset to baseline; clean only the known output dir.
    worktreeReset(wt, 'main', ['out']);
    expect(worktreeIsDirty(wt)).toBe(false);
    expect(fs.existsSync(path.join(wt, 'out', 'artifact.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(wt, 'README.md'), 'utf8')).toBe('base\n');

    // remove the checkout — the branch survives.
    worktreeRemove(wt);
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(repoPath, ['branch', '--list', 'feature/x'])).toContain('feature/x');
  });

  it('reset clean is scoped — untracked files outside cleanDirs survive (D-27 risk note)', () => {
    const wt = worktreePathFor(tmpDir, 'scope2', 'run2', 'repo');
    worktreeAdd(repoPath, wt, 'feature/y', 'main');
    fs.mkdirSync(path.join(wt, 'out'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'out', 'a.txt'), 'produced');
    fs.writeFileSync(path.join(wt, 'keep.txt'), 'untracked but useful');

    worktreeReset(wt, 'main', ['out']);
    expect(fs.existsSync(path.join(wt, 'out', 'a.txt'))).toBe(false); // cleaned
    expect(fs.existsSync(path.join(wt, 'keep.txt'))).toBe(true); // NOT clobbered
    worktreeRemove(wt);
  });

  it('worktreeAdd throws on a missing base (caller raises its hand, R05.AC-6)', () => {
    const wt = worktreePathFor(tmpDir, 'scope3', 'run3', 'repo');
    expect(() => worktreeAdd(repoPath, wt, 'feature/z', 'nonexistent-base')).toThrow();
  });

  // 审查修复 F4：worktreePrune 清主仓里工作目录已消失的陈旧注册（GC 里 worktreeRemove 失败降级 rm 后补的一手）。
  it('worktreePrune 清除工作目录已消失的陈旧注册，幂等不抛', () => {
    const wt = worktreePathFor(tmpDir, 'scopeP', 'runP', 'repo');
    worktreeAdd(repoPath, wt, 'feature/p', 'main');
    fs.rmSync(wt, { recursive: true, force: true }); // 模拟降级 rm：删工作目录、留主仓注册
    expect(git(repoPath, ['worktree', 'list'])).toContain(wt); // 陈旧注册仍在
    worktreePrune(repoPath);
    expect(git(repoPath, ['worktree', 'list'])).not.toContain(wt); // prune 清除
    expect(() => worktreePrune(repoPath)).not.toThrow(); // 再跑一次无残留也不抛
  });
});
