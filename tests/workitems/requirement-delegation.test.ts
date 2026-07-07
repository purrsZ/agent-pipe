import { describe, expect, it } from 'vitest';
import { checkpointReason } from '../../src/worktypes/requirement/checkpoint.js';
import {
  DELEGABLE_WAIT_REASONS,
  delegationGuardFor,
  requirementWorkType,
} from '../../src/worktypes/requirement/index.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';

// DELEGATE D-2 守护断言（本方案最重要的一条）：可委托白名单**恰为推进型三灯**，永不扩到事故类。
// 未来任何人手滑往 DELEGABLE_WAIT_REASONS 里塞判大/病历/取消/立项 gate，这里立刻红。

describe('DELEGABLE_WAIT_REASONS (DELEGATE D-2)', () => {
  it('恰为三灯：灯②(拆解拍板)、灯③(验收)、灯④(awaiting_close 关单)——不多不少', () => {
    expect([...DELEGABLE_WAIT_REASONS]).toEqual([
      checkpointReason(PHASE.implement), // 灯②：split→implement 边界（当前主线不设此 checkpoint，前向保护）
      checkpointReason(PHASE.deliver), // 灯③：integrate→deliver（桥层另有机器信号 guard）
      'awaiting_close', // 灯④：交付关单
    ]);
  });

  it('硬排除永不进来：立项 gate / 监工判大 / 一切病历 / 取消确认', () => {
    const banned = [
      // 立项 gate（料没收齐自动过无意义）。注意其 reason 字符串是 checkpoint:requirement:拆解——
      // 字面含「拆解」但语义是"进拆解前的门"，与灯②(拆解拍板=拆解完成后的门)不是一回事，勿混。
      checkpointReason(PHASE.split),
      // 监工判大（自动放行 = 监工白判）。
      'gatekeeper_big',
      // 一切病历（"已处理·继续"意味着人做过处置，自动点 = 空转）。
      'run_failed',
      'reconcile_conflict',
      'integration_unresolved',
      'retry_exhausted',
      'thrash',
      'stalled_no_path',
      'steer_escalated',
      // 破坏性确认。
      'cancel_confirm',
    ];
    for (const reason of banned) {
      expect(DELEGABLE_WAIT_REASONS).not.toContain(reason);
    }
  });

  // 审查修复：白名单与 guard 同址同源（DELEGABLE_WAIT_REASONS 直接取自 guard 声明表的键）——往白名单加
  // reason 必须同时声明机器信号 guard，结构上不可能出现「进了白名单却零校验自动过」的漂移；未声明恒 false。
  it('guard fail-closed：白名单外的 reason（即便被误发 delegation_due）恒不放行', () => {
    expect(delegationGuardFor('some_future_reason', [])).toBe(false);
    expect(delegationGuardFor('cancel_confirm', [])).toBe(false);
  });

  it('watchdog 前置 guard 已接线：requirementWorkType.delegationGuard 即 delegationGuardFor（同一函数，桥层消费方共用）', () => {
    expect(requirementWorkType.delegationGuard).toBe(delegationGuardFor);
  });
});
