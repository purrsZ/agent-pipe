import type { KnowledgeDoc, KnowledgeInjection } from './types.js';

// Selective injection with a budget (R16.AC-2). Priority: runbook (self-test commands are
//刚需) > pitfalls (avoid traps) > conventions > map (usually large, truncated first). Pure
// — the worker-runtime calls this when composing the worker prompt.
const PRIORITY: KnowledgeDoc[] = ['runbook', 'pitfalls', 'conventions', 'map'];

export function selectInjection(input: {
  repoKey: string;
  docs: Partial<Record<KnowledgeDoc, string>>;
  stale: boolean;
  budgetChars: number;
}): KnowledgeInjection {
  const sections: Array<{ doc: KnowledgeDoc; content: string }> = [];
  let used = 0;
  let truncatedByBudget = false;
  for (const doc of PRIORITY) {
    const content = input.docs[doc];
    if (content === undefined || content.length === 0) continue;
    if (used + content.length <= input.budgetChars) {
      sections.push({ doc, content });
      used += content.length;
    } else {
      // Doesn't fit — drop it (whole-doc, not partial, to avoid半截文档误导) and flag.
      truncatedByBudget = true;
    }
  }
  return { repoKey: input.repoKey, sections, stale: input.stale, truncatedByBudget };
}

// Render the selected sections into a prompt block (consumed by composeWorkerPrompt).
export function renderInjection(injection: KnowledgeInjection): string {
  if (injection.sections.length === 0) return '';
  const head = injection.stale ? '（注意：以下知识可能已过时，仅供参考）\n' : '';
  const body = injection.sections.map((s) => `## ${s.doc}\n${s.content}`).join('\n\n');
  return head + body;
}
