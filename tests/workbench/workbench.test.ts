import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { renderBoard, renderItem } from '../../src/workbench/render.js';
import { createWorkbenchServer } from '../../src/workbench/server.js';
import type { ItemView, WorkbenchActions, WorkbenchData } from '../../src/workbench/types.js';

const emptyView: ItemView = {
  summary: {
    id: 'wi-1',
    title: '空需求',
    stage: 'requirement:理解',
    status: 'active',
    updatedAt: 1,
  },
  runs: [],
  focus: [],
  activity: [],
  docs: [],
};

const fullView: ItemView = {
  summary: {
    id: 'wi-1',
    title: '双端需求',
    stage: 'requirement:并行实现',
    status: 'active',
    updatedAt: 1,
  },
  runs: [{ role: 'worker', status: 'running', repo: 'backend' }],
  focus: [{ waitId: 'wt-1', reason: 'checkpoint:requirement:合同' }],
  activity: [{ kind: 'contract_frozen', at: 1 }],
  docs: [{ name: 'brief.md', content: '# brief\n实现下单' }],
};

describe('workbench render (R17 + 空态 R17.AC-7)', () => {
  it('board renders empty state and items without crashing', () => {
    expect(renderBoard([])).toContain('暂无需求');
    const html = renderBoard([emptyView.summary]);
    expect(html).toContain('空需求');
    expect(html).toContain('/item/wi-1');
  });

  it('item page renders每区块 empty state for a fresh item', () => {
    const html = renderItem(emptyView);
    expect(html).toContain('当前没有需要你拍板'); // focus empty
    expect(html).toContain('还没有工人'); // runs empty
    expect(html).toContain('暂无活动'); // activity empty
    expect(html).toContain('暂无文档'); // docs empty
  });

  it('item page renders focus card with通过/打回 + runs + activity + docs', () => {
    const html = renderItem(fullView);
    expect(html).toContain('该你拍一下');
    expect(html).toContain('checkpoint:requirement:合同');
    expect(html).toContain('通过');
    expect(html).toContain('打回');
    expect(html).toContain('backend');
    expect(html).toContain('contract_frozen');
    expect(html).toContain('brief.md');
  });

  it('escapes HTML to avoid injection', () => {
    const html = renderBoard([{ ...emptyView.summary, title: '<script>x</script>' }]);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('workbench server (R18: single write入口 + 本人鉴权)', () => {
  const servers: ReturnType<typeof createWorkbenchServer>[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  function start(opts: {
    data: WorkbenchData;
    actions: WorkbenchActions;
    operator: string | null;
  }): Promise<{ base: string; calls: unknown[] }> {
    const server = createWorkbenchServer({
      data: opts.data,
      actions: opts.actions,
      auth: () => opts.operator,
    });
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        resolve({ base: `http://127.0.0.1:${port}`, calls: [] });
      });
    });
  }

  const data: WorkbenchData = {
    listItems: () => [fullView.summary],
    getItem: (id) => (id === 'wi-1' ? fullView : undefined),
  };

  it('serves board + item read views', async () => {
    const { base } = await start({ data, actions: noopActions(), operator: 'lichao' });
    expect(await (await fetch(`${base}/`)).text()).toContain('双端需求');
    expect(await (await fetch(`${base}/item/wi-1`)).text()).toContain('该你拍一下');
    expect((await fetch(`${base}/item/missing`)).status).toBe(404); // not a 500
  });

  it('rejects a write from a non-本人 (403), accepts from本人 and funnels through actions', async () => {
    const resolved: unknown[] = [];
    const actions: WorkbenchActions = {
      resolve: (i) => {
        resolved.push(i);
        return { ok: true };
      },
      message: () => ({ ok: true }),
    };

    const denied = await start({ data, actions, operator: null });
    const r1 = await fetch(`${denied.base}/item/wi-1/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'waitId=wt-1&approved=true&reason=ok',
    });
    expect(r1.status).toBe(403);
    expect(resolved).toHaveLength(0);

    const ok = await start({ data, actions, operator: 'lichao' });
    const r2 = await fetch(`${ok.base}/item/wi-1/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'waitId=wt-1&approved=false&reason=改一处',
      redirect: 'manual',
    });
    expect(r2.status).toBe(303);
    expect(resolved).toEqual([
      { itemId: 'wi-1', waitId: 'wt-1', operator: 'lichao', approved: false, reason: '改一处' },
    ]);
  });
});

function noopActions(): WorkbenchActions {
  return { resolve: () => ({ ok: true }), message: () => ({ ok: true }) };
}
