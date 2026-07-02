export interface WorkitemsConfig {
  maxOpen: number;
  watchdogIntervalMs: number;
  heartbeatTimeoutSec: number;
  humanWaitTtlSec: number;
  retryBudget: number;
  defaultDeadlineTtlSec: number;
  defaultWallclockCapSec: number;
  // Concurrent worker cap per workitem for owner-workers topology (R01/R24). Solo
  // topology ignores it. Default 2 — a typical requirement touches 2-3 repos.
  maxWorkersPerItem: number;
  // WS-1.2 活性看门防抖窗口（秒）：must-progress 单持续无在途工作超过此时长才发 liveness_stalled，
  // 避免 run 结论与下一次 dispatch 之间的正常瞬时空窗被误报。默认 30。
  livenessGraceSec: number;
}

export type WorkitemsEnv = Partial<Record<string, string | undefined>>;

const DEFAULTS: WorkitemsConfig = {
  maxOpen: 3,
  watchdogIntervalMs: 1000,
  heartbeatTimeoutSec: 60,
  humanWaitTtlSec: 86_400,
  retryBudget: 1,
  defaultDeadlineTtlSec: 3600,
  defaultWallclockCapSec: 1800,
  maxWorkersPerItem: 2,
  livenessGraceSec: 30,
};

function positiveInt(env: WorkitemsEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadWorkitemsConfig(env: WorkitemsEnv = process.env): WorkitemsConfig {
  return {
    maxOpen: positiveInt(env, 'WORKITEMS_MAX_OPEN', DEFAULTS.maxOpen),
    watchdogIntervalMs: positiveInt(
      env,
      'WORKITEMS_WATCHDOG_INTERVAL_MS',
      DEFAULTS.watchdogIntervalMs,
    ),
    heartbeatTimeoutSec: positiveInt(
      env,
      'WORKITEMS_HEARTBEAT_TIMEOUT_SEC',
      DEFAULTS.heartbeatTimeoutSec,
    ),
    humanWaitTtlSec: positiveInt(env, 'WORKITEMS_HUMAN_WAIT_TTL_SEC', DEFAULTS.humanWaitTtlSec),
    retryBudget: positiveInt(env, 'WORKITEMS_RETRY_BUDGET', DEFAULTS.retryBudget),
    defaultDeadlineTtlSec: positiveInt(
      env,
      'WORKITEMS_DEFAULT_DEADLINE_TTL_SEC',
      DEFAULTS.defaultDeadlineTtlSec,
    ),
    defaultWallclockCapSec: positiveInt(
      env,
      'WORKITEMS_DEFAULT_WALLCLOCK_CAP_SEC',
      DEFAULTS.defaultWallclockCapSec,
    ),
    maxWorkersPerItem: positiveInt(
      env,
      'WORKITEMS_MAX_WORKERS_PER_ITEM',
      DEFAULTS.maxWorkersPerItem,
    ),
    livenessGraceSec: positiveInt(env, 'WORKITEMS_LIVENESS_GRACE_SEC', DEFAULTS.livenessGraceSec),
  };
}
