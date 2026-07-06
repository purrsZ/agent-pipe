import { describe, expect, it } from 'vitest';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import type { WorkItemEvent } from '../../src/workitems/types.js';
import { registerRequirement, requirementWorkType } from '../../src/worktypes/requirement/index.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';
import { makeWorkItem } from '../helpers/workitems.js';

function ev(kind: string, payload: unknown = {}): WorkItemEvent {
  return { id: 1, workitemId: 'wi-1', seq: 1, kind, payload, createdAt: 1000 };
}

const t = requirementWorkType;

// PIVOT《设计外置·实现聚焦》：设计（理解/合同/详设 + 灯①②）已摘出 agent-pipe；新主线五相位「两灯一 gate」：
//   立项 →[立项 gate]→ 拆解(owner 跨仓对账) → 并行实现 → 集成验证 →[灯③]→ 交付 →[灯④ close]
describe('requirement WorkType definition', () => {
  it('is an owner-workers write type starting at 立项, with 立项 gate + 灯③ boundaries', () => {
    expect(t.id).toBe('requirement');
    expect(t.topology(makeWorkItem('wi-1'))).toBe('owner-workers');
    expect(t.permissions).toEqual({ mode: 'write' });
    expect(t.initialPhase(makeWorkItem('wi-1'))).toBe(PHASE.intake);
    expect(t.checkpoints.requiredBefore).toEqual([
      PHASE.split, // 立项 gate（立项→拆解）
      PHASE.deliver, // 灯③（集成验证→交付）
    ]);
    expect(t.artifacts.reportRequired).toBe(true);
  });

  it('registers into a registry', () => {
    const reg = new WorkTypeRegistry();
    registerRequirement(reg);
    expect(reg.get('requirement')).toBe(t);
  });
});

describe('requirement lifecycle transitions', () => {
  it('creation enters 立项 (intake) without dispatching — 收料先于开干', () => {
    const out = t.onEvent(makeWorkItem('wi-1'), ev('workitem_created'));
    expect(out.phase).toEqual({ to: PHASE.intake, reason: 'created' });
    expect(out.dispatch).toBeUndefined();
  });

  it('立项 gate: intake_field_set raises the gate only once all required fields are folded in', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.intake });
    // partial history (one field) → not ready, stay put, no gate.
    const partial = t.onEvent(
      item,
      ev('intake_field_set', { priorIntakeEvents: [{ key: 'name', value: 'n' }] }),
    );
    expect(partial).toEqual({});
    // all 5 required fields folded → raise the 立项 gate (拆解 boundary), NOT a phase change.
    const ready = t.onEvent(
      item,
      ev('intake_field_set', {
        priorIntakeEvents: [
          { key: 'name', value: 'n' },
          { key: 'summary', value: 's' },
          { key: 'repos', value: ['repo-a'] },
          { key: 'prd', value: 'p' },
          { key: 'acceptance', value: 'a' },
        ],
      }),
    );
    expect(ready.phase).toBeUndefined();
    expect(ready.waits?.[0]).toMatchObject({
      kind: 'human',
      reason: `checkpoint:${PHASE.split}`,
    });
  });

  it('立项 gate 幂等：已 raise（open wait 在）后补料不重复 raise（避免孤儿 wait / 重复推卡）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.intake });
    const required = [
      { key: 'name', value: 'n' },
      { key: 'summary', value: 's' },
      { key: 'repos', value: ['repo-a'] },
      { key: 'prd', value: 'p' },
      { key: 'acceptance', value: 'a' },
    ];
    const out = t.onEvent(
      item,
      ev('intake_field_set', {
        priorIntakeEvents: [...required, { key: 'scope', value: '边界' }],
        openWaitReasons: [`checkpoint:${PHASE.split}`],
      }),
    );
    expect(out).toEqual({});
  });

  it('立项 gate approved advances 立项 → 拆解 + 发 intake_finalize effect（owner run 不在此派，改由 repos_set 触发）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.intake });
    const out = t.onEvent(item, ev('wait_resolved', { decision: { approved: true } }));
    expect(out.phase).toEqual({ to: PHASE.split, reason: 'checkpoint_approved' });
    // 不在此 dispatch owner——否则与 repos 提升抢跑，run 会用空 repos 落到 defaultCwd 跑错仓（真机暴露）。
    expect(out.dispatch ?? []).toHaveLength(0);
    expect(out.effects?.[0]).toMatchObject({ kind: 'intake_finalize' });
  });

  it('repos_set 多仓（≥2）在拆解阶段 → dispatch 首个 owner 对账 run（满配）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.split });
    const out = t.onEvent(item, ev('repos_set', { repos: ['/abs/a', '/abs/b'] }));
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'reconcile' } });
  });

  it('WS-6 repos_set 单仓 → lite：直跳并行实现 + 派 1 个 worker（跳过 owner 对账）', () => {
    // 注意：applyReposSet 只写 DB、不改内存 item，onReposSet 里 item.repos 仍是旧值 → 以事件 payload 判 lite。
    const item = makeWorkItem('wi-1', { phase: PHASE.split });
    const out = t.onEvent(item, ev('repos_set', { repos: ['/abs/only'] }));
    expect(out.phase).toEqual({ to: PHASE.implement, reason: 'lite_single_repo' });
    expect(out.dispatch).toHaveLength(1);
    expect(out.dispatch?.[0]).toMatchObject({ role: 'worker', repo: '/abs/only' });
  });

  it('repos_set 在非拆解阶段不触发 run（防御，避免重复派）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    const out = t.onEvent(item, ev('repos_set', { repos: ['/abs/a'] }));
    expect(out.dispatch ?? []).toHaveLength(0);
  });

  it('立项 gate「驳回」(防御，无真驳回语义) 重弹立项 gate 而非卡死无 wait', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.intake });
    const out = t.onEvent(item, ev('wait_resolved', { decision: { approved: false } }));
    expect(out.phase).toBeUndefined();
    expect(out.waits?.[0]).toMatchObject({
      kind: 'human',
      reason: `checkpoint:${PHASE.split}`,
    });
  });

  it('intake_field_set outside the 立项 phase is inert', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.split });
    expect(t.onEvent(item, ev('intake_field_set', { priorIntakeEvents: [] }))).toEqual({});
  });

  it('拆解：owner 对账 run 收尾 → 起 reconcile_check effect（不直接推进）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.split });
    const out = t.onEvent(item, ev('run_completed', { role: 'owner' }));
    expect(out.phase).toBeUndefined();
    expect(out.effects?.[0]).toMatchObject({ kind: 'reconcile_check' });
  });

  it('reconcile_passed（全咬合）→ 拆解→并行实现，按仓分发一仓一 worker', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.split, repos: ['repo-a', 'repo-b'] });
    const out = t.onEvent(item, ev('reconcile_passed', { interfaces: 2 }));
    expect(out.phase).toEqual({ to: PHASE.implement, reason: 'reconcile_passed' });
    expect(out.dispatch).toHaveLength(2);
    for (const d of out.dispatch ?? []) expect(d).toMatchObject({ role: 'worker' });
    expect(out.dispatch?.map((d) => d.repo).sort()).toEqual(['repo-a', 'repo-b']);
  });

  it('reconcile_conflict（冲突/悬空）→ raise 人（病历），停在拆解，不推进', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.split });
    const out = t.onEvent(
      item,
      ev('reconcile_conflict', {
        unresolved: [{ kind: 'dangling', interfaceId: 'x', detail: 'd' }],
      }),
    );
    expect(out.phase).toBeUndefined();
    expect(out.waits?.[0]).toMatchObject({ kind: 'human', reason: 'reconcile_conflict' });
    // ENHANCE E1：raise 病历的同批派参谋 only-read run（stage=advise）。
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'advise' } });
  });

  it('reconcile_conflict 幂等：病历已 open（openWaitReasons 含它）→ 不重复 raise（也不派参谋）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.split });
    const out = t.onEvent(
      item,
      ev('reconcile_conflict', { unresolved: [], openWaitReasons: ['reconcile_conflict'] }),
    );
    expect(out).toEqual({});
  });

  it('人 resolve 对账病历（拆解阶段, approved）→ 重派 owner 重对账（多轮收敛）；declined → 留在拆解', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.split });
    // 容器在 wait_resolved 上注入被解析 wait 的 reason，worktype 据此精确路由。
    const out = t.onEvent(
      item,
      ev('wait_resolved', {
        decision: { approved: true },
        resolvedWaitReason: 'reconcile_conflict',
      }),
    );
    expect(out.phase).toBeUndefined();
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'reconcile' } });
    // declined → 重弹同名病历（防死状态：病历必须一直 open 到 approve 或整单 /cancel），不是裸 {}。
    const declined = t.onEvent(
      item,
      ev('wait_resolved', {
        decision: { approved: false },
        resolvedWaitReason: 'reconcile_conflict',
      }),
    );
    expect(declined.waits?.[0]).toMatchObject({ kind: 'human', reason: 'reconcile_conflict' });
  });

  it('run_failed 重试再败（retries=1）→ raise 人病历（不静默卡死）；幂等', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.split, repos: ['repo-a', 'repo-b'] });
    const out = t.onEvent(item, ev('run_failed', { role: 'owner', assignmentRetries: 1 }));
    expect(out.waits?.[0]).toMatchObject({ kind: 'human', reason: 'run_failed' });
    // 病历已 open（容器注入 openWaitReasons）→ 不重复 raise 孤儿病历。
    expect(
      t.onEvent(item, ev('run_failed', { assignmentRetries: 1, openWaitReasons: ['run_failed'] })),
    ).toEqual({});
  });

  it('resolve run_failed 病历（approved）→ 重试当前阶段入口工作', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['repo-a'] });
    const out = t.onEvent(
      item,
      ev('wait_resolved', { decision: { approved: true }, resolvedWaitReason: 'run_failed' }),
    );
    expect(out.dispatch?.[0]).toMatchObject({ role: 'worker' });
  });

  it('cancel_confirm 病历 resolve（approved，生产决策不带 action）→ 按 wait reason 路由到终止需求', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    const out = t.onEvent(
      item,
      ev('wait_resolved', {
        decision: { approved: true, payload: { reason: 'ok' } },
        resolvedWaitReason: 'cancel_confirm',
      }),
    );
    expect(out).toEqual({ terminal: 'cancelled' });
  });

  it('非 checkpoint 阶段 resolve 一个普通决策（无 reason、无 action）不会误推进阶段', () => {
    // implement 阶段 nextPhase=integrate 非 checkpoint 边界 → 不推进，杜绝「取消被误执行成推进集成」。
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    expect(
      t.onEvent(
        item,
        ev('wait_resolved', { decision: { approved: true, payload: { reason: 'x' } } }),
      ),
    ).toEqual({});
  });

  it('WS-2 群内消息：拆解阶段 owner 空闲 → 派 steer 消费（消息必达，不再只记录）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.split });
    const out = t.onEvent(item, ev('human_message', { text: 'B 仓接口改名了', runningOwners: 0 }));
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'steer' } });
  });

  it('WS-2 群内消息：实现/集成/交付阶段 owner 空闲 → 派 steer 消费', () => {
    for (const phase of [PHASE.implement, PHASE.integrate, PHASE.deliver]) {
      const item = makeWorkItem('wi-1', { phase });
      const out = t.onEvent(item, ev('human_message', { text: '随手一句', runningOwners: 0 }));
      expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'steer' } });
    }
  });

  it('INTAKE L1 /scout：立项相位 owner 空闲 → 派勘探 run（hints 去前缀）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.intake });
    const out = t.onEvent(
      item,
      ev('human_message', { text: '/scout alaeatposapp posapp', runningOwners: 0 }),
    );
    expect(out.dispatch?.[0]).toMatchObject({
      role: 'owner',
      payload: { stage: 'scout', hints: 'alaeatposapp posapp' },
    });
  });

  it('INTAKE L1 /scout：owner 忙 → {}（不排队，桥层回执已发用户可重发）；非立项相位 → {}', () => {
    const busy = makeWorkItem('wi-1', { phase: PHASE.intake });
    expect(t.onEvent(busy, ev('human_message', { text: '/scout x', runningOwners: 1 }))).toEqual(
      {},
    );
    const nonIntake = makeWorkItem('wi-1', { phase: PHASE.implement });
    expect(
      t.onEvent(nonIntake, ev('human_message', { text: '/scout x', runningOwners: 0 })),
    ).toEqual({});
  });

  it('INTAKE L1 勘探收尾 → scout_apply effect（带 reportPath）；未消费消息补派 steer', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.intake });
    const out = t.onEvent(
      item,
      ev('run_completed', {
        role: 'owner',
        stage: 'scout',
        reportPath: 'assignments/s/report.md',
        unconsumedHumanMessages: 1,
      }),
    );
    expect(out.effects?.[0]).toMatchObject({
      kind: 'scout_apply',
      payload: { reportPath: 'assignments/s/report.md' },
    });
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'steer' } });
  });

  it('INTAKE L1 勘探失败 → {}（不弹病历、不自动重试，收料继续走人工）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.intake });
    expect(
      t.onEvent(item, ev('run_failed', { role: 'owner', stage: 'scout', assignmentRetries: 0 })),
    ).toEqual({});
  });

  it('last worker (runningWorkers===0) → 监工 gate（gatekeeper_review）；放行后 owner assess，owner done→集成验证', () => {
    // 多仓（满配）路径：单仓 lite 走另一条（gatekeeper_passed 直接进集成，见 WS-6 describe）。
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['repo-a', 'repo-b'] });
    const onWorker = t.onEvent(item, ev('run_completed', { role: 'worker', runningWorkers: 0 }));
    expect(onWorker.phase).toBeUndefined();
    // 不直接 assess——先过监工 gate。
    expect(onWorker.effects?.[0]).toMatchObject({ kind: 'gatekeeper_review' });

    // 监工放行 → owner assess。
    const onPassed = t.onEvent(item, ev('gatekeeper_passed', { approved: 0 }));
    expect(onPassed.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'assess' } });

    const onOwner = t.onEvent(item, ev('run_completed', { role: 'owner' }));
    expect(onOwner.phase).toEqual({ to: PHASE.integrate, reason: 'workers_done' });
  });

  it('监工判大（gatekeeper_big：跨仓外溢/疑则）→ raise 人病历，停在实现；幂等', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    const out = t.onEvent(
      item,
      ev('gatekeeper_big', { raises: [{ interfaceId: 'x', question: 'q' }] }),
    );
    expect(out.waits?.[0]).toMatchObject({ kind: 'human', reason: 'gatekeeper_big' });
    // ENHANCE E1：判大 raise 同批派参谋 only-read run（stage=advise）。
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'advise' } });
    // 幂等路径（病历已 open）：raise 前 return {} → 不派参谋。
    expect(t.onEvent(item, ev('gatekeeper_big', { openWaitReasons: ['gatekeeper_big'] }))).toEqual(
      {},
    );
  });

  it('人 resolve 监工病历：approved → owner assess；declined → 重弹病历（防死状态）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    const approved = t.onEvent(
      item,
      ev('wait_resolved', { decision: { approved: true }, resolvedWaitReason: 'gatekeeper_big' }),
    );
    expect(approved.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'assess' } });
    const declined = t.onEvent(
      item,
      ev('wait_resolved', { decision: { approved: false }, resolvedWaitReason: 'gatekeeper_big' }),
    );
    expect(declined.waits?.[0]).toMatchObject({ kind: 'human', reason: 'gatekeeper_big' });
  });

  it('T4: a non-last worker (runningWorkers>0) rests — no 监工 gate until the batch is in', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['repo-a', 'repo-b'] });
    const early = t.onEvent(item, ev('run_completed', { role: 'worker', runningWorkers: 1 }));
    expect(early).toEqual({});
    const last = t.onEvent(item, ev('run_completed', { role: 'worker', runningWorkers: 0 }));
    expect(last.effects?.[0]).toMatchObject({ kind: 'gatekeeper_review' });
  });

  it('T4: a worker conclusion with no runningWorkers field is treated as the last (back-compat)', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['repo-a'] });
    const out = t.onEvent(item, ev('run_completed', { role: 'worker' }));
    expect(out.effects?.[0]).toMatchObject({ kind: 'gatekeeper_review' });
  });

  it('T4: in 集成验证 a fix worker re-checks integration only once the whole fix batch is in', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate });
    expect(t.onEvent(item, ev('run_completed', { role: 'worker', runningWorkers: 1 }))).toEqual({});
    expect(
      t.onEvent(item, ev('run_completed', { role: 'worker', runningWorkers: 0 })).effects?.[0],
    ).toMatchObject({ kind: 'integration_check' });
  });

  it('灯③ — integration_check_passed in 集成验证 raises the delivery checkpoint', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate });
    const out = t.onEvent(item, ev('integration_check_passed'));
    expect(out.phase).toBeUndefined();
    expect(out.waits?.[0]).toMatchObject({ reason: `checkpoint:${PHASE.deliver}` });
  });

  it('灯③ approved advances 集成验证 → 交付 and rests (no auto MR work)', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate });
    const out = t.onEvent(item, ev('wait_resolved', { decision: { approved: true } }));
    expect(out.phase).toEqual({ to: PHASE.deliver, reason: 'checkpoint_approved' });
    expect(out.dispatch).toBeUndefined();
  });

  it('灯③ rejected stays in 集成验证 and 派 steer 读打回意见决定返工（WS-5，不再空转 integration_check）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate });
    const out = t.onEvent(item, ev('wait_resolved', { decision: { approved: false } }));
    expect(out.phase).toBeUndefined();
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'steer' } });
    expect(out.effects ?? []).toHaveLength(0);
  });

  it('灯④ — close in 交付 terminates done; elsewhere close is inert', () => {
    expect(
      t.onEvent(makeWorkItem('wi-1', { phase: PHASE.deliver }), ev('close_requested')),
    ).toEqual({ terminal: 'done' });
    expect(t.onEvent(makeWorkItem('wi-1', { phase: PHASE.split }), ev('close_requested'))).toEqual(
      {},
    );
  });

  it('/cancel raises a confirm wait; a cancel decision then terminates cancelled', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    const confirm = t.onEvent(item, ev('human_message', { text: '/cancel' }));
    expect(confirm.waits?.[0]).toMatchObject({ reason: 'cancel_confirm' });

    const cancelled = t.onEvent(
      item,
      ev('wait_resolved', { decision: { approved: true, payload: { action: 'cancel' } } }),
    );
    expect(cancelled).toEqual({ terminal: 'cancelled' });
  });

  it('a plain wait_resolved (no decision) does not advance phase (救场 resolve)', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate });
    expect(t.onEvent(item, ev('wait_resolved', { reason: 'rescued' }))).toEqual({});
  });

  it('isDecisionStale is never-stale without a contract change (PIVOT 砍合同变更引擎)', () => {
    expect(t.isDecisionStale({ data: {} }, [])).toBe(false);
  });

  // WS-0.4: owner run 结论优先按 stage 路由（stage 随 run 结论透传），不再靠 phase 猜「owner run 是什么」。
  it('WS-0 stage=reconcile 的 owner run 收尾 → reconcile_check（不限相位，implement 也生效）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    const out = t.onEvent(item, ev('run_completed', { role: 'owner', stage: 'reconcile' }));
    expect(out.effects?.[0]).toMatchObject({ kind: 'reconcile_check' });
  });

  it('WS-0 stage=assess 的 owner run 收尾（implement 相位）→ 推进集成验证', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    const out = t.onEvent(item, ev('run_completed', { role: 'owner', stage: 'assess' }));
    expect(out.phase).toEqual({ to: PHASE.integrate, reason: 'workers_done' });
  });

  it('WS-0 stage=steer 的 owner run 收尾 → steer_apply effect（带 reportPath）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    const out = t.onEvent(
      item,
      ev('run_completed', { role: 'owner', stage: 'steer', reportPath: 'assignments/x/report.md' }),
    );
    expect(out.effects?.[0]).toMatchObject({
      kind: 'steer_apply',
      payload: { reportPath: 'assignments/x/report.md' },
    });
  });

  it('WS-0 stage 缺失 → 回落 phase 路由（拆解 owner → reconcile_check，与旧行为逐字节一致）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.split });
    const out = t.onEvent(item, ev('run_completed', { role: 'owner' }));
    expect(out.effects?.[0]).toMatchObject({ kind: 'reconcile_check' });
  });

  // WS-1.1: 活性不变式豁免声明——立项/交付合法休息，其它相位必须有在途工作。
  it('WS-1 liveness：intake/deliver = may-rest；拆解/实现/集成 = must-progress', () => {
    expect(t.liveness?.(makeWorkItem('wi-1', { phase: PHASE.intake }))).toBe('may-rest');
    expect(t.liveness?.(makeWorkItem('wi-1', { phase: PHASE.deliver }))).toBe('may-rest');
    for (const phase of [PHASE.split, PHASE.implement, PHASE.integrate]) {
      expect(t.liveness?.(makeWorkItem('wi-1', { phase }))).toBe('must-progress');
    }
  });

  // WS-1.3: 容器发的 liveness_stalled → raise stalled_no_path 病历；已 open 则幂等。
  it('WS-1 liveness_stalled → 病历 stalled_no_path（幂等）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    const out = t.onEvent(item, ev('liveness_stalled', {}));
    expect(out.waits?.[0]).toMatchObject({ kind: 'human', reason: 'stalled_no_path' });
    expect(
      t.onEvent(item, ev('liveness_stalled', { openWaitReasons: ['stalled_no_path'] })),
    ).toEqual({});
  });

  it('WS-1 resolve stalled_no_path 病历：approved → 重试当前阶段；declined → 重弹', () => {
    // 多仓（拆解阶段自愈回 owner 对账）；单仓 lite 自愈派 worker，见 WS-6 describe。
    const item = makeWorkItem('wi-1', { phase: PHASE.split, repos: ['repo-a', 'repo-b'] });
    const approved = t.onEvent(
      item,
      ev('wait_resolved', { decision: { approved: true }, resolvedWaitReason: 'stalled_no_path' }),
    );
    expect(approved.dispatch?.[0]).toMatchObject({
      role: 'owner',
      payload: { stage: 'reconcile' },
    });
    const declined = t.onEvent(
      item,
      ev('wait_resolved', { decision: { approved: false }, resolvedWaitReason: 'stalled_no_path' }),
    );
    expect(declined.waits?.[0]).toMatchObject({ kind: 'human', reason: 'stalled_no_path' });
  });

  // WS-1.5: 补全 retry_exhausted / thrash 显式分支；兜底收紧防「未知 reason 被误当 checkpoint 拍板」(#13)。
  it('WS-1 resolve retry_exhausted（approved）→ 重试当前阶段，在 integrate 不误推进 deliver（修 #13）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate });
    const out = t.onEvent(
      item,
      ev('wait_resolved', { decision: { approved: true }, resolvedWaitReason: 'retry_exhausted' }),
    );
    expect(out.phase).toBeUndefined();
    expect(out.effects?.[0]).toMatchObject({ kind: 'integration_check' });
  });

  it('WS-1 resolve retry_exhausted（declined）→ 重弹；thrash approved → {}，declined → 重弹', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate });
    expect(
      t.onEvent(
        item,
        ev('wait_resolved', {
          decision: { approved: false },
          resolvedWaitReason: 'retry_exhausted',
        }),
      ).waits?.[0],
    ).toMatchObject({ reason: 'retry_exhausted' });
    const impl = makeWorkItem('wi-1', { phase: PHASE.implement });
    expect(
      t.onEvent(
        impl,
        ev('wait_resolved', { decision: { approved: true }, resolvedWaitReason: 'thrash' }),
      ),
    ).toEqual({});
    expect(
      t.onEvent(
        impl,
        ev('wait_resolved', { decision: { approved: false }, resolvedWaitReason: 'thrash' }),
      ).waits?.[0],
    ).toMatchObject({ reason: 'thrash' });
  });

  it('WS-1 兜底收紧：非 checkpoint 未知 reason resolve 不误推进（integrate + 未知 reason → {}）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate });
    const out = t.onEvent(
      item,
      ev('wait_resolved', {
        decision: { approved: true },
        resolvedWaitReason: 'some_container_reason',
      }),
    );
    expect(out).toEqual({});
  });

  // WS-2 消息必达：派发规则 + steer_directive 消费。
  it('WS-2 实现相位 human_message 且 owner 空闲 → 派 steer；owner 忙 → {}', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    const idle = t.onEvent(item, ev('human_message', { text: '改字段', runningOwners: 0 }));
    expect(idle.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'steer' } });
    expect(t.onEvent(item, ev('human_message', { text: 'x', runningOwners: 1 }))).toEqual({});
  });

  it('WS-2 立项相位 human_message → 不派 steer（走 bridge 收料）；/cancel 仍触发确认', () => {
    const intake = makeWorkItem('wi-1', { phase: PHASE.intake });
    expect(t.onEvent(intake, ev('human_message', { text: 'x', runningOwners: 0 }))).toEqual({});
    const impl = makeWorkItem('wi-1', { phase: PHASE.implement });
    expect(t.onEvent(impl, ev('human_message', { text: '/cancel' })).waits?.[0]).toMatchObject({
      reason: 'cancel_confirm',
    });
  });

  it('WS-2 owner assess 收尾且 unconsumed>0 → 追加 steer dispatch；steer 自己收尾不追加', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    const assess = t.onEvent(
      item,
      ev('run_completed', { role: 'owner', stage: 'assess', unconsumedHumanMessages: 2 }),
    );
    expect(assess.phase).toEqual({ to: PHASE.integrate, reason: 'workers_done' });
    expect(assess.dispatch?.some((d) => (d.payload as { stage?: string })?.stage === 'steer')).toBe(
      true,
    );
    const steer = t.onEvent(
      item,
      ev('run_completed', {
        role: 'owner',
        stage: 'steer',
        reportPath: 'r',
        unconsumedHumanMessages: 3,
      }),
    );
    expect(steer.effects?.[0]).toMatchObject({ kind: 'steer_apply' });
    expect(steer.dispatch ?? []).toHaveLength(0);
  });

  it('ENHANCE E1 参谋（advise）收尾零流转 → {}；unconsumed>0 追加 steer（消息必达，不因参谋占窗口而漏）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    // 无未消费消息 → 纯 {}（建议只进人眼，不进状态机）。
    expect(t.onEvent(item, ev('run_completed', { role: 'owner', stage: 'advise' }))).toEqual({});
    // 参谋跑动期间攒下未消费群消息 → 收尾追加 steer 补派消费。
    const noisy = t.onEvent(
      item,
      ev('run_completed', { role: 'owner', stage: 'advise', unconsumedHumanMessages: 2 }),
    );
    expect(noisy.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'steer' } });
  });

  it('ENHANCE E1 参谋（advise）run_failed → {}（不弹病历、不自动重试；事故 wait 本就 open 着）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    expect(t.onEvent(item, ev('run_failed', { role: 'owner', stage: 'advise' }))).toEqual({});
  });

  it('ENHANCE E5 实证质检（inspect）收尾零流转 → {}；unconsumed>0 追加 steer（消息必达）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate });
    // 无未消费消息 → 纯 {}（实证报告只进人眼，不进状态机）。
    expect(t.onEvent(item, ev('run_completed', { role: 'owner', stage: 'inspect' }))).toEqual({});
    // 质检跑动期间攒下未消费群消息 → 收尾追加 steer 补派消费。
    const noisy = t.onEvent(
      item,
      ev('run_completed', { role: 'owner', stage: 'inspect', unconsumedHumanMessages: 2 }),
    );
    expect(noisy.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'steer' } });
  });

  it('ENHANCE E5 实证质检（inspect）run_failed → {}（不弹病历；灯③ 有机器 note + 交付清单兜底）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate });
    expect(t.onEvent(item, ev('run_failed', { role: 'owner', stage: 'inspect' }))).toEqual({});
  });

  it('WS-2 steer_directive redo_reconcile（implement + owner 空闲）→ 派 owner reconcile', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    const out = t.onEvent(
      item,
      ev('steer_directive', { action: 'redo_reconcile', runningOwners: 0 }),
    );
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'reconcile' } });
  });

  it('WS-2 steer_directive rework → 只对无 running worker 的仓派 rework worker（带 note）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['/a', '/b'] });
    const out = t.onEvent(
      item,
      ev('steer_directive', {
        action: 'rework',
        repos: ['/a', '/b'],
        note: '改样式',
        runningWorkerRepos: ['/b'],
      }),
    );
    expect(out.dispatch).toHaveLength(1);
    expect(out.dispatch?.[0]).toMatchObject({
      role: 'worker',
      repo: '/a',
      payload: { stage: 'rework', note: '改样式' },
    });
  });

  it('WS-2 steer_directive raise_human → steer_escalated 病历（幂等）；none → {}', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    expect(
      t.onEvent(item, ev('steer_directive', { action: 'raise_human', note: '裁决' })).waits?.[0],
    ).toMatchObject({ reason: 'steer_escalated' });
    expect(
      t.onEvent(
        item,
        ev('steer_directive', { action: 'raise_human', openWaitReasons: ['steer_escalated'] }),
      ),
    ).toEqual({});
    expect(t.onEvent(item, ev('steer_directive', { action: 'none' }))).toEqual({});
  });

  it('WS-2 resolve steer_escalated（approved → {}；declined → 重弹）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    expect(
      t.onEvent(
        item,
        ev('wait_resolved', {
          decision: { approved: true },
          resolvedWaitReason: 'steer_escalated',
        }),
      ),
    ).toEqual({});
    expect(
      t.onEvent(
        item,
        ev('wait_resolved', {
          decision: { approved: false },
          resolvedWaitReason: 'steer_escalated',
        }),
      ).waits?.[0],
    ).toMatchObject({ reason: 'steer_escalated' });
  });

  it('WS-2 steer run 失败 → 不弹病历（消息仍在窗口内，下个 owner run 会带上）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    expect(t.onEvent(item, ev('run_failed', { role: 'owner', stage: 'steer' }))).toEqual({});
  });
});

describe('requirement WS-5 打回带意见 + 监工判大返工通道', () => {
  it('灯③ declined → 派 steer 读打回意见决定返工（不再空转 integration_check）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate, repos: ['repo-a'] });
    const out = t.onEvent(
      item,
      ev('wait_resolved', {
        decision: { approved: false },
        resolvedWaitReason: `checkpoint:${PHASE.deliver}`,
      }),
    );
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'steer' } });
    expect(out.effects ?? []).toHaveLength(0);
  });

  it('监工判大 resolve(approved, action=rework) → 派 owner reconcile（重对账）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['repo-a', 'repo-b'] });
    const out = t.onEvent(
      item,
      ev('wait_resolved', {
        decision: { approved: true, payload: { action: 'rework' } },
        resolvedWaitReason: 'gatekeeper_big',
      }),
    );
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'reconcile' } });
  });

  it('监工判大 resolve(approved, proceed/无 action) → 派 owner assess（现状放行）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['repo-a'] });
    const out = t.onEvent(
      item,
      ev('wait_resolved', {
        decision: { approved: true, payload: { action: 'proceed' } },
        resolvedWaitReason: 'gatekeeper_big',
      }),
    );
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'assess' } });
  });

  it('reconcile_passed(implement) → gatekeeper_rework effect（不推进阶段）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['repo-a'] });
    const out = t.onEvent(item, ev('reconcile_passed', {}));
    expect(out.effects?.[0]).toMatchObject({ kind: 'gatekeeper_rework' });
    expect(out.phase).toBeUndefined();
  });

  it('rework_requested(implement) → 只对无 running worker 的仓派 rework worker', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['repo-a', 'repo-b'] });
    const out = t.onEvent(
      item,
      ev('rework_requested', {
        repos: ['repo-a', 'repo-b'],
        note: '按新图纸返工',
        runningWorkerRepos: ['repo-b'], // b 有 running worker → 跳过（幂等/防重派）
      }),
    );
    expect(out.dispatch).toHaveLength(1);
    expect(out.dispatch?.[0]).toMatchObject({
      role: 'worker',
      repo: 'repo-a',
      payload: { stage: 'rework', note: '按新图纸返工' },
    });
  });

  it('rework_requested 非 implement 相位 → 无动作', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate, repos: ['repo-a'] });
    expect(t.onEvent(item, ev('rework_requested', { repos: ['repo-a'] }))).toEqual({});
  });

  it('reconcile_conflict(implement)：人改图纸仍冲突 → 病历再弹（放宽相位守卫）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    const out = t.onEvent(item, ev('reconcile_conflict', { unresolved: [{}] }));
    expect(out.waits?.[0]).toMatchObject({ kind: 'human', reason: 'reconcile_conflict' });
  });

  it('resolve reconcile_conflict(approved) in implement → 重派 owner reconcile', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    const out = t.onEvent(
      item,
      ev('wait_resolved', {
        decision: { approved: true },
        resolvedWaitReason: 'reconcile_conflict',
      }),
    );
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'reconcile' } });
  });
});

describe('requirement WS-6 复杂度自适应 lite 主线', () => {
  it('gatekeeper_passed 单仓 lite → 跳过 assess 直接进集成验证', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['/abs/only'] });
    const out = t.onEvent(item, ev('gatekeeper_passed', { approved: 0 }));
    expect(out.phase).toEqual({ to: PHASE.integrate, reason: 'lite_skip_assess' });
    expect(out.effects?.[0]).toMatchObject({ kind: 'integration_check' });
  });

  it('gatekeeper_passed 多仓 → 派 owner assess（现状）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['/abs/a', '/abs/b'] });
    const out = t.onEvent(item, ev('gatekeeper_passed', { approved: 0 }));
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'assess' } });
    expect(out.phase).toBeUndefined();
  });

  it('retryCurrentPhase：lite 单在拆解阶段自愈 → 派 worker（不派回 owner 对账）', () => {
    // 防 stalled 自愈把 lite 单派回 owner 对账。用 stalled_no_path resolve 触发 retryCurrentPhase。
    const item = makeWorkItem('wi-1', { phase: PHASE.split, repos: ['/abs/only'] });
    const out = t.onEvent(
      item,
      ev('wait_resolved', {
        decision: { approved: true },
        resolvedWaitReason: 'stalled_no_path',
      }),
    );
    expect(out.dispatch?.[0]).toMatchObject({ role: 'worker', repo: '/abs/only' });
  });

  it('retryCurrentPhase：多仓在拆解阶段自愈 → 派 owner 对账（现状）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.split, repos: ['/abs/a', '/abs/b'] });
    const out = t.onEvent(
      item,
      ev('wait_resolved', {
        decision: { approved: true },
        resolvedWaitReason: 'stalled_no_path',
      }),
    );
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'reconcile' } });
  });
});

describe('requirement WS-7 交付清单 + 灯④ 关单', () => {
  it('integration_check_passed（灯③ 首次 raise）→ 同批追加 deliver_manifest effect + inspect 质检 dispatch', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate, repos: ['repo-a'] });
    const out = t.onEvent(item, ev('integration_check_passed', { reason: 'no_contract' }));
    expect(out.waits?.[0]).toMatchObject({ reason: `checkpoint:${PHASE.deliver}` });
    expect((out.effects ?? []).some((e) => e.kind === 'deliver_manifest')).toBe(true);
    // ENHANCE E5：灯③ 首次 raise 同批派实证质检 owner run（stage=inspect），与 deliver_manifest 共享幂等守卫。
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner', payload: { stage: 'inspect' } });
  });

  it('integration_check_passed（灯③ 已 open，幂等重跑）→ 不重复生成 deliver_manifest / inspect', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate, repos: ['repo-a'] });
    const out = t.onEvent(
      item,
      ev('integration_check_passed', {
        reason: 'no_contract',
        openWaitReasons: [`checkpoint:${PHASE.deliver}`],
      }),
    );
    expect(out.waits ?? []).toHaveLength(0);
    expect(out.effects ?? []).toHaveLength(0);
    // ENHANCE E5：rerun 不重派 inspect（与 deliver_manifest 同守卫）。
    expect(out.dispatch ?? []).toHaveLength(0);
  });

  it('灯③ approved → 进交付 + 挂 awaiting_close wait（灯④）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate });
    const out = t.onEvent(
      item,
      ev('wait_resolved', {
        decision: { approved: true },
        resolvedWaitReason: `checkpoint:${PHASE.deliver}`,
      }),
    );
    expect(out.phase).toEqual({ to: PHASE.deliver, reason: 'checkpoint_approved' });
    expect(out.waits?.[0]).toMatchObject({ kind: 'human', reason: 'awaiting_close' });
  });

  it('resolve awaiting_close(approved) in 交付 → terminal done；declined → 重弹', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.deliver });
    expect(
      t.onEvent(
        item,
        ev('wait_resolved', {
          decision: { approved: true },
          resolvedWaitReason: 'awaiting_close',
        }),
      ),
    ).toEqual({ terminal: 'done' });
    const declined = t.onEvent(
      item,
      ev('wait_resolved', { decision: { approved: false }, resolvedWaitReason: 'awaiting_close' }),
    );
    expect(declined.waits?.[0]).toMatchObject({ kind: 'human', reason: 'awaiting_close' });
  });
});

describe('requirement WS-8 run_failed 先自动重试一次', () => {
  it('worker 首败（retries=0）→ 自动重试同仓（不弹病历）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['repo-a'] });
    const out = t.onEvent(
      item,
      ev('run_failed', {
        role: 'worker',
        repo: 'repo-a',
        stage: 'implement',
        assignmentRetries: 0,
      }),
    );
    expect(out.waits ?? []).toHaveLength(0);
    expect(out.dispatch?.[0]).toMatchObject({
      role: 'worker',
      repo: 'repo-a',
      retries: 1,
      payload: { stage: 'implement' },
    });
  });

  it('worker 重试再败（retries=1）→ 弹病历', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['repo-a'] });
    const out = t.onEvent(
      item,
      ev('run_failed', { role: 'worker', repo: 'repo-a', assignmentRetries: 1 }),
    );
    expect(out.waits?.[0]).toMatchObject({ reason: 'run_failed' });
    expect(out.dispatch ?? []).toHaveLength(0);
  });

  it('错误含 write-guard fail-closed → 直接病历（护栏失效不重试，D-L）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['repo-a'] });
    const out = t.onEvent(
      item,
      ev('run_failed', {
        role: 'worker',
        repo: 'repo-a',
        assignmentRetries: 0,
        error: 'write-guard fail-closed: probe rejected a write',
      }),
    );
    expect(out.waits?.[0]).toMatchObject({ reason: 'run_failed' });
    expect(out.dispatch ?? []).toHaveLength(0);
  });

  it('owner 首败 → 自动重试（ownerSpec + retries=1，按 stage）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.split, repos: ['repo-a', 'repo-b'] });
    const out = t.onEvent(
      item,
      ev('run_failed', { role: 'owner', stage: 'reconcile', assignmentRetries: 0 }),
    );
    expect(out.dispatch?.[0]).toMatchObject({
      role: 'owner',
      retries: 1,
      payload: { stage: 'reconcile' },
    });
  });

  it('steer 失败 → 无动作（不重试不病历，WS-2.2c）', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    expect(
      t.onEvent(item, ev('run_failed', { role: 'owner', stage: 'steer', assignmentRetries: 0 })),
    ).toEqual({});
  });
});
