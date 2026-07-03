import { describe, expect, it } from 'vitest';
import { raceWithTimeout } from '../src/index.js';

// 审查修复 F2：带超时的竞速 helper（立项 AI 抽取超时兜底靠它）。按时 settle 返回值；超时返回 'timeout'
// 不抛；且竞速输家在超时后 reject 不成 unhandled rejection。

describe('raceWithTimeout（审查修复 F2）', () => {
  it('p 按时 settle → 返回其值', async () => {
    expect(await raceWithTimeout(Promise.resolve('ok'), 1000)).toBe('ok');
  });

  it('ms 内未决 → 返回 timeout（不抛）', async () => {
    const never = new Promise<string>(() => {});
    expect(await raceWithTimeout(never, 5)).toBe('timeout');
  });

  it('超时后输家再 reject 不成 unhandled rejection', async () => {
    let rejectLater!: (e: unknown) => void;
    const p = new Promise<string>((_, rej) => {
      rejectLater = rej;
    });
    expect(await raceWithTimeout(p, 5)).toBe('timeout');
    rejectLater(new Error('late')); // 超时后才 reject —— 内部 p.catch 兜底，不冒泡
    await new Promise((res) => setTimeout(res, 10));
  });
});
