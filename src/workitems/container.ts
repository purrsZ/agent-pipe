import { createWorkitemsBackupJob } from './backup.js';
import { SystemClock } from './clock.js';
import { loadWorkitemsConfig, type WorkitemsConfig } from './config.js';
import { EffectRuntime } from './effects.js';
import { startupRecovery } from './recovery.js';
import { WorkTypeRegistry } from './registry.js';
import { ReducerRuntime } from './reducer.js';
import { WorkitemsStore } from './store.js';
import { ArtifactStore } from './artifacts.js';
import { WorkitemsApi } from './api.js';
import { Watchdog } from './watchdog.js';
import type { BackupJob } from '../backup.js';
import type { LoggerLike } from './shared.js';
import type { Clock } from './types.js';

export interface WorkitemsContainerOptions {
  dbPath: string;
  workitemsDir: string;
  backupsDir: string;
  clock?: Clock;
  logger?: LoggerLike;
  cfg?: WorkitemsConfig;
  env?: Record<string, string | undefined>;
}

export interface WorkitemsContainer {
  api: WorkitemsApi;
  store: WorkitemsStore;
  artifacts: ArtifactStore;
  registry: WorkTypeRegistry;
  reducer: ReducerRuntime;
  effects: EffectRuntime;
  watchdog: Watchdog;
  start(): void;
  stop(): void;
  backupJob(): BackupJob;
}

export function createWorkitemsContainer(options: WorkitemsContainerOptions): WorkitemsContainer {
  const clock = options.clock ?? new SystemClock();
  const logger = options.logger ?? {};
  const cfg = options.cfg ?? loadWorkitemsConfig(options.env);
  const store = new WorkitemsStore(options.dbPath, clock);
  const artifacts = new ArtifactStore(options.workitemsDir, logger);
  const registry = new WorkTypeRegistry();

  let effects: EffectRuntime | undefined;
  const reducer = new ReducerRuntime({
    store,
    registry,
    clock,
    cfg,
    logger,
    isRunClass: (kind) => effects?.isRunClass(kind) ?? kind === 'run',
    postCommit: (actions) => {
      for (const action of actions) {
        if (action.kind === 'abort_effect') {
          effects?.abort(action.effectId, action.reason);
        } else if (action.kind === 'poke') {
          effects?.poke(action.workitemId);
        }
      }
    },
  });
  effects = new EffectRuntime({ store, reducer, registry, artifacts, clock, logger });
  const watchdog = new Watchdog({ store, reducer, effects, clock, logger, cfg });
  const api = new WorkitemsApi({
    store,
    registry,
    reducer,
    artifacts,
    clock,
    afterCreate: (item) => effects?.poke(item.id),
  });

  let stopped = false;
  return {
    api,
    store,
    artifacts,
    registry,
    reducer,
    effects,
    watchdog,
    start: () => {
      startupRecovery({ store, effects: effects!, artifacts, clock, logger, reducer });
      watchdog.start();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      watchdog.stop();
      effects!.stopIntake();
      effects!.abortInflight();
      store.close();
    },
    backupJob: () =>
      createWorkitemsBackupJob({
        store,
        artifactsDir: options.workitemsDir,
        backupsDir: options.backupsDir,
        logger,
      }),
  };
}
