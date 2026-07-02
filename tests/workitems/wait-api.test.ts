import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { TimerNotResolvableError } from '../../src/workitems/errors.js';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { ReducerRuntime } from '../../src/workitems/reducer.js';
import { WorkitemsStore } from '../../src/workitems/store.js';
import { Watchdog } from '../../src/workitems/watchdog.js';
import type { Clock, Transition, Wait, WorkItem, WorkType } from '../../src/workitems/types.js';

let tmpDir: string;
let now = 1000;
const clock: Clock = { now: () => now };
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-wait-api-test-'));
  now = 1000;
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(): {
  api: WorkitemsApi;
  reducer: ReducerRuntime;
  store: WorkitemsStore;
  watchdog: Watchdog;
} {
  const store = new WorkitemsStore(path.join(tmpDir, 'workitems.sqlite'), clock);
  const registry = new WorkTypeRegistry();
  const cfg = loadWorkitemsConfig({
    WORKITEMS_HEARTBEAT_TIMEOUT_SEC: '1000',
    WORKITEMS_RETRY_BUDGET: '1',
  });
  const reducer = new ReducerRuntime({ store, registry, clock, cfg, logger, postCommit: () => {} });
  const artifacts = new ArtifactStore(path.join(tmpDir, 'workitems'), logger);
  const watchdog = new Watchdog({
    store,
    reducer,
    effects: { lastBeat: () => now },
    clock,
    logger,
    cfg,
    registry,
  });
  registry.register(workType());
  return {
    api: new WorkitemsApi({ store, registry, reducer, artifacts, clock }),
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
    onEvent: (_item, ev): Transition => {
      if (ev.kind === 'human_wait') {
        return { waits: [{ kind: 'human', reason: 'operator', deadlineTtlSec: 1 }] };
      }
      if (ev.kind === 'timer_wait') {
        return { waits: [{ kind: 'timer', reason: 'delay', deadlineTtlSec: 10 }] };
      }
      if (ev.kind === 'start') {
        return { dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 60 }] };
      }
      if (ev.kind === 'agent_wait' && isObject(ev.payload)) {
        return {
          waits: [
            {
              kind: 'agent',
              reason: 'child',
              deadlineTtlSec: 10,
              originAssignmentId:
                typeof ev.payload.assignmentId === 'string' ? ev.payload.assignmentId : undefined,
            },
          ],
        };
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
  return api.createWorkItem({ type: 'noop', title: 'Wait API', source: {} }).item;
}

function singleOpenWait(store: WorkitemsStore, itemId: string): Wait {
  const waits = store.listOpenWaits(itemId);
  expect(waits).toHaveLength(1);
  return waits[0]!;
}

function eventKinds(store: WorkitemsStore, itemId: string): string[] {
  return store.listEvents(itemId).map((event) => event.kind);
}

describe('wait API', () => {
  it('renews a human wait and re-arms its reminder after the reset', () => {
    const { api, reducer, store, watchdog } = harness();
    const item = createItem(api);
    reducer.enqueue(item.id, { kind: 'human_wait' });
    const wait = singleOpenWait(store, item.id);

    // WS-3: 提醒不再看 deadline，改为 createdAt + waitRemindAfterSec（默认 4h）触发。
    now = wait.createdAt + 14_400 * 1000;
    watchdog.tick();
    expect(store.getWait(wait.id)).toMatchObject({ remindedAt: now });
    expect(eventKinds(store, item.id).filter((kind) => kind === 'wait_reminder')).toHaveLength(1);

    api.renewWait(wait.id, { operator: 'codex', deadlineTtlSec: 3 });
    // 续期清空 remindedAt → due 回落到 createdAt+remindAfter（已过）→ 下一 tick 立即再催。
    expect(store.getWait(wait.id)).toMatchObject({
      deadlineAt: now + 3000,
      renewedCount: 1,
      remindedAt: null,
    });
    expect(
      store.listEvents(item.id).find((event) => event.kind === 'wait_renewed')?.payload,
    ).toEqual({ waitId: wait.id, operator: 'codex', newDeadlineAt: now + 3000 });

    watchdog.tick();
    expect(eventKinds(store, item.id).filter((kind) => kind === 'wait_reminder')).toHaveLength(2);
    store.close();
  });

  it('keeps deadline changes out of raw updateWait production calls', () => {
    const reducerSource = fs.readFileSync(
      path.join(process.cwd(), 'src/workitems/reducer.ts'),
      'utf8',
    );

    expect(reducerSource).not.toMatch(/updateWait\([\s\S]{0,300}deadlineAt/);
    expect(reducerSource).toContain('renewWaitDeadline');
  });

  it('resolves human and agent waits through the reducer and removes them from rollup and watchdog scans', () => {
    const { api, reducer, store, watchdog } = harness();
    const humanItem = createItem(api);
    reducer.enqueue(humanItem.id, { kind: 'human_wait' });
    const humanWait = singleOpenWait(store, humanItem.id);

    expect(api.resolveWait(humanWait.id, { operator: 'human-1', reason: 'answered' })).toEqual({
      resolved: true,
    });
    expect(store.getWait(humanWait.id)).toMatchObject({
      resolvedAt: 1000,
      resolvedBy: 'human-1',
      resolveReason: 'answered',
    });
    expect(store.getWorkItem(humanItem.id)).toMatchObject({ status: 'active', statusDetail: null });

    now = humanWait.deadlineAt;
    watchdog.tick();
    expect(eventKinds(store, humanItem.id)).not.toContain('wait_reminder');

    const agentItem = createItem(api);
    reducer.enqueue(agentItem.id, { kind: 'start' });
    const assignmentId = store.listAssignments(agentItem.id)[0]!.id;
    reducer.enqueue(agentItem.id, { kind: 'agent_wait', payload: { assignmentId } });
    const agentWait = singleOpenWait(store, agentItem.id);

    expect(api.resolveWait(agentWait.id, { operator: 'agent-1', reason: 'child_done' })).toEqual({
      resolved: true,
    });
    expect(store.getWait(agentWait.id)).toMatchObject({
      resolvedAt: now,
      resolvedBy: 'agent-1',
      resolveReason: 'child_done',
    });
    expect(
      store.listEvents(agentItem.id).find((event) => event.kind === 'wait_resolved')?.payload,
    ).toEqual({
      waitId: agentWait.id,
      operator: 'agent-1',
      reason: 'child_done',
    });
    store.close();
  });

  it('rejects repeated resolve without adding another event', () => {
    const { api, reducer, store } = harness();
    const item = createItem(api);
    reducer.enqueue(item.id, { kind: 'human_wait' });
    const wait = singleOpenWait(store, item.id);

    expect(api.resolveWait(wait.id, { operator: 'human-1', reason: 'answered' })).toEqual({
      resolved: true,
    });
    expect(api.resolveWait(wait.id, { operator: 'human-1', reason: 'again' })).toEqual({
      resolved: false,
      alreadyResolvedAt: 1000,
    });
    expect(eventKinds(store, item.id).filter((kind) => kind === 'wait_resolved')).toHaveLength(1);
    store.close();
  });

  it('does not allow timers to be actively resolved', () => {
    const { api, reducer, store } = harness();
    const item = createItem(api);
    reducer.enqueue(item.id, { kind: 'timer_wait' });
    const wait = singleOpenWait(store, item.id);

    expect(() => api.resolveWait(wait.id, { operator: 'human-1', reason: 'skip' })).toThrow(
      TimerNotResolvableError,
    );
    expect(store.getWait(wait.id)).toMatchObject({ resolvedAt: null });
    expect(eventKinds(store, item.id)).not.toContain('wait_resolved');
    store.close();
  });
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
