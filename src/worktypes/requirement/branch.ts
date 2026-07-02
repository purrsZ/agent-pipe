import type { WorkItem } from '../../workitems/types.js';

// WS-7：worker worktree 的分支名。worker-handler（建 worktree 时）与 deliver.ts（交付清单）共用同一份，
// 避免两处推导漂移导致交付清单里的分支名对不上真实分支。纯函数。
export function branchFor(
  workitem: WorkItem,
  assignment: { id: string; repo: string | null },
): string {
  const repo = (assignment.repo ?? 'repo').replace(/[^A-Za-z0-9._-]+/g, '-');
  return `req/${workitem.id.slice(3, 15)}/${repo}-${assignment.id.slice(3, 11)}`;
}
