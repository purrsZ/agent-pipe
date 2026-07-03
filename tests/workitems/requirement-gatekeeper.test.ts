import { describe, expect, it } from 'vitest';
import type { EffectContext } from '../../src/workitems/effects.js';
import type { WorkItemEvent } from '../../src/workitems/types.js';
import {
  createGatekeeperReviewHandler,
  createGatekeeperReworkHandler,
  gatekeeperVerdict,
  parseWorkerRaises,
  partitionRaises,
} from '../../src/worktypes/requirement/gatekeeper.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';
import { makeWorkItem } from '../helpers/workitems.js';

// PIVOT §4 监工科层域单测。

const block = (obj: unknown, tag = 'gatekeeper') =>
  `实现说明……\n\n\`\`\`${tag}\n${JSON.stringify(obj)}\n\`\`\`\n`;

describe('parseWorkerRaises', () => {
  it('抽 ```gatekeeper 块的 raises；缺 question 的丢弃；无块 → []', () => {
    const r = parseWorkerRaises(
      block({
        raises: [
          { interfaceId: 'createOrder', question: '要加字段', repo: '/repos/backend' },
          { interfaceId: 'x' }, // 无 question → 丢
        ],
      }),
    );
    expect(r).toEqual([
      { interfaceId: 'createOrder', question: '要加字段', repo: '/repos/backend' },
    ]);
    expect(parseWorkerRaises('纯实现报告，无上报')).toEqual([]);
  });

  it('也接受 ```json 块；纯本仓上报 interfaceId 留空', () => {
    const r = parseWorkerRaises(block({ raises: [{ question: '本仓内部要重构' }] }, 'json'));
    expect(r).toEqual([{ interfaceId: '', question: '本仓内部要重构', repo: '' }]);
  });
});

describe('gatekeeperVerdict / partitionRaises', () => {
  it('声明 interfaceId（碰跨仓契约/疑则）→ 大；纯本仓 → 小', () => {
    expect(gatekeeperVerdict({ repo: '', interfaceId: 'createOrder', question: 'q' })).toBe('big');
    expect(gatekeeperVerdict({ repo: '', interfaceId: '', question: 'q' })).toBe('small');
    const p = partitionRaises([
      { repo: '', interfaceId: 'createOrder', question: 'a' },
      { repo: '', interfaceId: '', question: 'b' },
    ]);
    expect(p.big).toHaveLength(1);
    expect(p.small).toHaveLength(1);
  });
});

function fakeCtx(artifacts: Record<string, string>, events: WorkItemEvent[]) {
  const emitted: Array<{ kind: string; payload: unknown }> = [];
  const written: Record<string, string> = {};
  const ctx = {
    effect: {
      id: 1,
      workitemId: 'wi-1',
      seq: 9,
      kind: 'gatekeeper_review',
      payload: {},
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
    },
    workitem: makeWorkItem('wi-1', { type: 'requirement', phase: PHASE.implement }),
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
    readArtifact: (rel: string) => artifacts[rel],
    emit: (kind: string, payload: unknown) => emitted.push({ kind, payload }),
  } as unknown as EffectContext;
  return { ctx, emitted, written };
}

const runCompleted = (reportPath: string): WorkItemEvent => ({
  id: 1,
  workitemId: 'wi-1',
  seq: 1,
  kind: 'run_completed',
  payload: { role: 'worker', reportPath },
  createdAt: 1000,
});

describe('gatekeeper_review effect handler', () => {
  const handler = createGatekeeperReviewHandler();

  it('无工人上报 → gatekeeper_passed', async () => {
    const { ctx, emitted, written } = fakeCtx({ 'assignments/w1/report.md': 'ok，无上报' }, [
      runCompleted('assignments/w1/report.md'),
    ]);
    await handler.run(ctx);
    expect(emitted[0]).toMatchObject({ kind: 'gatekeeper_passed', payload: { approved: 0 } });
    expect(written['contract/gatekeeper-log.md']).toContain('判大（raise 人）: 0');
  });

  it('纯本仓上报（判小）→ gatekeeper_passed + 回写图纸留痕', async () => {
    const { ctx, emitted, written } = fakeCtx(
      { 'assignments/w1/report.md': block({ raises: [{ question: '本仓重构 X' }] }) },
      [runCompleted('assignments/w1/report.md')],
    );
    await handler.run(ctx);
    expect(emitted[0]).toMatchObject({ kind: 'gatekeeper_passed', payload: { approved: 1 } });
    expect(written['contract/gatekeeper-log.md']).toContain('本仓重构 X');
  });

  it('跨仓外溢上报（判大）→ gatekeeper_big + 留痕', async () => {
    const { ctx, emitted, written } = fakeCtx(
      {
        'assignments/w1/report.md': block({
          raises: [
            {
              interfaceId: 'createOrder',
              question: '要给 createOrder 加字段',
              repo: '/repos/backend',
            },
          ],
        }),
      },
      [runCompleted('assignments/w1/report.md')],
    );
    await handler.run(ctx);
    expect(emitted[0]!.kind).toBe('gatekeeper_big');
    expect((emitted[0]!.payload as { raises: unknown[] }).raises).toHaveLength(1);
    expect(written['contract/gatekeeper-log.md']).toContain('判大');
  });

  it('多工人混合：有一条跨仓外溢即判大（gatekeeper_big）', async () => {
    const { ctx, emitted } = fakeCtx(
      {
        'assignments/w1/report.md': block({ raises: [{ question: '本仓小改' }] }),
        'assignments/w2/report.md': block({
          raises: [{ interfaceId: 'pay', question: '改 pay 字段方向' }],
        }),
      },
      [runCompleted('assignments/w1/report.md'), runCompleted('assignments/w2/report.md')],
    );
    await handler.run(ctx);
    expect(emitted[0]!.kind).toBe('gatekeeper_big');
  });

  // F6：报告按 assignment 隔离永不覆盖，监工须每仓只看最新一条，否则返工链永不自收敛。
  const workerRun = (repo: string, reportPath: string, seq: number): WorkItemEvent => ({
    id: seq,
    workitemId: 'wi-1',
    seq,
    kind: 'run_completed',
    payload: { role: 'worker', repo, reportPath },
    createdAt: 1000,
  });

  it('F6：同仓两轮 run_completed（旧带 raise 块、新无）→ 只读最新报告 → gatekeeper_passed', async () => {
    const { ctx, emitted } = fakeCtx(
      {
        'assignments/init/report.md': block({
          raises: [{ interfaceId: 'createOrder', question: '要加字段', repo: 'repo-a' }],
        }),
        'assignments/rework/report.md': 'ok，按新图纸返工，无上报',
      },
      [
        workerRun('repo-a', 'assignments/init/report.md', 1), // 初始轮（带跨仓上报块）
        workerRun('repo-a', 'assignments/rework/report.md', 2), // 返工轮（无块），监工只看这条
      ],
    );
    await handler.run(ctx);
    expect(emitted[0]!.kind).toBe('gatekeeper_passed');
  });

  it('F6：owner run_completed 的报告不参与监工扫描（只看 worker）', async () => {
    const { ctx, emitted } = fakeCtx(
      {
        'assignments/owner/report.md': block({
          raises: [
            { interfaceId: 'x', question: 'owner 报告里的块不该被监工读到', repo: 'repo-a' },
          ],
        }),
        'assignments/w/report.md': 'ok，无上报',
      },
      [
        {
          id: 1,
          workitemId: 'wi-1',
          seq: 1,
          kind: 'run_completed',
          payload: { role: 'owner', repo: 'repo-a', reportPath: 'assignments/owner/report.md' },
          createdAt: 1000,
        },
        workerRun('repo-a', 'assignments/w/report.md', 2),
      ],
    );
    await handler.run(ctx);
    expect(emitted[0]!.kind).toBe('gatekeeper_passed');
  });
});

// WS-5：监工判大后人已改图纸并重对账通过 → gatekeeper_rework 从最近一条 gatekeeper_big 的 raises 提取
// 受影响仓 → emit rework_requested → 定向重派这些仓的 worker（红线不放松：图纸仍只有人能改）。
const gatekeeperBig = (raises: unknown[]): WorkItemEvent => ({
  id: 2,
  workitemId: 'wi-1',
  seq: 2,
  kind: 'gatekeeper_big',
  payload: { raises },
  createdAt: 1000,
});

describe('gatekeeper_rework effect handler (WS-5)', () => {
  const handler = createGatekeeperReworkHandler();

  it('从最近一条 gatekeeper_big 的 raises 提取受影响仓 ∩ workitem.repos → emit rework_requested', async () => {
    const { ctx, emitted } = fakeCtx({}, [
      gatekeeperBig([{ interfaceId: 'createOrder', question: 'q', repo: '/repos/backend' }]),
      gatekeeperBig([
        { interfaceId: 'createOrder', question: 'q', repo: '/repos/backend' },
        { interfaceId: 'x', question: 'q2', repo: '/repos/other' }, // 不在 workitem.repos → 过滤
      ]),
    ]);
    (ctx.workitem as { repos: string[] }).repos = ['/repos/backend', '/repos/frontend'];
    await handler.run(ctx);
    expect(emitted[0]!.kind).toBe('rework_requested');
    expect((emitted[0]!.payload as { repos: string[] }).repos).toEqual(['/repos/backend']);
    expect((emitted[0]!.payload as { note: string }).note).toBeTruthy();
  });

  it('raises 无有效 repo → 回落 workitem.repos 全量（宁多勿漏）', async () => {
    const { ctx, emitted } = fakeCtx({}, [
      gatekeeperBig([{ interfaceId: 'x', question: 'q', repo: '' }]),
    ]);
    (ctx.workitem as { repos: string[] }).repos = ['/repos/a', '/repos/b'];
    await handler.run(ctx);
    expect((emitted[0]!.payload as { repos: string[] }).repos).toEqual(['/repos/a', '/repos/b']);
  });

  it('无 gatekeeper_big 事件 → 回落 workitem.repos 全量', async () => {
    const { ctx, emitted } = fakeCtx({}, []);
    (ctx.workitem as { repos: string[] }).repos = ['/repos/a'];
    await handler.run(ctx);
    expect((emitted[0]!.payload as { repos: string[] }).repos).toEqual(['/repos/a']);
  });
});
