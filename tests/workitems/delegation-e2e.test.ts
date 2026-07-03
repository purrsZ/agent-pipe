import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDelegationDue } from '../../src/index.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { type EffectContext, EffectRuntime } from '../../src/workitems/effects.js';
import { ReducerRuntime } from '../../src/workitems/reducer.js';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { WorkitemsStore } from '../../src/workitems/store.js';
import { Watchdog } from '../../src/workitems/watchdog.js';
import { createGatekeeperReviewHandler } from '../../src/worktypes/requirement/gatekeeper.js';
import {
  DELEGABLE_WAIT_REASONS,
  registerRequirement,
} from '../../src/worktypes/requirement/index.js';
import { createIntakeFinalizeHandler } from '../../src/worktypes/requirement/intake-finalize.js';
import { createIntegrationCheckHandler } from '../../src/worktypes/requirement/integration.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';
import { createReconcileCheckHandler } from '../../src/worktypes/requirement/reconcile.js';

// DELEGATE e2e（沙箱，不含飞书出口）：真容器 + 真 watchdog（假时钟）+ 真桥层执行器 runDelegationDue。
// 方案 D2.4 原文以「灯② wait」为标的——当前主线 split→implement 不设 checkpoint、灯② wait 不会出现，
// 按方案意图改以灯③（guard 拦 no_contract）与灯④ awaiting_close（自动过全链路）双标的验证（记要有载）。

let tmpDir: string;
let now = 1000;
const clock = { now: () => now };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const live: Array<{ store: WorkitemsStore; effects: EffectRuntime }> = [];
const DELAY_MS = 600 * 1000;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-delegate-e2e-'));
  now = 1000;
  vi.clearAllMocks();
});

afterEach(async () => {
  const hs = live.splice(0);
  for (const h of hs) {
    h.effects.stopIntake();
    h.effects.abortInflight();
  }
  await new Promise((r) => setTimeout(r, 10));
  for (const h of hs) h.store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 精简版 requirement-e2e harness + 真 Watchdog（手动 tick，假时钟可推）。
function harness() {
  const store = new WorkitemsStore(path.join(tmpDir, 'wi.sqlite'), clock);
  const registry = new WorkTypeRegistry();
  let effects: EffectRuntime | undefined;
  const cfg = loadWorkitemsConfig({ WORKITEMS_MAX_OPEN: '8', WORKITEMS_MAX_WORKERS_PER_ITEM: '2' });
  const reducer = new ReducerRuntime({
    store,
    registry,
    clock,
    cfg,
    logger,
    isRunClass: (kind) => effects?.isRunClass(kind) ?? kind === 'run',
    postCommit: (actions) => {
      for (const a of actions) {
        if (a.kind === 'abort_effect') effects?.abort(a.effectId, a.reason);
        else effects?.poke(a.workitemId);
      }
    },
  });
  const artifacts = new ArtifactStore(path.join(tmpDir, 'art'), logger);
  effects = new EffectRuntime({ store, reducer, registry, artifacts, clock, logger });
  registerRequirement(registry);
  // 通用自动收尾 run handler（同 requirement-e2e）：写报告即完成；无 reconcile.json → 对账 no_reconcile 放行。
  effects.registerHandler({
    kind: 'run',
    recovery: 'resume-or-redispatch',
    canResume: () => false,
    run: async (ctx: EffectContext) => {
      ctx.heartbeat();
      const aid = ctx.assignment?.id ?? 'x';
      ctx.writeArtifact(`assignments/${aid}/report.md`, `ok ${aid}`, 'report');
    },
  });
  effects.registerHandler(createReconcileCheckHandler());
  effects.registerHandler(createGatekeeperReviewHandler());
  effects.registerHandler(createIntegrationCheckHandler());
  effects.registerHandler(createIntakeFinalizeHandler());
  const api = new WorkitemsApi({
    store,
    registry,
    reducer,
    artifacts,
    afterCreate: (item) => effects?.poke(item.id),
  });
  const watchdog = new Watchdog({ store, reducer, effects, clock, logger, cfg, registry });
  live.push({ store, effects });
  return { store, api, watchdog };
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 3000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('waitFor timed out');
}

describe('DELEGATE 委托模式 e2e（真容器 + 真 watchdog + 真执行器）', () => {
  it('双仓走到灯③ → 到点 delegation_due → guard 拦 no_contract；灯④ 到点自动关单 done、不再重发', async () => {
    const { store, api, watchdog } = harness();
    const notices: string[] = [];
    const bridgeDeps = {
      workitems: { store, api },
      notify: async (text: string) => {
        notices.push(text);
      },
      logger,
      now: () => now,
    };
    const item = api.createWorkItem({
      type: 'requirement',
      title: '睡前放权',
      source: {},
      repos: ['repo-a', 'repo-b'],
    }).item;

    // 立项收料 → 立项 gate 人工放行（立项 gate 不可委托，D-2）→ 拆解对账 → 实现 → 集成 → 灯③。
    for (const f of [
      { key: 'name', value: '需求' },
      { key: 'summary', value: '背景' },
      { key: 'prd', value: 'PRD' },
      { key: 'acceptance', value: '验收' },
      { key: 'repos', value: ['repo-a', 'repo-b'] },
    ]) {
      api.injectIntakeField(item.id, f);
    }
    await waitFor(() =>
      expect(
        store.listOpenWaits(item.id).some((w) => w.reason === `checkpoint:${PHASE.split}`),
      ).toBe(true),
    );
    const intakeGate = store
      .listOpenWaits(item.id)
      .find((w) => w.reason === `checkpoint:${PHASE.split}`)!;
    api.resolveWait(intakeGate.id, {
      operator: 'lichao',
      reason: 'go',
      decision: { approved: true },
    });
    await waitFor(() =>
      expect(
        store.listOpenWaits(item.id).some((w) => w.reason === `checkpoint:${PHASE.deliver}`),
      ).toBe(true),
    );
    const light3 = store
      .listOpenWaits(item.id)
      .find((w) => w.reason === `checkpoint:${PHASE.deliver}`)!;

    // 睡前放权：写一条真白名单授权（模拟 /delegate 8h 的写入）。
    store.upsertDelegation(item.id, {
      reasons: [...DELEGABLE_WAIT_REASONS],
      grantNote: '/delegate 8h',
      expiresAt: now + 24 * 3_600 * 1000,
      createdBy: 'u-1',
    });

    // 时钟跳跃前等在途 run（E5 inspect）收尾——否则假时钟前跳 600s 会把仍 running 的 run 误判
    // heartbeat_silent（真机不会有这种跳变，纯测试工位问题）。
    await waitFor(() =>
      expect(store.listAssignments(item.id).every((a) => a.status !== 'running')).toBe(true),
    );

    // 冷静期内 tick 不发；推过 delay → delegation_due（payload 指向灯③ wait）。
    watchdog.tick();
    const dues = () => store.listEvents(item.id).filter((e) => e.kind === 'delegation_due');
    expect(dues()).toHaveLength(0);
    now = light3.createdAt + DELAY_MS;
    watchdog.tick();
    await waitFor(() => expect(dues()).toHaveLength(1));
    expect(dues()[0]!.payload).toEqual({ waitId: light3.id });

    // 桥层执行器消费：双仓但无跨仓契约 → integration_check_passed 带 reason（no_contract，静态对账未生效）
    // → guard 拦住、灯③ 保持 open 等人（D-4 保守面）。
    await runDelegationDue(bridgeDeps, dues()[0]!);
    expect(store.getWait(light3.id)!.resolvedAt).toBeNull();
    expect(notices).toHaveLength(0);

    // 人醒来手动过灯③ → 交付相位挂 awaiting_close（灯④，白名单内、无 guard）。
    api.resolveWait(light3.id, { operator: 'lichao', reason: 'ok', decision: { approved: true } });
    await waitFor(() => expect(store.getWorkItem(item.id)!.phase).toBe(PHASE.deliver));
    const closeWait = store.listOpenWaits(item.id).find((w) => w.reason === 'awaiting_close')!;

    // 灯④ 到点 → delegation_due → 执行器自动关单：resolveWait(operator=delegation) → 整单 done + 通知。
    now = closeWait.createdAt + DELAY_MS;
    watchdog.tick();
    await waitFor(() =>
      expect(dues().some((e) => (e.payload as { waitId: string }).waitId === closeWait.id)).toBe(
        true,
      ),
    );
    const closeDue = dues().find((e) => (e.payload as { waitId: string }).waitId === closeWait.id)!;
    await runDelegationDue(bridgeDeps, closeDue);
    await waitFor(() => expect(store.getWorkItem(item.id)!.status).toBe('done'));
    expect(store.getWait(closeWait.id)).toMatchObject({ resolvedBy: 'delegation' });
    expect(store.getWait(closeWait.id)!.resolveReason).toContain('【委托】/delegate 8h');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('已按你的委托自动通过');

    // 终态后不再重发：再推一个 delay 窗口 tick，delegation_due 总数不变（终态单被扫描排除 + wait 已关）。
    const total = dues().length;
    now += DELAY_MS * 2;
    watchdog.tick();
    expect(dues()).toHaveLength(total);

    // 幂等：对同一条已消费的 delegation_due 重放执行器（watchdog 重发竞态）→ 无副作用。
    await runDelegationDue(bridgeDeps, closeDue);
    expect(notices).toHaveLength(1);
  });
});
