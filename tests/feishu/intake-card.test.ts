import { describe, expect, it } from 'vitest';
import {
  buildIntakeChecklistCard,
  type IntakeChecklistView,
} from '../../src/feishu/intake-card.js';

// 立项清单卡（M-I1 任务3）：纯渲染 feishu 卡，接中性视图（不 import worktypes）。

// 测试里钻飞书卡 JSON 结构，用 any 简化（noExplicitAny 在本仓 biome 配置里已关）。
type AnyCard = any;
const elementsOf = (c: AnyCard): AnyCard[] => c.body.elements;
const buttonOf = (c: AnyCard): AnyCard | undefined => elementsOf(c).find((e) => e.tag === 'button');
const textOf = (c: AnyCard): string =>
  elementsOf(c)
    .filter((e) => e.tag === 'markdown')
    .map((e) => e.content)
    .join('\n');

function view(over: Partial<IntakeChecklistView> = {}): IntakeChecklistView {
  return {
    title: '订单状态查询',
    items: [
      { label: '需求名称', done: true, required: true, value: '订单状态查询' },
      { label: '一句话需求 + 背景', done: true, required: true },
      { label: '涉及代码仓库', done: false, required: true },
      { label: 'PRD', done: false, required: true },
      { label: '验收标准 / 完成定义', done: false, required: true },
      { label: '范围边界（明确不做什么）', done: false, required: false },
    ],
    filled: 2,
    total: 5,
    ready: false,
    missing: ['涉及代码仓库', 'PRD', '验收标准 / 完成定义'],
    ...over,
  };
}

describe('buildIntakeChecklistCard', () => {
  it('收料中：蓝头 + 进度 + ✅/⬜ 清单 + 缺项提示，无按钮', () => {
    const card = buildIntakeChecklistCard(view());
    expect((card as AnyCard).header.template).toBe('blue');
    expect((card as AnyCard).header.title.content).toContain('订单状态查询');
    const text = textOf(card);
    expect(text).toContain('必填 2/5');
    expect(text).toContain('✅ 需求名称');
    expect(text).toContain('⬜ PRD');
    expect(text).toContain('订单状态查询'); // 已填值摘要
    expect(text).toContain('还差：涉及代码仓库、PRD、验收标准 / 完成定义');
    expect(buttonOf(card)).toBeUndefined(); // 未料齐，不出立项完成按钮
  });

  it('料齐 + gate：绿头 + 「立项完成」按钮走 ckpt 单写路径（approved=true）', () => {
    const ready = view({
      items: view().items.map((i) => (i.required ? { ...i, done: true } : i)),
      filled: 5,
      total: 5,
      ready: true,
      missing: [],
    });
    const card = buildIntakeChecklistCard(ready, {
      itemId: 'wi-1',
      waitId: 'wt-gate',
      boundary: 'requirement:理解',
    });
    expect((card as AnyCard).header.template).toBe('green');
    expect(textOf(card)).toContain('料齐');
    const btn = buttonOf(card);
    expect(btn).toBeDefined();
    expect(btn.text.content).toContain('立项完成');
    expect(btn.behaviors[0].value).toEqual({
      kind: 'ckpt', // 复用 checkpoint：点立项完成 = 立项 gate 通过
      itemId: 'wi-1',
      waitId: 'wt-gate',
      boundary: 'requirement:理解',
      approved: true,
    });
  });

  it('料齐但未传 gate routing（wait 尚未 raise）→ 不出按钮（防御）', () => {
    const card = buildIntakeChecklistCard(view({ ready: true, filled: 5, missing: [] }));
    expect(buttonOf(card)).toBeUndefined();
  });

  it('AI 预填待确认项渲染 🟡，必填项标 *', () => {
    const card = buildIntakeChecklistCard(
      view({
        items: [
          {
            label: '验收标准 / 完成定义',
            done: false,
            required: true,
            pending: true,
            value: 'AI 抽的草稿',
          },
          { label: '范围边界', done: false, required: false },
        ],
      }),
    );
    const text = textOf(card);
    expect(text).toContain('🟡 验收标准 / 完成定义');
    expect(text).toContain('＊'); // 必填星标（全角，避开 markdown 斜体把 <font> 吞掉）
    expect(text).not.toContain('<font color="red">*</font>'); // 不再用半角 * 星标
    expect(text).toContain('AI 抽的草稿');
  });

  it('超长需求名截断', () => {
    const card = buildIntakeChecklistCard(view({ title: '需'.repeat(60) }));
    expect((card as AnyCard).header.title.content).toContain('…');
  });
});
