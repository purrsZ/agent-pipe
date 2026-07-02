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

// WS-1.4 补派（parked dispatch 持久化）：owner-workers 超 worker 并发上限的 dispatch 不再被静默丢弃——
// 完整 spec 落 workitem_parked 表；一个 worker 收尾时 releaseWakePending 反序列化重派（强一致计数保证不超发）。
// terminal 清空 parked（防僵尸复活）。

let tmpDir: string;
let seq = 0;
const clock = { now: () => 1000 };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const live: Array<{ store: WorkitemsStore; effects: EffectRuntime }> = [];
let gate = deferred();
let blockWorkers = true;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-parked-'));
  vi.clearAllMocks();
  gate = deferred();
  blockWorkers = true;
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

async function runControlled(ctx: EffectContext): Promise<void> {
  const a = ctx.assignment;
  if (!a) throw new Error('missing assignment');
  ctx.heartbeat();
  if (blockWorkers && a.role === 'worker') {
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) return resolve();
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      void gate.promise.then(() => resolve());
    });
  }
  if (ctx.signal.aborted) return;
  ctx.writeArtifact(`assignments/${a.id}/report.md`, `ok ${a.id}`, 'report');
}

function harness(onEvent: OnEvent, maxWorkers: number) {
  seq += 1;
  const store = new WorkitemsStore(path.join(tmpDir, `wi-${seq}.sqlite`), clock);
  const registry = new WorkTypeRegistry();
  let effects: EffectRuntime | undefined;
  const reducer = new ReducerRuntime({
    store,
    registry,
    clock,
    cfg: loadWorkitemsConfig({
      WORKITEMS_MAX_OPEN: '8',
      WORKITEMS_MAX_WORKERS_PER_ITEM: String(maxWorkers),
    }),
    logger,
    isRunClass: (kind) => effects?.isRunClass(kind) ?? kind === 'run',
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

function dispatchWorkers(n: number): OnEvent {
  return (_item, ev) =>
    ev.kind === 'workitem_created'
      ? {
          dispatch: Array.from({ length: n }, (_v, i) => ({
            role: 'worker' as const,
            repo: `/abs/repo-${i}`,
            deadlineTtlSec: 60,
            wallclockCapSec: 30,
          })),
        }
      : {};
}

describe('WS-1.4 store parked CRUD', () => {
  it('insertParked / listParked（按 id 升序）/ deleteParked', () => {
    seq += 1;
    const store = new WorkitemsStore(path.join(tmpDir, `store-${seq}.sqlite`), clock);
    const item = makeWorkItem('wi-p', { type: 'ow' });
    store.insertWorkItem(item);
    live.push({
      store,
      effects: { stopIntake() {}, abortInflight() {} } as unknown as EffectRuntime,
    });
    store.insertParked(item.id, 5, JSON.stringify({ role: 'worker', repo: 'a' }));
    store.insertParked(item.id, 6, JSON.stringify({ role: 'worker', repo: 'b' }));
    const rows = store.listParked(item.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.seq).toBe(5);
    expect(JSON.parse(rows[0]!.spec)).toMatchObject({ role: 'worker', repo: 'a' });
    store.deleteParked(rows[0]!.id);
    const after = store.listParked(item.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.seq).toBe(6);
  });
});

describe('WS-1.4 补派', () => {
  it('超额 worker 落 parked；worker 收尾后 parked 补派为新 assignment', async () => {
    const { api, store } = harness(dispatchWorkers(3), 2);
    const item = api.createWorkItem({ type: 'ow', title: 't', source: {} }).item;
    // cap=2 → 2 running，第 3 个 parked（wakePending）。
    await waitFor(() => expect(store.countRunningWorkers(item.id)).toBe(2));
    expect(store.listParked(item.id)).toHaveLength(1);
    expect(store.getWorkItem(item.id)!.wakePending).toBe(true);
    // 只创建了 2 个 assignment（第 3 个还在 parked，未落 assignment）。
    expect(store.listAssignments(item.id).filter((a) => a.role === 'worker')).toHaveLength(2);

    // 释放 → 2 running 完成 → 第一个收尾时 releaseWakePending 补派第 3 个（gate 已 resolve，补派的也直接跑完）。
    gate.resolve();
    await waitFor(() => {
      const done = store
        .listAssignments(item.id)
        .filter((a) => a.role === 'worker' && a.status === 'done');
      expect(done).toHaveLength(3);
    });
    // parked 清空，不超发（始终 ≤ maxWorkers 并发）。
    expect(store.listParked(item.id)).toHaveLength(0);
  });

  it('terminal 清空 parked（防僵尸复活）', async () => {
    const onEvent: OnEvent = (_item, ev) => {
      if (ev.kind === 'workitem_created') {
        return {
          dispatch: Array.from({ length: 3 }, (_v, i) => ({
            role: 'worker' as const,
            repo: `/abs/repo-${i}`,
            deadlineTtlSec: 60,
            wallclockCapSec: 30,
          })),
        };
      }
      if (ev.kind === 'human_message') return { terminal: 'cancelled' };
      return {};
    };
    const { api, store, reducer } = harness(onEvent, 2);
    const item = api.createWorkItem({ type: 'ow', title: 't', source: {} }).item;
    await waitFor(() => expect(store.listParked(item.id)).toHaveLength(1));

    reducer.enqueue(item.id, { kind: 'human_message', payload: { text: 'kill' } });
    expect(store.getWorkItem(item.id)!.status).toBe('cancelled');
    expect(store.listParked(item.id)).toHaveLength(0);
  });

  it('去重：同 repo 已有 running worker 时重复 dispatch 被跳过（防 retry × 残留 parked 双写）', async () => {
    const onEvent: OnEvent = (_item, ev) => {
      if (ev.kind === 'workitem_created') {
        return {
          dispatch: [
            { role: 'worker', repo: '/abs/repo-a', deadlineTtlSec: 60, wallclockCapSec: 30 },
          ],
        };
      }
      // 模拟 retryCurrentPhase 重派同一 repo（此时 repo-a 已有 running worker）。
      if (ev.kind === 'human_message') {
        return {
          dispatch: [
            { role: 'worker', repo: '/abs/repo-a', deadlineTtlSec: 60, wallclockCapSec: 30 },
          ],
        };
      }
      return {};
    };
    const { api, store, reducer } = harness(onEvent, 2);
    const item = api.createWorkItem({ type: 'ow', title: 't', source: {} }).item;
    await waitFor(() => expect(store.countRunningWorkers(item.id)).toBe(1));
    reducer.enqueue(item.id, { kind: 'human_message', payload: { text: 'retry' } });
    // repo-a 已 running → 第二次 dispatch 被去重跳过：既不双开也不落 parked。
    const repoAWorkers = store
      .listAssignments(item.id)
      .filter((a) => a.role === 'worker' && a.repo === '/abs/repo-a');
    expect(repoAWorkers).toHaveLength(1);
    expect(store.listParked(item.id)).toHaveLength(0);
  });
});
