import { describe, expect, it } from 'vitest';
import { ensureFeishuDirect } from '../../src/feishu/client.js';

// 飞书直连：open.feishu.cn 追加进 NO_PROXY，让国内直连服务绕过本机代理（Clash 抖动挂请求
// 是流式卡冻结的根因层）。纯函数，传自造 env 对象断言，不碰 process.env。
describe('ensureFeishuDirect', () => {
  it('空 env → 只建 NO_PROXY=open.feishu.cn（no_proxy 不新建）', () => {
    const env: NodeJS.ProcessEnv = {};
    ensureFeishuDirect(env);
    expect(env.NO_PROXY).toBe('open.feishu.cn');
    expect(env.no_proxy).toBeUndefined();
  });

  it('已有 NO_PROXY=a.com → 追加变 a.com,open.feishu.cn', () => {
    const env: NodeJS.ProcessEnv = { NO_PROXY: 'a.com' };
    ensureFeishuDirect(env);
    expect(env.NO_PROXY).toBe('a.com,open.feishu.cn');
  });

  it('已含 open.feishu.cn → 原样不动（幂等）', () => {
    const env: NodeJS.ProcessEnv = { NO_PROXY: 'a.com,open.feishu.cn' };
    ensureFeishuDirect(env);
    expect(env.NO_PROXY).toBe('a.com,open.feishu.cn');
  });

  it('no_proxy 小写已有值 → 同样追加', () => {
    const env: NodeJS.ProcessEnv = { no_proxy: 'b.com' };
    ensureFeishuDirect(env);
    expect(env.no_proxy).toBe('b.com,open.feishu.cn');
  });
});
