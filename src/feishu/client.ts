import * as lark from '@larksuiteoapi/node-sdk';

export function createFeishuClients(appId: string, appSecret: string) {
  const domain = lark.Domain.Feishu;
  const client = new lark.Client({ appId, appSecret, domain });
  const wsClient = new lark.WSClient({ appId, appSecret, domain });
  return { client, wsClient };
}
