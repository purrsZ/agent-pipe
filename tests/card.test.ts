import { describe, expect, it } from 'vitest';
import {
  anchorAction,
  AUQ_ACTION_KIND,
  buildAnchorCard,
  buildCancelledCard,
  buildCheckpointAnsweredCard,
  buildCheckpointCard,
  buildErrorCard,
  buildQuestionAnsweredCard,
  buildQuestionCard,
  buildReportCard,
  CHECKPOINT_ACTION_KIND,
  formatClock,
} from '../src/feishu/card.js';
import { parseCardAction } from '../src/feishu/event-router.js';

describe('formatClock', () => {
  it('under an hour: m:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(5_000)).toBe('0:05');
    expect(formatClock(956_000)).toBe('15:56'); // the exact case from the screenshot
  });

  it('over an hour: h:mm:ss', () => {
    expect(formatClock(3_600_000)).toBe('1:00:00');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatClock(36_000_000)).toBe('10:00:00');
  });

  it('rounds sub-second and clamps negatives', () => {
    expect(formatClock(59_999)).toBe('1:00');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('buildAnchorCard (M1b WI-4)', () => {
  it('renders id / title / stage / status with a blue header when open', () => {
    const card = buildAnchorCard({
      id: 'wi-1',
      title: '看看 runner 有几个',
      stage: 'probe:looking',
      status: 'open',
    }) as { header: { template: string }; body: unknown };
    const json = JSON.stringify(card);
    expect(json).toContain('wi-1');
    expect(json).toContain('看看 runner 有几个');
    expect(json).toContain('probe:looking');
    expect(card.header.template).toBe('blue');
  });

  it('uses a grey header and a closed hint when closed', () => {
    const card = buildAnchorCard({
      id: 'wi-1',
      title: 't',
      stage: 'probe:done',
      status: 'done',
      closed: true,
    }) as { header: { template: string } };
    expect(card.header.template).toBe('grey');
    expect(JSON.stringify(card)).toContain('已关闭');
  });

  it('truncates an overlong title in the header', () => {
    const card = buildAnchorCard({
      id: 'wi-1',
      title: 'x'.repeat(80),
      stage: 's',
      status: 'open',
    }) as { header: { title: { content: string } } };
    expect(card.header.title.content).toContain('…');
  });

  it('uses a red header and a failed hint when status is failed (M1b WI-7)', () => {
    const card = buildAnchorCard({
      id: 'wi-1',
      title: 't',
      stage: 'probe:failed',
      status: 'failed',
    }) as { header: { template: string } };
    expect(card.header.template).toBe('red');
    const json = JSON.stringify(card);
    expect(json).toContain('调查失败');
    expect(json).toContain('已失败');
  });

  it('closed takes precedence over failed (grey, not red)', () => {
    const card = buildAnchorCard({
      id: 'wi-1',
      title: 't',
      stage: 'probe:failed',
      status: 'failed',
      closed: true,
    }) as { header: { template: string } };
    expect(card.header.template).toBe('grey');
  });

  it('defaults the header noun to 调查 (probe), but honours an override (T3 去调查化)', () => {
    const probe = buildAnchorCard({ id: 'wi-1', title: 't', stage: 's', status: 'open' });
    expect(JSON.stringify(probe)).toContain('调查 · t');

    const req = buildAnchorCard({
      id: 'wi-2',
      title: 't',
      stage: 'requirement:理解',
      status: 'open',
      noun: '需求',
    });
    const json = JSON.stringify(req);
    expect(json).toContain('需求 · t');
    expect(json).not.toContain('调查');
  });

  it('applies the noun to the failed header too (需求失败)', () => {
    const card = buildAnchorCard({
      id: 'wi-2',
      title: 't',
      stage: 's',
      status: 'failed',
      noun: '需求',
    });
    expect(JSON.stringify(card)).toContain('需求失败 · t');
  });
});

describe('buildCheckpointCard (T3 灯卡)', () => {
  const routing = { itemId: 'wi-1', waitId: 'wt-9', boundary: 'requirement:合同' };

  it('renders gate label + rail and 通过/打回 callback buttons carrying the routing', () => {
    const card = buildCheckpointCard(
      { title: '双端登录', gateLabel: '灯① 理解→合同', rail: '●灯①  ○灯②(快)' },
      routing,
    ) as { header: { template: string }; body: { elements: Array<Record<string, unknown>> } };
    expect(card.header.template).toBe('orange');
    const json = JSON.stringify(card);
    expect(json).toContain('灯① 理解→合同');
    expect(json).toContain('●灯①');
    expect(json).toContain('通过');
    expect(json).toContain('打回');

    const buttons = card.body.elements.filter((e) => e.tag === 'button');
    expect(buttons).toHaveLength(2);
    const values = buttons.map(
      (b) => (b.behaviors as Array<{ value: Record<string, unknown> }>)[0]!.value,
    );
    expect(values).toEqual([
      {
        kind: CHECKPOINT_ACTION_KIND,
        itemId: 'wi-1',
        waitId: 'wt-9',
        boundary: 'requirement:合同',
        approved: true,
      },
      {
        kind: CHECKPOINT_ACTION_KIND,
        itemId: 'wi-1',
        waitId: 'wt-9',
        boundary: 'requirement:合同',
        approved: false,
      },
    ]);
  });

  it('parseCardAction round-trips the 通过 button value (the consumer reads it back)', () => {
    const card = buildCheckpointCard({ title: 't', gateLabel: '灯①', rail: 'r' }, routing) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    const approveBtn = card.body.elements.find((e) => e.tag === 'button') as {
      behaviors: Array<{ value: unknown }>;
    };
    const action = parseCardAction({
      action: { value: approveBtn.behaviors[0]!.value },
      operator: { open_id: 'ou_owner' },
    });
    expect(action?.value).toMatchObject({
      kind: CHECKPOINT_ACTION_KIND,
      itemId: 'wi-1',
      waitId: 'wt-9',
      approved: true,
    });
  });
});

describe('buildCheckpointAnsweredCard (T3 灯卡终态)', () => {
  it('green 已通过 when approved', () => {
    const card = buildCheckpointAnsweredCard('t', '灯①', true) as { header: { template: string } };
    expect(card.header.template).toBe('green');
    expect(JSON.stringify(card)).toContain('已通过');
  });

  it('grey 已打回 when rejected', () => {
    const card = buildCheckpointAnsweredCard('t', '灯①', false) as { header: { template: string } };
    expect(card.header.template).toBe('grey');
    expect(JSON.stringify(card)).toContain('已打回');
  });

  it('grey 已处理 when resolved elsewhere (approved === null)', () => {
    const card = buildCheckpointAnsweredCard('t', '灯①', null) as { header: { template: string } };
    expect(card.header.template).toBe('grey');
    expect(JSON.stringify(card)).toContain('已处理');
  });
});

describe('buildReportCard (M1b WI-6)', () => {
  it('renders the title and report body under a green header', () => {
    const card = buildReportCard('看看 runner', 'BODY 内容') as { header: { template: string } };
    const json = JSON.stringify(card);
    expect(json).toContain('看看 runner');
    expect(json).toContain('BODY 内容');
    expect(card.header.template).toBe('green');
  });

  it('truncates an overlong report', () => {
    const card = buildReportCard('t', 'x'.repeat(40_000));
    expect(JSON.stringify(card)).toContain('已截断');
  });

  it('shows a placeholder for an empty report', () => {
    const card = buildReportCard('t', '   ');
    expect(JSON.stringify(card)).toContain('空报告');
  });
});

describe('buildErrorCard (M1b WI-7)', () => {
  it('renders the title + error summary under a red header', () => {
    const card = buildErrorCard('看看 runner', 'boom: cwd not found') as {
      header: { template: string };
    };
    const json = JSON.stringify(card);
    expect(json).toContain('看看 runner');
    expect(json).toContain('boom: cwd not found');
    expect(card.header.template).toBe('red');
  });

  it('truncates an overlong error', () => {
    const card = buildErrorCard('t', 'x'.repeat(40_000));
    expect(JSON.stringify(card)).toContain('已截断');
  });

  it('shows a placeholder for an empty error', () => {
    const card = buildErrorCard('t', '   ');
    expect(JSON.stringify(card)).toContain('未知错误');
  });
});

describe('buildCancelledCard (M2)', () => {
  it('renders 调查中断 · title under a grey header', () => {
    const card = buildCancelledCard('看看 runner') as { header: { template: string } };
    const json = JSON.stringify(card);
    expect(json).toContain('调查中断');
    expect(json).toContain('看看 runner');
    expect(card.header.template).toBe('grey');
  });

  it('truncates an overlong title', () => {
    const card = buildCancelledCard('x'.repeat(60)) as {
      header: { title: { content: string } };
    };
    expect(card.header.title.content).toContain('…');
  });
});

describe('anchorAction (M1b WI-7 → M2)', () => {
  it('terminal run_failed → refresh anchor ONLY (M2: failure card is the streaming card terminal patch)', () => {
    expect(anchorAction('run_failed', true)).toEqual({ reply: false, update: true });
  });

  it('other terminal (done) → skip — runDone owns the anchor (D6)', () => {
    expect(anchorAction('close_requested', true)).toEqual({ reply: false, update: false });
    expect(anchorAction('run_completed', true)).toEqual({ reply: false, update: false });
  });

  it('non-terminal progress → refresh anchor only (incl. mid-retry run_failed, D4)', () => {
    expect(anchorAction('run_completed', false)).toEqual({ reply: false, update: true });
    expect(anchorAction('human_message', false)).toEqual({ reply: false, update: true });
    expect(anchorAction('run_failed', false)).toEqual({ reply: false, update: true });
  });
});

describe('buildQuestionCard (AskUserQuestion interactive card)', () => {
  const q = {
    toolUseId: 'toolu_1',
    questions: [
      {
        question: '在重构上更偏好哪种？',
        header: '重构策略',
        multiSelect: false,
        options: [
          { label: '激进重写', description: '推倒重来' },
          { label: '渐进迁移', description: '逐步迁移' },
        ],
      },
    ],
  };
  type Btn = { tag: string; behaviors?: Array<{ value: Record<string, unknown> }> };

  it('renders one callback button per option carrying routing + label in action.value', () => {
    const card = buildQuestionCard('我的任务', q, { taskId: 't1', chatId: 'c1' }) as {
      header: { template: string };
      body: { elements: Btn[] };
    };
    expect(card.header.template).toBe('orange');
    const buttons = card.body.elements.filter((e) => e.tag === 'button');
    expect(buttons).toHaveLength(2);
    const v0 = buttons[0]!.behaviors![0]!.value;
    expect(v0.kind).toBe(AUQ_ACTION_KIND);
    expect(v0.taskId).toBe('t1');
    expect(v0.chatId).toBe('c1');
    expect(v0.label).toBe('激进重写');
    expect(v0.header).toBe('重构策略');
  });

  it('keeps option label + description and the 直接回复 fallback hint', () => {
    const json = JSON.stringify(buildQuestionCard('t', q, { taskId: 't1', chatId: 'c1' }));
    expect(json).toContain('激进重写');
    expect(json).toContain('推倒重来');
    expect(json).toContain('也可直接回复选项名');
  });

  it('button action.value round-trips through parseCardAction (the kernel callback path)', () => {
    const card = buildQuestionCard('t', q, { taskId: 't1', chatId: 'c1' }) as {
      body: { elements: Btn[] };
    };
    const value = card.body.elements.find((e) => e.tag === 'button')!.behaviors![0]!.value;
    const action = parseCardAction({
      action: { value },
      operator: { open_id: 'ou_1' },
      open_message_id: 'om_1',
    });
    expect(action).not.toBeNull();
    const v = action!.value as Record<string, unknown>;
    expect(v.kind).toBe(AUQ_ACTION_KIND);
    expect(v.taskId).toBe('t1');
    expect(v.label).toBe('激进重写');
  });

  it('marks a multiSelect question with a hint', () => {
    const multi = { ...q, questions: [{ ...q.questions[0]!, multiSelect: true }] };
    expect(JSON.stringify(buildQuestionCard('t', multi, { taskId: 't1', chatId: 'c1' }))).toContain(
      '可多选',
    );
  });
});

describe('buildQuestionAnsweredCard', () => {
  it('renders 已选择 X under a green header', () => {
    const card = buildQuestionAnsweredCard('我的任务', '渐进迁移') as {
      header: { template: string };
    };
    const json = JSON.stringify(card);
    expect(json).toContain('已选择');
    expect(json).toContain('渐进迁移');
    expect(card.header.template).toBe('green');
  });
});
