import { describe, expect, it } from 'vitest';
import {
  composeAdvisePrompt,
  renderGatekeeperIncident,
  renderIntegrationIncident,
  renderReconcileIncident,
} from '../../src/worktypes/requirement/advisor.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';

// ENHANCE E1 事故参谋纯核心：三类事故单渲染（防御式）+ composeAdvisePrompt（复用 steer 全景 + 事故单 + 只出建议）。

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
