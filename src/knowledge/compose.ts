import { renderInjection, selectInjection } from './injection.js';
import type { KnowledgeStore } from './store.js';
import { KNOWLEDGE_DOCS, type FreshnessPolicy, type KnowledgeDoc } from './types.js';

// Default per-prompt knowledge budget (chars). Selective injection never dumps the whole
// knowledge tree — it fits the highest-priority docs (runbook > pitfalls > conventions > map)
// into this budget and flags what it dropped. Env-tunable upstream if needed.
export const KNOWLEDGE_BUDGET_CHARS = 6000;

// Compose the repo-knowledge block injected into a worker prompt (R16, Stage 5 live half): read
// the four docs, assess freshness against the repo's live HEAD, run the budget-bounded selective
// injection, and render. Returns undefined when the repo has no indexed knowledge (graceful — the
// worker prompt simply omits the block). Stale knowledge is still injected, flagged not dropped
// (R16.AC-4), so a worker can use it with a caveat while a re-index is pending. The cold-index run
// that FILLS these docs is the live half (Stage 7); this is the read+inject side.
export function composeRepoKnowledge(
  deps: { store: KnowledgeStore; policy: FreshnessPolicy; budgetChars: number; now: () => number },
  repoKey: string,
  repoPath: string,
): string | undefined {
  const docs: Partial<Record<KnowledgeDoc, string>> = {};
  let any = false;
  for (const doc of KNOWLEDGE_DOCS) {
    const content = deps.store.readDoc(repoKey, doc);
    if (content && content.trim().length > 0) {
      docs[doc] = content;
      any = true;
    }
  }
  if (!any) return undefined; // never-indexed → no git read, no block.

  const verdict = deps.store.assess(repoKey, repoPath, deps.policy, deps.now());
  const injection = selectInjection({
    repoKey,
    docs,
    stale: !verdict.fresh,
    budgetChars: deps.budgetChars,
  });
  const rendered = renderInjection(injection);
  return rendered.trim().length > 0 ? rendered : undefined;
}
