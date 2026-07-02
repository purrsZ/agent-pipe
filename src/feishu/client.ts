import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../logger.js';
import { createWsHealthLogger } from './ws-health.js';

export function createFeishuClients(
  appId: string,
  appSecret: string,
  logger: Logger,
  // WS-4: onWsRecovered fires when the ws recovers from a disconnect (not on first connect) —
  // index.ts binds it to 断线补拉. Passed as a stable closure so main() can late-bind the actual
  // backfill fn after sender/store are assembled.
  opts?: { onWsRecovered?: () => void },
) {
  const domain = lark.Domain.Feishu;
  const client = new lark.Client({ appId, appSecret, domain });
  // Feed the SDK's ws state logs through a wrapper that forwards them AND tracks a health flag,
  // so the reconnect guard can beat the SDK's hard-coded 120s reconnect interval.
  const { sdkLogger, health } = createWsHealthLogger(logger, { onRecovered: opts?.onWsRecovered });
  const wsClient = new lark.WSClient({ appId, appSecret, domain, logger: sdkLogger });
  return { client, wsClient, wsHealth: health };
}
