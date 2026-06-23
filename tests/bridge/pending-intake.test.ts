import { describe, expect, it } from 'vitest';
import { PendingIntakeStore } from '../../src/bridge/pending-intake.js';

// /req 后「等群名」临时待答态（M-I2）：纯内存、键控、TTL，时间注入便于单测。

describe('PendingIntakeStore（/req 等群名待答态）', () => {
  it('set → has/take 取出消费；take 后不再 has', () => {
    const s = new PendingIntakeStore(1000);
    s.set('u1', 'c1', '加订单查询', 100);
    expect(s.has('u1', 'c1', 200)).toBe(true);
    expect(s.take('u1', 'c1', 200)).toEqual({ description: '加订单查询', createdAt: 100 });
    expect(s.has('u1', 'c1', 200)).toBe(false); // 已消费
    expect(s.take('u1', 'c1', 200)).toBeUndefined();
  });

  it('超过 TTL → has/take 返回空并清理', () => {
    const s = new PendingIntakeStore(1000);
    s.set('u1', 'c1', 'x', 100);
    expect(s.has('u1', 'c1', 1101)).toBe(false); // 1101 - 100 > 1000 → 过期
    expect(s.take('u1', 'c1', 1101)).toBeUndefined();
  });

  it('keyed by 用户+会话，互不串', () => {
    const s = new PendingIntakeStore(1000);
    s.set('u1', 'c1', 'a', 0);
    s.set('u2', 'c1', 'b', 0);
    s.set('u1', 'c2', 'c', 0);
    expect(s.take('u1', 'c1', 0)?.description).toBe('a');
    expect(s.take('u2', 'c1', 0)?.description).toBe('b');
    expect(s.take('u1', 'c2', 0)?.description).toBe('c');
  });

  it('同 key 再 set 覆盖（最后一次 /req 为准）；clear 撤销', () => {
    const s = new PendingIntakeStore(1000);
    s.set('u1', 'c1', 'old', 0);
    s.set('u1', 'c1', 'new', 0);
    expect(s.take('u1', 'c1', 0)?.description).toBe('new');

    s.set('u1', 'c1', 'x', 0);
    s.clear('u1', 'c1');
    expect(s.has('u1', 'c1', 0)).toBe(false);
  });
});
