import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createTokenAuth } from '../../src/workbench/auth.js';
import { createWorkbenchServer } from '../../src/workbench/server.js';
import type { ItemView, WorkbenchActions, WorkbenchData } from '../../src/workbench/types.js';

type Headers = Record<string, string | string[] | undefined>;
const H = (h: Headers): Headers => h;

describe('createTokenAuth (workbench 本人鉴权, T2)', () => {
  it('returns null for every request when no token is configured (read-only board)', () => {
    const auth = createTokenAuth({ token: '', operator: 'ou_owner' });
    expect(auth(H({ authorization: 'Bearer anything' }))).toBeNull();
    expect(auth(H({ cookie: 'wb_token=anything' }))).toBeNull();
    expect(auth(H({}))).toBeNull();
  });

  it('accepts a matching Bearer token and returns the operator', () => {
    const auth = createTokenAuth({ token: 's3cret', operator: 'ou_owner' });
    expect(auth(H({ authorization: 'Bearer s3cret' }))).toBe('ou_owner');
    // scheme is case-insensitive
    expect(auth(H({ authorization: 'bearer s3cret' }))).toBe('ou_owner');
  });

  it('accepts a matching wb_token cookie (browser form POST path)', () => {
    const auth = createTokenAuth({ token: 's3cret', operator: 'ou_owner' });
    expect(auth(H({ cookie: 'foo=bar; wb_token=s3cret; x=y' }))).toBe('ou_owner');
  });

  it('rejects a wrong, absent, or empty token', () => {
    const auth = createTokenAuth({ token: 's3cret', operator: 'ou_owner' });
    expect(auth(H({ authorization: 'Bearer nope' }))).toBeNull();
    expect(auth(H({ cookie: 'wb_token=nope' }))).toBeNull();
    expect(auth(H({}))).toBeNull();
    expect(auth(H({ authorization: 'Bearer ' }))).toBeNull();
  });

  it('does not match a token of a different length (constant-time guard returns false)', () => {
    const auth = createTokenAuth({ token: 's3cret', operator: 'ou_owner' });
    expect(auth(H({ authorization: 'Bearer s3cretEXTRA' }))).toBeNull();
  });

  it('url-decodes the cookie value before comparing', () => {
    const auth = createTokenAuth({ token: 'a b/c', operator: 'ou_owner' });
    expect(auth(H({ cookie: 'wb_token=a%20b%2Fc' }))).toBe('ou_owner');
  });

  it('prefers Authorization over cookie when both are present', () => {
    const auth = createTokenAuth({ token: 's3cret', operator: 'ou_owner' });
    expect(auth(H({ authorization: 'Bearer s3cret', cookie: 'wb_token=nope' }))).toBe('ou_owner');
  });
});

// End-to-end through a real server — exactly how index.ts plugs createTokenAuth into
// createWorkbenchServer. Catches real request-header casing / Bearer parsing on req.headers.
describe('createTokenAuth wired into a real workbench server (T2 seam)', () => {
  const servers: ReturnType<typeof createWorkbenchServer>[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  const view: ItemView = {
    summary: {
      id: 'wi-1',
      title: '需求',
      stage: 'requirement:理解',
      status: 'active',
      updatedAt: 1,
    },
    runs: [],
    focus: [{ waitId: 'wt-1', reason: 'checkpoint:requirement:合同' }],
    activity: [],
    docs: [],
  };
  const data: WorkbenchData = {
    listItems: () => [view.summary],
    getItem: (id) => (id === 'wi-1' ? view : undefined),
  };

  function start(token: string): Promise<{ base: string; resolved: unknown[] }> {
    const resolved: unknown[] = [];
    const actions: WorkbenchActions = {
      resolve: (i) => {
        resolved.push(i);
        return { ok: true };
      },
      message: () => ({ ok: true }),
    };
    const server = createWorkbenchServer({
      data,
      actions,
      auth: createTokenAuth({ token, operator: 'ou_owner' }),
    });
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve({ base: `http://127.0.0.1:${port}`, resolved });
      });
    });
  }

  it('serves read views without auth but rejects an unauthenticated write (403)', async () => {
    const { base, resolved } = await start('s3cret');
    expect(await (await fetch(`${base}/`)).text()).toContain('需求');
    const r = await fetch(`${base}/item/wi-1/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'waitId=wt-1&approved=true&reason=ok',
    });
    expect(r.status).toBe(403);
    expect(resolved).toHaveLength(0);
  });

  it('accepts a write carrying a Bearer token and funnels it through actions as the operator', async () => {
    const { base, resolved } = await start('s3cret');
    const r = await fetch(`${base}/item/wi-1/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Bearer s3cret',
      },
      body: 'waitId=wt-1&approved=false&reason=改一处',
      redirect: 'manual',
    });
    expect(r.status).toBe(303);
    expect(resolved).toEqual([
      { itemId: 'wi-1', waitId: 'wt-1', operator: 'ou_owner', approved: false, reason: '改一处' },
    ]);
  });

  it('accepts a write carrying the wb_token cookie (browser path)', async () => {
    const { base, resolved } = await start('s3cret');
    const r = await fetch(`${base}/item/wi-1/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'wb_token=s3cret',
      },
      body: 'waitId=wt-1&approved=true&reason=ok',
      redirect: 'manual',
    });
    expect(r.status).toBe(303);
    expect(resolved).toHaveLength(1);
  });
});
