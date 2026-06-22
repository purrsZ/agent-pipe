import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { EffectRuntime } from '../../src/workitems/effects.js';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { ReducerRuntime } from '../../src/workitems/reducer.js';
import { WorkitemsStore } from '../../src/workitems/store.js';
import { createWorkbenchAdapter } from '../../src/workitems/workbench-adapter.js';
import type { Transition, WorkItem, WorkItemEvent, WorkType } from '../../src/workitems/types.js';

let tmpDir: string;
const clock = { now: () => 1000 };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-wb-adapter-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(onEvent: (item: WorkItem, ev: WorkItemEvent) => Transition) {
  const store = new WorkitemsStore(path.join(tmpDir, 'wi.sqlite'), clock);
  const registry = new WorkTypeRegistry();
  const reducer = new ReducerRuntime({
    store,
    registry,
    clock,
    cfg: loadWorkitemsConfig({ WORKITEMS_MAX_OPEN: '8' }),
    logger,
    isRunClass: (k) => k === 'run',
    postCommit: () => {},
  });
  const artifacts = new ArtifactStore(path.join(tmpDir, 'art'), logger);
  const type: WorkType = {
    id: 'wb',
    triggers: { api: true },
    initialPhase: () => 'wb:start',
    onEvent,
    isDecisionStale: () => false,
    topology: () => 'solo',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: false },
  };
  registry.register(type);
  const api = new WorkitemsApi({ store, registry, reducer, artifacts });
  // EffectRuntime constructed for parity (not driven here).
  void new EffectRuntime({ store, reducer, registry, artifacts, clock, logger });
  return { store, artifacts, api };
}

describe('workbench adapter (read view-model + write回流)', () => {
  it('builds an ItemView from the store + artifacts and lists the board', () => {
    const { store, artifacts, api } = harness((_i, ev) =>
      ev.kind === 'workitem_created'
        ? { waits: [{ kind: 'human', reason: 'checkpoint:wb:gate', deadlineTtlSec: 600 }] }
        : {},
    );
    const item = api.createWorkItem({ type: 'wb', title: '需求 X', source: {} }).item;
    artifacts.writeFile(item.id, 'brief.md', '# 需求 X\n内容', 'brief');

    const { data } = createWorkbenchAdapter({ store, artifacts, api });

    expect(data.listItems().map((s) => s.title)).toContain('需求 X');
    const view = data.getItem(item.id)!;
    expect(view.summary.stage).toBe('wb:start');
    expect(view.focus.map((f) => f.reason)).toContain('checkpoint:wb:gate'); // open human wait
    expect(view.docs.find((d) => d.name === 'brief.md')?.content).toContain('需求 X');
    expect(view.activity.some((a) => a.kind === 'workitem_created')).toBe(true);
    expect(data.getItem('missing')).toBeUndefined();
  });

  it('resolve回流 funnels through resolveWait carrying the decision', () => {
    const { store, artifacts, api } = harness((_i, ev) =>
      ev.kind === 'workitem_created'
        ? { waits: [{ kind: 'human', reason: 'checkpoint:wb:gate', deadlineTtlSec: 600 }] }
        : {},
    );
    const item = api.createWorkItem({ type: 'wb', title: 'Y', source: {} }).item;
    const wait = store.listOpenWaits(item.id)[0]!;
    const { actions } = createWorkbenchAdapter({ store, artifacts, api });

    const r = actions.resolve({
      itemId: item.id,
      waitId: wait.id,
      operator: 'lichao',
      approved: true,
      reason: 'ok',
    });
    expect(r.ok).toBe(true);
    const resolved = store.listEvents(item.id).find((e) => e.kind === 'wait_resolved')!;
    expect(resolved.payload).toMatchObject({ operator: 'lichao', decision: { approved: true } });
  });

  it('message回流 injects a human_message', () => {
    const { store, artifacts, api } = harness(() => ({}));
    const item = api.createWorkItem({ type: 'wb', title: 'Z', source: {} }).item;
    const { actions } = createWorkbenchAdapter({ store, artifacts, api });
    expect(actions.message({ itemId: item.id, operator: 'lichao', text: '看看 X' }).ok).toBe(true);
    expect(store.listEvents(item.id).some((e) => e.kind === 'human_message')).toBe(true);
  });
});
