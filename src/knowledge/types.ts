// Repo knowledge layer (D-08/D-16) — its own layer, organised by repo key, never by work
// item. Each repo gets four docs + a manifest; the whole $DATA_DIR/knowledge/ tree is one
// git repo. These types are the SSOT (internal-apis has no knowledge section — it is
// independent of the workitems/worktypes/kernel改造清单).

export type KnowledgeDoc = 'map' | 'conventions' | 'runbook' | 'pitfalls';

export const KNOWLEDGE_DOCS: KnowledgeDoc[] = ['map', 'conventions', 'runbook', 'pitfalls'];

// Per-repo index manifest (lives alongside the docs, git-tracked).
export interface RepoKnowledge {
  repoKey: string;
  generatedAtCommit: string; // 🔑 freshness anchor — the repo HEAD when knowledge was built
  generatedAt: number; // epoch ms
  docs: Record<KnowledgeDoc, string>; // relative paths within the knowledge repo
}

export interface FreshnessVerdict {
  repoKey: string;
  fresh: boolean; // false → mark stale, trigger rebuild
  commitsBehind: number;
  daysSince: number;
  reason?: 'commits-exceeded' | 'days-exceeded' | 'missing' | 'never-indexed';
}

// Empirical defaults (DEFER-3) — env-tunable, calibrated in production, never from one sample.
export interface FreshnessPolicy {
  maxCommitsBehind: number; // default 200
  maxDaysSince: number; // default 30
}

// Selective injection (R16.AC-2): by repo, bounded by a budget — never the whole knowledge.
export interface KnowledgeInjection {
  repoKey: string;
  sections: Array<{ doc: KnowledgeDoc; content: string }>;
  stale: boolean; // injected even if stale, but flagged so the worker/owner knows
  truncatedByBudget: boolean; // hit the injection budget, some docs dropped
}
