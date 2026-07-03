import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreeAdd, worktreeDiffStat, worktreePathFor } from '../../src/agents/worktree.js';

// F1（审查修复）：交付清单 diffstat 基线。worktree 分支从主仓 HEAD fork，worktree 内 HEAD 即工作分支本身，
// 旧实现默认 base='HEAD' → `HEAD...HEAD` 恒空 → 永远「(无改动)」。缺省基线改取主仓 HEAD，三点自动取 merge-base。

let tmpDir: string;
let repoPath: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-diffstat-'));
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

describe('worktreeDiffStat 缺省基线 = 主仓 HEAD（审查修复 F1）', () => {
  it('不传 base → 输出含改动文件名、非「(无改动)」', () => {
    const wt = worktreePathFor(tmpDir, 'scope1', 'run1', 'repo');
    worktreeAdd(repoPath, wt, 'feature/x', 'main');
    // worktree 内改文件并 commit（模拟 worker 施工）
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'new work\n');
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-m', 'work']);

    const stat = worktreeDiffStat(wt);
    expect(stat).not.toBe('(无改动)');
    expect(stat).toContain('feature.txt');
  });

  it('主仓 fork 后再前进一格 → diffstat 不变（三点 merge-base 语义钉死）', () => {
    const wt = worktreePathFor(tmpDir, 'scope2', 'run2', 'repo');
    worktreeAdd(repoPath, wt, 'feature/y', 'main');
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'new work\n');
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-m', 'work']);
    const before = worktreeDiffStat(wt);

    // 主仓 main 前进一格（与 worktree 无关的提交）
    fs.writeFileSync(path.join(repoPath, 'other.txt'), 'unrelated\n');
    git(repoPath, ['add', '-A']);
    git(repoPath, ['commit', '-m', 'main advances']);

    const after = worktreeDiffStat(wt);
    expect(after).toBe(before); // 三点取共同祖先，主仓前进不影响
    expect(after).not.toContain('other.txt'); // 主仓新增文件不算进 worktree 改动
    expect(after).toContain('feature.txt');
  });

  it('worktree 目录删除 → 返回占位串（既有降级语义不回归）', () => {
    const wt = worktreePathFor(tmpDir, 'scope3', 'run3', 'repo');
    worktreeAdd(repoPath, wt, 'feature/z', 'main');
    fs.rmSync(wt, { recursive: true, force: true });
    expect(worktreeDiffStat(wt)).toBe('(worktree 已清理或不可读)');
  });
});
