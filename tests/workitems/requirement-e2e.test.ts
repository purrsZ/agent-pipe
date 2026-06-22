import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { EffectRuntime, type EffectContext } from '../../src/workitems/effects.js';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { ReducerRuntime } from '../../src/workitems/reducer.js';
import { WorkitemsStore } from '../../src/workitems/store.js';
import { createIntegrationCheckHandler } from '../../src/worktypes/requirement/integration.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';
import { registerRequirement } from '../../src/worktypes/requirement/index.js';

// Stage 3 "skeleton runs end to end": drive the full 7-phase lifecycle through the real
// container (single-flight gate, checkpoint waits, worker fan-out) with a generic auto-
// completing run handler standing in for real agents. One repo ⇒ one worker (multi-worker
// batch aggregation is Stage 4).

let tmpDir: string;
let seq = 0;
const clock = { now: () => 1000 };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const live: Array<{ store: WorkitemsStore; effects: EffectRuntime }> = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-req-e2e-'));
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

function harness() {
  seq += 1;
  const store = new WorkitemsStore(path.join(tmpDir, `wi-${seq}.sqlite`), clock);
  const registry = new WorkTypeRegistry();
  let effects: EffectRuntime | undefined;
  const reducer = new ReducerRuntime({
    store,
    registry,
    clock,
    cfg: loadWorkitemsConfig({ WORKITEMS_MAX_OPEN: '8', WORKITEMS_MAX_WORKERS_PER_ITEM: '2' }),
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
  registerRequirement(registry);
  // Generic auto-completing run handler: write a report and return (the report门 passes).
  effects.registerHandler({
    kind: 'run',
    recovery: 'resume-or-redispatch',
    canResume: () => false,
    run: async (ctx: EffectContext) => {
      const aid = ctx.assignment?.id ?? 'x';
      ctx.heartbeat();
      ctx.writeArtifact(`assignments/${aid}/report.md`, `ok ${aid}`, 'report');
    },
  });
  // 集成验证 effect: with no frozen contract in this skeleton run it emits passed (no_contract).
  effects.registerHandler(createIntegrationCheckHandler());
  const api = new WorkitemsApi({
    store,
    registry,
    reducer,
    artifacts,
    afterCreate: (item) => effects?.poke(item.id),
  });
  live.push({ store, effects });
  return { store, api };
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

describe('requirement skeleton end-to-end', () => {
  it('walks 理解→合同→详设→拆解→并行实现→集成验证→交付→done through the 4 lights', async () => {
    const { store, api } = harness();
    const item = api.createWorkItem({
      type: 'requirement',
      title: '双端需求',
      source: {},
      repos: ['repo-a'],
    }).item;

    const checkpointsSeen: string[] = [];
    // Resolve each checkpoint as it appears until we rest in 交付.
    for (let i = 0; i < 8; i++) {
      await waitFor(() => {
        const cur = store.getWorkItem(item.id)!;
        const wait = store.listOpenWaits(item.id).find((w) => w.reason.startsWith('checkpoint:'));
        expect(cur.phase === PHASE.deliver || wait !== undefined).toBe(true);
      });
      if (store.getWorkItem(item.id)!.phase === PHASE.deliver) break;
      const wait = store.listOpenWaits(item.id).find((w) => w.reason.startsWith('checkpoint:'))!;
      checkpointsSeen.push(wait.reason);
      api.resolveWait(wait.id, { operator: 'lichao', reason: 'ok', decision: { approved: true } });
    }

    // Exactly the four lights, in order.
    expect(checkpointsSeen).toEqual([
      `checkpoint:${PHASE.contract}`, // 灯①
      `checkpoint:${PHASE.design}`, // 灯②快
      `checkpoint:${PHASE.split}`, // 灯②慢
      `checkpoint:${PHASE.deliver}`, // 灯③
    ]);
    expect(store.getWorkItem(item.id)!.phase).toBe(PHASE.deliver);
    expect(store.getWorkItem(item.id)!.status).not.toBe('done'); // 灯④ rests, awaits close

    // a worker actually ran for the single repo (parented to the splitter owner).
    const workers = store.listAssignments(item.id).filter((a) => a.role === 'worker');
    expect(workers).toHaveLength(1);
    expect(workers[0]!.repo).toBe('repo-a');
    expect(workers[0]!.parentId).toBeTruthy();

    // 灯④: human submits → done.
    api.injectClose(item.id);
    await waitFor(() => expect(store.getWorkItem(item.id)!.status).toBe('done'));
  });

  it('a rejected 灯① keeps the item in 理解 and re-runs the owner', async () => {
    const { store, api } = harness();
    const item = api.createWorkItem({
      type: 'requirement',
      title: '驳回',
      source: {},
      repos: ['repo-a'],
    }).item;

    await waitFor(() =>
      expect(
        store.listOpenWaits(item.id).some((w) => w.reason === `checkpoint:${PHASE.contract}`),
      ).toBe(true),
    );
    const wait = store.listOpenWaits(item.id)[0]!;
    api.resolveWait(wait.id, { operator: 'lichao', reason: 'redo', decision: { approved: false } });

    // stays in 理解; a fresh owner run was dispatched, and a new 灯① wait re-appears.
    await waitFor(() => {
      expect(store.getWorkItem(item.id)!.phase).toBe(PHASE.understand);
      const open = store.listOpenWaits(item.id).filter((w) => w.reason.startsWith('checkpoint:'));
      expect(open.length).toBe(1);
    });
  });
});
