import { describe, expect, it } from 'vitest';
import type { EffectContext } from '../../src/workitems/effects.js';
import type { WorkItemEvent } from '../../src/workitems/types.js';
import { createIntakeFinalizeHandler } from '../../src/worktypes/requirement/intake-finalize.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';
import { makeWorkItem } from '../helpers/workitems.js';

// intake_finalize effect（M-I3 沙箱内核）：立项 gate 通过 → fold 立项填项历史 → 写立项书 + 提升 repos。

function ev(kind: string, payload: unknown): WorkItemEvent {
  return { id: 1, workitemId: 'wi-1', seq: 1, kind, payload, createdAt: 1000 };
}

function fakeCtx(priorEvents: WorkItemEvent[]) {
  const emitted: Array<{ kind: string; payload: unknown }> = [];
  const written: Record<string, string> = {};
  const ctx = {
    effect: {
      id: 1,
      workitemId: 'wi-1',
      seq: 9,
      kind: 'intake_finalize',
      payload: {},
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
    },
    workitem: makeWorkItem('wi-1', { type: 'requirement', phase: PHASE.understand }),
    signal: new AbortController().signal,
    clock: { now: () => 1000 },
    logger: {},
    batchFromSeq: 0,
    heartbeat: () => {},
    eventsSince: () => priorEvents,
    setAgentSessionId: () => {},
    writeArtifact: (rel: string, content: string) => {
      written[rel] = content;
    },
    readArtifact: () => undefined,
    emit: (kind: string, payload: unknown) => emitted.push({ kind, payload }),
  } as unknown as EffectContext;
  return { ctx, emitted, written };
}

describe('intake_finalize handler', () => {
  const handler = createIntakeFinalizeHandler();

  it('folds 立项填项历史 → 写立项书 intake/intake.md + emit repos_set 提升仓库', async () => {
    const { ctx, emitted, written } = fakeCtx([
      ev('intake_field_set', { key: 'name', value: '订单状态查询' }),
      ev('intake_field_set', { key: 'summary', value: '运营按单号查状态' }),
      ev('intake_field_set', { key: 'repos', value: ['/abs/backend', '/abs/frontend'] }),
      ev('intake_field_set', { key: 'acceptance', value: '输入单号返回状态' }),
      ev('run_completed', { role: 'owner' }), // 非 intake 事件被过滤
    ]);
    await handler.run(ctx);
    const brief = written['intake/intake.md'];
    expect(brief).toContain('# 立项书：订单状态查询');
    expect(brief).toContain('## 涉及代码仓库');
    expect(brief).toContain('- /abs/backend');
    expect(brief).toContain('输入单号返回状态');
    expect(emitted).toEqual([
      { kind: 'repos_set', payload: { repos: ['/abs/backend', '/abs/frontend'] } },
    ]);
  });

  it('立项未填 repos（异常兜底）→ 仍写立项书但不 emit repos_set', async () => {
    const { ctx, emitted, written } = fakeCtx([
      ev('intake_field_set', { key: 'name', value: '需求' }),
    ]);
    await handler.run(ctx);
    expect(written['intake/intake.md']).toContain('# 立项书：需求');
    expect(emitted).toEqual([]);
  });

  it('recovery 是 rerun（纯派生，崩溃后重跑幂等）', () => {
    expect(handler.recovery).toBe('rerun');
  });
});
