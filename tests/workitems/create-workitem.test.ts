import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { OpenLimitError, TypeNotRegisteredError } from '../../src/workitems/errors.js';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { ReducerRuntime } from '../../src/workitems/reducer.js';
import { WorkitemsStore } from '../../src/workitems/store.js';
import type {
  Clock,
  Transition,
  WorkItem,
  WorkItemEvent,
  WorkType,
} from '../../src/workitems/types.js';

let tmpDir: string;
const clock: Clock = { now: () => 1000 };
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-create-workitem-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function workType(
  id: string,
  onEvent: (item: WorkItem, ev: WorkItemEvent) => Transition = () => ({}),
): WorkType {
  return {
    id,
    triggers: { api: true },
    initialPhase: () => `${id}:initial`,
    onEvent,
    isDecisionStale: () => false,
    topology: () => 'solo',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: true },
  };
}

function createHarness(maxOpen = 3): {
  api: WorkitemsApi;
  store: WorkitemsStore;
  registry: WorkTypeRegistry;
  artifactsDir: string;
} {
  const store = new WorkitemsStore(path.join(tmpDir, 'workitems.sqlite'), clock);
  const registry = new WorkTypeRegistry();
  const cfg = loadWorkitemsConfig({ WORKITEMS_MAX_OPEN: String(maxOpen) });
  const reducer = new ReducerRuntime({ store, registry, clock, cfg, logger, postCommit: () => {} });
  const artifactsDir = path.join(tmpDir, 'workitems');
  const artifacts = new ArtifactStore(artifactsDir, logger);
  const api = new WorkitemsApi({ store, registry, reducer, artifacts });
  return { api, store, registry, artifactsDir };
}

describe('WorkitemsApi.createWorkItem', () => {
  it('creates a registered workitem with initial phase, creation event, and artifact repo', () => {
    const { api, store, registry, artifactsDir } = createHarness();
    registry.register(workType('noop'));

    const result = api.createWorkItem({
      type: 'noop',
      title: 'Probe',
      source: { kind: 'unit' },
      dedupeKey: 'probe',
    });

    expect(result.created).toBe(true);
    expect(result.item.type).toBe('noop');
    expect(result.item.title).toBe('Probe');
    expect(result.item.status).toBe('open');
    expect(result.item.phase).toBe('noop:initial');
    expect(result.item.source).toEqual({ kind: 'unit' });
    expect(store.listEvents(result.item.id).map((ev) => ev.kind)).toEqual(['workitem_created']);
    expect(store.listEvents(result.item.id)[0]!.payload).toEqual({
      source: { kind: 'unit' },
      title: 'Probe',
    });
    expect(fs.existsSync(path.join(artifactsDir, result.item.id, '.git'))).toBe(true);
    store.close();
  });

  it('rejects unregistered types without writing rows', () => {
    const { api, store } = createHarness();

    expect(() =>
      api.createWorkItem({
        type: 'ghost',
        title: 'Ghost',
        source: { kind: 'unit' },
      }),
    ).toThrow(TypeNotRegisteredError);
    expect(store.countNonTerminal()).toBe(0);
    store.close();
  });

  it('silently returns an existing item for dedupe collisions', () => {
    const { api, store, registry } = createHarness();
    registry.register(workType('noop'));

    const first = api.createWorkItem({
      type: 'noop',
      title: 'Probe',
      source: { n: 1 },
      dedupeKey: 'same',
    });
    const second = api.createWorkItem({
      type: 'noop',
      title: 'Probe again',
      source: { n: 2 },
      dedupeKey: 'same',
    });

    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, item: first.item });
    expect(store.countNonTerminal()).toBe(1);
    expect(store.listEvents(first.item.id)).toHaveLength(1);
    store.close();
  });

  it('allows multiple items when dedupeKey is omitted', () => {
    const { api, store, registry } = createHarness();
    registry.register(workType('noop'));

    const first = api.createWorkItem({ type: 'noop', title: 'A', source: {} });
    const second = api.createWorkItem({ type: 'noop', title: 'A', source: {} });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(first.item.id).not.toBe(second.item.id);
    expect(store.countNonTerminal()).toBe(2);
    store.close();
  });

  it('enforces max non-terminal workitems and ignores terminal items', () => {
    const { api, store, registry } = createHarness(3);
    registry.register(workType('noop'));
    const items = [1, 2, 3].map((n) =>
      api.createWorkItem({ type: 'noop', title: `Item ${n}`, source: { n } }),
    );

    expect(() => api.createWorkItem({ type: 'noop', title: 'Item 4', source: { n: 4 } })).toThrow(
      OpenLimitError,
    );
    expect(store.countNonTerminal()).toBe(3);
    store.updateWorkItem(items[0]!.item.id, { status: 'done', updatedAt: 2000 });
    expect(api.createWorkItem({ type: 'noop', title: 'Item 4', source: { n: 4 } }).created).toBe(
      true,
    );
    store.close();
  });

  it('respects configured maxOpen', () => {
    const { api, store, registry } = createHarness(4);
    registry.register(workType('noop'));
    for (const n of [1, 2, 3, 4]) {
      api.createWorkItem({ type: 'noop', title: `Item ${n}`, source: { n } });
    }

    expect(() => api.createWorkItem({ type: 'noop', title: 'Item 5', source: { n: 5 } })).toThrow(
      OpenLimitError,
    );
    expect(store.countNonTerminal()).toBe(4);
    store.close();
  });

  it('applies the initial transition skeleton for dispatch, waits, and effects in the create transaction', () => {
    const { api, store, registry } = createHarness();
    registry.register(
      workType('noop', () => ({
        dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30, payload: { run: 1 } }],
        waits: [{ kind: 'timer', reason: 'cooldown', deadlineTtlSec: 5 }],
        effects: [{ kind: 'audit', payload: { ok: true } }],
      })),
    );

    const result = api.createWorkItem({ type: 'noop', title: 'With transition', source: {} });

    expect(store.listAssignments(result.item.id)).toHaveLength(1);
    expect(store.listOpenWaits(result.item.id)).toHaveLength(1);
    expect(store.listInflightEffects(result.item.id).map((effect) => effect.kind)).toEqual([
      'run',
      'audit',
    ]);
    expect(store.getWorkItem(result.item.id)!.status).toBe('active');
    store.close();
  });
});
