import { describe, expect, it } from 'vitest';
import type { EffectContext } from '../../src/workitems/effects.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';
import {
  composeScoutPrompt,
  createScoutApplyHandler,
  parseScoutResult,
} from '../../src/worktypes/requirement/intake-scout.js';
import { makeWorkItem } from '../helpers/workitems.js';

// INTAKE L1 勘探纯核心（composeScoutPrompt / parseScoutResult）+ scout_apply effect。

const scoutBlock = (obj: unknown) =>
  `找到了一个候选仓……\n\n\`\`\`scout\n${JSON.stringify(obj)}\n\`\`\`\n`;

describe('composeScoutPrompt', () => {
  it('织入线索 / 搜索根 / 登记快照 / 产出格式 + 「绝不编造路径」红线', () => {
    const p = composeScoutPrompt({
      title: '订单导出',
      hints: 'alaeatposapp',
      roots: ['/Users/zwh', '/work'],
      registrySnapshot: '- posapp → /Users/zwh/posapp',
      summary: '给订单页加导出',
    });
    expect(p).toContain('勘探员');
    expect(p).toContain('alaeatposapp');
    expect(p).toContain('- /Users/zwh');
    expect(p).toContain('- /work');
    expect(p).toContain('posapp → /Users/zwh/posapp');
    expect(p).toContain('给订单页加导出');
    expect(p).toContain('```scout');
    expect(p).toContain('绝不编造路径');
    expect(p).toContain('只读浏览');
  });

  it('无搜索根 / 无线索 / 空登记表也不抛，给出占位', () => {
    const p = composeScoutPrompt({ title: 'X', hints: '', roots: [], registrySnapshot: '' });
    expect(p).toContain('无法搜盘');
    expect(p).toContain('登记表为空');
  });
});

describe('parseScoutResult', () => {
  it('正常：抽 repos / ambiguities / notFound', () => {
    const r = parseScoutResult(
      scoutBlock({
        repos: ['/a/x'],
        ambiguities: [{ question: '用哪个？', options: ['/b/y（新）', '/c/y（旧）'] }],
        notFound: ['zzz'],
      }),
    );
    expect(r.repos).toEqual(['/a/x']);
    expect(r.ambiguities).toEqual([
      { question: '用哪个？', options: ['/b/y（新）', '/c/y（旧）'] },
    ]);
    expect(r.notFound).toEqual(['zzz']);
  });

  it('坏 JSON / 无块 → 全空（永不抛）', () => {
    expect(parseScoutResult('```scout\n坏 json\n```')).toEqual({
      repos: [],
      ambiguities: [],
      notFound: [],
    });
    expect(parseScoutResult('没有块的纯说明')).toEqual({
      repos: [],
      ambiguities: [],
      notFound: [],
    });
    expect(parseScoutResult('')).toEqual({ repos: [], ambiguities: [], notFound: [] });
  });

  it('取最后一个有效块；repos 剔除非字符串；选项<2 的歧义丢弃', () => {
    const r = parseScoutResult(
      scoutBlock({ repos: ['/first'] }) +
        scoutBlock({
          repos: ['/a', 123, null],
          ambiguities: [
            { question: '有效', options: ['/x', '/y'] },
            { question: '只一个选项', options: ['/z'] },
            { question: '', options: ['/p', '/q'] },
          ],
          notFound: [],
        }),
    );
    expect(r.repos).toEqual(['/a']);
    expect(r.ambiguities).toEqual([{ question: '有效', options: ['/x', '/y'] }]);
  });

  it('也认 ```json 块', () => {
    const r = parseScoutResult(`\`\`\`json\n${JSON.stringify({ repos: ['/j'] })}\n\`\`\``);
    expect(r.repos).toEqual(['/j']);
  });

  it('INTAKE L2：解析 materials（prd/acceptance/background）；缺 path/summary 的项丢弃', () => {
    const r = parseScoutResult(
      scoutBlock({
        repos: ['/a'],
        materials: {
          prd: { path: 'docs/prd.md', summary: '导出订单' },
          acceptance: { path: '', summary: '缺 path 丢弃' },
          background: { summary: '老板要报表' },
        },
      }),
    );
    expect(r.materials).toEqual({
      prd: { path: 'docs/prd.md', summary: '导出订单' },
      background: { summary: '老板要报表' },
    });
  });

  it('INTAKE L2：只有 materials（无 repos/歧义/notFound）也算有效块', () => {
    const r = parseScoutResult(scoutBlock({ materials: { prd: { path: 'p.md', summary: 's' } } }));
    expect(r.materials?.prd).toEqual({ path: 'p.md', summary: 's' });
  });
});

function fakeCtx(
  artifacts: Record<string, string>,
  payload: unknown,
): { ctx: EffectContext; emitted: Array<{ kind: string; payload: unknown }> } {
  const emitted: Array<{ kind: string; payload: unknown }> = [];
  const ctx = {
    effect: { id: 1, workitemId: 'wi-1', seq: 9, kind: 'scout_apply', payload },
    workitem: makeWorkItem('wi-1', { type: 'requirement', phase: PHASE.intake, repos: [] }),
    signal: new AbortController().signal,
    clock: { now: () => 1000 },
    logger: {},
    batchFromSeq: 0,
    heartbeat: () => {},
    eventsSince: () => [],
    setAgentSessionId: () => {},
    writeArtifact: () => {},
    readArtifact: (rel: string) => artifacts[rel],
    emit: (kind: string, p: unknown) => emitted.push({ kind, payload: p }),
  } as unknown as EffectContext;
  return { ctx, emitted };
}

describe('scout_apply effect handler', () => {
  const handler = createScoutApplyHandler();

  it('读报告 → emit scout_result（repos/ambiguities/notFound/materials）', async () => {
    const report = scoutBlock({
      repos: ['/a/x'],
      ambiguities: [{ question: '用哪个？', options: ['/b/y', '/c/y'] }],
      notFound: ['zzz'],
      materials: { prd: { path: 'p.md', summary: 's' } },
    });
    const { ctx, emitted } = fakeCtx(
      { 'assignments/s/report.md': report },
      { reportPath: 'assignments/s/report.md' },
    );
    await handler.run(ctx);
    expect(emitted[0]).toMatchObject({
      kind: 'scout_result',
      payload: {
        repos: ['/a/x'],
        ambiguities: [{ question: '用哪个？', options: ['/b/y', '/c/y'] }],
        notFound: ['zzz'],
        materials: { prd: { path: 'p.md', summary: 's' } },
      },
    });
  });

  it('空报告 / reportPath 缺失 → emit 全空（审计留痕）', async () => {
    const missing = fakeCtx({}, { reportPath: 'assignments/none/report.md' });
    await handler.run(missing.ctx);
    expect(missing.emitted[0]).toMatchObject({
      kind: 'scout_result',
      payload: { repos: [], ambiguities: [], notFound: [] },
    });

    const noPath = fakeCtx({}, {});
    await handler.run(noPath.ctx);
    expect(noPath.emitted[0]).toMatchObject({
      kind: 'scout_result',
      payload: { repos: [], ambiguities: [], notFound: [] },
    });
  });
});
