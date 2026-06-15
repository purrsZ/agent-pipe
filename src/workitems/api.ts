import type { ArtifactStore } from './artifacts.js';
import { TimerNotResolvableError } from './errors.js';
import type { ReducerRuntime } from './reducer.js';
import type { WorkTypeRegistry } from './registry.js';
import { assertPositiveFinite } from './shared.js';
import type { WorkitemsStore } from './store.js';
import type { Clock, CreateInput, CreateResult, Wait, WorkItem, WorkItemEvent } from './types.js';

export interface WorkitemsApiDeps {
  store: WorkitemsStore;
  registry: WorkTypeRegistry;
  reducer: ReducerRuntime;
  artifacts: ArtifactStore;
  clock?: Clock;
  afterCreate?: (item: WorkItem) => void;
}

export type ResolveWaitResult = { resolved: true } | { resolved: false; alreadyResolvedAt: number };

export class WorkitemsApi {
  constructor(private readonly deps: WorkitemsApiDeps) {}

  createWorkItem(input: CreateInput): CreateResult {
    const result = this.deps.reducer.bootstrapApply(input);
    if (result.created) {
      this.deps.artifacts.initRepo(result.item.id);
      this.deps.afterCreate?.(result.item);
    }
    return result;
  }

  getWorkItem(id: string): WorkItem | undefined {
    return this.deps.store.getWorkItem(id);
  }

  listEvents(id: string): WorkItemEvent[] {
    return this.deps.store.listEvents(id);
  }

  resolveWait(waitId: string, input: { operator: string; reason: string }): ResolveWaitResult {
    const wait = this.requireWait(waitId);
    if (wait.kind === 'timer') {
      throw new TimerNotResolvableError(waitId);
    }
    if (wait.resolvedAt !== null) {
      return { resolved: false, alreadyResolvedAt: wait.resolvedAt };
    }

    this.deps.reducer.enqueue(wait.workitemId, {
      kind: 'wait_resolved',
      payload: { waitId, operator: input.operator, reason: input.reason },
    });
    return { resolved: true };
  }

  renewWait(waitId: string, input: { operator: string; deadlineTtlSec: number }): void {
    const wait = this.requireWait(waitId);
    if (wait.kind !== 'human') {
      throw new Error('Only human waits can be renewed');
    }
    if (wait.resolvedAt !== null) {
      throw new Error('Resolved waits cannot be renewed');
    }
    assertPositiveFinite(input.deadlineTtlSec, 'deadlineTtlSec');

    const newDeadlineAt = this.now() + input.deadlineTtlSec * 1000;
    this.deps.reducer.enqueue(wait.workitemId, {
      kind: 'wait_renewed',
      payload: { waitId, operator: input.operator, newDeadlineAt },
    });
  }

  private requireWait(waitId: string): Wait {
    const wait = this.deps.store.getWait(waitId);
    if (!wait) {
      throw new Error(`Wait not found: ${waitId}`);
    }
    return wait;
  }

  private now(): number {
    return this.deps.clock?.now() ?? Date.now();
  }
}
