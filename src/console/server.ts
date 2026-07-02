import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

// 需求管控台 HTTP 服务：通用 JSON + 静态托管层，本身不含任何业务语义（看板数据与拍板写回都由
// index 以回调注入）。因此它能与 kernel 中立的 src/workbench 一样保持中性、互不干扰。
// 提供给 React SPA：GET /api/requirement-board（只读看板 JSON）+ POST /api/requirement/resolve
// （拍板回流，本人 token 才放行）。其余路由静态托管 staticDir（web/dist）。

export interface ConsoleServerDeps {
  // 返回看板数据（由 index 注入：业务投影在上层完成，这里只负责序列化吐出）。
  board: () => unknown;
  // 拍板回流（由 index 注入：funnel 进上层单写入口）。返回是否成功。
  resolve: (
    input: { waitId: string; approved: boolean; reason: string },
    operator: string,
  ) => { ok: boolean };
  auth: (headers: http.IncomingHttpHeaders) => string | null;
  staticDir: string;
  logger?: { error?: (o: unknown, m?: string) => void };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

export function createConsoleServer(deps: ConsoleServerDeps): http.Server {
  return http.createServer((req, res) => {
    handle(req, res, deps).catch((err) => {
      deps.logger?.error?.({ err }, 'console request failed');
      if (!res.headersSent) sendText(res, 500, 'internal error');
    });
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ConsoleServerDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/requirement-board') {
    return sendJson(res, 200, deps.board());
  }

  if (method === 'POST' && pathname === '/api/requirement/resolve') {
    // 写回流是本人-only（与 workbench 写入口同规矩）。
    const operator = deps.auth(req.headers);
    if (!operator) return sendText(res, 403, 'forbidden');
    const body = parseJson(await readBody(req));
    const waitId = typeof body.waitId === 'string' ? body.waitId : '';
    if (!waitId) return sendText(res, 400, 'waitId required');
    const result = deps.resolve(
      {
        waitId,
        approved: body.approved !== false, // 缺省按通过；显式 false 才打回
        reason: typeof body.reason === 'string' ? body.reason : '',
      },
      operator,
    );
    return sendJson(res, result.ok ? 200 : 409, { ok: result.ok });
  }

  if (method === 'GET' || method === 'HEAD') {
    return serveStatic(res, deps.staticDir, pathname);
  }

  sendText(res, 404, 'not found');
}

// 静态托管 staticDir：命中文件即返回；否则回退 index.html（SPA 单页路由）。防目录穿越。
function serveStatic(res: http.ServerResponse, staticDir: string, pathname: string): void {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const candidate = path.resolve(staticDir, rel);
  const indexHtml = path.join(staticDir, 'index.html');

  const withinRoot = candidate === staticDir || candidate.startsWith(staticDir + path.sep);
  const target =
    withinRoot && rel !== '' && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : indexHtml;

  if (!fs.existsSync(target)) {
    sendText(res, 404, '需求管控台未构建：请先在 web/ 下执行 npm run build');
    return;
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(target));
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendText(res: http.ServerResponse, code: number, body: string): void {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
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

function parseJson(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
