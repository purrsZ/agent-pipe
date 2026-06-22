import { CHECKPOINT_ACTION_KIND } from './card.js';

// 立项清单卡：群内引导式立项的「脸面」。展示清单 ✅/⬜ + 必填进度 + 缺项提示；料齐（立项 gate raised）
// 时出「立项完成」按钮——它就是立项 gate（立项→理解 checkpoint）的「通过」，复用 ckpt 单写路径 resolve，
// 点完进「理解」开跑现有引擎。
//
// kernel-neutral：本文件只渲染上游（requirement 层 / bridge）预备好的中性视图（IntakeChecklistView），
// 不 import worktypes 的 IntakeState——和 buildCheckpointCard 的 gateLabel/rail 预渲染同款纪律。
// 立项清单 → 视图的映射（用 intake 纯核心 requiredMissing/requiredProgress/isFieldSatisfied）由 bridge
// 在 M-I3 接线时做。

export interface IntakeChecklistItemView {
  label: string;
  done: boolean; // 已「算齐」（user 填 或 ai-extracted 已确认）
  required: boolean; // 当前是否必填（含 ui 勾选后升必填）
  pending?: boolean; // AI 预填、待用户确认
  value?: string; // 已填值摘要（可选展示）
}

export interface IntakeChecklistView {
  title: string; // 需求名（= 群名）
  items: IntakeChecklistItemView[];
  filled: number; // 必填已齐数
  total: number; // 必填总数（随 ui 勾选变）
  ready: boolean; // 必填齐 → 可立项完成
  missing: string[]; // 缺的必填项 label（"还差：X、Y"）
}

// 立项 gate 的路由（料齐后才有：gate raise 出 wait 才能 resolve）。立项完成按钮带它走 ckpt 单写路径。
export interface IntakeGateRouting {
  itemId: string;
  waitId: string;
  boundary: string; // 立项 gate boundary（上游给的边界标识字符串），handleCheckpointAction 渲染回执用
}

export function buildIntakeChecklistCard(
  view: IntakeChecklistView,
  gate?: IntakeGateRouting,
): object {
  const title = view.title.length > 40 ? `${view.title.slice(0, 40)}…` : view.title;
  const rows = view.items.map((it) => {
    const box = it.done ? '✅' : it.pending ? '🟡' : '⬜';
    const star = it.required ? ' <font color="red">*</font>' : '';
    const val = it.value ? ` — <font color="grey">${truncate(it.value, 24)}</font>` : '';
    return `${box} ${it.label}${star}${val}`;
  });
  const progress = view.ready
    ? `**必填 ${view.filled}/${view.total}** · 料齐，可点「立项完成」开跑`
    : `**必填 ${view.filled}/${view.total}** · 收齐必填项后放行`;
  const elements: object[] = [
    { tag: 'markdown', content: progress },
    { tag: 'markdown', content: rows.join('\n') },
  ];
  if (!view.ready && view.missing.length > 0) {
    elements.push({
      tag: 'markdown',
      content: `<font color="grey">还差：${view.missing.join('、')}</font>`,
    });
  }
  // 料齐 + 有 gate wait → 出「立项完成」按钮（= 立项 gate 通过）。无打回项：补料继续发消息即可。
  if (view.ready && gate) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '立项完成 · 开始开发' },
      type: 'primary',
      width: 'default',
      behaviors: [
        {
          type: 'callback',
          value: {
            kind: CHECKPOINT_ACTION_KIND, // 立项 gate = checkpoint wait；点立项完成走同一条 resolve 路径
            itemId: gate.itemId,
            waitId: gate.waitId,
            boundary: gate.boundary,
            approved: true,
          },
        },
      ],
    });
  }
  return {
    schema: '2.0',
    header: {
      template: view.ready ? 'green' : 'blue',
      title: { tag: 'plain_text', content: `立项清单 · ${title}` },
    },
    body: { direction: 'vertical', padding: '12px', elements },
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
