import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkitemsApi } from '../../src/workitems/api.js';
import { ArtifactStore } from '../../src/workitems/artifacts.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import { type EffectContext, EffectRuntime } from '../../src/workitems/effects.js';
import { ReducerRuntime } from '../../src/workitems/reducer.js';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { WorkitemsStore } from '../../src/workitems/store.js';
import { registerRequirement } from '../../src/worktypes/requirement/index.js';
import { createGatekeeperReviewHandler } from '../../src/worktypes/requirement/gatekeeper.js';
import { createIntakeFinalizeHandler } from '../../src/worktypes/requirement/intake-finalize.js';
import { createIntegrationCheckHandler } from '../../src/worktypes/requirement/integration.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';
import { createReconcileCheckHandler } from '../../src/worktypes/requirement/reconcile.js';

// PIVOT《设计外置·实现聚焦》：设计已摘出 agent-pipe。Drive the full 5-phase lifecycle through the real
// container (single-flight gate, checkpoint waits, owner 跨仓对账, worker fan-out) with a generic
// auto-completing run handler standing in for real agents:
//   立项 →[立项 gate]→ 拆解(owner 对账→reconcile_check) → 并行实现 → 集成验证 →[灯③]→ 交付 →[灯④ close]
// 一仓 ⇒ 一 worker；T4 adds the multi-worker owner fan-in ("advance only once all workers are in").

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

function harness(
  opts: {
    workerDelayMs?: Record<string, number>;
    reconcileJson?: string;
    failRepo?: string;
    raiseRepo?: string; // 该仓 worker 在报告里输出一个跨仓 ```gatekeeper 上报（→ 监工判大）
  } = {},
) {
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
  // Generic auto-completing run handler: write a report and return (the report门 passes). The
  // owner 拆解 对账 run writes no reconcile.json here → reconcile_check 走 no_reconcile 放行（无跨仓
  // 接口的需求），与真 afterRun 的「解析不到 → 空结果」一致。conflict / 全咬合 路径由 reconcile 单测覆盖。
  effects.registerHandler({
    kind: 'run',
    recovery: 'resume-or-redispatch',
    canResume: () => false,
    run: async (ctx: EffectContext) => {
      const aid = ctx.assignment?.id ?? 'x';
      const repo = ctx.assignment?.repo;
      const delay = repo ? (opts.workerDelayMs?.[repo] ?? 0) : 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      ctx.heartbeat();
      // 模拟一次 agent run 报错（worker 施工失败）→ effects 层 emit run_failed。
      if (repo && opts.failRepo && repo === opts.failRepo) {
        throw new Error(`worker run failed for ${repo}`);
      }
      // 模拟真 afterRun：拆解阶段 owner 对账 run 落 reconcile.json（让 reconcile_check 能对账/raise 病历）。
      if (
        ctx.assignment?.role === 'owner' &&
        ctx.workitem.phase === PHASE.split &&
        opts.reconcileJson
      ) {
        ctx.writeArtifact('contract/reconcile.json', opts.reconcileJson, 'reconcile');
      }
      // 模拟工人「疑则上报」：指定仓的 worker 报告末尾带一个跨仓 ```gatekeeper 块（interfaceId 非空 → 判大）。
      const raise =
        repo && opts.raiseRepo && repo === opts.raiseRepo
          ? `\n\`\`\`gatekeeper\n${JSON.stringify({ raises: [{ interfaceId: 'createOrder', question: '要给 createOrder 加字段', repo }] })}\n\`\`\`\n`
          : '';
      ctx.writeArtifact(`assignments/${aid}/report.md`, `ok ${aid}${raise}`, 'report');
    },
  });
  // 拆解阶段 owner 跨仓对账判定 effect。
  effects.registerHandler(createReconcileCheckHandler());
  // 并行实现阶段监工科层判定 effect（扫工人上报；stub 工人无 ```gatekeeper 块 → 放行）。
  effects.registerHandler(createGatekeeperReviewHandler());
  // 集成验证 effect: with no cross-repo contract in this skeleton run it emits passed (no_contract).
  effects.registerHandler(createIntegrationCheckHandler());
  // 立项收尾 effect: 立项 gate 通过 → 落立项书 + 提升 repos（emit repos_set）。
  effects.registerHandler(createIntakeFinalizeHandler());
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
  it('walks 立项→拆解→并行实现→集成验证→交付→done through 立项 gate + 灯③', async () => {
    const { store, api } = harness();
    const item = api.createWorkItem({
      type: 'requirement',
      title: '双端需求',
      source: {},
      repos: ['repo-a'],
    }).item;

    await walkThroughIntake(store, api, item.id); // 立项 gate（立项→拆解）通过 → 进拆解，自动对账推进

    // 拆解（对账放行）→ 并行实现 → 集成验证，最终 raise 灯③（集成验证→交付）。
    await waitFor(() =>
      expect(
        store.listOpenWaits(item.id).some((w) => w.reason === `checkpoint:${PHASE.deliver}`),
      ).toBe(true),
    );
    const deliverGate = store
      .listOpenWaits(item.id)
      .find((w) => w.reason === `checkpoint:${PHASE.deliver}`)!;
    api.resolveWait(deliverGate.id, {
      operator: 'lichao',
      reason: 'ok',
      decision: { approved: true },
    });

    await waitFor(() => expect(store.getWorkItem(item.id)!.phase).toBe(PHASE.deliver));
    expect(store.getWorkItem(item.id)!.status).not.toBe('done'); // 灯④ rests, awaits close

    // a worker actually ran for the single repo.
    const workers = store.listAssignments(item.id).filter((a) => a.role === 'worker');
    expect(workers).toHaveLength(1);
    expect(workers[0]!.repo).toBe('repo-a');

    // 灯④: human submits → done.
    api.injectClose(item.id);
    await waitFor(() => expect(store.getWorkItem(item.id)!.status).toBe('done'));
  });

  it('立项: a new requirement rests in 立项 (no run), gathers料, then the 立项 gate opens 拆解', async () => {
    const { store, api } = harness();
    const item = api.createWorkItem({
      type: 'requirement',
      title: '订单状态查询',
      source: {},
      repos: ['repo-a'],
    }).item;

    // 创建即停在立项，不 dispatch 任何 run（收料先于开干）。
    expect(store.getWorkItem(item.id)!.phase).toBe(PHASE.intake);
    expect(store.listAssignments(item.id)).toHaveLength(0);

    // 必填未齐：填了部分，不 raise 立项 gate、不开干。
    api.injectIntakeField(item.id, { key: 'name', value: '订单状态查询' });
    api.injectIntakeField(item.id, { key: 'summary', value: '运营按单号查状态' });
    expect(
      store.listOpenWaits(item.id).filter((w) => w.reason.startsWith('checkpoint:')),
    ).toHaveLength(0);
    expect(store.getWorkItem(item.id)!.phase).toBe(PHASE.intake);

    // 必填齐 → 立项 gate（立项→拆解）出现，仍不 dispatch（人审前不开干）。
    api.injectIntakeField(item.id, { key: 'repos', value: ['repo-a'] });
    api.injectIntakeField(item.id, { key: 'prd', value: 'PRD 全文' });
    api.injectIntakeField(item.id, { key: 'acceptance', value: '输入单号返回状态' });
    await waitFor(() =>
      expect(
        store.listOpenWaits(item.id).some((w) => w.reason === `checkpoint:${PHASE.split}`),
      ).toBe(true),
    );
    expect(store.listAssignments(item.id)).toHaveLength(0); // 仍未开干

    // 放行立项 gate → 进拆解，dispatch 首个 owner 对账 run（repos 提升完成后由 repos_set 触发）。
    const gate = store
      .listOpenWaits(item.id)
      .find((w) => w.reason === `checkpoint:${PHASE.split}`)!;
    api.resolveWait(gate.id, { operator: 'lichao', reason: 'go', decision: { approved: true } });
    await waitFor(() => {
      expect(store.getWorkItem(item.id)!.phase).toBe(PHASE.split);
      expect(store.listAssignments(item.id).some((a) => a.role === 'owner')).toBe(true);
    });
  });

  it('立项: 补料 after the gate opened does NOT raise a duplicate gate (容器注入 openWaitReasons → 幂等)', async () => {
    const { store, api } = harness();
    const item = api.createWorkItem({
      type: 'requirement',
      title: '幂等',
      source: {},
      repos: ['repo-a'],
    }).item;
    for (const f of [
      { key: 'name', value: 'n' },
      { key: 'summary', value: 's' },
      { key: 'repos', value: ['repo-a'] },
      { key: 'prd', value: 'p' },
      { key: 'acceptance', value: 'a' },
    ]) {
      api.injectIntakeField(item.id, f);
    }
    const intakeGates = () =>
      store.listOpenWaits(item.id).filter((w) => w.reason === `checkpoint:${PHASE.split}`);
    await waitFor(() => expect(intakeGates()).toHaveLength(1));

    // 补料 → 仍只有 1 个立项 gate wait（容器 enrich 注入 openWaitReasons，幂等）。
    api.injectIntakeField(item.id, { key: 'scope', value: '不做导出' });
    api.injectIntakeField(item.id, { key: 'acceptance', value: '更精确的验收' });
    expect(intakeGates()).toHaveLength(1);
  });

  it('立项: repos 收齐后提升进 workitem.repos（/req 不带 --repo 的头号坑）', async () => {
    const { store, api } = harness();
    const item = api.createWorkItem({
      type: 'requirement',
      title: 'repo 提升',
      source: {},
      repos: [], // M-I3 /req 去掉 --repo → 创建时仓库为空
    }).item;
    expect(store.getWorkItem(item.id)!.repos).toEqual([]);

    for (const f of [
      { key: 'name', value: 'n' },
      { key: 'summary', value: 's' },
      { key: 'repos', value: ['/abs/repo-x', '/abs/repo-y'] },
      { key: 'prd', value: 'p' },
      { key: 'acceptance', value: 'a' },
    ]) {
      api.injectIntakeField(item.id, f);
    }
    const gate = () =>
      store.listOpenWaits(item.id).find((w) => w.reason === `checkpoint:${PHASE.split}`);
    await waitFor(() => expect(gate()).toBeDefined());
    api.resolveWait(gate()!.id, { operator: 'lichao', reason: 'go', decision: { approved: true } });

    // 进拆解后，intake_finalize effect 把立项 repos 提升为 workitem.repos（emit repos_set → setRepos）。
    await waitFor(() => {
      expect(store.getWorkItem(item.id)!.phase).toBe(PHASE.split);
      expect(store.getWorkItem(item.id)!.repos).toEqual(['/abs/repo-x', '/abs/repo-y']);
    });
  });

  it('立项: 工作台「驳回」立项 gate 不卡死——重弹 gate，仍可立项完成进拆解', async () => {
    const { store, api } = harness();
    const item = api.createWorkItem({
      type: 'requirement',
      title: '驳回立项',
      source: {},
      repos: ['repo-a'],
    }).item;
    for (const f of [
      { key: 'name', value: 'n' },
      { key: 'summary', value: 's' },
      { key: 'repos', value: ['repo-a'] },
      { key: 'prd', value: 'p' },
      { key: 'acceptance', value: 'a' },
    ]) {
      api.injectIntakeField(item.id, f);
    }
    const openGate = () =>
      store.listOpenWaits(item.id).find((w) => w.reason === `checkpoint:${PHASE.split}`);
    await waitFor(() => expect(openGate()).toBeDefined());

    // 工作台驳回（approved=false）→ 不卡死：旧 wait resolved，立即重弹一个新立项 gate，item 留在立项。
    api.resolveWait(openGate()!.id, {
      operator: 'lichao',
      reason: 'hold',
      decision: { approved: false },
    });
    await waitFor(() => {
      expect(store.getWorkItem(item.id)!.phase).toBe(PHASE.intake);
      expect(openGate()).toBeDefined();
    });

    // 再点立项完成 → 进拆解（恢复路径完好）。
    api.resolveWait(openGate()!.id, {
      operator: 'lichao',
      reason: 'go',
      decision: { approved: true },
    });
    await waitFor(() => expect(store.getWorkItem(item.id)!.phase).toBe(PHASE.split));
  });

  it('灯③反馈回路：驳回 灯③ 留在集成验证并重核（integration_check 重跑），仍可再通过', async () => {
    const { store, api } = harness();
    const item = api.createWorkItem({
      type: 'requirement',
      title: '灯三驳回',
      source: {},
      repos: ['repo-a'],
    }).item;
    await walkThroughIntake(store, api, item.id);

    await waitFor(() =>
      expect(
        store.listOpenWaits(item.id).some((w) => w.reason === `checkpoint:${PHASE.deliver}`),
      ).toBe(true),
    );
    const wait = store
      .listOpenWaits(item.id)
      .find((w) => w.reason === `checkpoint:${PHASE.deliver}`)!;
    api.resolveWait(wait.id, { operator: 'lichao', reason: 'redo', decision: { approved: false } });

    // 留在集成验证；重核（integration_check 重跑，no_contract → passed）→ 灯③ 重新出现，仍可通过。
    await waitFor(() => {
      expect(store.getWorkItem(item.id)!.phase).toBe(PHASE.integrate);
      expect(
        store.listOpenWaits(item.id).some((w) => w.reason === `checkpoint:${PHASE.deliver}`),
      ).toBe(true);
    });
    const wait2 = store
      .listOpenWaits(item.id)
      .find((w) => w.reason === `checkpoint:${PHASE.deliver}`)!;
    api.resolveWait(wait2.id, { operator: 'lichao', reason: 'ok', decision: { approved: true } });
    await waitFor(() => expect(store.getWorkItem(item.id)!.phase).toBe(PHASE.deliver));
  });

  it('拆解：owner 对账发现悬空 → reconcile_conflict 病历 raised + 停在拆解；resolve 病历 → 重派对账', async () => {
    const reconcileJson = JSON.stringify({
      interfaces: [],
      unresolved: [
        {
          kind: 'dangling',
          interfaceId: 'getCoupon',
          detail: 'frontend 调用但无人提供',
          repos: ['frontend'],
        },
      ],
    });
    const { store, api } = harness({ reconcileJson });
    const item = api.createWorkItem({
      type: 'requirement',
      title: '对账冲突',
      source: {},
      repos: ['repo-a'],
    }).item;
    await walkThroughIntake(store, api, item.id);

    // owner 对账 run → reconcile_check → reconcile_conflict → 病历，停在拆解、不进并行实现。
    await waitFor(() =>
      expect(store.listOpenWaits(item.id).some((w) => w.reason === 'reconcile_conflict')).toBe(
        true,
      ),
    );
    expect(store.getWorkItem(item.id)!.phase).toBe(PHASE.split);
    const ownersBefore = store.listAssignments(item.id).filter((a) => a.role === 'owner').length;

    // resolve 病历（approved）→ 容器注入 resolvedWaitReason → worktype 重派 owner 重对账（多轮收敛）。
    const wait = store.listOpenWaits(item.id).find((w) => w.reason === 'reconcile_conflict')!;
    api.resolveWait(wait.id, { operator: 'lichao', reason: 'fixed', decision: { approved: true } });
    await waitFor(() =>
      expect(
        store.listAssignments(item.id).filter((a) => a.role === 'owner').length,
      ).toBeGreaterThan(ownersBefore),
    );
  });

  it('监工科层：worker 上报跨仓外溢 → gatekeeper_big 病历，停在实现；resolve → 继续进集成', async () => {
    const { store, api } = harness({ raiseRepo: 'repo-a' });
    const item = api.createWorkItem({
      type: 'requirement',
      title: '监工',
      source: {},
      repos: ['repo-a'],
    }).item;
    await walkThroughIntake(store, api, item.id);

    // 拆解放行 → 并行实现 → repo-a worker 上报跨仓 → gatekeeper_review 判大 → 病历，不进集成。
    await waitFor(() =>
      expect(store.listOpenWaits(item.id).some((w) => w.reason === 'gatekeeper_big')).toBe(true),
    );
    expect(store.getWorkItem(item.id)!.phase).toBe(PHASE.implement);
    // 监工回写图纸留痕（判大也记）。
    expect(api.listEvents(item.id).some((e) => e.kind === 'gatekeeper_big')).toBe(true);

    // 人裁决（已改图纸/返工）resolve 病历 → 继续 assess → 集成 → 灯③。
    const wait = store.listOpenWaits(item.id).find((w) => w.reason === 'gatekeeper_big')!;
    api.resolveWait(wait.id, { operator: 'lichao', reason: 'fixed', decision: { approved: true } });
    await waitFor(() =>
      expect(
        store.listOpenWaits(item.id).some((w) => w.reason === `checkpoint:${PHASE.deliver}`),
      ).toBe(true),
    );
  });

  it('run_failed：worker 施工报错 → raise run_failed 病历（不静默卡死）', async () => {
    const { store, api } = harness({ failRepo: 'repo-a' });
    const item = api.createWorkItem({
      type: 'requirement',
      title: '执行报错',
      source: {},
      repos: ['repo-a'],
    }).item;
    await walkThroughIntake(store, api, item.id);
    // 拆解(no_reconcile 放行)→ 并行实现 → repo-a worker 报错 → run_failed → 病历。
    await waitFor(() =>
      expect(store.listOpenWaits(item.id).some((w) => w.reason === 'run_failed')).toBe(true),
    );
  });

  // 立项：注入必填项 → 立项 gate（立项→拆解）出现 → 放行 → 进拆解（dispatch owner 对账 run）。
  // 立项收的 repos 在 gate 通过时（intake_finalize effect）提升为 workitem.repos，覆盖 createWorkItem
  // 的初值——所以这里注入的 repos 必须 = 该测试期望 worker fan-out 的仓库集。
  async function walkThroughIntake(
    store: WorkitemsStore,
    api: WorkitemsApi,
    itemId: string,
    repos: string[] = ['repo-a'],
  ): Promise<void> {
    for (const f of [
      { key: 'name', value: '需求' },
      { key: 'summary', value: '背景' },
      { key: 'prd', value: 'PRD' },
      { key: 'acceptance', value: '验收' },
      { key: 'repos', value: repos },
    ]) {
      api.injectIntakeField(itemId, f);
    }
    await waitFor(() =>
      expect(
        store.listOpenWaits(itemId).some((w) => w.reason === `checkpoint:${PHASE.split}`),
      ).toBe(true),
    );
    const gate = store.listOpenWaits(itemId).find((w) => w.reason === `checkpoint:${PHASE.split}`)!;
    api.resolveWait(gate.id, { operator: 'lichao', reason: 'go', decision: { approved: true } });
    await waitFor(() => expect(store.getWorkItem(itemId)!.phase).toBe(PHASE.split));
  }

  // 过完立项 gate 后，拆解(对账放行)→并行实现自动展开。Stops once a worker per repo is fanned out so a
  // test can observe the fan-in.
  async function walkToImplement(
    store: WorkitemsStore,
    api: WorkitemsApi,
    itemId: string,
    repos: string[] = ['repo-a'],
  ): Promise<void> {
    await walkThroughIntake(store, api, itemId, repos);
    await waitFor(() =>
      expect(store.listAssignments(itemId).some((a) => a.role === 'worker')).toBe(true),
    );
  }

  it('T4: 并行实现 does not advance until ALL workers are in — a slow second repo holds it', async () => {
    const { store, api } = harness({ workerDelayMs: { 'repo-b': 300 } });
    const item = api.createWorkItem({
      type: 'requirement',
      title: '双端需求',
      source: {},
      repos: ['repo-a', 'repo-b'],
    }).item;

    await walkToImplement(store, api, item.id, ['repo-a', 'repo-b']);

    // repo-a finishes fast while repo-b is still running.
    await waitFor(() => {
      const ws = store.listAssignments(item.id).filter((a) => a.role === 'worker');
      expect(ws.find((a) => a.repo === 'repo-a')?.status).toBe('done');
      expect(ws.find((a) => a.repo === 'repo-b')?.status).toBe('running');
    });
    // T4 fan-in: one finished repo must NOT advance the batch — still in 并行实现, no 灯③ yet.
    expect(store.getWorkItem(item.id)!.phase).toBe(PHASE.implement);
    expect(
      store.listOpenWaits(item.id).some((w) => w.reason === `checkpoint:${PHASE.deliver}`),
    ).toBe(false);

    // once repo-b is in too, the owner assesses the full batch → 集成验证 → 灯③ appears.
    await waitFor(() =>
      expect(
        store.listOpenWaits(item.id).some((w) => w.reason === `checkpoint:${PHASE.deliver}`),
      ).toBe(true),
    );
    const workers = store.listAssignments(item.id).filter((a) => a.role === 'worker');
    expect(workers).toHaveLength(2);
    expect(workers.map((w) => w.repo).sort()).toEqual(['repo-a', 'repo-b']);
  });

  it('T4: an over-cap repo (repos > maxWorkersPerItem) is surfaced with a warning (R01.AC-9 gap)', async () => {
    const { store, api } = harness(); // cap = 2
    const item = api.createWorkItem({
      type: 'requirement',
      title: '三端需求',
      source: {},
      repos: ['repo-a', 'repo-b', 'repo-c'],
    }).item;

    await walkToImplement(store, api, item.id, ['repo-a', 'repo-b', 'repo-c']);

    // entering 并行实现 fans out 3 workers; cap=2 parks the third and logs it loudly.
    await waitFor(() =>
      expect(logger.warn.mock.calls.some((c) => String(c[1] ?? '').includes('over cap'))).toBe(
        true,
      ),
    );
  });
});
