import { describe, expect, it } from 'vitest';
import type { EffectContext } from '../../src/workitems/effects.js';
import type { WorkItemEvent } from '../../src/workitems/types.js';
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

  it('worktree 不存在 → diffstat 占位（不抛）', async () => {
    const { ctx, written } = fakeCtx([workerDone('/repos/x', 'as-000000zz', 'r', 1)], ['/repos/x']);
    await handler.run(ctx);
    expect(written['delivery/manifest.md']).toContain('(worktree 已清理或不可读)');
  });

  it('无 worker 记录 → 空清单不炸', async () => {
    const { ctx, emitted } = fakeCtx([], []);
    await handler.run(ctx);
    expect(emitted[0]!.kind).toBe('manifest_ready');
    expect((emitted[0]!.payload as { repos: unknown[] }).repos).toEqual([]);
  });
});
