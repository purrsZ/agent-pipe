import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { ReducerRuntime } from '../../src/workitems/reducer.js';
import { WorkitemsStore } from '../../src/workitems/store.js';
import { Watchdog } from '../../src/workitems/watchdog.js';
import { makeAssignment, makeWait } from '../helpers/workitems.js';
import type { Clock, Transition, WorkItem, WorkType } from '../../src/workitems/types.js';

let tmpDir: string;
let now = 1000;
const clock: Clock = { now: () => now };
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-watchdog-test-'));
  now = 1000;
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(lastBeat: (assignmentId: string) => number | undefined = () => undefined): {
  api: WorkitemsApi;
  reducer: ReducerRuntime;
  store: WorkitemsStore;
  watchdog: Watchdog;
} {
  const store = new WorkitemsStore(path.join(tmpDir, 'workitems.sqlite'), clock);
  const registry = new WorkTypeRegistry();
  const cfg = loadWorkitemsConfig({
    WORKITEMS_HEARTBEAT_TIMEOUT_SEC: '5',
    WORKITEMS_WATCHDOG_INTERVAL_MS: '100',
  });
  const reducer = new ReducerRuntime({
    store,
    registry,
    clock,
    cfg,
    logger,
    isRunClass: (kind) => kind === 'run',
    postCommit: () => {},
  });
  const artifacts = new ArtifactStore(path.join(tmpDir, 'workitems'), logger);
  registry.register(workType());
  const watchdog = new Watchdog({
    store,
    reducer,
    effects: { lastBeat },
    clock,
    logger,
    cfg,
    registry,
  });
  return {
    api: new WorkitemsApi({ store, registry, reducer, artifacts }),
    reducer,
    store,
    watchdog,
  };
}

function workType(): WorkType {
  return {
    id: 'noop',
    triggers: { api: true },
    initialPhase: () => 'noop:idle',
    onEvent: (item, ev): Transition => {
      // A poisoned item throws when the watchdog drives it, exercising tick isolation.
      if (item.title === 'poison' && ev.kind === 'timer_fired') {
        throw new Error('poisoned timer apply');
      }
      return {};
    },
    isDecisionStale: () => false,
    topology: () => 'solo',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: true },
  };
}

function createItem(api: WorkitemsApi): WorkItem {
  return api.createWorkItem({ type: 'noop', title: 'Watchdog', source: {} }).item;
}

describe('Watchdog.tick', () => {
  it('does not remind a human wait before waitRemindAfterSec (4h default)', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    // WS-3: 提醒不再看 deadline，改为 createdAt + waitRemindAfterSec（默认 4h）触发。
    store.insertWait(makeWait('wt-human', item.id, { kind: 'human', createdAt: 1000 }));

    now = 1000 + 4 * 3_600 * 1000 - 1; // 差 1ms 到首催窗口
    watchdog.tick();

    expect(store.listEvents(item.id).map((event) => event.kind)).toEqual(['workitem_created']);
    store.close();
  });

  it('reminds a human wait at 4h, holds until 24h, then repeats', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    store.insertWait(makeWait('wt-human', item.id, { kind: 'human', createdAt: 1000 }));

    now = 1000 + 4 * 3_600 * 1000; // 首催窗口到点
    watchdog.tick();
    watchdog.tick(); // 同一时刻再 tick 不应重复
    expect(store.listEvents(item.id).map((event) => event.kind)).toEqual([
      'workitem_created',
      'wait_reminder',
    ]);
    expect(store.getWait('wt-human')!.remindedAt).toBe(now);

    now += 24 * 3_600 * 1000 - 1; // 差 1ms 到重复窗口
    watchdog.tick();
    expect(store.listEvents(item.id).filter((e) => e.kind === 'wait_reminder')).toHaveLength(1);

    now += 1; // 到 24h 重复点
    watchdog.tick();
    expect(store.listEvents(item.id).filter((e) => e.kind === 'wait_reminder')).toHaveLength(2);
    expect(store.getWait('wt-human')!.remindedAt).toBe(now);
    store.close();
  });

  it('resolved 的 wait 即使过了催办窗口也不催（WS-3 §3.4，审查修复 T5）', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    // 一条已 resolved 的 human wait（createdAt=1000）。
    store.insertWait(
      makeWait('wt-resolved', item.id, {
        kind: 'human',
        createdAt: 1000,
        deadlineAt: 1000,
        resolvedAt: 1000,
        resolvedBy: 'user',
        resolveReason: 'done',
      }),
    );

    // 推进到远超首催窗口（createdAt + 4h）——未 resolve 的 wait 此刻必被催，以此暴露 resolved 守卫是否真生效。
    now = 1000 + 5 * 3_600 * 1000;
    watchdog.tick();

    expect(store.listEvents(item.id).filter((e) => e.kind === 'wait_reminder')).toHaveLength(0);
    store.close();
  });

  it('fires and resolves timer waits', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    const wait = makeWait('wt-timer', item.id, { kind: 'timer', deadlineAt: 1000 });
    store.insertWait(wait);

    watchdog.tick();

    expect(store.listEvents(item.id).map((event) => event.kind)).toEqual([
      'workitem_created',
      'timer_fired',
    ]);
    expect(store.getWait(wait.id)).toMatchObject({
      resolvedAt: 1000,
      resolvedBy: 'container',
      resolveReason: 'timer_fired',
    });
    store.close();
  });

  it('turns due agent waits into assignment_stalled events', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    const assignment = makeAssignment('as-agent', item.id, {
      deadlineAt: 10_000,
      wallclockCapSec: 60,
      startedAt: 1000,
    });
    store.insertAssignment(assignment);
    const wait = makeWait('wt-agent', item.id, {
      kind: 'agent',
      originAssignmentId: assignment.id,
      deadlineAt: 1000,
    });
    store.insertWait(wait);

    watchdog.tick();

    expect(store.listEvents(item.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assignment_stalled',
          payload: {
            assignmentId: assignment.id,
            reason: 'agent_wait_expired',
            waitId: wait.id,
          },
        }),
      ]),
    );
    store.close();
  });

  it('resolves expired agent waits whose origin already finished, without tick spam', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    const assignment = makeAssignment('as-done', item.id, {
      status: 'done',
      deadlineAt: 10_000,
      wallclockCapSec: 60,
      startedAt: 1000,
      endedAt: 900,
    });
    store.insertAssignment(assignment);
    const wait = makeWait('wt-agent-dangling', item.id, {
      kind: 'agent',
      originAssignmentId: assignment.id,
      deadlineAt: 1000,
    });
    store.insertWait(wait);

    watchdog.tick();
    watchdog.tick();
    watchdog.tick();

    expect(store.getWait(wait.id)).toMatchObject({
      resolvedAt: 1000,
      resolvedBy: 'container',
      resolveReason: 'origin_terminal',
    });
    const kinds = store.listEvents(item.id).map((event) => event.kind);
    expect(kinds.filter((kind) => kind === 'assignment_stalled')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'wait_resolved')).toHaveLength(1);
    expect(store.getAssignment(assignment.id)!.status).toBe('done');
    store.close();
  });

  it('emits heartbeat_silent when no heartbeat arrives before timeout', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    const assignment = makeAssignment('as-heartbeat', item.id, {
      deadlineAt: 20_000,
      wallclockCapSec: 60,
      startedAt: 1000,
      createdAt: 1000,
    });
    store.insertAssignment(assignment);
    now = 6000;

    watchdog.tick();

    expect(store.listEvents(item.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assignment_stalled',
          payload: { assignmentId: assignment.id, reason: 'heartbeat_silent' },
        }),
      ]),
    );
    store.close();
  });

  it('prefers wallclock_exceeded over heartbeat_silent when heartbeat is fresh', () => {
    const { api, store, watchdog } = harness(() => 6900);
    const item = createItem(api);
    const assignment = makeAssignment('as-wallclock', item.id, {
      deadlineAt: 20_000,
      wallclockCapSec: 5,
      startedAt: 1000,
      createdAt: 1000,
    });
    store.insertAssignment(assignment);
    now = 7000;

    watchdog.tick();

    const stalled = store
      .listEvents(item.id)
      .filter((event) => event.kind === 'assignment_stalled');
    expect(stalled).toHaveLength(1);
    expect(stalled[0]!.payload).toEqual({
      assignmentId: assignment.id,
      reason: 'wallclock_exceeded',
    });
    store.close();
  });

  it('emits only one stalled event per assignment with wallclock priority', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    const assignment = makeAssignment('as-many', item.id, {
      deadlineAt: 1000,
      wallclockCapSec: 5,
      startedAt: 1000,
      createdAt: 1000,
    });
    store.insertAssignment(assignment);
    now = 7000;

    watchdog.tick();

    const stalled = store
      .listEvents(item.id)
      .filter((event) => event.kind === 'assignment_stalled');
    expect(stalled).toHaveLength(1);
    expect(stalled[0]!.payload).toEqual({
      assignmentId: assignment.id,
      reason: 'wallclock_exceeded',
    });
    store.close();
  });

  it('isolates a poisoned workitem so one throwing apply cannot crash the tick', () => {
    const { api, store, watchdog } = harness();
    const poison = api.createWorkItem({ type: 'noop', title: 'poison', source: {} }).item;
    const healthy = api.createWorkItem({ type: 'noop', title: 'healthy', source: {} }).item;
    store.insertWait(makeWait('wt-poison', poison.id, { kind: 'timer', deadlineAt: 1000 }));
    store.insertWait(makeWait('wt-healthy', healthy.id, { kind: 'timer', deadlineAt: 1000 }));

    // The poisoned item throws inside its apply; the tick must survive and still
    // drive the healthy item to completion rather than bubbling up an uncaught throw.
    expect(() => watchdog.tick()).not.toThrow();
    expect(logger.error).toHaveBeenCalled();

    expect(store.getWait('wt-healthy')).toMatchObject({
      resolvedAt: 1000,
      resolveReason: 'timer_fired',
    });
    expect(store.listEvents(healthy.id).map((e) => e.kind)).toContain('timer_fired');

    // The poisoned apply rolled back atomically: no committed timer_fired, wait still open.
    expect(store.getWait('wt-poison')!.resolvedAt).toBeNull();
    expect(store.listEvents(poison.id).map((e) => e.kind)).toEqual(['workitem_created']);
    store.close();
  });

  it('survives a throwing scan query without crashing the tick (crash isolation)', () => {
    // safeEnqueue isolates per-workitem enqueue throws; this guards the OTHER half —
    // a scan query (listOpenWaits / listRunningAssignments) throwing must not escape
    // the 1Hz setInterval callback and take the whole bridge down.
    const throwingStore = {
      listOpenWaits: () => {
        throw new Error('SQLITE_BUSY');
      },
      listRunningAssignments: () => [],
      getAssignment: () => undefined,
    } as unknown as WorkitemsStore;
    const wd = new Watchdog({
      store: throwingStore,
      reducer: { enqueue: () => {} } as unknown as ReducerRuntime,
      effects: { lastBeat: () => undefined },
      clock,
      logger,
      cfg: loadWorkitemsConfig({}),
      registry: new WorkTypeRegistry(),
    });

    expect(() => wd.tick()).not.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });

  // DELEGATE D1.3：委托到点扫描。全程 opaque reason（'r-a'），证明容器零语义——匹配是逐字节字符串比较。
  describe('delegation_due (DELEGATE D1.3)', () => {
    const DELAY_MS = 600 * 1000; // delegationDelaySec 默认 600s

    function delegated(overrides: { reasons?: string[]; expiresAt?: number } = {}) {
      const h = harness();
      const item = createItem(h.api);
      h.store.insertWait(
        makeWait('wt-h', item.id, { kind: 'human', reason: 'r-a', createdAt: 1000 }),
      );
      h.store.upsertDelegation(item.id, {
        reasons: overrides.reasons ?? ['r-a'],
        grantNote: '/delegate 8h',
        expiresAt: overrides.expiresAt ?? 1000 + 24 * 3_600 * 1000,
        createdBy: 'u-1',
      });
      return { ...h, item };
    }

    const dueEvents = (store: WorkitemsStore, id: string) =>
      store.listEvents(id).filter((e) => e.kind === 'delegation_due');

    it('匹配授权 + 过冷静期 → 发 delegation_due（payload 带 waitId）；delay 内不发', () => {
      const { store, watchdog, item } = delegated();

      now = 1000 + DELAY_MS - 1; // 差 1ms 到冷静期
      watchdog.tick();
      expect(dueEvents(store, item.id)).toHaveLength(0);

      now = 1000 + DELAY_MS;
      watchdog.tick();
      expect(dueEvents(store, item.id)).toHaveLength(1);
      expect(dueEvents(store, item.id)[0]!.payload).toEqual({ waitId: 'wt-h' });
      store.close();
    });

    it('未被消费时按 delay 间隔节流重发，而非每 tick 重发', () => {
      const { store, watchdog, item } = delegated();
      now = 1000 + DELAY_MS;
      watchdog.tick();
      watchdog.tick(); // 同一时刻再 tick 不重发
      now += 1000;
      watchdog.tick(); // 1s 后也不重发（节流窗口内）
      expect(dueEvents(store, item.id)).toHaveLength(1);

      now += DELAY_MS; // 过了一个节流窗口 → 重发（消费方 crash 自愈路径）
      watchdog.tick();
      expect(dueEvents(store, item.id)).toHaveLength(2);
      store.close();
    });

    it('reason 不在授权列表 → 不发（opaque 逐字节匹配）', () => {
      const { store, watchdog, item } = delegated({ reasons: ['r-other'] });
      now = 1000 + DELAY_MS * 2;
      watchdog.tick();
      expect(dueEvents(store, item.id)).toHaveLength(0);
      store.close();
    });

    it('授权已撤销 → 不发', () => {
      const { store, watchdog, item } = delegated();
      store.revokeDelegation(item.id);
      now = 1000 + DELAY_MS * 2;
      watchdog.tick();
      expect(dueEvents(store, item.id)).toHaveLength(0);
      store.close();
    });

    it('授权已到期 → 不发', () => {
      const { store, watchdog, item } = delegated({ expiresAt: 1000 + DELAY_MS }); // 到期时刻 == 冷静期到点
      now = 1000 + DELAY_MS * 2;
      watchdog.tick();
      expect(dueEvents(store, item.id)).toHaveLength(0);
      store.close();
    });

    it('wait 已 resolve → 不发（催办同理），且节流条目被清扫', () => {
      const { store, watchdog, item } = delegated();
      store.updateWait('wt-h', { resolvedAt: 1500, resolvedBy: 'user', resolveReason: 'done' });
      now = 1000 + DELAY_MS * 2;
      watchdog.tick();
      expect(dueEvents(store, item.id)).toHaveLength(0);
      store.close();
    });

    // ── 审查修复：冷静期锚点 / 人的未决事项 / 打回优先 / worktype guard 前置 / 节流顺序 ─────────

    it('灯先亮、人后放权 → 冷静期锚 grant.createdAt：/delegate 后仍有完整反悔窗口，不秒过', () => {
      const { api, store, watchdog } = harness();
      const item = createItem(api);
      store.insertWait(
        makeWait('wt-h', item.id, { kind: 'human', reason: 'r-a', createdAt: 1000 }),
      );
      // 灯已挂远超一个冷静期，人才放权（授权行 createdAt 取 store 时钟 = now）。
      now = 1000 + DELAY_MS * 3;
      const grantAt = now;
      store.upsertDelegation(item.id, {
        reasons: ['r-a'],
        grantNote: '/delegate 8h',
        expiresAt: now + 24 * 3_600 * 1000,
        createdBy: 'u-1',
      });
      watchdog.tick(); // 放权当刻
      now = grantAt + DELAY_MS - 1; // 差 1ms 到「授权 + 冷静期」
      watchdog.tick();
      expect(dueEvents(store, item.id)).toHaveLength(0);
      now = grantAt + DELAY_MS;
      watchdog.tick();
      expect(dueEvents(store, item.id)).toHaveLength(1);
      store.close();
    });

    it('同单还有授权未覆盖的 open human wait → 不发；该 wait 关闭后下窗口恢复', () => {
      const { store, watchdog, item } = delegated();
      store.insertWait(
        makeWait('wt-x', item.id, { kind: 'human', reason: 'r-incident', createdAt: 1000 }),
      );
      now = 1000 + DELAY_MS;
      watchdog.tick();
      expect(dueEvents(store, item.id)).toHaveLength(0); // 人有未决事项，授权不覆盖当下局面
      store.updateWait('wt-x', { resolvedAt: now, resolvedBy: 'user', resolveReason: 'ok' });
      now += DELAY_MS; // 深检查被拦也刷新节流 → 下一个窗口
      watchdog.tick();
      expect(dueEvents(store, item.id)).toHaveLength(1);
      store.close();
    });

    it('授权后人显式打回过同名 wait → 重弹的 wait 不再自动过（人的更晚决定优先）', () => {
      const { api, store, watchdog, item } = delegated();
      // 人打回（decision.approved=false 走真 API，落 wait_resolved 事件）→ 业务侧重弹同名 wait。
      api.resolveWait('wt-h', {
        operator: 'lichao',
        reason: '暂不',
        decision: { approved: false },
      });
      store.insertWait(
        makeWait('wt-h2', item.id, { kind: 'human', reason: 'r-a', createdAt: 1000 }),
      );
      now = 1000 + DELAY_MS * 5;
      watchdog.tick();
      expect(dueEvents(store, item.id)).toHaveLength(0);
      store.close();
    });

    it('打回发生在授权之前 → 不影响（重新放权即重置打回记忆）', () => {
      const { api, store, watchdog } = harness();
      const item = createItem(api);
      store.insertWait(
        makeWait('wt-old', item.id, { kind: 'human', reason: 'r-a', createdAt: 1000 }),
      );
      api.resolveWait('wt-old', {
        operator: 'lichao',
        reason: '暂不',
        decision: { approved: false },
      });
      now = 5000; // 打回之后才放权
      store.upsertDelegation(item.id, {
        reasons: ['r-a'],
        grantNote: '/delegate 8h',
        expiresAt: now + 24 * 3_600 * 1000,
        createdBy: 'u-1',
      });
      store.insertWait(
        makeWait('wt-new', item.id, { kind: 'human', reason: 'r-a', createdAt: 5000 }),
      );
      now = 5000 + DELAY_MS;
      watchdog.tick();
      expect(dueEvents(store, item.id)).toHaveLength(1);
      store.close();
    });

    it('worktype delegationGuard 不过 → 不 enqueue（永拦的灯不整夜刷事件/刷卡），每窗口只重扫', () => {
      const enqueued: Array<{ kind: string }> = [];
      const wait = makeWait('wt-g', 'wi-1', { kind: 'human', reason: 'r-a', createdAt: 1000 });
      const grant = {
        id: 1,
        workitemId: 'wi-1',
        reasons: ['r-a'],
        grantNote: 'g',
        expiresAt: 10 * DELAY_MS,
        createdBy: 'u',
        createdAt: 1000,
        revokedAt: null,
      };
      const guarded: WorkType = { ...workType(), id: 'guarded', delegationGuard: () => false };
      const registry = new WorkTypeRegistry();
      registry.register(guarded);
      const wd = new Watchdog({
        store: {
          listOpenWaits: () => [wait],
          listRunningAssignments: () => [],
          listNonTerminal: () => [],
          activeDelegation: () => grant,
          listEvents: () => [],
          getWorkItem: () => ({ id: 'wi-1', type: 'guarded', status: 'active' }) as WorkItem,
          getWait: () => undefined,
        } as unknown as WorkitemsStore,
        reducer: {
          enqueue: (_id: string, e: { kind: string }) => {
            enqueued.push(e);
          },
        } as unknown as ReducerRuntime,
        effects: { lastBeat: () => undefined },
        clock,
        logger,
        cfg: loadWorkitemsConfig({}),
        registry,
      });
      now = 1000 + DELAY_MS * 3;
      wd.tick();
      wd.tick();
      // 既无 delegation_due 也不该有别的（wait_reminder 首催窗口 4h 未到）。
      expect(enqueued.filter((e) => e.kind === 'delegation_due')).toHaveLength(0);
    });

    it('enqueue 瞬时失败 → 节流不刷新，下 tick 立即重试（不白等一个冷静期窗口）', () => {
      const enqueued: string[] = [];
      let failOnce = true;
      const wait = makeWait('wt-r', 'wi-1', { kind: 'human', reason: 'r-a', createdAt: 1000 });
      const grant = {
        id: 1,
        workitemId: 'wi-1',
        reasons: ['r-a'],
        grantNote: 'g',
        expiresAt: 10 * DELAY_MS,
        createdBy: 'u',
        createdAt: 1000,
        revokedAt: null,
      };
      const wd = new Watchdog({
        store: {
          listOpenWaits: () => [wait],
          listRunningAssignments: () => [],
          listNonTerminal: () => [],
          activeDelegation: () => grant,
          listEvents: () => [],
          getWorkItem: () => undefined,
          getWait: () => undefined,
        } as unknown as WorkitemsStore,
        reducer: {
          enqueue: (_id: string, e: { kind: string }) => {
            if (e.kind === 'delegation_due' && failOnce) {
              failOnce = false;
              throw new Error('SQLITE_BUSY');
            }
            enqueued.push(e.kind);
          },
        } as unknown as ReducerRuntime,
        effects: { lastBeat: () => undefined },
        clock,
        logger,
        cfg: loadWorkitemsConfig({}),
        registry: new WorkTypeRegistry(),
      });
      now = 1000 + DELAY_MS;
      wd.tick(); // enqueue 抛错被隔离，节流未刷新
      expect(enqueued.filter((k) => k === 'delegation_due')).toHaveLength(0);
      now += 1000; // 下一个 1Hz tick 即重试成功，无需等满一个 delegationDelaySec
      wd.tick();
      expect(enqueued.filter((k) => k === 'delegation_due')).toHaveLength(1);
    });
  });

  it('never drives a terminal workitem — no timer/agent/assignment spam (v4 #3)', () => {
    const { api, store, watchdog } = harness();
    const item = createItem(api);
    store.updateWorkItem(item.id, { status: 'done', updatedAt: 1000 });
    // Dangling open wait + running assignment left on a now-terminal item.
    store.insertWait(makeWait('wt-timer', item.id, { kind: 'timer', deadlineAt: 1000 }));
    store.insertAssignment(
      makeAssignment('as-run', item.id, {
        deadlineAt: 1000,
        wallclockCapSec: 5,
        startedAt: 1000,
        createdAt: 1000,
      }),
    );

    now = 7000;
    watchdog.tick();
    watchdog.tick();
    watchdog.tick();

    // The terminal item is excluded from every scan: nothing appended across ticks.
    expect(store.listEvents(item.id).map((event) => event.kind)).toEqual(['workitem_created']);
    store.close();
  });
});
