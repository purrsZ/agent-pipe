import type { ArtifactStore } from './artifacts.js';
import type { WorkitemsApi } from './api.js';
import type { WorkitemsStore } from './store.js';
import type { WorkItem } from './types.js';
import type { ItemSummary, ItemView, WorkbenchActions, WorkbenchData } from '../workbench/types.js';

// Bridges the neutral workbench (kernel) to the real container (workitems layer — business
// words allowed). Reads build the view-model from the five tables + artifact repo; writes
// funnel through the single inject门面 (resolveWait / injectHumanMessage), so the page stays
// a读投影 and there is exactly one write path (R18.AC-1/AC-2). A checkpoint p板 rides the
// decision on resolveWait (D-03); the operator is the本人 the server authenticated.

const DOC_PATHS = ['brief.md', 'journal.md', 'decisions.md', 'report.md', 'contract/contract.md'];

export function createWorkbenchAdapter(deps: {
  store: WorkitemsStore;
  artifacts: ArtifactStore;
  api: Pick<WorkitemsApi, 'resolveWait' | 'injectHumanMessage'>;
}): { data: WorkbenchData; actions: WorkbenchActions } {
  const toSummary = (item: WorkItem): ItemSummary => ({
    id: item.id,
    title: item.title,
    stage: item.phase, // opaque — passed through, not interpreted
    status: item.status,
    updatedAt: item.updatedAt,
  });

  const toView = (item: WorkItem): ItemView => {
    const runs = deps.store.listAssignments(item.id).map((a) => ({
      role: a.role,
      status: a.status,
      repo: a.repo,
    }));
    const focus = deps.store
      .listOpenWaits(item.id)
      .filter((w) => w.kind === 'human')
      .map((w) => ({ waitId: w.id, reason: w.reason }));
    const activity = deps.store.listEvents(item.id).map((e) => ({ kind: e.kind, at: e.createdAt }));
    const docs = DOC_PATHS.map((name) => ({
      name,
      content: deps.artifacts.readFile(item.id, name),
    })).filter((d): d is { name: string; content: string } => d.content !== undefined);
    return { summary: toSummary(item), runs, focus, activity, docs };
  };

  return {
    data: {
      listItems: () => deps.store.listNonTerminal().map(toSummary),
      getItem: (id) => {
        const item = deps.store.getWorkItem(id);
        return item ? toView(item) : undefined;
      },
    },
    actions: {
      resolve: ({ waitId, operator, approved, reason }) => {
        // 打回 carries its reason into the台账 (D-18.AC-3); checkpoint p板 rides the decision.
        const r = deps.api.resolveWait(waitId, {
          operator,
          reason,
          decision: { approved, payload: { reason } },
        });
        return { ok: r.resolved };
      },
      message: ({ itemId, text }) => {
        deps.api.injectHumanMessage(itemId, { text });
        return { ok: true };
      },
    },
  };
}
