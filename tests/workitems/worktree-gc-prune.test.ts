import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 审查修复 F4：GC 里 worktreeRemove 失败降级 rm 后，要对已知主仓补 `git worktree prune` 清陈旧注册。
// 真仓难自然复现「remove 失败但 mainRepoOf 仍可算」，故 mock worktree.js 直接钉死降级分支的接线。

vi.mock('../../src/agents/worktree.js', () => ({
  mainRepoOf: vi.fn((wt: string) => `/main-of${wt}`),
  worktreeRemove: vi.fn(() => {
    throw new Error('remove failed');
  }),
  worktreePrune: vi.fn(),
}));

import { mainRepoOf, worktreePrune, worktreeRemove } from '../../src/agents/worktree.js';
import { runWorktreeGc } from '../../src/worktypes/requirement/worktree-gc.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-wtgc-prune-'));
  vi.clearAllMocks();
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeStore(items: Record<string, { status: string; updatedAt: number }>) {
  return { getWorkItem: (id: string) => items[id] };
}

describe('runWorktreeGc 降级 prune（审查修复 F4）', () => {
  it('worktreeRemove 失败 → 降级 rm + 对缓存的主仓 worktreePrune', () => {
    const id = 'wi-x';
    const leaf = path.join(tmpDir, id, 'repo', 'run1'); // worktreesDir/<id>/<repo>/<run>
    fs.mkdirSync(leaf, { recursive: true });

    runWorktreeGc({
      store: fakeStore({ [id]: { status: 'done', updatedAt: NOW - 8 * DAY } }),
      worktreesDir: tmpDir,
      logger,
      now: NOW,
    });

    expect(mainRepoOf).toHaveBeenCalledWith(leaf); // remove 前先缓存主仓
    expect(worktreeRemove).toHaveBeenCalledWith(leaf);
    expect(worktreePrune).toHaveBeenCalledWith(`/main-of${leaf}`); // 降级后补 prune
    expect(logger.warn).toHaveBeenCalled(); // 记了降级 warn
    expect(fs.existsSync(path.join(tmpDir, id))).toBe(false); // 目录兜底删除
  });

  it('worktreeRemove 成功 → 不 prune', () => {
    vi.mocked(worktreeRemove).mockImplementationOnce(() => {});
    const id = 'wi-ok';
    fs.mkdirSync(path.join(tmpDir, id, 'repo', 'run1'), { recursive: true });

    runWorktreeGc({
      store: fakeStore({ [id]: { status: 'done', updatedAt: NOW - 8 * DAY } }),
      worktreesDir: tmpDir,
      logger,
      now: NOW,
    });
    expect(worktreePrune).not.toHaveBeenCalled();
  });
});
