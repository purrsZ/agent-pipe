// HTML 工作台 (R17/R18) — kernel layer, so every symbol here stays NEUTRAL (no upper-layer
// business vocabulary, CI-enforced). The upper-layer adapter shapes the store + artifacts
// into this neutral view-model; the HTTP layer only renders it and routes button回流 back
// through the injected actions. "stage" is an opaque progress string; "run" is one执行单元;
// "focus" is an open human wait awaiting a p板.

export interface ItemSummary {
  id: string;
  title: string;
  stage: string; // opaque progress string (set upstream — never interpreted here)
  status: string;
  updatedAt: number;
}

export interface RunView {
  role: string;
  status: string;
  repo: string | null;
}

export interface FocusView {
  waitId: string;
  reason: string;
}

export interface ActivityEntry {
  kind: string;
  at: number;
}

export interface DocView {
  name: string;
  content: string; // markdown source — rendered client-side / escaped server-side
}

export interface ItemView {
  summary: ItemSummary;
  runs: RunView[];
  focus: FocusView[];
  activity: ActivityEntry[];
  docs: DocView[];
}

// Read projection the HTTP layer queries (implemented by the upper-layer adapter).
export interface WorkbenchData {
  listItems(): ItemSummary[];
  getItem(id: string): ItemView | undefined;
}

// Write回流 — the page buttons funnel through the single inject门面. operator is the
// authenticated本人 identity (R18.AC-4). approved=false carries a reason into the台账.
export interface WorkbenchActions {
  resolve(input: {
    itemId: string;
    waitId: string;
    operator: string;
    approved: boolean;
    reason: string;
  }): { ok: boolean };
  message(input: { itemId: string; operator: string; text: string }): { ok: boolean };
}

// Auth: map a request to the本人 identity, or null to reject a write (read stays open).
export type WorkbenchAuth = (
  headers: Record<string, string | string[] | undefined>,
) => string | null;
