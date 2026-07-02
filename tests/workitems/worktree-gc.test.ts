import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWorktreeGc } from '../../src/worktypes/requirement/worktree-gc.js';

// WS-7.4 worktree 每日 GC：终态且 7 天以上 → 删；非终态 / 未到期 → 留；孤目录 30 天才删。分支保留（这里只测目录去留）。

let tmpDir: string;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-wtgc-'));
  vi.clearAllMocks();
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkItemDir(id: string): string {
  const dir = path.join(tmpDir, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeStore(items: Record<string, { status: string; updatedAt: number }>) {
  return { getWorkItem: (id: string) => items[id] };
}

describe('runWorktreeGc (WS-7.4)', () => {
  it('终态且 8 天前 → 删目录', () => {
    mkItemDir('wi-old');
    const r = runWorktreeGc({
      store: fakeStore({ 'wi-old': { status: 'done', updatedAt: NOW - 8 * DAY } }),
      worktreesDir: tmpDir,
      logger,
      now: NOW,
    });
    expect(fs.existsSync(path.join(tmpDir, 'wi-old'))).toBe(false);
    expect(r.removed).toBe(1);
  });

  it('终态但未到期（3 天）→ 留', () => {
    mkItemDir('wi-fresh');
    runWorktreeGc({
      store: fakeStore({ 'wi-fresh': { status: 'done', updatedAt: NOW - 3 * DAY } }),
      worktreesDir: tmpDir,
      logger,
      now: NOW,
    });
    expect(fs.existsSync(path.join(tmpDir, 'wi-fresh'))).toBe(true);
  });

  it('非终态（active）即便很老也留', () => {
    mkItemDir('wi-active');
    runWorktreeGc({
      store: fakeStore({ 'wi-active': { status: 'active', updatedAt: NOW - 30 * DAY } }),
      worktreesDir: tmpDir,
      logger,
      now: NOW,
    });
    expect(fs.existsSync(path.join(tmpDir, 'wi-active'))).toBe(true);
  });

  it('孤目录（DB 无此单）默认 30 天内不删', () => {
    mkItemDir('wi-orphan'); // mtime = now-ish（刚建）
    const r = runWorktreeGc({
      store: fakeStore({}),
      worktreesDir: tmpDir,
      logger,
      now: NOW + 1000, // 目录刚建，远不到 30 天
    });
    expect(fs.existsSync(path.join(tmpDir, 'wi-orphan'))).toBe(true);
    expect(r.kept).toBe(1);
  });

  it('worktreesDir 不存在 → 返回 0/0 不抛', () => {
    expect(() =>
      runWorktreeGc({
        store: fakeStore({}),
        worktreesDir: path.join(tmpDir, 'nope'),
        logger,
        now: NOW,
      }),
    ).not.toThrow();
  });
});
