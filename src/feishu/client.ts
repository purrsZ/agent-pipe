import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../logger.js';
import { createWsHealthLogger } from './ws-health.js';

// 飞书直连：open.feishu.cn 是国内直连服务，不该跟着走本机代理（HTTP(S)_PROXY 指向的 Clash
// 抖动会让请求挂起——流式卡冻结的根因层）。追加进 NO_PROXY 两种大小写；claude 子进程继承
// 此 env 无害（它们不调飞书；走 Anthropic 的代理策略不受影响）。
export function ensureFeishuDirect(env: NodeJS.ProcessEnv): void {
  for (const key of ['NO_PROXY', 'no_proxy'] as const) {
    const cur = env[key];
    if (cur === undefined || cur.trim() === '') {
      if (key === 'NO_PROXY') env[key] = 'open.feishu.cn';
      continue;
    }
    const items = cur.split(',').map((s) => s.trim());
    if (!items.includes('open.feishu.cn')) env[key] = `${cur},open.feishu.cn`;
  }
}

export function createFeishuClients(
  appId: string,
  appSecret: string,
  logger: Logger,
  // WS-4: onWsRecovered fires when the ws recovers from a disconnect (not on first connect) —
  // index.ts binds it to 断线补拉. Passed as a stable closure so main() can late-bind the actual
  // backfill fn after sender/store are assembled.
  opts?: { onWsRecovered?: () => void },
) {
  ensureFeishuDirect(process.env);
  // SDK 全局 HTTP 超时：axios 默认 0=永不超时，挂起请求会吊死上层单飞行队列，也让 stop() 的
  // 僵尸帧交接失去 settle 保证。30s 取偏宽（文件上传/下载也走这条实例）。
  lark.defaultHttpInstance.defaults.timeout = 30_000;
  const domain = lark.Domain.Feishu;
  const client = new lark.Client({ appId, appSecret, domain });
  // Feed the SDK's ws state logs through a wrapper that forwards them AND tracks a health flag,
  // so the reconnect guard can beat the SDK's hard-coded 120s reconnect interval.
  const { sdkLogger, health } = createWsHealthLogger(logger, { onRecovered: opts?.onWsRecovered });
  const wsClient = new lark.WSClient({ appId, appSecret, domain, logger: sdkLogger });
  return { client, wsClient, wsHealth: health };
}
