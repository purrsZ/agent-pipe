import * as http from 'node:http';
import { renderBoard, renderItem } from './render.js';
import type { WorkbenchActions, WorkbenchAuth, WorkbenchData } from './types.js';

// Lightweight HTTP工作台 (R17.AC-1: Node 自带 http, no framework). SSR read views + a single
// write入口 that funnels through the injected inject门面 (R18.AC-1/AC-2: page is读投影,
// agent never touches the page). Reads are open; writes require本人 auth (R18.AC-4). Routes
// use a neutral `/item/<id>` prefix to hold the kernel red-line.

export interface WorkbenchServerDeps {
  data: WorkbenchData;
  actions: WorkbenchActions;
  auth: WorkbenchAuth;
  logger?: { error?: (o: unknown, m?: string) => void };
}

export function createWorkbenchServer(deps: WorkbenchServerDeps): http.Server {
  return http.createServer((req, res) => {
    handle(req, res, deps).catch((err) => {
      deps.logger?.error?.({ err }, 'workbench request failed');
      if (!res.headersSent) send(res, 500, 'text/plain', 'internal error');
    });
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: WorkbenchServerDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // [] | ['item', id] | ['item', id, action]
  const method = req.method ?? 'GET';

  if (method === 'GET' && parts.length === 0) {
    return send(res, 200, 'text/html', renderBoard(deps.data.listItems()));
  }

  if (parts[0] === 'item' && parts[1]) {
    const id = parts[1];
    if (method === 'GET' && parts.length === 2) {
      const view = deps.data.getItem(id);
      if (!view) return send(res, 404, 'text/html', renderBoard(deps.data.listItems()));
      return send(res, 200, 'text/html', renderItem(view));
    }
    if (method === 'POST' && (parts[2] === 'resolve' || parts[2] === 'message')) {
      // Writes are本人-only (R18.AC-4). Reads above stay open.
      const operator = deps.auth(req.headers);
      if (!operator) return send(res, 403, 'text/plain', 'forbidden');
      const form = parseForm(await readBody(req));
      if (parts[2] === 'resolve') {
        const r = deps.actions.resolve({
          itemId: id,
          waitId: form.waitId ?? '',
          operator,
          approved: form.approved === 'true',
          reason: form.reason ?? '',
        });
        return redirectOr(res, r.ok, id);
      }
      const r = deps.actions.message({ itemId: id, operator, text: form.text ?? '' });
      return redirectOr(res, r.ok, id);
    }
  }

  send(res, 404, 'text/plain', 'not found');
}

function redirectOr(res: http.ServerResponse, ok: boolean, id: string): void {
  if (!ok) {
    send(res, 409, 'text/plain', 'rejected');
    return;
  }
  res.writeHead(303, { location: `/item/${encodeURIComponent(id)}` });
  res.end();
}

function send(res: http.ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { 'content-type': `${type}; charset=utf-8` });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function parseForm(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}
