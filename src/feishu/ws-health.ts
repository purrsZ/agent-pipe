import type { Logger } from '../logger.js';

/** Shape of the logger the Feishu SDK's WSClient accepts (error/warn/info/debug/trace). */
export interface SdkLogger {
  error: (...m: unknown[]) => void;
  warn: (...m: unknown[]) => void;
  info: (...m: unknown[]) => void;
  debug: (...m: unknown[]) => void;
  trace: (...m: unknown[]) => void;
}

export interface WsHealth {
  /** true once 'ws client ready'/'reconnect success' is seen; false on disconnect signals. */
  healthy: boolean;
  /** ms timestamp of the last healthy<->unhealthy transition. */
  since: number;
}

// The Feishu node-sdk WSClient logs these at connection-state transitions (lib/index.js):
//   healthy  : 'ws client ready' / 'reconnect success'
//   unhealthy: 'reconnect' / 'connect failed' / 'unable to connect' / 'ws ... closed'
// HEALTHY is matched first because 'reconnect success' also contains 'reconnect'.
const HEALTHY_RE = /ws client ready|reconnect success/;
const UNHEALTHY_RE = /reconnect|connect failed|unable to connect|ws (?:client )?closed/;

/**
 * Wrap our pino logger so the SDK's ws state-transition logs both flow through normally AND
 * drive a `WsHealth` flag. The flag is the input to {@link startWsReconnectGuard}, which
 * proactively reconnects faster than the SDK's hard-coded 120s reconnectInterval.
 */
export function createWsHealthLogger(
  base: Logger,
  // WS-4: onRecovered 在 WS 从 unhealthy 恢复 healthy 时触发一次（用于断线后主动补拉离线消息）。
  // everHealthy 守卫：首次建连（初值 healthy=false → true）不算「恢复」、不触发，否则启动即误补拉。
  opts?: { onRecovered?: () => void },
): { sdkLogger: SdkLogger; health: WsHealth } {
  const health: WsHealth = { healthy: false, since: Date.now() };
  let everHealthy = false;
  const observe = (parts: unknown[]): void => {
    const text = parts.map((p) => (typeof p === 'string' ? p : String(p))).join(' ');
    let next: boolean | undefined;
    if (HEALTHY_RE.test(text)) next = true;
    else if (UNHEALTHY_RE.test(text)) next = false;
    if (next !== undefined && next !== health.healthy) {
      health.healthy = next;
      health.since = Date.now();
      if (next) {
        if (everHealthy) opts?.onRecovered?.();
        everHealthy = true;
      }
    }
  };
  const line = (parts: unknown[]): string => parts.map(String).join(' ');
  return {
    sdkLogger: {
      error: (...m) => {
        observe(m);
        base.error({ sdk: 'feishu-ws' }, line(m));
      },
      warn: (...m) => {
        observe(m);
        base.warn({ sdk: 'feishu-ws' }, line(m));
      },
      info: (...m) => {
        observe(m);
        base.info({ sdk: 'feishu-ws' }, line(m));
      },
      debug: (...m) => {
        observe(m);
        base.debug({ sdk: 'feishu-ws' }, line(m));
      },
      trace: (...m) => {
        observe(m);
        base.trace({ sdk: 'feishu-ws' }, line(m));
      },
    },
    health,
  };
}

/**
 * Guard against the SDK's 120s reconnect interval: poll the {@link WsHealth} flag and, once
 * the ws has been unhealthy past `graceMs`, proactively call `reconnect()` (= wsClient.start,
 * which is re-entrant — it terminates the stale socket and invalidates older reconnect loops).
 * `cooldownMs` bounds how often we force a reconnect so a persistently-down network doesn't get
 * hammered. Returns a stop function. The timer is unref'd so it never holds the process open.
 */
export function startWsReconnectGuard(deps: {
  reconnect: () => Promise<void>;
  health: WsHealth;
  logger: Logger;
  checkIntervalMs?: number;
  graceMs?: number;
  cooldownMs?: number;
}): () => void {
  const checkInterval = deps.checkIntervalMs ?? 15_000;
  const grace = deps.graceMs ?? 20_000;
  const cooldown = deps.cooldownMs ?? 30_000;
  let lastManualAt = 0;
  const timer = setInterval(() => {
    if (deps.health.healthy) return;
    const now = Date.now();
    if (now - deps.health.since < grace) return;
    if (now - lastManualAt < cooldown) return;
    lastManualAt = now;
    deps.logger.warn(
      { unhealthyForMs: now - deps.health.since },
      'ws 断连超时，主动重连（绕开 SDK 120s reconnectInterval）',
    );
    void deps.reconnect().catch((err) => deps.logger.error({ err }, 'ws 主动重连失败'));
  }, checkInterval);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
