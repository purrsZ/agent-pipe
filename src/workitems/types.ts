export type WorkItemStatus = 'open' | 'active' | 'waiting' | 'done' | 'failed' | 'cancelled';
export type NonTerminalWorkItemStatus = Exclude<WorkItemStatus, 'done' | 'failed' | 'cancelled'>;
export type WaitKind = 'human' | 'agent' | 'timer';
export type AssignmentRole = 'owner' | 'worker' | 'solo';
export type AssignmentStatus = 'running' | 'done' | 'failed' | 'superseded' | 'cancelled';
export type EffectStatus = 'pending' | 'running' | 'done' | 'aborted';

export interface Clock {
  now(): number;
}

export interface WorkItem {
  id: string;
  type: string;
  title: string;
  status: WorkItemStatus;
  statusDetail: WaitKind | null;
  phase: string;
  source: unknown;
  dedupeKey: string | null;
  repos: string[];
  context: unknown;
  wakePending: boolean;
  discardStreak: number;
  createdAt: number;
  updatedAt: number;
}

export interface Assignment {
  id: string;
  workitemId: string;
  parentId: string | null;
  repo: string | null;
  role: AssignmentRole;
  status: AssignmentStatus;
  agentSessionId: string | null;
  replacesAssignmentId: string | null;
  deadlineAt: number;
  wallclockCapSec: number;
  retries: number;
  basedOnSeq: number;
  briefPath: string | null;
  reportPath: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface Wait {
  id: string;
  workitemId: string;
  kind: WaitKind;
  originAssignmentId: string | null;
  reason: string;
  deadlineAt: number;
  renewedCount: number;
  remindedAt: number | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
  resolveReason: string | null;
  createdAt: number;
}

export interface Effect {
  id: number;
  workitemId: string;
  seq: number;
  kind: string;
  payload: unknown;
  status: EffectStatus;
  createdAt: number;
  updatedAt: number;
}

export interface WorkItemEvent {
  id: number;
  workitemId: string;
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: number;
}

export interface TriggerSpec {
  api: boolean;
}

export interface PermissionProfile {
  mode: 'readonly' | 'write';
}

export interface CheckpointPolicy {
  requiredBefore: string[];
}

export interface ArtifactSpec {
  briefTemplate?: string;
  reportRequired: boolean;
}

export interface Decision {
  refs?: {
    assignmentIds?: string[];
    waitIds?: string[];
  };
  data?: unknown;
}

export interface AssignmentSpec {
  role: AssignmentRole;
  repo?: string;
  deadlineTtlSec: number;
  wallclockCapSec: number;
  replacesAssignmentId?: string;
  retries?: number;
  brief?: string;
  payload?: unknown;
  // Enables the Owner→Worker parent chain (D-19). The reducer writes it into
  // assignment.parent_id (replacing the historical hard-coded null) so batch
  // attribution / cascade abort can read it back. Optional: solo dispatches omit it.
  parentAssignmentId?: string;
}

export interface WaitSpec {
  kind: WaitKind;
  reason: string;
  deadlineTtlSec: number;
  originAssignmentId?: string;
}

export interface EffectDecl {
  kind: string;
  payload?: unknown;
}

export interface Transition {
  phase?: { to: string; reason: string };
  terminal?: 'done' | 'failed' | 'cancelled';
  dispatch?: AssignmentSpec[];
  waits?: WaitSpec[];
  effects?: EffectDecl[];
}

export interface WorkType {
  id: string;
  triggers: TriggerSpec;
  initialPhase(item: WorkItem): string;
  onEvent(item: WorkItem, ev: WorkItemEvent): Transition;
  isDecisionStale(decision: Decision, eventsSince: WorkItemEvent[]): boolean;
  topology(item: WorkItem): 'solo' | 'owner-workers';
  permissions: PermissionProfile;
  checkpoints: CheckpointPolicy;
  artifacts: ArtifactSpec;
}

export interface CreateInput {
  type: string;
  title: string;
  source: unknown;
  dedupeKey?: string;
  repos?: string[];
  context?: unknown;
}

export type CreateResult = { created: true; item: WorkItem } | { created: false; item: WorkItem };
