import * as fs from 'node:fs';
import { worktreeDiffStat, worktreePathFor } from '../../agents/worktree.js';
import type { EffectContext, EffectHandler } from '../../workitems/effects.js';
import { branchFor } from './branch.js';

const MAX_SUMMARY_CHARS = 3000;
const TRUNCATE_SUFFIX = '\n\n…（已截断，全文见 delivery/manifest.md）';

// WS-7 交付最后一公里（D-I）：不自动 MR / 不自动 push（平台差异 + 出站发布需人手），但给全每仓的分支名、
// diffstat、本地接手命令、push 命令，让飞书里看得见产物落在哪。灯③ 拍板前就生成好，人拍板即见。
// recovery:'rerun'（纯读 git + 写 artifact，幂等）。
export function createDeliverManifestHandler(opts: {
  worktreesDir: string;
  baseRef?: string;
}): EffectHandler {
  return {
    kind: 'deliver_manifest',
    recovery: 'rerun',
    run: (ctx) => deliverManifest(ctx, opts),
  };
}

interface RepoDelivery {
  repo: string;
  assignmentId: string;
  reportPath: string;
}

async function deliverManifest(
  ctx: EffectContext,
  opts: { worktreesDir: string; baseRef?: string },
): Promise<void> {
  // 每仓取最后一条 worker run_completed（多轮 fix/rework 后以最终为准）。
  const byRepo = new Map<string, RepoDelivery>();
  for (const ev of ctx.eventsSince(0)) {
    if (ev.kind !== 'run_completed') continue;
    const p = ev.payload;
    if (typeof p !== 'object' || p === null) continue;
    const o = p as Record<string, unknown>;
    if (o.role !== 'worker') continue;
    const repo = typeof o.repo === 'string' ? o.repo : '';
    const assignmentId = typeof o.assignmentId === 'string' ? o.assignmentId : '';
    if (!repo || !assignmentId) continue;
    const reportPath = typeof o.reportPath === 'string' ? o.reportPath : '';
    byRepo.set(repo, { repo, assignmentId, reportPath });
  }

  const sections: string[] = [`# 交付清单 · ${ctx.workitem.title}`];
  const repoBranches: Array<{ repo: string; branch: string }> = [];
  for (const d of byRepo.values()) {
    const branch = branchFor(ctx.workitem, { id: d.assignmentId, repo: d.repo });
    const wt = worktreePathFor(opts.worktreesDir, ctx.workitem.id, d.assignmentId, d.repo);
    // baseRef 缺省透传 undefined → worktreeDiffStat 以主仓 HEAD 为基线（三点 merge-base），
    // 避免 worktree 内 HEAD...HEAD 恒空导致「(无改动)」。
    const diffstat = worktreeDiffStat(wt, opts.baseRef);
    repoBranches.push({ repo: d.repo, branch });
    // VERIFY V1（#5）：接手命令随 worktree 是否仍在分流。worktree 还在时，分支正被这个 linked worktree
    // 占用，主仓直接 `git switch <branch>` 会「branch already checked out」失败——给工作副本路径 + 先移除
    // worktree 再 switch 的正确命令。已被 GC 清理 → 回落原来的主仓 switch。fs.existsSync 判断（effect handler
    // 允许 IO）。
    const handoffLines = fs.existsSync(wt)
      ? [
          `- 工作副本：cd ${wt}  （分支已在此 worktree 签出，改动就在这里）`,
          `- 主仓接手：git worktree remove ${wt} 后 cd ${d.repo} && git switch ${branch}（或等自动清理后直接 switch）`,
        ]
      : [`- 本地接手：cd ${d.repo} && git switch ${branch}`];
    sections.push(
      [
        `## ${d.repo}`,
        `- 分支：${branch} （已在主仓创建，worktree 删除后依然存在）`,
        `- 改动概览：${diffstat}`,
        `- 工人回执：${d.reportPath || '(无)'}`,
        ...handoffLines,
        `- 推送开 MR：git push origin ${branch} 后到代码平台发起 MR`,
      ].join('\n'),
    );
  }
  if (repoBranches.length === 0) {
    sections.push('（本单无 worker 施工记录，无交付产物）');
  }

  const full = sections.join('\n\n');
  ctx.writeArtifact('delivery/manifest.md', full, '交付清单');
  const summaryText =
    full.length > MAX_SUMMARY_CHARS
      ? full.slice(0, MAX_SUMMARY_CHARS - TRUNCATE_SUFFIX.length) + TRUNCATE_SUFFIX
      : full;
  ctx.emit('manifest_ready', { repos: repoBranches, summaryText });
}
