import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worktreeAdd, worktreePathFor } from '../../src/agents/worktree.js';
import { branchFor } from '../../src/worktypes/requirement/branch.js';
import { runWorktreeGc } from '../../src/worktypes/requirement/worktree-gc.js';
import { makeWorkItem } from '../helpers/workitems.js';

// WS-7.4 worktree 每日 GC：终态且 7 天以上 → 删；非终态 / 未到期 → 留；孤目录 30 天才删。分支保留（这里只测目录去留）。

let tmpDir: string;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-wtgc-'));
  vi.clearAllMocks();
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkItemDir(id: string): string {
  const dir = path.join(tmpDir, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeStore(items: Record<string, { status: string; updatedAt: number }>) {
  return { getWorkItem: (id: string) => items[id] };
}

describe('runWorktreeGc (WS-7.4)', () => {
  it('终态且 8 天前 → 删目录', () => {
    mkItemDir('wi-old');
    const r = runWorktreeGc({
      store: fakeStore({ 'wi-old': { status: 'done', updatedAt: NOW - 8 * DAY } }),
      worktreesDir: tmpDir,
      logger,
      now: NOW,
    });
    expect(fs.existsSync(path.join(tmpDir, 'wi-old'))).toBe(false);
    expect(r.removed).toBe(1);
  });

  it('终态但未到期（3 天）→ 留', () => {
    mkItemDir('wi-fresh');
    runWorktreeGc({
      store: fakeStore({ 'wi-fresh': { status: 'done', updatedAt: NOW - 3 * DAY } }),
      worktreesDir: tmpDir,
      logger,
      now: NOW,
    });
    expect(fs.existsSync(path.join(tmpDir, 'wi-fresh'))).toBe(true);
  });

  it('非终态（active）即便很老也留', () => {
    mkItemDir('wi-active');
    runWorktreeGc({
      store: fakeStore({ 'wi-active': { status: 'active', updatedAt: NOW - 30 * DAY } }),
      worktreesDir: tmpDir,
      logger,
      now: NOW,
    });
    expect(fs.existsSync(path.join(tmpDir, 'wi-active'))).toBe(true);
  });

  it('孤目录（DB 无此单）默认 30 天内不删', () => {
    mkItemDir('wi-orphan'); // mtime = now-ish（刚建）
    const r = runWorktreeGc({
      store: fakeStore({}),
      worktreesDir: tmpDir,
      logger,
      now: NOW + 1000, // 目录刚建，远不到 30 天
    });
    expect(fs.existsSync(path.join(tmpDir, 'wi-orphan'))).toBe(true);
    expect(r.kept).toBe(1);
  });

  it('worktreesDir 不存在 → 返回 0/0 不抛', () => {
    expect(() =>
      runWorktreeGc({
        store: fakeStore({}),
        worktreesDir: path.join(tmpDir, 'nope'),
        logger,
        now: NOW,
      }),
    ).not.toThrow();
  });
});

// VERIFY V1（#5）：GC 删除前对未提交 worktree 兜底提交（宁留勿丢的最后一道防线：worker 从没成功收尾过时）。
describe('runWorktreeGc 删除前兜底提交 (VERIFY V1)', () => {
  let root: string;
  let repoPath: string;
  let worktreesDir: string;

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-wtgc-commit-'));
    repoPath = path.join(root, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    git(repoPath, ['init', '-b', 'main']);
    git(repoPath, ['config', 'user.email', 't@t']);
    git(repoPath, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'base\n');
    git(repoPath, ['add', '-A']);
    git(repoPath, ['commit', '-m', 'base']);
    worktreesDir = path.join(root, 'worktrees');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function addWorktree(workitemId: string, assignmentId: string): { wt: string; branch: string } {
    const branch = branchFor(makeWorkItem(workitemId, { repos: [repoPath] }), {
      id: assignmentId,
      repo: repoPath,
    });
    const wt = worktreePathFor(worktreesDir, workitemId, assignmentId, repoPath);
    worktreeAdd(repoPath, wt, branch, 'HEAD');
    return { wt, branch };
  }

  it('dirty worktree → 先兜底提交到分支再删；分支保留且含未提交产出', () => {
    const workitemId = 'wi-gc1';
    const { wt, branch } = addWorktree(workitemId, 'as-gc100000');
    fs.writeFileSync(path.join(wt, 'produced.ts'), 'export const p = 1;\n'); // 未提交产出

    const r = runWorktreeGc({
      store: fakeStore({ [workitemId]: { status: 'done', updatedAt: NOW - 8 * DAY } }),
      worktreesDir,
      logger,
      now: NOW,
    });

    expect(fs.existsSync(path.join(worktreesDir, workitemId))).toBe(false); // 目录已删
    expect(r.removed).toBe(1);
    // 分支保留 + 兜底提交落在分支上（未提交产出没被 GC 吞掉）。
    expect(git(repoPath, ['log', '--oneline', branch])).toContain('GC 前兜底提交');
    expect(git(repoPath, ['show', '--stat', branch])).toContain('produced.ts');
  });

  it('clean worktree → 直接删，不产生空提交', () => {
    const workitemId = 'wi-gc2';
    const { branch } = addWorktree(workitemId, 'as-gc200000');
    const before = git(repoPath, ['rev-list', '--count', branch]).trim();

    const r = runWorktreeGc({
      store: fakeStore({ [workitemId]: { status: 'done', updatedAt: NOW - 8 * DAY } }),
      worktreesDir,
      logger,
      now: NOW,
    });

    expect(r.removed).toBe(1);
    expect(git(repoPath, ['rev-list', '--count', branch]).trim()).toBe(before); // 无兜底提交
  });

  it('兜底提交失败 → 不删该 worktree + 保留整目录 + warn（宁留勿丢）', () => {
    const workitemId = 'wi-gc3';
    const { wt } = addWorktree(workitemId, 'as-gc300000');
    fs.writeFileSync(path.join(wt, 'produced.ts'), 'export const p = 1;\n'); // dirty
    // 装一个必失败的 pre-commit 钩子（跨环境稳定地让 git commit 抛错，不依赖全局 git 身份）。
    const hooksDir = path.join(root, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const hook = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    git(repoPath, ['config', 'core.hooksPath', hooksDir]);

    const r = runWorktreeGc({
      store: fakeStore({ [workitemId]: { status: 'done', updatedAt: NOW - 8 * DAY } }),
      worktreesDir,
      logger,
      now: NOW,
    });

    expect(fs.existsSync(wt)).toBe(true); // 这个 worktree 没删
    expect(fs.existsSync(path.join(worktreesDir, workitemId))).toBe(true); // 整目录保留
    expect(r.removed).toBe(0);
    expect(r.kept).toBe(1);
    expect(logger.warn).toHaveBeenCalled(); // 有 warn（宁留勿丢）
  });
});
