import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../logger.js';
import { createWsHealthLogger } from './ws-health.js';

export function createFeishuClients(appId: string, appSecret: string, logger: Logger) {
  const domain = lark.Domain.Feishu;
  const client = new lark.Client({ appId, appSecret, domain });
  // Feed the SDK's ws state logs through a wrapper that forwards them AND tracks a health flag,
  // so the reconnect guard can beat the SDK's hard-coded 120s reconnect interval.
  const { sdkLogger, health } = createWsHealthLogger(logger);
  const wsClient = new lark.WSClient({ appId, appSecret, domain, logger: sdkLogger });
  return { client, wsClient, wsHealth: health };
}
