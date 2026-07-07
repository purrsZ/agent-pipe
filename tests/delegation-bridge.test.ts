import { describe, expect, it, vi } from 'vitest';
import {
  delegationCardHint,
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

  it('灯③：异形 payload（null/字符串/坏行）→ false——无法解读走保守面，不当真通过（审查修复）', () => {
    expect(delegationGuardFor(LIGHT3, [ev('integration_check_passed', null, 1)])).toBe(false);
    expect(delegationGuardFor(LIGHT3, [ev('integration_check_passed', 'ok', 1)])).toBe(false);
    // reason 为 null（非 undefined）同样不算真通过——与 deliverGateNote 共用同一份解读，不再分叉。
    expect(delegationGuardFor(LIGHT3, [ev('integration_check_passed', { reason: null }, 1)])).toBe(
      false,
    );
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
    grant?:
      | { reasons?: string[]; grantNote: string; expiresAt: number; createdAt?: number }
      | undefined;
    events?: WorkItemEvent[];
    // 同单其它 open waits（默认只有目标 wait 自己）；打回优先测试用 extraWaits 挂历史 wait 供 getWait 反查。
    openWaits?: Array<{ id: string; kind: string; reason: string }>;
    extraWaits?: Record<string, { workitemId: string; reason: string; resolvedAt: number | null }>;
    notifyError?: boolean;
  } = {},
) {
  const resolves: Array<{ waitId: string; input: unknown }> = [];
  const notices: string[] = [];
  const logger = { error: vi.fn(), info: vi.fn() };
  const targetWait =
    'wait' in over ? over.wait : { workitemId: 'wi-1', reason: 'awaiting_close', resolvedAt: null };
  const deps = {
    workitems: {
      store: {
        getWait: (id: string) => (id === 'wt-1' ? targetWait : over.extraWaits?.[id]),
        activeDelegation: () =>
          'grant' in over
            ? over.grant === undefined
              ? undefined
              : {
                  reasons: over.grant.reasons ?? [...DELEGABLE_WAIT_REASONS],
                  createdAt: over.grant.createdAt ?? 0,
                  grantNote: over.grant.grantNote,
                  expiresAt: over.grant.expiresAt,
                }
            : {
                reasons: [...DELEGABLE_WAIT_REASONS],
                grantNote: '/delegate 8h',
                expiresAt: 4_000_000,
                createdAt: 0,
              },
        listOpenWaits: () =>
          over.openWaits ?? [
            { id: 'wt-1', kind: 'human', reason: targetWait?.reason ?? 'awaiting_close' },
          ],
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

  it('同单还有授权未覆盖的 open human wait（如 cancel_confirm）→ 不自动过（审查修复：自动关单不埋人未决事项）', async () => {
    const { deps, resolves } = executorDeps({
      openWaits: [
        { id: 'wt-1', kind: 'human', reason: 'awaiting_close' },
        { id: 'wt-c', kind: 'human', reason: 'cancel_confirm' },
      ],
    });
    await runDelegationDue(deps, dueEvent);
    expect(resolves).toHaveLength(0);
  });

  it('同单其它 open wait 若也在授权列表内（或非 human）→ 不拦', async () => {
    const { deps, resolves } = executorDeps({
      openWaits: [
        { id: 'wt-1', kind: 'human', reason: 'awaiting_close' },
        { id: 'wt-3', kind: 'human', reason: LIGHT3 }, // 授权覆盖的灯不算未决事项
        { id: 'wt-t', kind: 'timer', reason: 'anything' }, // 非 human 不算
      ],
    });
    await runDelegationDue(deps, dueEvent);
    expect(resolves).toHaveLength(1);
  });

  it('授权之后人显式打回过同名 wait → 不自动过（人的更晚决定优先，审查修复）', async () => {
    const { deps, resolves } = executorDeps({
      grant: { grantNote: '/delegate 8h', expiresAt: 4_000_000, createdAt: 1000 },
      extraWaits: { 'wt-old': { workitemId: 'wi-1', reason: 'awaiting_close', resolvedAt: 1500 } },
      events: [
        ev(
          'wait_resolved',
          { waitId: 'wt-old', operator: 'lichao', reason: '暂不', decision: { approved: false } },
          1,
        ),
      ],
    });
    await runDelegationDue(deps, dueEvent);
    expect(resolves).toHaveLength(0);
  });

  it('打回发生在授权之前 → 不影响（重新 /delegate 即重置打回记忆）', async () => {
    const { deps, resolves } = executorDeps({
      grant: { grantNote: '/delegate 8h', expiresAt: 4_000_000, createdAt: 1500 },
      extraWaits: { 'wt-old': { workitemId: 'wi-1', reason: 'awaiting_close', resolvedAt: 900 } },
      // 事件 createdAt=1000 < grant.createdAt=1500 → humanDeclinedSince 扫不到（授权前的历史不算）。
      events: [
        ev(
          'wait_resolved',
          { waitId: 'wt-old', operator: 'lichao', reason: '暂不', decision: { approved: false } },
          1,
        ),
      ],
    });
    await runDelegationDue(deps, dueEvent);
    expect(resolves).toHaveLength(1);
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
    expect(replies[0]).toContain('打回过的灯本次委托不再自动过'); // 打回优先（审查修复）如实交代
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

// ── delegationCardHint 卡片提示（D3）─────────────────────────────────────────────────────

describe('delegationCardHint (DELEGATE D3)', () => {
  const wait = { reason: 'awaiting_close', createdAt: 1000 };
  const grant = {
    reasons: ['awaiting_close', LIGHT3],
    expiresAt: 1000 + 8 * 3_600_000,
    createdAt: 1000,
  };
  const NOW = 2000; // 出卡时刻（冷静期内）

  it('生效授权 + reason 命中 + guard 放行 → 灰字提示（带 /delegate off，「HH:mm 前」对齐设计文档）', () => {
    const hint = delegationCardHint(wait, grant, [], 600, NOW);
    expect(hint).toContain('委托生效中');
    expect(hint).toContain('/delegate off');
    expect(hint).toMatch(/将于 \d{2}:\d{2} 前自动通过/);
  });

  it('无授权 / reason 不在授权列表 → 不提示', () => {
    expect(delegationCardHint(wait, undefined, [], 600, NOW)).toBeUndefined();
    expect(
      delegationCardHint({ reason: 'gatekeeper_big', createdAt: 1000 }, grant, [], 600, NOW),
    ).toBeUndefined();
  });

  it('灯③ guard 拦住（no_contract）→ 不提示——卡上不承诺不会发生的自动通过', () => {
    const events = [ev('integration_check_passed', { reason: 'no_contract' }, 1)];
    expect(
      delegationCardHint({ reason: LIGHT3, createdAt: 1000 }, grant, events, 600, NOW),
    ).toBeUndefined();
    // 真通过则提示照出。
    const passed = [ev('integration_check_passed', { interfaceCount: 2 }, 1)];
    expect(
      delegationCardHint({ reason: LIGHT3, createdAt: 1000 }, grant, passed, 600, NOW),
    ).toContain('委托生效中');
  });

  it('到点前授权已过期 → 不提示（不会自动过）', () => {
    const expiring = { reasons: ['awaiting_close'], expiresAt: 1000 + 60_000, createdAt: 1000 }; // 1min 后过期 < 10min 冷静期
    expect(delegationCardHint(wait, expiring, [], 600, NOW)).toBeUndefined();
  });

  it('灯先亮、人后放权 → 时刻锚 grant.createdAt（与 watchdog 同式，卡上时刻不与实际行为漂移）', () => {
    const lateGrant = { ...grant, createdAt: 1000 + 3_600_000 }; // 灯挂 1h 后才 /delegate
    const hint = delegationCardHint(wait, lateGrant, [], 600, lateGrant.createdAt + 1)!;
    // autoAt = grant.createdAt + 600s；若仍锚 wait.createdAt 早已过期会渲染成「即将」。
    const d = new Date(lateGrant.createdAt + 600_000);
    const expected = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(hint).toContain(`将于 ${expected} 前自动通过`);
  });

  it('补发卡时 autoAt 已成过去 → 改说「即将自动通过」，不渲染过去时刻（审查修复）', () => {
    const hint = delegationCardHint(wait, grant, [], 600, 1000 + 4 * 3_600_000); // 首发失败 4h 后补发
    expect(hint).toContain('即将自动通过');
    expect(hint).not.toMatch(/\d{2}:\d{2}/);
  });
});
