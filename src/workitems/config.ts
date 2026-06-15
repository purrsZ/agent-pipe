export interface WorkitemsConfig {
  maxOpen: number;
  watchdogIntervalMs: number;
  heartbeatTimeoutSec: number;
  humanWaitTtlSec: number;
  retryBudget: number;
  defaultDeadlineTtlSec: number;
  defaultWallclockCapSec: number;
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
  };
}
