import { describe, expect, it } from 'vitest';
import {
  composeAdvisePrompt,
  composeInspectPrompt,
  renderEventDigest,
  renderGatekeeperIncident,
  renderIntegrationIncident,
  renderReconcileIncident,
} from '../../src/worktypes/requirement/advisor.js';
import type { WorkItemEvent } from '../../src/workitems/types.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';

// ENHANCE E1 事故参谋纯核心：三类事故单渲染（防御式）+ composeAdvisePrompt（复用 steer 全景 + 事故单 + 只出建议）。
// ENHANCE E2：大事记摘要 renderEventDigest（事件流 → 人话时间线，上界折叠，防御式）。

const evt = (kind: string, payload: unknown, createdAt = 1000): WorkItemEvent => ({
  id: 1,
  workitemId: 'wi-1',
  seq: 1,
  kind,
  payload,
  createdAt,
});

describe('renderGatekeeperIncident（监工判大）', () => {
  it('渲染事故类型 + 逐条判大明细（仓/接口/上报内容）', () => {
    const s = renderGatekeeperIncident({
      raises: [
        { repo: '/repos/backend', interfaceId: 'createOrder', question: '要给 createOrder 加字段' },
      ],
    });
    expect(s).toContain('监工判大');
    expect(s).toContain('createOrder');
    expect(s).toContain('要给 createOrder 加字段');
    expect(s).toContain('/repos/backend');
  });

  it('坏 payload / 空 raises → 回落「(事故详情缺失)」，永不抛', () => {
    expect(renderGatekeeperIncident(null)).toContain('(事故详情缺失)');
    expect(renderGatekeeperIncident({ raises: 'nope' })).toContain('(事故详情缺失)');
    expect(renderGatekeeperIncident({ raises: [] })).toContain('(事故详情缺失)');
    expect(() => renderGatekeeperIncident({ raises: [123, {}, null] })).not.toThrow();
  });
});

describe('renderReconcileIncident（跨仓对账冲突）', () => {
  it('渲染事故类型 + 逐条未决（冲突/悬空 + 接口 + detail + 涉及仓）', () => {
    const s = renderReconcileIncident({
      unresolved: [
        {
          kind: 'dangling',
          interfaceId: 'getCoupon',
          detail: 'frontend 调用但无人提供',
          repos: ['/repos/frontend'],
        },
      ],
    });
    expect(s).toContain('对账冲突');
    expect(s).toContain('悬空');
    expect(s).toContain('getCoupon');
    expect(s).toContain('frontend 调用但无人提供');
    expect(s).toContain('/repos/frontend');
  });

  it('坏 payload → 回落「(事故详情缺失)」，永不抛', () => {
    expect(renderReconcileIncident({})).toContain('(事故详情缺失)');
    expect(renderReconcileIncident(undefined)).toContain('(事故详情缺失)');
    expect(() => renderReconcileIncident({ unresolved: [{ detail: 123 }, 'x'] })).not.toThrow();
  });
});

describe('renderIntegrationIncident（集成验证修不动）', () => {
  it('渲染事故类型 + 第几轮 + 受影响仓 + 破坏性差异', () => {
    const s = renderIntegrationIncident({
      round: 3,
      affectedRepos: ['/repos/backend', '/repos/frontend'],
      breaking: [{ interfaceId: 'createOrder', kind: 'missing' }],
    });
    expect(s).toContain('集成验证修不动');
    expect(s).toContain('3'); // 第 3 轮
    expect(s).toContain('/repos/backend');
    expect(s).toContain('createOrder');
  });

  it('坏 payload → 回落「(事故详情缺失)」，永不抛', () => {
    expect(renderIntegrationIncident(undefined)).toContain('(事故详情缺失)');
    expect(renderIntegrationIncident({})).toContain('(事故详情缺失)');
    expect(() => renderIntegrationIncident({ breaking: 'x', affectedRepos: 5 })).not.toThrow();
  });
});

describe('composeAdvisePrompt', () => {
  it('织入事故单 + steer 全景（契约摘要）+ followups + 仅供参考结尾；不要求 steer 块', () => {
    const p = composeAdvisePrompt({
      title: '需求X',
      phase: PHASE.implement,
      repos: ['/a', '/b'],
      followups: ['另外注意兼容旧客户端'],
      contractSummary: '跨仓契约 2 条接口：\n- GET /x\n- POST /y',
      incident: renderGatekeeperIncident({
        raises: [{ repo: '/a', interfaceId: 'createOrder', question: '要加字段' }],
      }),
    });
    expect(p).toContain('参谋'); // 角色 = 参谋（不是包工头）
    expect(p).toContain('事故单');
    expect(p).toContain('createOrder'); // incident 在场
    expect(p).toContain('跨仓契约 2 条接口'); // steer 全景上下文在场
    expect(p).toContain('另外注意兼容旧客户端'); // followups 一并回应
    expect(p).toContain('以上仅供参考'); // 固定结尾提示（引导人写意见框）
    expect(p).toContain('意见框'); // 提示人在事故卡意见框写修正
    expect(p).not.toContain('```steer'); // 不要求 steer 块（防误触发行动）
  });

  it('followups 为空时不加「用户这批话」段（参谋主任务是分析事故）', () => {
    const p = composeAdvisePrompt({
      title: 't',
      phase: PHASE.split,
      repos: ['/a'],
      followups: [],
      incident: '事故单缺失回落',
    });
    expect(p).toContain('参谋');
    expect(p).not.toContain('用户这批话');
  });
});

// ENHANCE E5：集成实证质检员 prompt——契约全文 + 立项书（验收标准）+ 各仓 worktree 清单 + 只取证不判定。
describe('composeInspectPrompt（集成实证质检员）', () => {
  it('织入契约 + 验收标准 + worktree 清单 + followups + 只取证不判定 + 灯③结尾；不产 steer 块', () => {
    const p = composeInspectPrompt({
      title: '加跨端下单接口',
      repos: ['/repos/backend', '/repos/frontend'],
      intakeBrief: '# 立项书\n\n## 验收标准 / 完成定义\n下单成功返回单号',
      contract: '{"interfaces":[{"id":"createOrder","signature":"POST /orders"}]}',
      digest: '- [07-03 10:00] 进入「集成验证中」',
      worktrees: [
        { repo: '/repos/backend', worktreePath: '/wt/backend' },
        { repo: '/repos/frontend', worktreePath: '/wt/frontend' },
      ],
      followups: ['注意兼容旧客户端'],
    });
    expect(p).toContain('实证质检员'); // 角色（非包工头/参谋）
    expect(p).toContain('只取证不判定'); // 只取证不判定
    expect(p).toContain('下单成功返回单号'); // 验收标准在场
    expect(p).toContain('createOrder'); // 契约全文在场
    expect(p).toContain('/wt/backend'); // worktree 清单（实物）在场
    expect(p).toContain('/wt/frontend');
    expect(p).toContain('注意兼容旧客户端'); // followups 一并回应
    expect(p).toContain('灯③'); // 结尾引导人在灯③卡意见框写修正
    expect(p).not.toContain('```steer'); // 质检员零行动权，不产 steer 块
  });

  it('单仓无契约 / 空 worktree → 缺省不炸，仍出质检员角色 + 结尾', () => {
    const p = composeInspectPrompt({ title: 't', repos: ['/a'], worktrees: [], followups: [] });
    expect(p).toContain('实证质检员');
    expect(p).toContain('只取证不判定');
    expect(p).not.toContain('用户这批话'); // followups 空 → 不加段
    expect(p).not.toContain('跨仓契约全文'); // contract 缺省 → 不加段（单仓对照立项书全量核对）
  });
});

describe('renderEventDigest（大事记摘要）', () => {
  it('典型事件流 → phase 变迁行 + 判大行 + 人裁决意见原文；无关 kind 一律跳过', () => {
    const digest = renderEventDigest([
      evt('workitem_created', {}), // 跳过
      evt('phase_changed', {
        from: 'requirement:立项',
        to: 'requirement:拆解',
        reason: 'intake_ready',
      }),
      evt('gatekeeper_big', {
        raises: [{ interfaceId: 'createOrder', repo: '/repos/backend', question: 'q' }],
      }),
      evt('wait_resolved', {
        reason: '按方案B改，注意兼容旧客户端',
        decision: { approved: false },
      }),
      evt('run_completed', { role: 'owner' }), // 跳过
    ]);
    expect(digest).toContain('进入「requirement:拆解」');
    expect(digest).toContain('立项料齐'); // reason 人话
    expect(digest).toContain('监工判大');
    expect(digest).toContain('createOrder');
    expect(digest).toContain('人裁决：打回');
    expect(digest).toContain('按方案B改'); // 意见原文入账（WS-5 起 reason 即人的意见）
    expect(digest).not.toContain('workitem_created');
    expect(digest).not.toContain('run_completed');
  });

  it('空流 / 全是无关 kind → 空串', () => {
    expect(renderEventDigest([])).toBe('');
    expect(renderEventDigest([evt('workitem_created', {}), evt('run_completed', {})])).toBe('');
  });

  it('超 40 行 → 保头保尾 + 中间折叠「-（中间 N 件事略）」', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      evt('integration_check_failed', { round: i + 1 }),
    );
    const digest = renderEventDigest(many);
    const lines = digest.split('\n');
    expect(lines.length).toBeLessThanOrEqual(40);
    expect(digest).toContain('件事略'); // 折叠行
    expect(digest).toContain('第 1 轮未过'); // 保头（最早）
    expect(digest).toContain('第 60 轮未过'); // 保尾（最近）
  });

  it('坏 payload 永不抛（行降级 / 跳过）', () => {
    expect(() =>
      renderEventDigest([evt('phase_changed', null), evt('gatekeeper_big', 'x')]),
    ).not.toThrow();
    // steer_directive action=none 是审计留痕、无实质动作 → 跳过。
    expect(renderEventDigest([evt('steer_directive', { action: 'none' })])).toBe('');
  });
});
