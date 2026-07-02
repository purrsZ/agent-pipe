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

/** Dirty = any tracked change or untracked file (`git status --porcelain` non-empty). */
export function worktreeIsDirty(worktreePath: string): boolean {
  return git(worktreePath, ['status', '--porcelain']).trim().length > 0;
}

/**
 * WS-7 交付清单：worktree 相对 base 的改动概览（`git diff --stat <base>...HEAD`）。worktree 已清理 /
 * 命令失败 → 返回占位串，不抛（交付清单是尽力而为，不该因一个仓读不到而崩掉整份清单）。
 */
export function worktreeDiffStat(worktreePath: string, base: string): string {
  try {
    const out = git(worktreePath, ['diff', '--stat', `${base}...HEAD`]).trim();
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

function mainRepoOf(worktreePath: string): string {
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
