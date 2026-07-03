import { describe, expect, it } from 'vitest';
import {
  anchorAction,
  AUQ_ACTION_KIND,
  buildAnchorCard,
  buildCancelConfirmCard,
  buildCancelledCard,
  buildCaseFileAnsweredCard,
  buildCaseFileCard,
  buildCheckpointAnsweredCard,
  buildCheckpointCard,
  buildClosureCard,
  buildErrorCard,
  buildGatekeeperBigCard,
  buildWorkitemQuestionCard,
  buildQuestionAnsweredCard,
  buildQuestionCard,
  buildQuestionFormCard,
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

// WS-5：灯卡/病历卡把按钮移进 form，并加 opinion 输入框。提交时飞书同时回传 button.value 与 form_value.opinion。
function formOf(card: { body: { elements: Array<Record<string, unknown>> } }): {
  elements: Array<Record<string, unknown>>;
} {
  return card.body.elements.find((e) => e.tag === 'form') as {
    elements: Array<Record<string, unknown>>;
  };
}
function formButtons(card: {
  body: { elements: Array<Record<string, unknown>> };
}): Array<Record<string, unknown>> {
  return formOf(card).elements.filter((e) => e.tag === 'button');
}
function formInputNames(card: { body: { elements: Array<Record<string, unknown>> } }): string[] {
  return formOf(card)
    .elements.filter((e) => e.tag === 'input')
    .map((e) => e.name as string);
}

describe('buildCheckpointCard (T3 灯卡)', () => {
  const routing = { itemId: 'wi-1', waitId: 'wt-9', boundary: 'requirement:合同' };

  it('WS-5: form 包裹 opinion 输入框 + 通过/打回 submit 按钮，value 携带 routing/approved', () => {
    const card = buildCheckpointCard(
      { title: '双端登录', gateLabel: '灯① 理解→合同', rail: '●灯①  ○灯②(快)' },
      routing,
    ) as { header: { template: string }; body: { elements: Array<Record<string, unknown>> } };
    expect(card.header.template).toBe('orange');
    const json = JSON.stringify(card);
    expect(json).toContain('灯① 理解→合同');
    expect(json).toContain('通过');
    expect(json).toContain('打回');

    expect(formInputNames(card)).toContain('opinion');
    const buttons = formButtons(card);
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b.form_action_type).toBe('submit');
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

  it('WS-7：note 渲染为灰字（灯③ 证据厚化）', () => {
    const card = buildCheckpointCard(
      { title: 't', gateLabel: '灯③', rail: 'r', note: '⚠️ 静态对账未生效（本单无跨仓契约）' },
      routing,
    );
    expect(JSON.stringify(card)).toContain('静态对账未生效');
  });

  it('parseCardAction round-trips the 通过 button value (the consumer reads it back)', () => {
    const card = buildCheckpointCard({ title: 't', gateLabel: '灯①', rail: 'r' }, routing) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    const approveBtn = formButtons(card)[0] as { behaviors: Array<{ value: unknown }> };
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

describe('buildCaseFileCard (病历卡)', () => {
  const routing = { itemId: 'wi-1', waitId: 'wt-9' };

  it('red header, label+detail, WS-5 form+opinion + 已处理·继续 / 终止需求 两 submit 按钮(取消带 cancel:true)', () => {
    const card = buildCaseFileCard(
      { title: '自定义菜品备注', label: '跨仓对账 · 冲突/悬空', detail: '后端仓未列入' },
      routing,
    ) as { header: { template: string }; body: { elements: Array<Record<string, unknown>> } };
    expect(card.header.template).toBe('red');
    const json = JSON.stringify(card);
    expect(json).toContain('跨仓对账 · 冲突/悬空');
    expect(json).toContain('后端仓未列入');
    expect(json).toContain('已处理');
    expect(json).toContain('终止需求');

    expect(formInputNames(card)).toContain('opinion');
    const buttons = formButtons(card);
    expect(buttons).toHaveLength(2);
    const values = buttons.map(
      (b) => (b.behaviors as Array<{ value: Record<string, unknown> }>)[0]!.value,
    );
    expect(values[0]).toEqual({
      kind: CHECKPOINT_ACTION_KIND,
      itemId: 'wi-1',
      waitId: 'wt-9',
      caseLabel: '跨仓对账 · 冲突/悬空',
      approved: true,
    });
    expect(values[1]).toEqual({
      kind: CHECKPOINT_ACTION_KIND,
      itemId: 'wi-1',
      waitId: 'wt-9',
      caseLabel: '跨仓对账 · 冲突/悬空',
      cancel: true,
    });
  });

  it('parseCardAction round-trips the 终止需求 button (handler reads cancel:true back)', () => {
    const card = buildCaseFileCard({ title: 't', label: '监工 · 跨仓外溢' }, routing) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    const cancelBtn = formButtons(card)[1] as {
      behaviors: Array<{ value: unknown }>;
    };
    const action = parseCardAction({
      action: { value: cancelBtn.behaviors[0]!.value },
      operator: { open_id: 'ou_owner' },
    });
    expect(action?.value).toMatchObject({
      kind: CHECKPOINT_ACTION_KIND,
      itemId: 'wi-1',
      waitId: 'wt-9',
      cancel: true,
    });
  });
});

describe('buildCancelConfirmCard (WS-10.9 取消确认卡)', () => {
  it('red，确认终止/继续推进 两 callback 按钮', () => {
    const card = buildCancelConfirmCard('订单导出', { itemId: 'wi-1', waitId: 'wt-9' }) as {
      header: { template: string };
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(card.header.template).toBe('red');
    expect(JSON.stringify(card)).toContain('确认终止需求');
    const buttons = card.body.elements.filter((e) => e.tag === 'button');
    expect(buttons).toHaveLength(2);
    const values = buttons.map(
      (b) => (b.behaviors as Array<{ value: Record<string, unknown> }>)[0]!.value,
    );
    expect(values[0]).toMatchObject({
      kind: CHECKPOINT_ACTION_KIND,
      itemId: 'wi-1',
      waitId: 'wt-9',
      approved: true,
    });
    expect(values[1]).toMatchObject({ approved: false });
  });
});

describe('buildClosureCard (WS-7 灯④ 关单卡)', () => {
  it('orange，确认关单/暂不 两 callback 按钮 + note', () => {
    const card = buildClosureCard(
      { title: '订单导出', note: '各仓已合并' },
      { itemId: 'wi-1', waitId: 'wt-9' },
    ) as { header: { template: string }; body: { elements: Array<Record<string, unknown>> } };
    expect(card.header.template).toBe('orange');
    const json = JSON.stringify(card);
    expect(json).toContain('关单');
    expect(json).toContain('各仓已合并');
    const buttons = card.body.elements.filter((e) => e.tag === 'button');
    expect(buttons).toHaveLength(2);
    const values = buttons.map(
      (b) => (b.behaviors as Array<{ value: Record<string, unknown> }>)[0]!.value,
    );
    expect(values[0]).toMatchObject({
      kind: CHECKPOINT_ACTION_KIND,
      itemId: 'wi-1',
      waitId: 'wt-9',
      approved: true,
    });
    expect(values[1]).toMatchObject({ approved: false });
  });
});

describe('buildGatekeeperBigCard (WS-5 监工判大三按钮)', () => {
  const routing = { itemId: 'wi-1', waitId: 'wt-9' };

  it('三 submit 按钮(重对账并返工 action=rework / 放行 proceed / 终止需求) + opinion 输入框', () => {
    const card = buildGatekeeperBigCard(
      { title: '订单导出', label: '监工 · 跨仓外溢', detail: '要给 createOrder 加字段' },
      routing,
    ) as { header: { template: string }; body: { elements: Array<Record<string, unknown>> } };
    expect(card.header.template).toBe('red');
    expect(formInputNames(card)).toContain('opinion');

    const buttons = formButtons(card);
    expect(buttons).toHaveLength(3);
    for (const b of buttons) expect(b.form_action_type).toBe('submit');
    const values = buttons.map(
      (b) => (b.behaviors as Array<{ value: Record<string, unknown> }>)[0]!.value,
    );
    expect(values[0]).toMatchObject({
      kind: CHECKPOINT_ACTION_KIND,
      itemId: 'wi-1',
      waitId: 'wt-9',
      approved: true,
      action: 'rework',
    });
    expect(values[1]).toMatchObject({ approved: true, action: 'proceed' });
    expect(values[2]).toMatchObject({ cancel: true });
  });
});

describe('buildCaseFileAnsweredCard (病历卡终态)', () => {
  it('grey 已终止需求 when cancelled', () => {
    const card = buildCaseFileAnsweredCard('t', '跨仓对账', true) as {
      header: { template: string };
    };
    expect(card.header.template).toBe('grey');
    expect(JSON.stringify(card)).toContain('已终止需求');
  });
  it('green 已处理·继续 when not cancelled', () => {
    const card = buildCaseFileAnsweredCard('t', '监工', false) as { header: { template: string } };
    expect(card.header.template).toBe('green');
    expect(JSON.stringify(card)).toContain('已处理');
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

describe('buildQuestionFormCard (AUQ 表单卡：凑齐 + 自定义)', () => {
  const q = {
    toolUseId: 'toolu_1',
    questions: [
      { question: '早餐?', header: '早餐', options: [{ label: '面包' }, { label: '粥' }] },
      { question: '颜色?', header: '颜色', options: [{ label: '红' }] },
    ],
  };
  type El = {
    tag: string;
    name?: string;
    elements?: El[];
    behaviors?: Array<{ value: Record<string, unknown> }>;
    options?: Array<{ value: string }>;
  };

  it('wraps a form: per-question select_static + input, submit button carries total/headers', () => {
    const card = buildQuestionFormCard('任务', q, { taskId: 't1', chatId: 'c1' }) as {
      header: { template: string };
      body: { elements: El[] };
    };
    expect(card.header.template).toBe('orange');
    const form = card.body.elements.find((e) => e.tag === 'form');
    if (!form?.elements) throw new Error('expected a form container');
    const inner = form.elements;
    expect(inner.filter((e) => e.tag === 'select_static').map((e) => e.name)).toEqual([
      'q0_pick',
      'q1_pick',
    ]);
    expect(inner.filter((e) => e.tag === 'input').map((e) => e.name)).toEqual([
      'q0_custom',
      'q1_custom',
    ]);
    const submit = inner.find((e) => e.tag === 'button');
    const v = submit!.behaviors![0]!.value;
    expect(v.kind).toBe(AUQ_ACTION_KIND);
    expect(v.taskId).toBe('t1');
    expect(v.chatId).toBe('c1');
    expect(v.total).toBe(2);
    expect(v.headers).toEqual(['早餐', '颜色']);
  });

  it('select_static options carry the label as value', () => {
    const card = buildQuestionFormCard('任务', q, { taskId: 't1', chatId: 'c1' }) as {
      body: { elements: El[] };
    };
    const form = card.body.elements.find((e) => e.tag === 'form');
    const sel = form?.elements?.find((e) => e.tag === 'select_static');
    expect(sel?.options?.map((o) => o.value)).toEqual(['面包', '粥']);
  });
});

describe('buildWorkitemQuestionCard (WS-9 workitem run AskUserQuestion)', () => {
  it('提交按钮 value = { kind: auq-wi, workitemId, total, headers }', () => {
    const q = {
      toolUseId: 'tu',
      questions: [
        {
          question: '实现前先问：A 还是 B？',
          header: '方案',
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    };
    const card = buildWorkitemQuestionCard('订单导出', q, { workitemId: 'wi-1' }) as {
      body: { elements: Array<Record<string, unknown>> };
    };
    const form = card.body.elements.find((e) => e.tag === 'form') as {
      elements: Array<Record<string, unknown>>;
    };
    const submit = form.elements.find((e) => e.tag === 'button') as {
      behaviors: Array<{ value: Record<string, unknown> }>;
    };
    expect(submit.behaviors[0]!.value).toMatchObject({
      kind: 'auq-wi',
      workitemId: 'wi-1',
      total: 1,
      headers: ['方案'],
    });
  });
});
