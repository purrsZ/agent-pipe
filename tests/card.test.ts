import { describe, expect, it } from 'vitest';
import { formatClock } from '../src/feishu/card.js';

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
