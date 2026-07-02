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
import { requirementWorkType } from '../../src/worktypes/requirement/index.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';
import type { Clock } from '../../src/workitems/types.js';
import { makeAssignment, makeWait } from '../helpers/workitems.js';

// WS-1.2/1.3 活性自证：watchdog 扫描 must-progress 单，持续「无 running assignment ∧ 无 pending/running
// effect ∧ 无 open wait」≥ grace → 发 liveness_stalled；requirement 据此 raise stalled_no_path 病历。
// grace 默认 30s（WORKITEMS_LIVENESS_GRACE_SEC）。

let tmpDir: string;
let now = 1000;
const clock: Clock = { now: () => now };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-liveness-'));
  now = 1000;
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness() {
  const store = new WorkitemsStore(path.join(tmpDir, 'wi.sqlite'), clock);
  const registry = new WorkTypeRegistry();
  const cfg = loadWorkitemsConfig({ WORKITEMS_WATCHDOG_INTERVAL_MS: '100' });
  const reducer = new ReducerRuntime({
    store,
    registry,
    clock,
    cfg,
    logger,
    isRunClass: (kind) => kind === 'run',
    postCommit: () => {},
  });
  const artifacts = new ArtifactStore(path.join(tmpDir, 'art'), logger);
  registry.register(requirementWorkType);
  const watchdog = new Watchdog({
    store,
    reducer,
    effects: { lastBeat: () => undefined },
    clock,
    logger,
    cfg,
    registry,
  });
  const api = new WorkitemsApi({ store, registry, reducer, artifacts });
  return { api, store, reducer, watchdog, registry };
}

function stalledCount(store: WorkitemsStore, itemId: string): number {
  return store.listOpenWaits(itemId).filter((w) => w.reason === 'stalled_no_path').length;
}

describe('WS-1.2 watchdog 活性不变式扫描', () => {
  it('must-progress 单持续无在途工作 ≥ grace → liveness_stalled → stalled_no_path 病历', () => {
    const { api, store, watchdog } = harness();
    const item = api.createWorkItem({ type: 'requirement', title: 't', source: {} }).item;
    // 推到拆解（must-progress），此刻无 assignment/effect/wait（死状态）。
    store.updateWorkItem(item.id, { phase: PHASE.split, updatedAt: now });

    // grace 内不报警（第一次 tick 只记录首次违反时间）。
    watchdog.tick();
    expect(stalledCount(store, item.id)).toBe(0);

    // 走过 grace（默认 30s）。
    now += 31_000;
    watchdog.tick();
    expect(stalledCount(store, item.id)).toBe(1);

    // 再 tick 不重复弹（已有 open wait = 活路，幂等）。
    now += 31_000;
    watchdog.tick();
    expect(stalledCount(store, item.id)).toBe(1);
  });

  it('resolve stalled_no_path 病历（approved）→ 重派当前阶段入口（拆解 → owner reconcile run）', () => {
    const { api, store, watchdog } = harness();
    // WS-6：多仓（满配）→ 拆解自愈回 owner 对账；单仓 lite 会派 worker。
    const item = api.createWorkItem({
      type: 'requirement',
      title: 't',
      source: {},
      repos: ['repo-a', 'repo-b'],
    }).item;
    store.updateWorkItem(item.id, { phase: PHASE.split, updatedAt: now });
    watchdog.tick(); // 首次观测违反，记录时间
    now += 31_000;
    watchdog.tick(); // 持续 ≥ grace → 报警 → requirement raise 病历
    const wait = store.listOpenWaits(item.id).find((w) => w.reason === 'stalled_no_path');
    expect(wait).toBeDefined();

    api.resolveWait(wait!.id, { operator: 'x', reason: 'fixed', decision: { approved: true } });
    // retryCurrentPhase(split) → 派 owner reconcile assignment。
    const owner = store.listAssignments(item.id).find((a) => a.role === 'owner');
    expect(owner).toBeDefined();
  });

  it('may-rest 相位（intake / deliver）不报警', () => {
    const { api, store, watchdog } = harness();
    const item = api.createWorkItem({ type: 'requirement', title: 't', source: {} }).item;
    // 初始 intake（may-rest）——即便长时间无在途工作也不报警。
    now += 61_000;
    watchdog.tick();
    watchdog.tick();
    expect(stalledCount(store, item.id)).toBe(0);
    // 交付相位同样 may-rest。
    store.updateWorkItem(item.id, { phase: PHASE.deliver, updatedAt: now });
    now += 61_000;
    watchdog.tick();
    watchdog.tick();
    expect(stalledCount(store, item.id)).toBe(0);
  });

  it('probe / 无 liveness 声明的 worktype 不报警（缺省 may-rest）', () => {
    const { api, store, watchdog, registry } = harness();
    // 注册一个无 liveness 声明的 solo type。
    registry.register({
      id: 'plain',
      triggers: { api: true },
      initialPhase: () => 'plain:go',
      onEvent: () => ({}),
      isDecisionStale: () => false,
      topology: () => 'solo',
      permissions: { mode: 'readonly' },
      checkpoints: { requiredBefore: [] },
      artifacts: { reportRequired: true },
    });
    const item = api.createWorkItem({ type: 'plain', title: 't', source: {} }).item;
    now += 61_000;
    watchdog.tick();
    watchdog.tick();
    expect(store.listOpenWaits(item.id)).toHaveLength(0);
  });

  it('有 open wait → 不报警（是活路）', () => {
    const { api, store, watchdog } = harness();
    const item = api.createWorkItem({ type: 'requirement', title: 't', source: {} }).item;
    store.updateWorkItem(item.id, { phase: PHASE.implement, updatedAt: now });
    store.insertWait(makeWait('wt-open', item.id, { kind: 'human', reason: 'gatekeeper_big' }));
    now += 61_000;
    watchdog.tick();
    expect(stalledCount(store, item.id)).toBe(0);
  });

  it('有 running assignment → 不报警（是活路）', () => {
    const { api, store, watchdog } = harness();
    const item = api.createWorkItem({ type: 'requirement', title: 't', source: {} }).item;
    store.updateWorkItem(item.id, { phase: PHASE.implement, updatedAt: now });
    store.insertAssignment(
      makeAssignment('as-run', item.id, { role: 'worker', status: 'running' }),
    );
    now += 61_000;
    watchdog.tick();
    expect(stalledCount(store, item.id)).toBe(0);
  });

  it('终态单不报警（listNonTerminal 已排除）', () => {
    const { api, store, watchdog } = harness();
    const item = api.createWorkItem({ type: 'requirement', title: 't', source: {} }).item;
    store.updateWorkItem(item.id, { phase: PHASE.implement, status: 'done', updatedAt: now });
    now += 61_000;
    watchdog.tick();
    expect(stalledCount(store, item.id)).toBe(0);
  });
});
