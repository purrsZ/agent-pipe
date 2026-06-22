import type { Decision, WorkItemEvent } from '../../workitems/types.js';

// contract-engine (worktypes layer; pure sync — no async/await/fs/child_process). The full
// structure (ContractInterface / ContractSnapshot / ContractDiff / repoOf /
// contractStructuralDiff / computeImpact) lands in Stage 4. The skeleton ships only the
// stale predicate the worktype declares on `isDecisionStale`.
//
// isRequirementDecisionStale judges ONLY decision.data (the固化 contract fingerprint) +
// eventsSince — never reads fs (it runs inside the synchronous reducer). Stage 3 has no
// frozen contract yet, so it is conservatively never-stale; Stage 4 compares fingerprints
// + detects contract_change_applied touching the same repo (D-05).
export function isRequirementDecisionStale(
  _decision: Decision,
  _eventsSince: WorkItemEvent[],
): boolean {
  return false;
}
