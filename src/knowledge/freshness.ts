import type { FreshnessPolicy, FreshnessVerdict, RepoKnowledge } from './types.js';

// Pure freshness assessment (R16.AC-4). Staleness here means "the TARGET repo's git history
// drifted past a threshold since knowledge was built" (commits / days) — NOT a contract
// structural diff (orthogonal dimension, see knowledge-layer domain). Inputs are already
// measured; the git reads live in KnowledgeStore.

export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = {
  maxCommitsBehind: 200,
  maxDaysSince: 30,
};

export function loadFreshnessPolicy(
  env: Partial<Record<string, string | undefined>> = process.env,
): FreshnessPolicy {
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const v = Number(raw);
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${name} must be a positive integer`);
    return v;
  };
  return {
    maxCommitsBehind: num('KNOWLEDGE_STALE_MAX_COMMITS', DEFAULT_FRESHNESS_POLICY.maxCommitsBehind),
    maxDaysSince: num('KNOWLEDGE_STALE_MAX_DAYS', DEFAULT_FRESHNESS_POLICY.maxDaysSince),
  };
}

export function assessFreshness(
  repoKey: string,
  manifest: RepoKnowledge | undefined,
  head: { commitsBehind: number; daysSince: number } | undefined,
  policy: FreshnessPolicy,
): FreshnessVerdict {
  if (!manifest) {
    return { repoKey, fresh: false, commitsBehind: 0, daysSince: 0, reason: 'never-indexed' };
  }
  if (!head) {
    return { repoKey, fresh: false, commitsBehind: 0, daysSince: 0, reason: 'missing' };
  }
  if (head.commitsBehind > policy.maxCommitsBehind) {
    return { repoKey, fresh: false, ...head, reason: 'commits-exceeded' };
  }
  if (head.daysSince > policy.maxDaysSince) {
    return { repoKey, fresh: false, ...head, reason: 'days-exceeded' };
  }
  return { repoKey, fresh: true, ...head };
}
