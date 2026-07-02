import * as fs from 'node:fs';
import * as path from 'node:path';
import { worktreeRemove } from '../../agents/worktree.js';

interface GcLogger {
  info(o: unknown, m?: string): void;
  warn(o: unknown, m?: string): void;
  error(o: unknown, m?: string): void;
}

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const DEFAULT_OLDER_THAN_MS = 7 * 24 * 60 * 60 * 1000; // 终态单 7 天后清 worktree
const ORPHAN_OLDER_THAN_MS = 30 * 24 * 60 * 60 * 1000; // DB 里查不到的孤目录 30 天才清

// WS-7.4 worktree 每日 GC：终态（done/failed/cancelled）且 updatedAt 早于 olderThanMs 的单 → 删其 worktree
// （分支永远保留，worktree.ts:51-54 语义：git worktree remove --force 只删检出、留分支）。DB 里查不到的孤目录
// （DB 重置过）→ 30 天才删并 log 警示。删盘不进事件流（容器 terminal 时已丢弃 effects），故走每日任务而非
// transition。永不抛：单目录失败只 log，不拖累其它。
export function runWorktreeGc(deps: {
  store: { getWorkItem(id: string): { status: string; updatedAt: number } | undefined };
  worktreesDir: string;
  logger: GcLogger;
  now?: number;
  olderThanMs?: number;
}): { removed: number; kept: number } {
  const now = deps.now ?? Date.now();
  const olderThan = deps.olderThanMs ?? DEFAULT_OLDER_THAN_MS;
  let removed = 0;
  let kept = 0;

  let entries: string[];
  try {
    entries = fs.readdirSync(deps.worktreesDir);
  } catch {
    return { removed: 0, kept: 0 }; // 目录还没建
  }

  for (const workitemId of entries) {
    const dir = path.join(deps.worktreesDir, workitemId);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const item = deps.store.getWorkItem(workitemId);
    if (!item) {
      // 孤目录：DB 无此 workitem（DB 重置过）→ 30 天才删。
      if (now - dirMtime(dir, now) >= ORPHAN_OLDER_THAN_MS) {
        deps.logger.warn({ dir }, 'worktree gc: removing orphan dir (no workitem in DB)');
        purgeDir(dir, deps.logger);
        removed++;
      } else {
        kept++;
      }
      continue;
    }
    if (!TERMINAL.has(item.status) || now - item.updatedAt < olderThan) {
      kept++;
      continue;
    }
    // 终态且够老 → 先对每个叶子 worktree（结构 <workitemId>/<sanitizedRepo>/<runId>）跑 worktree remove（清 git
    // 注册、留分支），再整目录兜底删。
    for (const wt of leafWorktrees(dir)) {
      try {
        worktreeRemove(wt);
      } catch (err) {
        deps.logger.warn({ err, wt }, 'worktree gc: worktree remove failed, will rm dir');
      }
    }
    purgeDir(dir, deps.logger);
    removed++;
  }

  deps.logger.info({ removed, kept, worktreesDir: deps.worktreesDir }, 'worktree gc done');
  return { removed, kept };
}

// 叶子 worktree 路径 = worktreesDir/<workitemId>/<sanitizedRepo>/<runId>（worktreePathFor 的结构）。
function leafWorktrees(itemDir: string): string[] {
  const out: string[] = [];
  let repos: string[];
  try {
    repos = fs.readdirSync(itemDir);
  } catch {
    return out;
  }
  for (const repo of repos) {
    const repoDir = path.join(itemDir, repo);
    let runs: string[];
    try {
      if (!fs.statSync(repoDir).isDirectory()) continue;
      runs = fs.readdirSync(repoDir);
    } catch {
      continue;
    }
    for (const run of runs) {
      const leaf = path.join(repoDir, run);
      try {
        if (fs.statSync(leaf).isDirectory()) out.push(leaf);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

function purgeDir(dir: string, logger: GcLogger): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    logger.error({ err, dir }, 'worktree gc: rm dir failed');
  }
}

function dirMtime(dir: string, fallback: number): number {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return fallback;
  }
}
