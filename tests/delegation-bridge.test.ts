import { describe, expect, it, vi } from 'vitest';
import {
  delegationGuardFor,
  parseDelegationDuration,
  runDelegateCommand,
  runDelegationDue,
} from '../src/index.js';
import { checkpointReason } from '../src/worktypes/requirement/checkpoint.js';
import { DELEGABLE_WAIT_REASONS } from '../src/worktypes/requirement/index.js';
import { PHASE } from '../src/worktypes/requirement/phases.js';
import type { WorkItem, WorkItemEvent } from '../src/workitems/types.js';

// DELEGATE D2.2/D2.3：桥层三件套——时长解析、/delegate 命令主体、guard + delegation_due 执行器。
// 依赖注入式导出（先例 applyCheckpointOpinion / backfillClaimedChats），假 deps 纯测。

const LIGHT2 = checkpointReason(PHASE.implement);
const LIGHT3 = checkpointReason(PHASE.deliver);

function ev(kind: string, payload: unknown, seq: number): WorkItemEvent {
  return { id: seq, workitemId: 'wi-1', seq, kind, payload, createdAt: 1000 };
}

describe('parseDelegationDuration', () => {
  it('Nh/Nm 合法解析（大小写不敏感）', () => {
    expect(parseDelegationDuration('8h')).toBe(8 * 3_600_000);
    expect(parseDelegationDuration('30m')).toBe(30 * 60_000);
    expect(parseDelegationDuration('24H')).toBe(24 * 3_600_000);
  });

  it('超 24h → over-cap（防「永久放权」）', () => {
    expect(parseDelegationDuration('25h')).toBe('over-cap');
    expect(parseDelegationDuration('1441m')).toBe('over-cap');
  });

  it('坏格式/非正数 → undefined', () => {
    for (const bad of ['', 'h', '8', '8d', '-8h', '8.5h', 'abc', '0h', '0m']) {
      expect(parseDelegationDuration(bad)).toBeUndefined();
    }
  });
});

describe('delegationGuardFor (DELEGATE D-4：只认机器信号)', () => {
  it('灯③：最后一条 integration_check_passed 无 reason（真通过）→ true', () => {
    const events = [
      ev('integration_check_passed', { reason: 'no_contract' }, 1), // 旧的不算，只看最后一条
      ev('integration_check_passed', { interfaceCount: 3 }, 2),
    ];
    expect(delegationGuardFor(LIGHT3, events)).toBe(true);
  });

  it('灯③：no_contract / no_claims（静态对账未生效）→ false，lite 单永不自动过', () => {
    expect(
      delegationGuardFor(LIGHT3, [ev('integration_check_passed', { reason: 'no_contract' }, 1)]),
    ).toBe(false);
    expect(
      delegationGuardFor(LIGHT3, [ev('integration_check_passed', { reason: 'no_claims' }, 1)]),
    ).toBe(false);
  });

  it('灯③：从无 integration_check_passed 事件 → false（保守）', () => {
    expect(delegationGuardFor(LIGHT3, [])).toBe(false);
    expect(delegationGuardFor(LIGHT3, [ev('integration_check_failed', {}, 1)])).toBe(false);
  });

  it('灯② 与 awaiting_close 无 guard → 恒 true（D-4）', () => {
    expect(delegationGuardFor(LIGHT2, [])).toBe(true);
    expect(delegationGuardFor('awaiting_close', [])).toBe(true);
  });

  it('非白名单恒 false（双保险）：判大/病历/取消/立项 gate 即便被误发 delegation_due 也过不了', () => {
    for (const reason of [
      'gatekeeper_big',
      'run_failed',
      'reconcile_conflict',
      'cancel_confirm',
      checkpointReason(PHASE.split), // 立项 gate
    ]) {
      expect(delegationGuardFor(reason, [ev('integration_check_passed', {}, 1)])).toBe(false);
    }
  });
});

// ── runDelegationDue 执行器 ─────────────────────────────────────────────────────────────

function executorDeps(
  over: {
    wait?: { workitemId: string; reason: string; resolvedAt: number | null } | undefined;
    grant?: { grantNote: string; expiresAt: number } | undefined;
    events?: WorkItemEvent[];
    notifyError?: boolean;
  } = {},
) {
  const resolves: Array<{ waitId: string; input: unknown }> = [];
  const notices: string[] = [];
  const logger = { error: vi.fn(), info: vi.fn() };
  const deps = {
    workitems: {
      store: {
        getWait: () =>
          'wait' in over
            ? over.wait
            : { workitemId: 'wi-1', reason: 'awaiting_close', resolvedAt: null },
        activeDelegation: () =>
          'grant' in over ? over.grant : { grantNote: '/delegate 8h', expiresAt: 4_000_000 },
      },
      api: {
        listEvents: () => over.events ?? [],
        resolveWait: (waitId: string, input: unknown) => {
          resolves.push({ waitId, input });
          return { resolved: true };
        },
      },
    },
    notify: async (text: string) => {
      if (over.notifyError) throw new Error('send failed');
      notices.push(text);
    },
    logger,
    now: () => 2000,
  };
  return { deps, resolves, notices, logger };
}

const dueEvent = ev('delegation_due', { waitId: 'wt-1' }, 9);

describe('runDelegationDue (DELEGATE D2.3)', () => {
  it('正常链路：resolve 参数形状（operator=delegation / reason 带【委托】原文 / approved=true）+ 通知发出', async () => {
    const { deps, resolves, notices } = executorDeps();
    await runDelegationDue(deps, dueEvent);
    expect(resolves).toHaveLength(1);
    expect(resolves[0]!.waitId).toBe('wt-1');
    expect(resolves[0]!.input).toMatchObject({
      operator: 'delegation',
      decision: { approved: true },
    });
    expect((resolves[0]!.input as { reason: string }).reason).toContain('【委托】/delegate 8h');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('已按你的委托自动通过');
    expect(notices[0]).toContain('交付待关单（灯④）'); // awaiting_close 的灯名
    expect(notices[0]).toContain('/delegate 8h'); // 授权原文
  });

  it('wait 已 resolve → 幂等 return（watchdog 节流重发/人抢先手动均无害）', async () => {
    const { deps, resolves } = executorDeps({
      wait: { workitemId: 'wi-1', reason: 'awaiting_close', resolvedAt: 1500 },
    });
    await runDelegationDue(deps, dueEvent);
    expect(resolves).toHaveLength(0);
  });

  it('授权已撤销/到期（activeDelegation 空）→ return（撤销竞态兜底）', async () => {
    const { deps, resolves } = executorDeps({ grant: undefined });
    await runDelegationDue(deps, dueEvent);
    expect(resolves).toHaveLength(0);
  });

  it('guard 不过（灯③ no_contract）→ 静默 return 且不 resolve，催办照常', async () => {
    const { deps, resolves, notices } = executorDeps({
      wait: { workitemId: 'wi-1', reason: LIGHT3, resolvedAt: null },
      events: [ev('integration_check_passed', { reason: 'no_contract' }, 1)],
    });
    await runDelegationDue(deps, dueEvent);
    expect(resolves).toHaveLength(0);
    expect(notices).toHaveLength(0);
  });

  it('灯③ 真通过 → guard 放行，通知带灯③灯名', async () => {
    const { deps, resolves, notices } = executorDeps({
      wait: { workitemId: 'wi-1', reason: LIGHT3, resolvedAt: null },
      events: [ev('integration_check_passed', { interfaceCount: 2 }, 1)],
    });
    await runDelegationDue(deps, dueEvent);
    expect(resolves).toHaveLength(1);
    expect(notices[0]).toContain('灯③');
  });

  it('通知发送失败只 log——resolve 已生效，不抛', async () => {
    const { deps, resolves, logger } = executorDeps({ notifyError: true });
    await expect(runDelegationDue(deps, dueEvent)).resolves.toBeUndefined();
    expect(resolves).toHaveLength(1);
    expect(logger.error).toHaveBeenCalled();
  });
});

// ── runDelegateCommand 命令主体 ─────────────────────────────────────────────────────────

function commandDeps(over: { item?: WorkItem | undefined; revoked?: number } = {}) {
  const upserts: Array<{ id: string; input: Record<string, unknown> }> = [];
  const revokes: string[] = [];
  const replies: string[] = [];
  const item: WorkItem | undefined =
    'item' in over ? over.item : ({ id: 'wi-1', status: 'active' } as WorkItem);
  const deps = {
    item,
    store: {
      upsertDelegation: (id: string, input: Record<string, unknown>) => upserts.push({ id, input }),
      revokeDelegation: (id: string) => {
        revokes.push(id);
        return over.revoked ?? 1;
      },
    },
    reply: async (text: string) => {
      replies.push(text);
    },
    delegableReasons: DELEGABLE_WAIT_REASONS,
    delaySec: 600,
    now: () => 0,
  };
  return { deps, upserts, revokes, replies };
}

const msg = { text: '/delegate 8h', userId: 'u-1' };

describe('runDelegateCommand (DELEGATE D2.2)', () => {
  it('/delegate 8h：写入白名单三灯 + grantNote=命令原文 + expiresAt=now+8h，确认文案诚实交代边界', async () => {
    const { deps, upserts, replies } = commandDeps();
    await runDelegateCommand(deps, msg, ['8h']);
    expect(upserts).toEqual([
      {
        id: 'wi-1',
        input: {
          reasons: [...DELEGABLE_WAIT_REASONS],
          grantNote: '/delegate 8h',
          expiresAt: 8 * 3_600_000,
          createdBy: 'u-1',
        },
      },
    ]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/已开启委托至 \d{2}:\d{2}/); // HH:mm 按本地时区渲染，不锚具体值
    expect(replies[0]).toContain('监工判大与一切病历仍会等你');
    expect(replies[0]).toContain('10 分钟'); // delaySec=600 如实渲染冷静期
    expect(replies[0]).toContain('/delegate off');
  });

  it('/delegate off：撤销并确认；无生效委托时如实说', async () => {
    const on = commandDeps();
    await runDelegateCommand(on.deps, msg, ['off']);
    expect(on.revokes).toEqual(['wi-1']);
    expect(on.replies[0]).toContain('已撤销本单委托');

    const none = commandDeps({ revoked: 0 });
    await runDelegateCommand(none.deps, msg, ['off']);
    expect(none.replies[0]).toContain('没有生效中的委托');
  });

  it('坏参/无参 → 用法提示，不写入', async () => {
    for (const args of [[], ['8d'], ['abc']]) {
      const { deps, upserts, replies } = commandDeps();
      await runDelegateCommand(deps, msg, args);
      expect(upserts).toHaveLength(0);
      expect(replies[0]).toContain('用法');
    }
  });

  it('超 24h → 拒绝并提示上限，不写入', async () => {
    const { deps, upserts, replies } = commandDeps();
    await runDelegateCommand(deps, msg, ['48h']);
    expect(upserts).toHaveLength(0);
    expect(replies[0]).toContain('上限 24h');
  });

  it('找不到单 / 终态 → 复用 /cancel 的两条文案，不写入', async () => {
    const missing = commandDeps({ item: undefined });
    await runDelegateCommand(missing.deps, msg, ['8h']);
    expect(missing.replies[0]).toBe('本会话没有进行中的需求单。');
    expect(missing.upserts).toHaveLength(0);

    const done = commandDeps({ item: { id: 'wi-1', status: 'done' } as WorkItem });
    await runDelegateCommand(done.deps, msg, ['8h']);
    expect(done.replies[0]).toContain('该单元已结束');
    expect(done.upserts).toHaveLength(0);
  });
});
