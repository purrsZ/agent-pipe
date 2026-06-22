import { timingSafeEqual } from 'node:crypto';
import type { WorkbenchAuth } from './types.js';

// Token-based 本人 auth for the workbench write入口 (R18.AC-4). Reads stay open — the server
// only calls this on POST. A browser form POST can't add a custom header, so the token rides a
// `wb_token` cookie; curl/API callers may use `Authorization: Bearer <token>`. An empty
// configured token keeps the board read-only (always null) until the operator sets one. The
// compare is constant-time so a wrong token leaks no length-by-length timing signal. Kept
// neutral (token/operator only) so this kernel-layer file holds the architecture red-line.
export function createTokenAuth(cfg: { token: string; operator: string }): WorkbenchAuth {
  return (headers) => {
    if (!cfg.token) return null;
    const provided = bearerOf(headers) ?? cookieOf(headers, 'wb_token');
    if (!provided) return null;
    return constantTimeEqual(provided, cfg.token) ? cfg.operator : null;
  };
}

type Headers = Record<string, string | string[] | undefined>;

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function bearerOf(headers: Headers): string | undefined {
  const raw = firstHeader(headers.authorization);
  const m = raw ? /^Bearer\s+(.+)$/i.exec(raw.trim()) : null;
  return m ? m[1] : undefined;
}

function cookieOf(headers: Headers, name: string): string | undefined {
  const raw = firstHeader(headers.cookie);
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
