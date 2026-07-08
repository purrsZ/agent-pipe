import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { ReducerRuntime, type PostCommitAction } from '../../src/workitems/reducer.js';
import { WorkitemsStore } from '../../src/workitems/store.js';
import type { Clock, WorkType } from '../../src/workitems/types.js';

// /cancel 修补（2026-07-08）：终态必须就地击杀在途 effect——同一事务翻 aborted（effect_aborted 事件
// 走不通：终态短路只留审计），postCommit 发 abort_effect 触发 signal（SIGINT 子进程 + 卡片收「中断」）。
// 取消即删库：deleteWorkItem 级联清子表；迟到事件落在已删单上 warn-drop 不抛。

let tmpDir: string;
const clock: Clock = { now: () => 1000 };
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-terminal-abort-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function build() {
  const store = new WorkitemsStore(path.join(tmpDir, 'wi.sqlite'), clock);
  const registry = new WorkTypeRegistry();
  const captured: PostCommitAction[] = [];
  const reducer = new ReducerRuntime({
    store,
    registry,
    clock,
    cfg: loadWorkitemsConfig({
      WORKITEMS_DEFAULT_DEADLINE_TTL_SEC: '7',
      WORKITEMS_DEFAULT_WALLCLOCK_CAP_SEC: '5',
    }),
    logger,
    isRunClass: (kind) => kind === 'run',
    postCommit: (actions) => captured.push(...actions),
  });
  const artifacts = new ArtifactStore(path.join(tmpDir, 'workitems'), logger);
  const type: WorkType = {
    id: 'noop',
    triggers: { api: true },
    initialPhase: () => 'noop:idle',
    onEvent: (_item, ev) => {
      if (ev.kind === 'start') {
        return { dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }] };
      }
      if (ev.kind === 'die') return { terminal: 'cancelled' };
      return {};
    },
    isDecisionStale: () => false,
    topology: () => 'solo',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: true },
  };
  registry.register(type);
  const api = new WorkitemsApi({ store, registry, reducer, artifacts });
  return { api, reducer, store, captured };
}

describe('终态击杀在途 effect', () => {
  it('terminal 事务内把在途 effect 翻 aborted，postCommit 发 abort_effect（signal 触发口）', () => {
    const { api, reducer, store, captured } = build();
    const item = api.createWorkItem({ type: 'noop', title: 'T', source: {} }).item;
    reducer.enqueue(item.id, { kind: 'start' }); // running assignment + pending run effect
    const [effect] = store.listInflightEffects(item.id);
    expect(effect).toBeDefined();
    captured.length = 0;

    reducer.enqueue(item.id, { kind: 'die' });

    expect(store.getWorkItem(item.id)?.status).toBe('cancelled');
    expect(store.listInflightEffects(item.id)).toHaveLength(0);
    expect(store.getEffect(effect!.id)?.status).toBe('aborted');
    expect(captured).toContainEqual({
      kind: 'abort_effect',
      effectId: effect!.id,
      reason: 'workitem_terminal',
    });
    // 既有行为回归：running 派工同事务标 superseded
    expect(store.listAssignments(item.id)[0]?.status).toBe('superseded');
    store.close();
  });

  it('无在途 effect 的终态不发多余 abort_effect', () => {
    const { api, reducer, store, captured } = build();
    const item = api.createWorkItem({ type: 'noop', title: 'T', source: {} }).item;
    captured.length = 0;
    reducer.enqueue(item.id, { kind: 'die' });
    expect(captured.filter((a) => a.kind === 'abort_effect')).toHaveLength(0);
    store.close();
  });
});

describe('取消即删库', () => {
  it('deleteWorkItem 级联清子表（events/effects/assignments），重复删幂等', () => {
    const { api, reducer, store } = build();
    const item = api.createWorkItem({ type: 'noop', title: 'T', source: {} }).item;
    reducer.enqueue(item.id, { kind: 'start' });
    expect(store.listEvents(item.id).length).toBeGreaterThan(0);

    expect(store.deleteWorkItem(item.id)).toBe(true);

    expect(store.getWorkItem(item.id)).toBeUndefined();
    expect(store.listEvents(item.id)).toHaveLength(0);
    expect(store.listInflightEffects(item.id)).toHaveLength(0);
    expect(store.listAssignments(item.id)).toHaveLength(0);
    expect(store.deleteWorkItem(item.id)).toBe(false);
    store.close();
  });

  it('事件流对外仍 append-only：父单还在时直接删事件被触发器拒绝', () => {
    const { api, store } = build();
    const item = api.createWorkItem({ type: 'noop', title: 'T', source: {} }).item;
    const raw = new Database(path.join(tmpDir, 'wi.sqlite'));
    try {
      expect(() =>
        raw.prepare('DELETE FROM workitem_events WHERE workitem_id = ?').run(item.id),
      ).toThrow(/append-only/);
    } finally {
      raw.close();
    }
    store.close();
  });

  it('迟到事件落在已删单上：warn-drop 不抛（run 自然完赛与删除竞态）', () => {
    const { api, reducer, store } = build();
    const item = api.createWorkItem({ type: 'noop', title: 'T', source: {} }).item;
    store.deleteWorkItem(item.id);

    expect(() => reducer.enqueue(item.id, { kind: 'run_completed', payload: {} })).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workitemId: item.id }),
      'event dropped: workitem missing',
    );
    store.close();
  });
});
