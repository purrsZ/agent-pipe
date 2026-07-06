import { describe, expect, it } from 'vitest';
import {
  renderRegistrySnapshot,
  runScoutResult,
  scoutConclusionCount,
  scoutRootsFrom,
} from '../src/index.js';
import type { WorkItemEvent } from '../src/workitems/types.js';

// INTAKE L1：scout_result 桥层消费（runScoutResult DI）+ 防抖计数（scoutConclusionCount）+ 搜索根/快照纯核心。

function ev(payload: unknown): WorkItemEvent {
  return { id: 1, workitemId: 'wi-1', seq: 1, kind: 'scout_result', payload, createdAt: 1000 };
}

function harness(over: Partial<Parameters<typeof runScoutResult>[0]> = {}) {
  const injected: string[][] = [];
  const upserted: string[] = [];
  const cards: Array<{ question: string; options: string[] }> = [];
  const posted: object[] = [];
  const notes: string[] = [];
  const deps = {
    currentRepos: [] as string[],
    isGitRepo: (p: string) => p.startsWith('/good'),
    injectRepos: (repos: string[]) => injected.push(repos),
    upsertRepo: (p: string) => upserted.push(p),
    buildQuestionCard: (question: string, options: string[]) => {
      cards.push({ question, options });
      return { question, options };
    },
    postCard: async (card: object) => {
      posted.push(card);
    },
    notify: async (text: string) => {
      notes.push(text);
    },
    logger: { error: () => {}, info: () => {} },
    ...over,
  };
  return { deps, injected, upserted, cards, posted, notes };
}

describe('runScoutResult (INTAKE L1 桥层 DI)', () => {
  it('合法仓：当场校验通过 → 与现有 repos 合并去重后注入 + 逐仓登记 + ✅ 文案', async () => {
    const h = harness({ currentRepos: ['/good/old'] });
    await runScoutResult(
      h.deps,
      ev({ repos: ['/good/x', '/good/old'], ambiguities: [], notFound: [] }),
    );
    expect(h.injected).toEqual([['/good/old', '/good/x']]); // 合并去重（/good/old 不重复）
    expect(h.upserted.sort()).toEqual(['/good/old', '/good/x']);
    expect(h.notes.join('\n')).toContain('✅');
  });

  it('非法仓：校验不过 → 不注入、不登记，降级为 ⚠️ 说明', async () => {
    const h = harness();
    await runScoutResult(h.deps, ev({ repos: ['/bad/x'], ambiguities: [], notFound: [] }));
    expect(h.injected).toEqual([]);
    expect(h.upserted).toEqual([]);
    expect(h.notes.join('\n')).toContain('⚠️');
    expect(h.notes.join('\n')).toContain('/bad/x');
  });

  it('歧义：每条出一张 AUQ 卡（断言卡 question/options 形状）', async () => {
    const h = harness();
    await runScoutResult(
      h.deps,
      ev({
        repos: [],
        ambiguities: [{ question: '用哪个 posapp？', options: ['/a/posapp', '/b/posapp'] }],
        notFound: [],
      }),
    );
    expect(h.cards).toEqual([{ question: '用哪个 posapp？', options: ['/a/posapp', '/b/posapp'] }]);
    expect(h.posted).toHaveLength(1);
  });

  it('notFound：出「没找到，请给绝对路径或 /scout 重试」文案', async () => {
    const h = harness();
    await runScoutResult(h.deps, ev({ repos: [], ambiguities: [], notFound: ['zzz'] }));
    expect(h.notes.join('\n')).toContain('没找到');
    expect(h.notes.join('\n')).toContain('zzz');
    expect(h.notes.join('\n')).toContain('/scout');
  });

  it('全空 payload → 无动作（no-op）', async () => {
    const h = harness();
    await runScoutResult(h.deps, ev({ repos: [], ambiguities: [], notFound: [] }));
    expect(h.injected).toEqual([]);
    expect(h.posted).toEqual([]);
    expect(h.notes).toEqual([]);
  });
});

describe('scoutConclusionCount (防抖 D-7)', () => {
  const conc = (kind: string, stage?: string): WorkItemEvent => ({
    id: 1,
    workitemId: 'wi-1',
    seq: 1,
    kind,
    payload: stage ? { stage } : {},
    createdAt: 1,
  });

  it('只数 run_completed/run_failed 里 stage=scout 的结论', () => {
    expect(
      scoutConclusionCount([
        conc('run_completed', 'scout'),
        conc('run_failed', 'scout'),
        conc('run_completed', 'steer'), // 非 scout 不数
        conc('human_message'), // 非结论不数
        conc('run_completed'), // 无 stage 不数
      ]),
    ).toBe(2);
  });

  it('无 scout 结论 → 0', () => {
    expect(scoutConclusionCount([conc('run_completed', 'reconcile')])).toBe(0);
    expect(scoutConclusionCount([])).toBe(0);
  });
});

describe('scoutRootsFrom (D-4 搜索根自举)', () => {
  it('登记仓父目录去重 ∪ env（冒号分隔）', () => {
    expect(scoutRootsFrom(['/Users/zwh/a', '/Users/zwh/b', '/work/c'], '/extra:/work')).toEqual([
      '/Users/zwh',
      '/work',
      '/extra',
    ]);
  });

  it('两者皆空 → []（勘探不可用）', () => {
    expect(scoutRootsFrom([], undefined)).toEqual([]);
    expect(scoutRootsFrom([], '  ')).toEqual([]);
  });
});

describe('renderRegistrySnapshot', () => {
  it('逐行渲染 仓名 → 绝对路径；空 → 空串', () => {
    expect(renderRegistrySnapshot([{ name: 'posapp', path: '/a/posapp' }])).toBe(
      '- posapp → /a/posapp',
    );
    expect(renderRegistrySnapshot([])).toBe('');
  });
});
