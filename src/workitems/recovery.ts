import type { ArtifactStore } from './artifacts.js';
import type { EffectRuntime } from './effects.js';
import { computeRollup } from './projection.js';
import type { ReducerRuntime } from './reducer.js';
import type { LoggerLike } from './shared.js';
import type { WorkitemsStore } from './store.js';
import type { Clock, WaitKind, WorkItemStatus } from './types.js';

export interface StartupRecoveryDeps {
  store: WorkitemsStore;
  effects: EffectRuntime;
  artifacts: ArtifactStore;
  clock: Clock;
  logger?: LoggerLike;
  reducer?: ReducerRuntime;
}

export function startupRecovery(deps: StartupRecoveryDeps): void {
  // A single corrupt artifact repo, poisoned row, or throwing handler must not abort the
  // whole recovery — that would make container.start() throw and the bridge would never
  // come up at all, taking every task down with it. Isolate each item/effect (and each
  // batch scan): log and continue so one bad workitem only loses its own recovery.
  deps.logger?.info?.('recovery: step 2 rebuild');
  isolate(deps, 'step 2 scan', undefined, () => {
    for (const item of deps.store.listNonTerminal()) {
      isolate(deps, 'rebuild', item.id, () =>
        recomputeFromStateTables(deps.store, item.id, item.status, deps.clock.now()),
      );
    }
  });

  deps.logger?.info?.('recovery: step 3 outbox');
  const pendingWorkitems = new Set<string>();
  isolate(deps, 'step 3 scan', undefined, () => {
    for (const effect of deps.store.listInflightEffects()) {
      if (effect.status === 'pending') {
        pendingWorkitems.add(effect.workitemId);
        continue;
      }
      isolate(deps, 'recover effect', effect.workitemId, () => {
        if (deps.effects.isRunClass(effect.kind)) {
          deps.effects.recoverRun(effect.id);
        } else {
          deps.effects.recoverRunning(effect.id);
        }
      });
    }
  });

  deps.logger?.info?.('recovery: step 4 reconcile');
  isolate(deps, 'step 4 scan', undefined, () => {
    for (const item of deps.store.listNonTerminal()) {
      isolate(deps, 'reconcile', item.id, () => {
        const result = deps.artifacts.reconcile(item.id, 'startup');
        if (result !== 'noop') {
          deps.reducer?.enqueue(item.id, { kind: 'artifact_reconciled', payload: { result } });
        }
      });
    }
  });

  for (const workitemId of pendingWorkitems) {
    deps.effects.poke(workitemId);
  }
}

// Run a recovery step in isolation: a throw is logged and swallowed so neither a single
// poisoned item nor a failing batch scan can prevent the bridge from starting.
function isolate(
  deps: StartupRecoveryDeps,
  label: string,
  workitemId: string | undefined,
  fn: () => void,
): void {
  try {
    fn();
  } catch (err) {
    deps.logger?.error?.({ err, workitemId }, `recovery: ${label} failed (isolated)`);
  }
}

function recomputeFromStateTables(
  store: WorkitemsStore,
  workitemId: string,
  current: WorkItemStatus,
  updatedAt: number,
): void {
  const result = computeRollup({
    current,
    openWaitKinds: store.listOpenWaits(workitemId).map((wait) => wait.kind as WaitKind),
    hasRunningAssignment: store
      .listAssignments(workitemId)
      .some((assignment) => assignment.status === 'running'),
    hasEventsBeyondCreation: current !== 'open',
  });
  store.updateWorkItem(workitemId, {
    status: result.status,
    statusDetail: result.detail,
    updatedAt,
  });
}
