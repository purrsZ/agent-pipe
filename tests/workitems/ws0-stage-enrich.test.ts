import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { type EffectContext, EffectRuntime } from '../../src/workitems/effects.js';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { ReducerRuntime } from '../../src/workitems/reducer.js';
import { WorkitemsStore } from '../../src/workitems/store.js';
import type { Transition, WorkItem, WorkItemEvent, WorkType } from '../../src/workitems/types.js';
import { makeWorkItem } from '../helpers/workitems.js';

// WS-0 内核地基回归：run 结论透传 dispatch payload 的 stage；enrich 给 owner-workers 事件注入
// runningOwners / unconsumedHumanMessages / runningWorkerRepos；新增 store 查询 lastRunEffectSeq /
// countEventsAfter。全部容器层、零业务语义。

let tmpDir: string;
let seq = 0;
const clock = { now: () => 1000 };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const live: Array<{ store: WorkitemsStore; effects: EffectRuntime }> = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-ws0-'));
  vi.clearAllMocks();
});

afterEach(async () => {
  const harnesses = live.splice(0);
  for (const h of harnesses) {
    h.effects.stopIntake();
    h.effects.abortInflight();
  }
  await new Promise((r) => setTimeout(r, 10));
  for (const h of harnesses) h.store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

type OnEvent = (item: WorkItem, ev: WorkItemEvent) => Transition;

function ownerWorkersType(onEvent: OnEvent): WorkType {
  return {
    id: 'ow',
    triggers: { api: true },
    initialPhase: () => 'ow:start',
    onEvent,
    isDecisionStale: () => false,
    topology: () => 'owner-workers',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: true },
  };
}

let blockWorkers = false;
let gateResolve: (() => void) | undefined;

async function runControlled(ctx: EffectContext): Promise<void> {
  const a = ctx.assignment;
  if (!a) throw new Error('missing assignment');
  ctx.heartbeat();
  if (blockWorkers && a.role === 'worker') {
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) return resolve();
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      gateResolve = resolve;
    });
  }
  if (ctx.signal.aborted) return;
  ctx.writeArtifact(`assignments/${a.id}/report.md`, `ok ${a.id}`, 'report');
}

function harness(onEvent: OnEvent) {
  seq += 1;
  const store = new WorkitemsStore(path.join(tmpDir, `wi-${seq}.sqlite`), clock);
  const registry = new WorkTypeRegistry();
  let effects: EffectRuntime | undefined;
  const reducer = new ReducerRuntime({
    store,
    registry,
    clock,
    cfg: loadWorkitemsConfig({ WORKITEMS_MAX_OPEN: '8', WORKITEMS_MAX_WORKERS_PER_ITEM: '4' }),
    logger,
    isRunClass: (kind) => effects?.isRunClass(kind) ?? kind === 'run',
    runKinds: () => effects?.runKinds() ?? ['run'],
    postCommit: (actions) => {
      for (const a of actions) {
        if (a.kind === 'abort_effect') effects?.abort(a.effectId, a.reason);
        else effects?.poke(a.workitemId);
      }
    },
  });
  const artifacts = new ArtifactStore(path.join(tmpDir, `art-${seq}`), logger);
  effects = new EffectRuntime({ store, reducer, registry, artifacts, clock, logger });
  registry.register(ownerWorkersType(onEvent));
  effects.registerHandler({
    kind: 'run',
    recovery: 'resume-or-redispatch',
    canResume: () => false,
    run: runControlled,
    resume: runControlled,
  });
  const api = new WorkitemsApi({
    store,
    registry,
    reducer,
    artifacts,
    afterCreate: (item) => effects?.poke(item.id),
  });
  live.push({ store, effects });
  return { store, reducer, effects, api };
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2000;
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

describe('WS-0.1 run 结论透传 stage', () => {
  it('dispatch payload 带 stage → run_completed 结论平铺该 stage', async () => {
    const { api, store } = harness((_item, ev) =>
      ev.kind === 'workitem_created'
        ? {
            dispatch: [
              {
                role: 'owner',
                deadlineTtlSec: 60,
                wallclockCapSec: 30,
                payload: { stage: 'reconcile' },
              },
            ],
          }
        : {},
    );
    const item = api.createWorkItem({ type: 'ow', title: 't', source: {} }).item;
    await waitFor(() => {
      const done = store.listEvents(item.id).find((e) => e.kind === 'run_completed');
      expect(done).toBeDefined();
      expect((done?.payload as { stage?: string }).stage).toBe('reconcile');
    });
  });

  it('dispatch payload 无 stage → run 结论不含 stage 字段', async () => {
    const { api, store } = harness((_item, ev) =>
      ev.kind === 'workitem_created'
        ? { dispatch: [{ role: 'owner', deadlineTtlSec: 60, wallclockCapSec: 30 }] }
        : {},
    );
    const item = api.createWorkItem({ type: 'ow', title: 't', source: {} }).item;
    await waitFor(() => {
      const done = store.listEvents(item.id).find((e) => e.kind === 'run_completed');
      expect(done).toBeDefined();
      expect((done?.payload as Record<string, unknown>).stage).toBeUndefined();
    });
  });
});

describe('WS-0.2 store 新查询', () => {
  function freshStore(): { store: WorkitemsStore; wid: string } {
    seq += 1;
    const store = new WorkitemsStore(path.join(tmpDir, `store-${seq}.sqlite`), clock);
    const item = makeWorkItem('wi-store', { type: 'ow' });
    store.insertWorkItem(item);
    live.push({
      store,
      effects: { stopIntake() {}, abortInflight() {} } as unknown as EffectRuntime,
    });
    return { store, wid: item.id };
  }

  it('lastRunEffectSeq 取匹配 kind 的最大 effect seq；无匹配 → 0', () => {
    const { store, wid } = freshStore();
    for (const [s, kind] of [
      [3, 'run'],
      [5, 'run'],
      [7, 'reconcile_check'],
    ] as const) {
      store.insertEffect({
        workitemId: wid,
        seq: s,
        kind,
        payload: null,
        status: 'done',
        createdAt: 1000,
        updatedAt: 1000,
      });
    }
    expect(store.lastRunEffectSeq(wid, ['run'])).toBe(5);
    expect(store.lastRunEffectSeq(wid, ['run', 'reconcile_check'])).toBe(7);
    expect(store.lastRunEffectSeq(wid, ['nope'])).toBe(0);
    expect(store.lastRunEffectSeq(wid, [])).toBe(0);
  });

  it('countEventsAfter 数 kind 且 seq > afterSeq 的事件', () => {
    const { store, wid } = freshStore();
    store.appendEvent(wid, 2, 'human_message', { text: 'a' });
    store.appendEvent(wid, 4, 'run_completed', {});
    store.appendEvent(wid, 6, 'human_message', { text: 'b' });
    expect(store.countEventsAfter(wid, 'human_message', 0)).toBe(2);
    expect(store.countEventsAfter(wid, 'human_message', 5)).toBe(1);
    expect(store.countEventsAfter(wid, 'human_message', 6)).toBe(0);
  });
});

describe('WS-0.2 enrich 注入新中性字段', () => {
  it('owner-workers 事件带 runningOwners / unconsumedHumanMessages / runningWorkerRepos', async () => {
    const captured: WorkItemEvent[] = [];
    const { api, store, reducer } = harness((_item, ev) => {
      captured.push(ev);
      return ev.kind === 'workitem_created'
        ? {
            dispatch: [
              {
                role: 'owner',
                deadlineTtlSec: 60,
                wallclockCapSec: 30,
                payload: { stage: 'reconcile' },
              },
            ],
          }
        : {};
    });
    const item = api.createWorkItem({ type: 'ow', title: 't', source: {} }).item;
    // owner run 收尾（owner 自己 done → runningOwners 看到 0）。
    await waitFor(() =>
      expect(store.listEvents(item.id).some((e) => e.kind === 'run_completed')).toBe(true),
    );
    // 群消息落在最后一个 run effect 之后 → unconsumedHumanMessages 计 1（含它自己）。
    reducer.enqueue(item.id, { kind: 'human_message', payload: { text: 'hi' } });
    const hm = captured.find((e) => e.kind === 'human_message');
    expect(hm).toBeDefined();
    const p = hm?.payload as Record<string, unknown>;
    expect(p.runningOwners).toBe(0);
    expect(p.unconsumedHumanMessages).toBe(1);
    expect(Array.isArray(p.runningWorkerRepos)).toBe(true);
    // run 结论自己也带这些字段（run_completed enrich 分支）。
    const done = captured.find((e) => e.kind === 'run_completed');
    expect((done?.payload as Record<string, unknown>).runningOwners).toBe(0);
    expect((done?.payload as Record<string, unknown>).runningWorkers).toBe(0);
  });

  it('消息落在最后一个 run effect 之前（被该 run 消费）→ unconsumedHumanMessages 计 0', async () => {
    const captured: WorkItemEvent[] = [];
    // 先收一条群消息，再由 workitem_created 派 run；消息 seq < run effect seq。
    const { api, store } = harness((_item, ev) => {
      captured.push(ev);
      return ev.kind === 'human_message'
        ? { dispatch: [{ role: 'owner', deadlineTtlSec: 60, wallclockCapSec: 30 }] }
        : {};
    });
    const item = api.createWorkItem({ type: 'ow', title: 't', source: {} }).item;
    api.injectHumanMessage(item.id, { text: 'early' });
    await waitFor(() =>
      expect(store.listEvents(item.id).some((e) => e.kind === 'run_completed')).toBe(true),
    );
    // run 收尾后，该 human_message 的 seq 落在 run effect 之前 → 下一次 enrich 计 0。
    const runEffectSeq = store.lastRunEffectSeq(item.id, ['run']);
    const hmEvents = store.listEvents(item.id).filter((e) => e.kind === 'human_message');
    expect(hmEvents.length).toBe(1);
    // dispatch 出的 run effect 与触发它的那条消息同 seq（dispatch 在处理该消息的同一 apply 内产生）→
    // 该消息落在「最后一次 run」水位内，被其 batch 窗口消费 → unconsumed 计 0。
    expect(hmEvents[0]!.seq).toBe(runEffectSeq);
    expect(store.countEventsAfter(item.id, 'human_message', runEffectSeq)).toBe(0);
  });

  it('有 running worker → runningWorkerRepos 含该仓（中性字符串数组）', async () => {
    blockWorkers = true;
    const captured: WorkItemEvent[] = [];
    const { api, store, reducer } = harness((_item, ev) => {
      captured.push(ev);
      if (ev.kind === 'workitem_created') {
        return {
          dispatch: [
            { role: 'worker', repo: '/abs/repo-a', deadlineTtlSec: 60, wallclockCapSec: 30 },
          ],
        };
      }
      return {};
    });
    const item = api.createWorkItem({ type: 'ow', title: 't', source: {} }).item;
    await waitFor(() => expect(store.countRunningWorkers(item.id)).toBe(1));
    // 群消息事件此刻 enrich → 应看到 running worker 的仓。
    reducer.enqueue(item.id, { kind: 'human_message', payload: { text: 'hi' } });
    const hm = captured.find((e) => e.kind === 'human_message');
    expect((hm?.payload as { runningWorkerRepos?: unknown }).runningWorkerRepos).toEqual([
      '/abs/repo-a',
    ]);
    gateResolve?.();
    blockWorkers = false;
  });
});
