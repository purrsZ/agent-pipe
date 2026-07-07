import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreeAdd, worktreePathFor } from '../../src/agents/worktree.js';
import type { EffectContext } from '../../src/workitems/effects.js';
import type { WorkItemEvent } from '../../src/workitems/types.js';
import { branchFor } from '../../src/worktypes/requirement/branch.js';
import { createDeliverManifestHandler } from '../../src/worktypes/requirement/deliver.js';
import { makeWorkItem } from '../helpers/workitems.js';

// WS-7 交付最后一公里（D-I）：不自动 MR，但给全每仓的分支名 / diffstat / 本地接手命令 / push 命令。

function workerDone(
  repo: string,
  assignmentId: string,
  reportPath: string,
  seq: number,
): WorkItemEvent {
  return {
    id: seq,
    workitemId: 'wi-1',
    seq,
    kind: 'run_completed',
    payload: { role: 'worker', repo, assignmentId, reportPath },
    createdAt: 1000,
  };
}

function fakeCtx(events: WorkItemEvent[], repos: string[]) {
  const emitted: Array<{ kind: string; payload: unknown }> = [];
  const written: Record<string, string> = {};
  const ctx = {
    effect: {
      id: 1,
      workitemId: 'wi-1',
      seq: 9,
      kind: 'deliver_manifest',
      payload: {},
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
    },
    workitem: makeWorkItem('wi-1', { type: 'requirement', repos, title: '订单导出' }),
    signal: new AbortController().signal,
    clock: { now: () => 1000 },
    logger: {},
    batchFromSeq: 0,
    heartbeat: () => {},
    eventsSince: () => events,
    setAgentSessionId: () => {},
    writeArtifact: (rel: string, content: string) => {
      written[rel] = content;
    },
    readArtifact: () => undefined,
    emit: (kind: string, payload: unknown) => emitted.push({ kind, payload }),
  } as unknown as EffectContext;
  return { ctx, emitted, written };
}

describe('deliver_manifest effect (WS-7)', () => {
  const handler = createDeliverManifestHandler({ worktreesDir: '/tmp/ap-no-such-worktrees' });

  it('每仓取最后一轮 worker，写 manifest.md + emit manifest_ready（含分支/接手命令）', async () => {
    const { ctx, emitted, written } = fakeCtx(
      [
        workerDone('/repos/backend', 'as-round1xx', 'assignments/as-round1xx/report.md', 1),
        workerDone('/repos/backend', 'as-round2yy', 'assignments/as-round2yy/report.md', 2), // 后一轮
        workerDone('/repos/frontend', 'as-front000', 'assignments/as-front000/report.md', 3),
      ],
      ['/repos/backend', '/repos/frontend'],
    );
    await handler.run(ctx);

    const md = written['delivery/manifest.md'];
    expect(md).toContain('# 交付清单 · 订单导出');
    expect(md).toContain('/repos/backend');
    expect(md).toContain('git switch req/');
    expect(md).toContain('git push origin req/');
    // backend 取最后一轮（分支名含 as-round2yy.slice(3,11)），不含第一轮。
    expect(md).toContain('round2yy');
    expect(md).not.toContain('round1xx');

    expect(emitted[0]!.kind).toBe('manifest_ready');
    const payload = emitted[0]!.payload as {
      repos: Array<{ repo: string; branch: string }>;
      summaryText: string;
    };
    expect(payload.repos.map((r) => r.repo).sort()).toEqual(['/repos/backend', '/repos/frontend']);
    expect(payload.summaryText).toContain('交付清单');
  });

  it('worktree 不存在 → diffstat 占位（不抛）+ 接手命令回落主仓 git switch', async () => {
    const { ctx, written } = fakeCtx([workerDone('/repos/x', 'as-000000zz', 'r', 1)], ['/repos/x']);
    await handler.run(ctx);
    const md = written['delivery/manifest.md']!;
    expect(md).toContain('(worktree 已清理或不可读)');
    // VERIFY V1：worktree 已清理 → 回落原来的「本地接手：cd <repo> && git switch」，不出 worktree remove 提示。
    expect(md).toContain('本地接手：cd /repos/x && git switch');
    expect(md).not.toContain('git worktree remove');
  });

  it('无 worker 记录 → 空清单不炸', async () => {
    const { ctx, emitted } = fakeCtx([], []);
    await handler.run(ctx);
    expect(emitted[0]!.kind).toBe('manifest_ready');
    expect((emitted[0]!.payload as { repos: unknown[] }).repos).toEqual([]);
  });

  // WS-7.6（T7）+ O2 边界：manifest 全文超上限 → summaryText 截断带提示、总长 ≤ 3000、repos 数组不截断，
  // artifact 存全文。造多仓 + 长路径把全文顶过 3000 字。
  it('manifest 全文超上限 → summaryText 截断（≤3000）、repos 完整、artifact 存全文', async () => {
    const repos: string[] = [];
    const events: WorkItemEvent[] = [];
    for (let i = 0; i < 20; i++) {
      const nn = String(i).padStart(2, '0');
      const repo = `/very/long/organization/monorepo/services/backend/module-${nn}`;
      repos.push(repo);
      events.push(
        workerDone(repo, `as-repo${nn}xxxx`, `assignments/as-repo${nn}/report.md`, i + 1),
      );
    }
    const { ctx, emitted, written } = fakeCtx(events, repos);
    await handler.run(ctx);

    const payload = emitted[0]!.payload as {
      repos: Array<{ repo: string; branch: string }>;
      summaryText: string;
    };
    const full = written['delivery/manifest.md']!;
    expect(full.length).toBeGreaterThan(3000); // 前提：确实超上限
    expect(payload.summaryText).toContain('（已截断，全文见 delivery/manifest.md）');
    expect(payload.summaryText.length).toBeLessThanOrEqual(3000); // O2：截断后总长不越界
    expect(payload.repos).toHaveLength(20); // repos 数组完整不截断
    expect(full.length).toBeGreaterThan(payload.summaryText.length); // artifact 为全文
  });
});

// VERIFY V1（#5）：worktree 仍存在时，分支被 linked worktree 占用，主仓直接 git switch 会失败——manifest 改给
// 工作副本路径 + 先移除 worktree 再 switch 的正确命令。真仓建 worktree 验证。
describe('deliver_manifest 接手命令随 worktree 是否在分流 (VERIFY V1)', () => {
  let tmpDir: string;
  let repoPath: string;

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-deliver-wt-'));
    repoPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    git(repoPath, ['init', '-b', 'main']);
    git(repoPath, ['config', 'user.email', 't@t']);
    git(repoPath, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'base\n');
    git(repoPath, ['add', '-A']);
    git(repoPath, ['commit', '-m', 'base']);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('worktree 仍在 → 给「工作副本 cd 路径」+「worktree remove 后 switch」，不给裸 git switch', async () => {
    const worktreesDir = path.join(tmpDir, 'worktrees');
    const assignmentId = 'as-live0000';
    const wi = makeWorkItem('wi-1', { type: 'requirement', repos: [repoPath], title: '真机交付' });
    const wtPath = worktreePathFor(worktreesDir, 'wi-1', assignmentId, repoPath);
    // 真的建一个 worktree（分支被它占用）。
    worktreeAdd(repoPath, wtPath, branchFor(wi, { id: assignmentId, repo: repoPath }), 'HEAD');
    // worker 在 worktree 里提交了改动（血统/兜底提交后的状态）。
    fs.writeFileSync(path.join(wtPath, 'feature.ts'), 'export const f = 1;\n');
    git(wtPath, ['add', '-A']);
    git(wtPath, ['commit', '-m', 'work']);

    const { ctx, written } = fakeCtx(
      [workerDone(repoPath, assignmentId, `assignments/${assignmentId}/report.md`, 1)],
      [repoPath],
    );
    const handler = createDeliverManifestHandler({ worktreesDir });
    await handler.run(ctx);

    const md = written['delivery/manifest.md']!;
    expect(md).toContain(`工作副本：cd ${wtPath}`); // 指向真实工作副本
    expect(md).toContain(`git worktree remove ${wtPath}`); // 先移除 worktree
    expect(md).not.toContain(`本地接手：cd ${repoPath} && git switch`); // 不再给会失败的裸 switch
    expect(md).toContain('feature.ts'); // diffstat 读到真实改动（兜底提交后不再「(无改动)」）
  });
});
