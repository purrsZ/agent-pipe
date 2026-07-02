import { describe, expect, it } from 'vitest';
import type { EffectContext } from '../../src/workitems/effects.js';
import type { InternalApiEntry } from '../../src/worktypes/requirement/design.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';
import {
  composeReconcilePrompt,
  createReconcileCheckHandler,
  parseReconcileResult,
  reconcileToContract,
  reconcileVerdict,
  structuralDangling,
} from '../../src/worktypes/requirement/reconcile.js';
import { makeWorkItem } from '../helpers/workitems.js';

// PIVOT §3.1 owner 跨仓「拼凑 + 对账」域单测。

const POS = '/repos/pos';
const PORTAL = '/repos/portal';

function iface(over: Partial<InternalApiEntry> = {}): InternalApiEntry {
  return {
    id: 'createOrder',
    signature: 'POST /orders',
    providerRepo: POS,
    consumerRepos: [PORTAL],
    fields: [],
    ...over,
  };
}

function fakeCtx(artifacts: Record<string, string>, repos: string[]) {
  const emitted: Array<{ kind: string; payload: unknown }> = [];
  const written: Record<string, string> = {};
  const ctx = {
    effect: {
      id: 1,
      workitemId: 'wi-1',
      seq: 9,
      kind: 'reconcile_check',
      payload: {},
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
    },
    workitem: makeWorkItem('wi-1', { type: 'requirement', phase: PHASE.split, repos }),
    signal: new AbortController().signal,
    clock: { now: () => 1000 },
    logger: {},
    batchFromSeq: 0,
    heartbeat: () => {},
    eventsSince: () => [],
    setAgentSessionId: () => {},
    writeArtifact: (rel: string, content: string) => {
      written[rel] = content;
    },
    readArtifact: (rel: string) => artifacts[rel],
    emit: (kind: string, payload: unknown) => emitted.push({ kind, payload }),
  } as unknown as EffectContext;
  return { ctx, emitted, written };
}

describe('composeReconcilePrompt', () => {
  it('是跨仓对账 prompt：列出各仓、要求末尾 json 块（interfaces+unresolved），不产设计', () => {
    const prompt = composeReconcilePrompt({ title: '加跨端下单', repos: [POS, PORTAL, '  '] });
    expect(prompt).toContain('对账');
    expect(prompt).toContain('```json');
    expect(prompt).toContain('unresolved');
    expect(prompt).toContain(`- ${POS}`);
    expect(prompt).toContain(`- ${PORTAL}`);
    expect(prompt).not.toContain('-   '); // 空白仓被滤掉
  });

  it('立项书 / followups 在则织入，不在则优雅降级', () => {
    expect(composeReconcilePrompt({ title: 't', repos: [POS] })).not.toContain('立项书');
    const withBoth = composeReconcilePrompt({
      title: 't',
      repos: [POS],
      intakeBrief: '# 立项书\n背景X',
      followups: ['B 仓改名了'],
    });
    expect(withBoth).toContain('立项书');
    expect(withBoth).toContain('B 仓改名了');
  });
});

describe('parseReconcileResult', () => {
  const block = (obj: unknown) => `对账说明…\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`;

  it('抽出 interfaces + unresolved；取最后一个有内容的块', () => {
    const report =
      block({ interfaces: [{ id: 'EX', signature: 'x', providerRepo: POS }] }) +
      block({
        interfaces: [iface()],
        unresolved: [{ kind: 'dangling', interfaceId: 'getCoupon', detail: 'd', repos: [PORTAL] }],
      });
    const r = parseReconcileResult(report);
    expect(r.interfaces.map((i) => i.id)).toEqual(['createOrder']); // last block wins
    expect(r.unresolved).toHaveLength(1);
    expect(r.unresolved[0]).toMatchObject({ kind: 'dangling', interfaceId: 'getCoupon' });
  });

  it('坏 unresolved.kind 归一为 conflict；缺 detail 的条目丢弃；无块 → 空结果', () => {
    const r = parseReconcileResult(
      block({
        interfaces: [],
        unresolved: [
          { kind: '乱写', interfaceId: 'a', detail: '有详情' },
          { kind: 'dangling', interfaceId: 'b' }, // 无 detail → 丢
        ],
      }),
    );
    expect(r.unresolved).toEqual([
      { kind: 'conflict', interfaceId: 'a', detail: '有详情', repos: [] },
    ]);
    expect(parseReconcileResult('纯文本无块')).toEqual({ interfaces: [], unresolved: [] });
  });
});

describe('structuralDangling (纯结构化安全网)', () => {
  it('全在清单内 → 无悬空', () => {
    expect(structuralDangling([iface()], [POS, PORTAL])).toEqual([]);
  });

  it('providerRepo 缺失 / 不在清单 → 悬空', () => {
    expect(structuralDangling([iface({ providerRepo: '' })], [POS, PORTAL])[0]).toMatchObject({
      kind: 'dangling',
    });
    expect(
      structuralDangling([iface({ providerRepo: '/repos/ghost' })], [PORTAL])[0]?.detail,
    ).toContain('提供方仓不在立项仓库清单');
  });

  it('consumerRepo 不在清单 → 悬空', () => {
    const d = structuralDangling([iface({ consumerRepos: ['/repos/ghost'] })], [POS]);
    expect(d[0]).toMatchObject({ kind: 'dangling' });
    expect(d[0]?.detail).toContain('调用方仓不在立项仓库清单');
  });
});

describe('reconcileVerdict', () => {
  it('owner 自报 unresolved ∪ 结构化悬空，去重；都空 → passed', () => {
    expect(reconcileVerdict({ interfaces: [iface()], unresolved: [] }, [POS, PORTAL])).toEqual({
      passed: true,
      unresolved: [],
    });
    const v = reconcileVerdict(
      {
        interfaces: [iface({ providerRepo: '/repos/ghost' })],
        unresolved: [{ kind: 'conflict', interfaceId: 'x', detail: '字段对不上', repos: [POS] }],
      },
      [POS, PORTAL],
    );
    expect(v.passed).toBe(false);
    expect(v.unresolved).toHaveLength(2); // owner 冲突 + 结构化悬空
  });

  it('多仓需求却 0 接口 0 未决 → 疑则判大（不当全咬合放行）；单仓 0 接口 → 放行', () => {
    const multi = reconcileVerdict({ interfaces: [], unresolved: [] }, [POS, PORTAL]);
    expect(multi.passed).toBe(false);
    expect(multi.unresolved[0]).toMatchObject({ kind: 'dangling', interfaceId: '(整体)' });
    // 单仓需求 0 接口属正常（无跨仓边界）→ 放行。
    expect(reconcileVerdict({ interfaces: [], unresolved: [] }, [POS])).toEqual({
      passed: true,
      unresolved: [],
    });
  });
});

describe('reconcileToContract', () => {
  it('空 → 空快照；非空 → 带 fingerprint 的快照', () => {
    expect(reconcileToContract({ interfaces: [], unresolved: [] }).interfaces).toEqual([]);
    const snap = reconcileToContract({ interfaces: [iface()], unresolved: [] });
    expect(snap.interfaces).toHaveLength(1);
    expect(typeof snap.fingerprint).toBe('string');
  });
});

describe('reconcile_check effect handler', () => {
  const handler = createReconcileCheckHandler();
  const reconcileJson = (obj: unknown) => ({ 'contract/reconcile.json': JSON.stringify(obj) });

  it('无 reconcile.json（无跨仓接口的需求）→ 放行 no_reconcile', async () => {
    const { ctx, emitted } = fakeCtx({}, [POS]);
    await handler.run(ctx);
    expect(emitted).toEqual([{ kind: 'reconcile_passed', payload: { reason: 'no_reconcile' } }]);
  });

  it('全咬合（接口都在清单内、无 unresolved）→ reconcile_passed + 落对账报告', async () => {
    const { ctx, emitted, written } = fakeCtx(
      reconcileJson({ interfaces: [iface()], unresolved: [] }),
      [POS, PORTAL],
    );
    await handler.run(ctx);
    expect(emitted[0]).toMatchObject({ kind: 'reconcile_passed', payload: { interfaces: 1 } });
    expect(written['contract/reconcile-report.md']).toContain('全咬合');
  });

  it('owner 自报冲突 → reconcile_conflict（病历）', async () => {
    const { ctx, emitted, written } = fakeCtx(
      reconcileJson({
        interfaces: [iface()],
        unresolved: [
          {
            kind: 'conflict',
            interfaceId: 'createOrder',
            detail: '字段方向对不上',
            repos: [POS, PORTAL],
          },
        ],
      }),
      [POS, PORTAL],
    );
    await handler.run(ctx);
    expect(emitted[0]!.kind).toBe('reconcile_conflict');
    expect((emitted[0]!.payload as { unresolved: unknown[] }).unresolved).toHaveLength(1);
    expect(written['contract/reconcile-report.md']).toContain('未决');
  });

  it('结构化安全网逮住「引用了清单外仓」的接口 → reconcile_conflict（owner 漏报也兜住）', async () => {
    const { ctx, emitted } = fakeCtx(
      reconcileJson({ interfaces: [iface({ consumerRepos: ['/repos/ghost'] })], unresolved: [] }),
      [POS, PORTAL], // ghost 不在清单
    );
    await handler.run(ctx);
    expect(emitted[0]!.kind).toBe('reconcile_conflict');
  });

  it('多仓需求但对出 0 接口 0 未决 → 疑则判大 reconcile_conflict（不静默放行）', async () => {
    const { ctx, emitted } = fakeCtx(reconcileJson({ interfaces: [], unresolved: [] }), [
      POS,
      PORTAL,
    ]);
    await handler.run(ctx);
    expect(emitted[0]!.kind).toBe('reconcile_conflict');
  });
});
