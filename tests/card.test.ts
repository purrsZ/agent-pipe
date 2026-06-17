import { describe, expect, it } from 'vitest';
import { buildAnchorCard, buildReportCard, formatClock } from '../src/feishu/card.js';

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
