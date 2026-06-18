import { describe, expect, it } from 'vitest';
import {
  anchorAction,
  buildAnchorCard,
  buildCancelledCard,
  buildErrorCard,
  buildReportCard,
  formatClock,
} from '../src/feishu/card.js';

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
