import { describe, expect, it } from 'vitest';
import {
  composeIntakeExtractPrompt,
  parseIntakeExtraction,
} from '../../src/worktypes/requirement/intake.js';

// AI 抽取的纯核心（M-I3 step8 live 版）：prompt 组装 + 输出解析。AI 真跑沙箱测不了，但这两块是纯的。

describe('composeIntakeExtractPrompt', () => {
  it('含字段菜单 + 已填/还缺 + 只输出 JSON 约束 + 用户原文', () => {
    const p = composeIntakeExtractPrompt('给订单页加导出', ['需求名称'], ['涉及代码仓库', 'PRD']);
    expect(p).toContain('repos：涉及代码仓库');
    expect(p).toContain('当前已填：需求名称');
    expect(p).toContain('还缺必填：涉及代码仓库、PRD');
    expect(p).toContain('只输出一个 JSON');
    expect(p).toContain('给订单页加导出');
  });

  it('INTAKE L0.3：有登记表则织入「已知仓库登记」小节（仓名 → 绝对路径）+ repoHints 指令', () => {
    const p = composeIntakeExtractPrompt(
      '就在 alaeatposapp 里',
      [],
      ['涉及代码仓库'],
      [{ name: 'alaeatposapp', path: '/Users/zwh/alaeatposapp' }],
    );
    expect(p).toContain('已知仓库登记（仓名 → 绝对路径');
    expect(p).toContain('- alaeatposapp → /Users/zwh/alaeatposapp');
    expect(p).toContain('repoHints');
  });

  it('INTAKE L0.3：无登记表时不织入登记小节（缺省参数）', () => {
    const p = composeIntakeExtractPrompt('给订单页加导出', [], []);
    expect(p).not.toContain('已知仓库登记（仓名 → 绝对路径');
  });
});

describe('parseIntakeExtraction', () => {
  it('裸 JSON：抽多字段 + repos 数组 + uiRequired', () => {
    const ex = parseIntakeExtraction(
      '{"fields":[{"key":"summary","value":"加导出"},{"key":"repos","value":["/abs/a","/abs/b"]}],"uiRequired":true}',
    );
    expect(ex).not.toBeNull();
    expect(ex!.uiRequired).toBe(true);
    expect(ex!.fields).toEqual([
      { key: 'summary', value: '加导出' },
      { key: 'repos', value: ['/abs/a', '/abs/b'] },
    ]);
  });

  it('围栏块 ```json + 前后话术也能解析', () => {
    const ex = parseIntakeExtraction(
      '好的，结果如下：\n```json\n{"fields":[{"key":"acceptance","value":"能导出"}]}\n```\n（仅供参考）',
    );
    expect(ex!.fields).toEqual([{ key: 'acceptance', value: '能导出' }]);
  });

  it('丢非清单 key / 空值 / 坏类型，保留合法项', () => {
    const ex = parseIntakeExtraction(
      '{"fields":[{"key":"bogus","value":"x"},{"key":"prd","value":""},{"key":"ui","value":"https://figma/x"},{"key":"repos","value":["/a",123]}]}',
    );
    expect(ex!.fields).toEqual([
      { key: 'ui', value: 'https://figma/x' },
      { key: 'repos', value: ['/a'] }, // 非字符串元素被剔除
    ]);
  });

  it('无可用字段 / 坏 JSON / 非对象 → null', () => {
    expect(parseIntakeExtraction('{"fields":[]}')).toBeNull();
    expect(parseIntakeExtraction('not json at all')).toBeNull();
    expect(parseIntakeExtraction('{"fields":[{"key":"bogus","value":"x"}]}')).toBeNull();
    expect(parseIntakeExtraction('')).toBeNull();
  });

  it('只有 uiRequired 也算有效结果', () => {
    const ex = parseIntakeExtraction('{"fields":[],"uiRequired":true}');
    expect(ex).toEqual({ fields: [], uiRequired: true });
  });

  it('INTAKE L0.3：解析 repoHints（去空白/非字符串剔除），只有 repoHints 也算有效', () => {
    const ex = parseIntakeExtraction('{"fields":[],"repoHints":["  alaeatposapp  ","",123]}');
    expect(ex).toEqual({ fields: [], repoHints: ['alaeatposapp'] });
  });

  it('INTAKE L0.3：repoHints 与 fields 并存', () => {
    const ex = parseIntakeExtraction(
      '{"fields":[{"key":"summary","value":"加导出"}],"repoHints":["posapp"]}',
    );
    expect(ex).toEqual({ fields: [{ key: 'summary', value: '加导出' }], repoHints: ['posapp'] });
  });

  it('INTAKE L0.3：空 repoHints 不进结果', () => {
    const ex = parseIntakeExtraction('{"fields":[{"key":"summary","value":"x"}],"repoHints":[]}');
    expect(ex).toEqual({ fields: [{ key: 'summary', value: 'x' }] });
  });
});
