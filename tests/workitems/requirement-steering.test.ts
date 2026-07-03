import { describe, expect, it } from 'vitest';
import type { EffectContext } from '../../src/workitems/effects.js';
import type { ContractSnapshot } from '../../src/worktypes/requirement/contract.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';
import {
  composeSteerPrompt,
  createSteerApplyHandler,
  parseSteerDirective,
  renderContractSummary,
  steeringNotePath,
} from '../../src/worktypes/requirement/steering.js';
import { makeWorkItem } from '../helpers/workitems.js';

// WS-2 消息必达：owner steer 通道纯核心（compose/parse/path/renderContractSummary）+ steer_apply effect。

const steerBlock = (obj: unknown) =>
  `面向用户的中文答复……\n\n\`\`\`steer\n${JSON.stringify(obj)}\n\`\`\`\n`;

describe('parseSteerDirective', () => {
  it('认 ```steer 块的四种 action', () => {
    expect(parseSteerDirective(steerBlock({ action: 'none', repos: [], note: '' })).action).toBe(
      'none',
    );
    expect(parseSteerDirective(steerBlock({ action: 'redo_reconcile' })).action).toBe(
      'redo_reconcile',
    );
    expect(
      parseSteerDirective(steerBlock({ action: 'rework', repos: ['/a'], note: '改x' })),
    ).toEqual({ action: 'rework', repos: ['/a'], note: '改x' });
    expect(parseSteerDirective(steerBlock({ action: 'raise_human', note: '裁决y' })).action).toBe(
      'raise_human',
    );
  });

  it('坏 JSON / 无块 / 非法 action → none（永不抛）', () => {
    expect(parseSteerDirective('没有块的纯答复')).toEqual({ action: 'none', repos: [], note: '' });
    expect(parseSteerDirective('```steer\n坏 json\n```')).toEqual({
      action: 'none',
      repos: [],
      note: '',
    });
    expect(parseSteerDirective(steerBlock({ action: 'bogus' })).action).toBe('none');
  });

  it('取最后一个有效块 + repos 过滤非字符串', () => {
    const r = parseSteerDirective(
      steerBlock({ action: 'none' }) +
        steerBlock({ action: 'rework', repos: ['/a', 123, null], note: 'n' }),
    );
    expect(r.action).toBe('rework');
    expect(r.repos).toEqual(['/a']);
  });

  it('也认 ```json 块', () => {
    const r = parseSteerDirective(
      `\`\`\`json\n${JSON.stringify({ action: 'raise_human' })}\n\`\`\``,
    );
    expect(r.action).toBe('raise_human');
  });
});

describe('steeringNotePath', () => {
  it('steering/<sanitized>.md（与 worktree.ts sanitize 一致）', () => {
    expect(steeringNotePath('/abs/repo-a')).toBe('steering/abs_repo-a.md');
    expect(steeringNotePath('repo')).toBe('steering/repo.md');
  });
});

describe('renderContractSummary', () => {
  it('输出条数 + 逐条 signature', () => {
    const snap = {
      version: 'v1',
      fingerprint: 'fp',
      interfaces: [
        { id: 'a', signature: 'GET /x', providerRepo: '/a', consumerRepos: [], fields: [] },
        { id: 'b', signature: 'POST /y', providerRepo: '/b', consumerRepos: [], fields: [] },
      ],
    } as ContractSnapshot;
    const s = renderContractSummary(snap);
    expect(s).toContain('2');
    expect(s).toContain('GET /x');
    expect(s).toContain('POST /y');
  });
});

describe('composeSteerPrompt', () => {
  it('织入 followups（最高优先级）+ 契约摘要 + 末尾 steer 块要求 + 四种 action 说明', () => {
    const p = composeSteerPrompt({
      title: '需求X',
      phase: PHASE.implement,
      repos: ['/a', '/b'],
      followups: ['把后端字段名改成 orderNo'],
      contractSummary: '跨仓契约 2 条接口：\n- GET /x\n- POST /y',
    });
    expect(p).toContain('包工头');
    expect(p).toContain('把后端字段名改成 orderNo');
    expect(p).toContain('跨仓契约 2 条接口');
    expect(p).toContain('```steer');
    expect(p).toContain('redo_reconcile');
    expect(p).toContain('rework');
    expect(p).toContain('raise_human');
    // ENHANCE E3：raise_human 上报必须带建议方案与理由（人参考建议来裁决，不再独自从零想方案）。
    expect(p).toContain('建议方案与理由');
    // ENHANCE E6：衍生文本产物（测试用例/自测清单等）属包工头分内事，直接产出不上报不外推。
    expect(p).toContain('衍生文本产物');
    expect(p).toContain('分内事');
    // ENHANCE E6：新增小型施工任务（补测试/补文档）走 rework 通道（语义放宽为定向施工指令）。
    expect(p).toContain('新增小型施工任务');
  });
});

function fakeCtx(
  artifacts: Record<string, string>,
  payload: unknown,
  repos: string[],
): {
  ctx: EffectContext;
  emitted: Array<{ kind: string; payload: unknown }>;
  written: Record<string, string>;
} {
  const emitted: Array<{ kind: string; payload: unknown }> = [];
  const written: Record<string, string> = {};
  const ctx = {
    effect: {
      id: 1,
      workitemId: 'wi-1',
      seq: 9,
      kind: 'steer_apply',
      payload,
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
    },
    workitem: makeWorkItem('wi-1', { type: 'requirement', phase: PHASE.implement, repos }),
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
    emit: (kind: string, p: unknown) => emitted.push({ kind, payload: p }),
  } as unknown as EffectContext;
  return { ctx, emitted, written };
}

describe('steer_apply effect handler', () => {
  const handler = createSteerApplyHandler();

  it('rework → 追加写 steering note + emit steer_directive；清单外的仓被过滤', async () => {
    const report = steerBlock({
      action: 'rework',
      repos: ['/abs/a', '/abs/outside'],
      note: '把 X 改成 Y',
    });
    const { ctx, emitted, written } = fakeCtx(
      { 'assignments/x/report.md': report, 'steering/abs_a.md': '# 旧指示\n之前的' },
      { reportPath: 'assignments/x/report.md' },
      ['/abs/a', '/abs/b'],
    );
    await handler.run(ctx);
    // 追加语义：旧内容保留 + 新 note。
    expect(written['steering/abs_a.md']).toContain('旧指示');
    expect(written['steering/abs_a.md']).toContain('把 X 改成 Y');
    // 清单外的 /abs/outside 不写 note。
    expect(written['steering/abs_outside.md']).toBeUndefined();
    // emit steer_directive，repos 交集后只含 /abs/a。
    expect(emitted[0]).toMatchObject({
      kind: 'steer_directive',
      payload: { action: 'rework', repos: ['/abs/a'], note: '把 X 改成 Y' },
    });
  });

  it('action=none 也 emit steer_directive（审计留痕 + anchor 刷新）', async () => {
    const { ctx, emitted } = fakeCtx(
      { 'assignments/x/report.md': '纯答复，无指令块' },
      { reportPath: 'assignments/x/report.md' },
      ['/abs/a'],
    );
    await handler.run(ctx);
    expect(emitted[0]).toMatchObject({ kind: 'steer_directive', payload: { action: 'none' } });
  });

  it('报告空（readArtifact undefined）→ emit none', async () => {
    const { ctx, emitted } = fakeCtx({}, { reportPath: 'assignments/none/report.md' }, ['/abs/a']);
    await handler.run(ctx);
    expect(emitted[0]).toMatchObject({ kind: 'steer_directive', payload: { action: 'none' } });
  });

  it('reportPath 缺失 → 直接 return，不 emit', async () => {
    const { ctx, emitted } = fakeCtx({}, {}, ['/abs/a']);
    await handler.run(ctx);
    expect(emitted).toHaveLength(0);
  });
});
