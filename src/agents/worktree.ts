import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Git worktree lifecycle — a kernel-neutral subsystem (D-27). A "worktree" is a real,
 * isolated checkout of a target repo where a write-profile run mutates code; it is NOT the
 * artifact repo (reports / contracts live there, managed by ArtifactStore — D-20). Two
 * separate path spaces, never mixed.
 *
 * Naming stays neutral (no upper-layer business vocabulary) so the kernel red-line holds:
 * callers pass opaque id strings; this layer only does paths + git. The reset path is a
 * disk-mutating operation — getting it wrong destroys real code output — so `clean` is
 * scoped to caller-named directories, never a blanket `-fd .` that would also delete
 * untracked-but-useful files.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Deterministic, recyclable worktree path. cwd AND the write-profile's writableDirs are
 * both derived from this single function so they always agree and move together
 * (R05.AC-7). Deviation from internal-apis §1.3: a leading `baseDir` is added (the kernel
 * has no implicit worktree root) — callers pass the configured root.
 */
export function worktreePathFor(
  baseDir: string,
  scopeId: string,
  runId: string,
  repo: string,
): string {
  return path.join(baseDir, scopeId, sanitize(repo), runId);
}

function sanitize(repo: string): string {
  // A repo key may be a path or url; reduce to a stable directory-safe leaf.
  return repo.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'repo';
}

/** `git worktree add -b <branch> <worktreePath> <base>` — branch a fresh checkout off base. */
export function worktreeAdd(
  repoPath: string,
  worktreePath: string,
  branch: string,
  base: string,
): void {
  git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, base]);
}

/** `git worktree remove --force` — drop the checkout; the branch is KEPT (R05.AC-3). */
export function worktreeRemove(worktreePath: string): void {
  const repoPath = mainRepoOf(worktreePath);
  git(repoPath, ['worktree', 'remove', '--force', worktreePath]);
}

/**
 * `git worktree prune` — drop stale administrative registrations under the main repo's
 * `.git/worktrees/` for checkouts whose directory was removed out-of-band (e.g. a GC fell
 * back to `rm` when `worktree remove` failed). Keeps same-path/same-branch reuse from tripping.
 */
export function worktreePrune(repoPath: string): void {
  git(repoPath, ['worktree', 'prune']);
}

/** Dirty = any tracked change or untracked file (`git status --porcelain` non-empty). */
export function worktreeIsDirty(worktreePath: string): boolean {
  return git(worktreePath, ['status', '--porcelain']).trim().length > 0;
}

/**
 * VERIFY V1（#5+R5 交付完整性）：`git add -A && git commit -m <message>` —— 把 worktree 全部改动
 * （含 untracked）提交到其当前分支。交付链假设 worker 会提交但契约没长牙——本函数是兜底（afterRun /
 * GC 前）把「未提交产出」变成分支上持久的 commit：交付清单读得到真 diff、GC 不再吞产出。仅在
 * `worktreeIsDirty` 为真时调用（clean 时提交会以 nonzero 退出抛错）。不 push、不建 MR（分支即唯一交付物）。
 */
export function worktreeCommitAll(worktreePath: string, message: string): void {
  git(worktreePath, ['add', '-A']);
  git(worktreePath, ['commit', '-m', message]);
}

/**
 * VERIFY V1（R5 血统续接）：`git rev-parse --verify --quiet refs/heads/<branch>` —— 分支是否存在。
 * 换轮新 worktree 以上一轮 worker 分支为 base 前，先确认那条分支真在（上一轮可能被 GC 删了 worktree
 * 但分支永远保留，故一般都在；防御式判空回落 HEAD）。不存在 → git 非零退出 → 抛 → catch 返回 false。
 */
export function branchExists(repoPath: string, branch: string): boolean {
  try {
    git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * WS-7 交付清单：worktree 相对 base 的改动概览（`git diff --stat <base>...HEAD`，三点自动取 merge-base）。
 * base 缺省时以主仓当前 HEAD 为基线——worktree 分支从主仓 HEAD fork，其自身 HEAD 即工作分支本身，
 * `HEAD...HEAD` 恒空；取主仓 HEAD 才拿得到真实改动，且主仓 fork 后又前进也不影响（三点取共同祖先）。
 * worktree 已清理 / 命令失败 → 返回占位串，不抛（交付清单尽力而为，不该因一个仓读不到而崩掉整份清单）。
 */
export function worktreeDiffStat(worktreePath: string, base?: string): string {
  try {
    const resolved = base ?? git(mainRepoOf(worktreePath), ['rev-parse', 'HEAD']).trim();
    const out = git(worktreePath, ['diff', '--stat', `${resolved}...HEAD`]).trim();
    return out || '(无改动)';
  } catch {
    return '(worktree 已清理或不可读)';
  }
}

/**
 * Reset the checkout back to a clean baseline before a redispatch (R05.AC-5/AC-8). Hard
 * reset to base, then `git clean -fd` scoped to cleanDirs ONLY — never the whole tree, so
 * untracked-but-useful files outside the known output dirs survive (D-27 risk note).
 */
export function worktreeReset(worktreePath: string, base: string, cleanDirs: string[]): void {
  git(worktreePath, ['reset', '--hard', base]);
  if (cleanDirs.length > 0) {
    git(worktreePath, ['clean', '-fd', '--', ...cleanDirs]);
  }
}

export function mainRepoOf(worktreePath: string): string {
  // common-dir points at the shared `.git` of the primary checkout; its parent is the repo
  // toplevel. Running `worktree remove` from there avoids "cannot run from the worktree
  // being removed".
  const commonDir = git(worktreePath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]).trim();
  return path.dirname(commonDir);
}
