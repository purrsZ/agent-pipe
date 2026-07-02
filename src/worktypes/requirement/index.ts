import type {
  AssignmentSpec,
  Transition,
  WorkItem,
  WorkItemEvent,
  WorkType,
} from '../../workitems/types.js';
import {
  checkpointDecisionOf,
  checkpointReason,
  crossesCheckpoint,
  raiseCheckpoint,
  ttlsOf,
} from './checkpoint.js';
import { isRequirementDecisionStale } from './contract.js';
import { fixRoundExceeded } from './integration.js';
import { foldIntake, INTAKE_FIELD_SET, isGateReady } from './intake.js';
import { CHECKPOINT_REQUIRED_BEFORE, nextPhase, PHASE } from './phases.js';

// requirement worktype — the 5-phase coordinator (PIVOT《设计外置·实现聚焦》). Pure sync reducer:
// this file declares all side effects as Transition (dispatch / waits / effects); the effect
// handlers (worker run, reconcile_check, integration_check, intake_finalize) do the IO. The
// container never interprets a requirement phase name (red-line).
//
// 设计已摘出 agent-pipe（人在 Claude Code 用 /spec-design 产各仓设计目录）。本机只「拿图纸施工 + 质检」。
// Lifecycle（两灯一 gate）：
//   立项 →[立项 gate]→ 拆解(owner 跨仓对账) → 并行实现 → 集成验证 →[灯③ 验收]→ 交付 →[灯④ close]
//
// 「拆解」phase 是新主线第一个 owner 动作：owner 读各仓设计的「外部方契约」节，拼凑 + 对账成跨仓契约
// （reconcile.ts）。全咬合 → 按仓分发施工；冲突/悬空 → raise 人（病历）。这份对账契约同时是灯③ 的对账基准。

const CHECKPOINT_WAIT_TTL_SEC = 86_400;

// WS-0.4 (D-C): dispatch payload.stage 词表——run 结论随 stage 中性透传（emitRunConclusion 平铺），
// worktype 按 (role, stage) 精确路由，不再靠 phase 猜「这个 owner run 是对账 / assess / steer」。
const STAGE = {
  reconcile: 'reconcile',
  assess: 'assess',
  steer: 'steer',
  implement: 'implement',
  fix: 'fix',
  rework: 'rework',
} as const;

export const requirementWorkType: WorkType = {
  id: 'requirement',
  triggers: { api: true },
  // 新单从「立项」起步（收料阶段），立项 gate 放行后才进「拆解」。
  initialPhase: () => PHASE.intake,
  onEvent: requirementTransition,
  isDecisionStale: isRequirementDecisionStale,
  // The parallel-dispatch master switch: returning non-'solo' makes the container's
  // single-flight gate route by role (owner single-flight / worker concurrency cap).
  topology: () => 'owner-workers',
  permissions: { mode: 'write' },
  // Single source of truth with crossesCheckpoint (phases.ts): 立项 gate + 灯③ 两道 checkpoint 边界.
  checkpoints: { requiredBefore: CHECKPOINT_REQUIRED_BEFORE },
  artifacts: { reportRequired: true },
  // WS-1.1 (D-D)：立项/交付合法休息（收料等人 / 交付等关单，有 open wait 时不变式本就满足），其它相位必须
  // 有在途工作，否则容器活性看门自曝 liveness_stalled（→ stalled_no_path 病历）。
  liveness: (item) =>
    item.phase === PHASE.intake || item.phase === PHASE.deliver ? 'may-rest' : 'must-progress',
};

export function registerRequirement(registry: { register(type: WorkType): void }): void {
  registry.register(requirementWorkType);
}

export function requirementTransition(item: WorkItem, ev: WorkItemEvent): Transition {
  switch (ev.kind) {
    case 'workitem_created':
      // 进「立项」收料，不 dispatch run——收料由 bridge/effect 驱动（intake_field_set）。立项 gate 通过后
      // 才进「拆解」并起 owner 对账 run（onWaitResolved → enterPhase(split) → intake_finalize → repos_set）。
      return { phase: { to: PHASE.intake, reason: 'created' } };
    case INTAKE_FIELD_SET:
      return onIntakeFieldSet(item, ev);
    case 'wait_resolved':
      return onWaitResolved(item, ev);
    case 'run_completed':
      return onRunCompleted(item, ev);
    case 'run_failed':
      // 容器对 run_failed 不自动重试（只对 stall/abort 重试），不处理就静默卡死全流程 → raise 人病历。
      return onRunFailed(item, ev);
    case 'repos_set':
      // 立项收尾把 repos 提升进 workitem 后才触发首个 owner 对账 run（确保 run 读到的 repos 已就位）。
      return onReposSet(item);
    case 'reconcile_passed':
      // owner 跨仓对账全咬合 → 拆解→并行实现（按仓分发）。
      return requestAdvance(
        item,
        PHASE.split,
        PHASE.implement,
        'reconcile_passed',
        openWaitReasonsOf(ev.payload),
      );
    case 'reconcile_conflict':
      return onReconcileConflict(item, ev);
    case 'gatekeeper_passed':
      // 监工放行（无跨仓外溢上报；判小的已回写图纸）→ 叫 owner 评估批次（assess）。
      return item.phase === PHASE.implement ? { dispatch: [ownerSpec(item, 'assess')] } : {};
    case 'gatekeeper_big':
      return onGatekeeperBig(item, ev);
    case 'integration_check_passed':
      return requestAdvance(
        item,
        PHASE.integrate,
        PHASE.deliver,
        'integration_passed',
        openWaitReasonsOf(ev.payload),
      );
    case 'integration_check_failed':
      return onIntegrationFailed(item, ev);
    case 'human_message':
      return onHumanMessage(item, ev);
    case 'liveness_stalled':
      // 容器活性看门（watchdog）发现 must-progress 单无任何在途工作 → 自曝；raise 病历让人重试当前阶段。
      return onLivenessStalled(item, ev);
    case 'close_requested':
      return onClose(item);
    default:
      return {};
  }
}

function onRunCompleted(item: WorkItem, ev: WorkItemEvent): Transition {
  const role = roleOf(ev.payload);
  const stage = stageOf(ev.payload);
  // owner run 结论优先按 stage 精确路由（D-C）：reconcile 不限相位（拆解 + WS-5 implement 内重对账都靠它）；
  // assess 在 implement 收尾推进集成验证；steer（WS-2）读报告落指令。stage 缺失（历史事件 / 纯单测手造）→
  // 回落下方旧 phase 路由，保证逐字节兼容。
  if (role === 'owner') {
    if (stage === STAGE.reconcile) return { effects: [{ kind: 'reconcile_check' }] };
    if (stage === STAGE.assess && item.phase === PHASE.implement) {
      return enterPhase(item, PHASE.integrate, 'workers_done', ev);
    }
    if (stage === STAGE.steer) {
      return {
        effects: [{ kind: 'steer_apply', payload: { reportPath: reportPathOf(ev.payload) } }],
      };
    }
  }
  switch (item.phase) {
    case PHASE.split:
      // owner 对账 run 收尾（afterRun 已落 contract/contract.json + contract/reconcile.json）→ 起静态
      // reconcile_check effect（与 integration_check 同构）：结构化安全网 ∪ owner 自报 → reconcile_passed/_conflict。
      return role === 'owner' ? { effects: [{ kind: 'reconcile_check' }] } : {};
    case PHASE.implement:
      // T4 owner-snapshot fan-in: only the LAST worker (no siblings still running — the container
      // injects `runningWorkers`) closes the batch. 它不直接叫 owner assess——先过**监工 gate**
      // （gatekeeper_review effect 扫各仓工人「疑则上报」：跨仓外溢→判大 raise 人 / 纯本仓→判小回写图纸），
      // 监工放行（gatekeeper_passed）后才 assess。earlier workers rest。
      if (role === 'worker') {
        return runningWorkersOf(ev.payload) === 0
          ? { effects: [{ kind: 'gatekeeper_review' }] }
          : {};
      }
      if (role === 'owner') return enterPhase(item, PHASE.integrate, 'workers_done', ev);
      return {};
    case PHASE.integrate:
      // A fix worker finished → re-run the static integration对账 (idempotent effect), but only
      // once the whole fix batch is in (runningWorkers===0) so a re-check never races a repo
      // still being fixed. The integration verdict drives the phase, not a run conclusion.
      return role === 'worker' && runningWorkersOf(ev.payload) === 0
        ? { effects: [{ kind: 'integration_check' }] }
        : {};
    default:
      return {};
  }
}

// owner 跨仓对账发现冲突/悬空 → raise 人（病历），停在拆解。人改对应单仓设计后 resolve 该 wait（onWaitResolved
// 的 split 分支）触发重对账。与「监工判大 / 集成未决」同构：不放行红线、挂起、攒进晨审（PIVOT §5）。
function onReconcileConflict(item: WorkItem, ev: WorkItemEvent): Transition {
  if (item.phase !== PHASE.split) return {};
  // 幂等：病历已 open 就别再 raise 一个孤儿 wait（reconcile_check 重跑、或并发触发）。
  if (openWaitReasonsOf(ev.payload).includes(RECONCILE_CONFLICT_REASON)) return {};
  return {
    waits: [
      { kind: 'human', reason: RECONCILE_CONFLICT_REASON, deadlineTtlSec: CHECKPOINT_WAIT_TTL_SEC },
    ],
  };
}

const RECONCILE_CONFLICT_REASON = 'reconcile_conflict';
const GATEKEEPER_BIG_REASON = 'gatekeeper_big';
const INTEGRATION_UNRESOLVED_REASON = 'integration_unresolved';
// WS-1.3：容器活性看门自曝的「非终态却无路可走」病历 reason。
const STALLED_NO_PATH_REASON = 'stalled_no_path';
// WS-1.5：容器（reducer）raise 的两类病历 reason——此前无显式 onWaitResolved 分支 + 无飞书卡（PIVOT 承认
// 只能从管控台 resolve），补上后与其它病历同权，且防「未知 reason resolve 被误当 checkpoint 拍板」(#13)。
const RETRY_EXHAUSTED_REASON = 'retry_exhausted';
const THRASH_REASON = 'thrash';

// 重弹一条同名 human 病历（declined 后防死状态：病历必须一直 open 到被 approve 或整单 /cancel）。
function reRaiseWait(reason: string): Transition {
  return { waits: [{ kind: 'human', reason, deadlineTtlSec: CHECKPOINT_WAIT_TTL_SEC }] };
}

// 监工判大（跨仓外溢/疑则）→ raise 人病历，停在并行实现、不进集成。人裁决（改图纸=人 / 返工=owner 派
// worker，本骨架简化为人拍板放行）后 resolve 病历 → 继续 assess（见 onWaitResolved）。idempotent。
function onGatekeeperBig(item: WorkItem, ev: WorkItemEvent): Transition {
  if (item.phase !== PHASE.implement) return {};
  if (openWaitReasonsOf(ev.payload).includes(GATEKEEPER_BIG_REASON)) return {};
  return {
    waits: [
      { kind: 'human', reason: GATEKEEPER_BIG_REASON, deadlineTtlSec: CHECKPOINT_WAIT_TTL_SEC },
    ],
  };
}

// 集成验证 fix loop (R13.AC-4/AC-6, D-11): the failure's round (counted by the integration_check
// handler, NOT assignment.retries) decides fix vs escalate.
function onIntegrationFailed(item: WorkItem, ev: WorkItemEvent): Transition {
  if (item.phase !== PHASE.integrate) return {};
  const round = numberField(ev.payload, 'round') ?? 1;
  if (fixRoundExceeded(round)) {
    // 连续集成失败 → 契约/拆解可能有问题，升级 human wait（病历）。幂等：已 open 不重复 raise（integration_check
    // 是 recovery:'rerun'，崩溃重跑会再 emit failed）。
    if (openWaitReasonsOf(ev.payload).includes(INTEGRATION_UNRESOLVED_REASON)) return {};
    return reRaiseWait(INTEGRATION_UNRESOLVED_REASON);
  }
  const repos = stringArrayField(ev.payload, 'affectedRepos');
  const targets = repos.length > 0 ? repos : item.repos.length > 0 ? item.repos : [''];
  return {
    dispatch: targets.map((repo) => ({
      role: 'worker' as const,
      repo: repo || undefined,
      deadlineTtlSec: ttlsOf(item).deadlineTtlSec,
      wallclockCapSec: ttlsOf(item).wallclockCapSec,
      payload: { stage: 'fix', repo, round },
    })),
  };
}

// 立项收料：容器（reducer.enrichEventForType）在每条 intake_field_set 上注入该单截至此刻的填项历史
// （priorIntakeEvents，中性搬运）。worktype 用纯 fold 重建清单状态、判定 gate：
//   必填齐 → 复用 checkpoint 机制 raise 立项 gate（立项→拆解 边界）；未齐 → 留在立项继续收料（{}）。
function onIntakeFieldSet(item: WorkItem, ev: WorkItemEvent): Transition {
  if (item.phase !== PHASE.intake) return {};
  const state = foldIntake(priorIntakeEventsOf(ev.payload));
  if (!isGateReady(state)) return {};
  // 幂等：立项 gate 已 raise（容器 enrich 注入的 openWaitReasons 含它）就别因补料重复弹 gate。
  if (openWaitReasonsOf(ev.payload).includes(checkpointReason(PHASE.split))) return {};
  return requestAdvance(item, PHASE.intake, PHASE.split, 'intake_ready');
}

// 立项收尾把立项收齐的 repos 提升进 workitem.repos（repos_set，由 intake_finalize emit）后，才 dispatch
// 首个 owner 对账 run——保证 run 的 resolveCwd / readableDirs 读到的是用户的仓库，而非 run 与提升抢跑时
// 落到的 defaultCwd（bot 自己的 cwd，真机暴露）。仅拆解阶段触发；owner 单飞门挡掉任何重复。
function onReposSet(item: WorkItem): Transition {
  if (item.phase !== PHASE.split) return {};
  return { dispatch: [ownerSpec(item, 'reconcile')] };
}

// Phase-work done → either gate (raise the human wait, stay) or advance + run entry work.
// openReasons = 容器注入的当前 open wait reason 集；该 checkpoint 已 open → 复用、不重复 raise（幂等，
// 防 effect 崩溃恢复重跑[reconcile_check / integration_check 都是 recovery:'rerun']再 emit 判定事件时
// 又挂一个孤儿 checkpoint wait）。非 checkpoint 边界（如 reconcile_passed→implement）由 `item.phase !==
// expected` 幂等兜住（首次已推进，重跑时 phase 已不等于 expected）。
function requestAdvance(
  item: WorkItem,
  expected: string,
  to: string,
  reason: string,
  openReasons: string[] = [],
): Transition {
  if (item.phase !== expected) return {};
  if (crossesCheckpoint(to)) {
    if (openReasons.includes(checkpointReason(to))) return {};
    return raiseCheckpoint(to, CHECKPOINT_WAIT_TTL_SEC);
  }
  return enterPhase(item, to, reason, undefined);
}

const RUN_FAILED_REASON = 'run_failed';

// 任意 run 报错（owner 对账 / worker 施工 / assess / fix）→ raise 人病历，不静默卡死。容器只把 assignment
// 标 failed、不重试不升级；尤其末位 worker 以 run_failed 收尾时 fan-in（依赖 run_completed）不唤醒 owner、
// 批次会永久挂起——病历让人看见并裁决（resolve 病历=重试当前阶段，见 onWaitResolved）。idempotent。
function onRunFailed(_item: WorkItem, ev: WorkItemEvent): Transition {
  if (openWaitReasonsOf(ev.payload).includes(RUN_FAILED_REASON)) return {};
  return {
    waits: [{ kind: 'human', reason: RUN_FAILED_REASON, deadlineTtlSec: CHECKPOINT_WAIT_TTL_SEC }],
  };
}

// WS-1.3：容器活性看门（watchdog）发现 must-progress 单无任何在途工作（running assignment / pending·running
// effect / open wait 皆空）→ liveness_stalled。raise 病历让人看见并重试当前阶段入口工作。幂等：病历已 open
// 不重复 raise（watchdog 每 tick 都可能再发，靠容器注入的 openWaitReasons 幂等）。
function onLivenessStalled(_item: WorkItem, ev: WorkItemEvent): Transition {
  if (openWaitReasonsOf(ev.payload).includes(STALLED_NO_PATH_REASON)) return {};
  return reRaiseWait(STALLED_NO_PATH_REASON);
}

// 按**被解析 wait 的原始 reason**（容器注入 resolvedWaitReason）精确路由，而非靠 phase 猜或依赖 resolve
// 决策里恰好带 action 字段——杜绝「在 implement 阶段 resolve 一个取消/run失败病历被误判成阶段拍板、错推到
// 集成验证」这类反向破坏。reason 缺省（纯单测手造事件无容器注入）时回落到「按 checkpoint 边界推进」。
function onWaitResolved(item: WorkItem, ev: WorkItemEvent): Transition {
  const decision = checkpointDecisionOf(ev);
  if (!decision) return {}; // a救场/other resolve carries no decision — nothing to advance.
  const reason = resolvedWaitReasonOf(ev.payload);

  // 取消确认病历：按 wait reason 路由（不依赖 payload.action——生产 resolve 决策统一为 {approved,reason}）。
  if (reason === 'cancel_confirm' || isCancelDecision(decision)) {
    return decision.approved ? { terminal: 'cancelled' } : {};
  }
  // 病历类 wait（对账/监工/run失败/集成未决）：resolve 时容器已关掉这条 wait（它是该阶段唯一的 open
  // wait、且工人都已 done），所以 declined 必须**重弹同名病历**——否则 item 停在原阶段、无 open wait、
  // 无 run、无任何再触发 = 死状态。approved → 走各自的前进动作；declined（或错误 phase）→ reRaise 病历，
  // 留给人再裁决（要彻底放弃走 /cancel）。
  if (reason === RECONCILE_CONFLICT_REASON) {
    return decision.approved && item.phase === PHASE.split
      ? { dispatch: [ownerSpec(item, 'reconcile')] }
      : reRaiseWait(RECONCILE_CONFLICT_REASON);
  }
  if (reason === GATEKEEPER_BIG_REASON) {
    return decision.approved && item.phase === PHASE.implement
      ? { dispatch: [ownerSpec(item, 'assess')] }
      : reRaiseWait(GATEKEEPER_BIG_REASON);
  }
  if (reason === RUN_FAILED_REASON) {
    return decision.approved ? retryCurrentPhase(item) : reRaiseWait(RUN_FAILED_REASON);
  }
  if (reason === INTEGRATION_UNRESOLVED_REASON) {
    return decision.approved && item.phase === PHASE.integrate
      ? { effects: [{ kind: 'integration_check' }] }
      : reRaiseWait(INTEGRATION_UNRESOLVED_REASON);
  }
  // WS-1.3/1.5：活性自曝病历 + 两类容器病历的显式分支（approved → 重试当前阶段入口 / declined → 重弹）。
  if (reason === STALLED_NO_PATH_REASON) {
    return decision.approved ? retryCurrentPhase(item) : reRaiseWait(STALLED_NO_PATH_REASON);
  }
  if (reason === RETRY_EXHAUSTED_REASON) {
    return decision.approved ? retryCurrentPhase(item) : reRaiseWait(RETRY_EXHAUSTED_REASON);
  }
  if (reason === THRASH_REASON) {
    // thrash 时容器已清 discardStreak；人确认即可（approved → {}），或重弹留观（declined）。
    return decision.approved ? {} : reRaiseWait(THRASH_REASON);
  }

  // checkpoint 拍板（立项 gate / 灯③）：兜底收紧（修 #13）——只有真正的 checkpoint wait（reason 以
  // 'checkpoint:' 开头）或纯单测手造事件（reason undefined、无容器注入）才按 checkpoint 边界推进，杜绝把
  // 别的容器病历 resolve 误判成阶段拍板（如 integrate resolve 一条 retry_exhausted → 误推到交付）。
  if (reason !== undefined && !reason.startsWith('checkpoint:')) return {};
  const to = nextPhase(item.phase);
  if (!to || !crossesCheckpoint(to)) return {};
  if (decision.approved) return enterPhase(item, to, 'checkpoint_approved', ev);
  // Rejected → stay in the current phase and redo its work (立项 gate 重弹 / 灯③ 回集成验证重核).
  return redoPhase(item);
}

// run 失败病历被 approve（人已处理环境/问题）→ 重试当前阶段的入口工作。
function retryCurrentPhase(item: WorkItem): Transition {
  if (item.phase === PHASE.split) return { dispatch: [ownerSpec(item, 'reconcile')] };
  if (item.phase === PHASE.implement) return { dispatch: workerDispatches(item, undefined) };
  if (item.phase === PHASE.integrate) return { effects: [{ kind: 'integration_check' }] };
  return {};
}

// Entry side effects per phase. Gated boundaries (拆解/交付) arrive here only after approval;
// non-gated (并行实现/集成验证) arrive straight from a verdict event.
function enterPhase(
  item: WorkItem,
  to: string,
  reason: string,
  triggerEv: WorkItemEvent | undefined,
): Transition {
  const base: Transition = { phase: { to, reason } };
  switch (to) {
    case PHASE.split:
      // 立项 gate 通过 → 进拆解：先只起 intake_finalize effect（落立项书 intake/intake.md + 把立项收齐的
      // 仓库提升为 workitem.repos，emit repos_set）。**不在此 dispatch owner run**——否则 run 与 repos 提升
      // 抢跑，run 先读到空 repos → 跑错仓（真机暴露）。owner 对账 run 改由 repos_set（提升完成）触发，见 onReposSet。
      return { ...base, effects: [{ kind: 'intake_finalize' }] };
    case PHASE.implement:
      // owner 对账全咬合 → 按仓分发（一仓一 worker，各领 contract 切片）。reconcile_passed 触发，无 owner
      // 父 assignment（owner 对账 run 此刻已 done，cascade-abort 无意义），parentAssignmentId 留空。
      return { ...base, dispatch: workerDispatches(item, ownerAssignmentIdOf(triggerEv)) };
    case PHASE.integrate:
      // 静态集成对账 effect（质检员，基准 = owner 对账出的跨仓契约）— emits integration_check_passed/failed.
      return { ...base, effects: [{ kind: 'integration_check' }] };
    case PHASE.deliver:
      // 灯④: rest in non-terminal — no auto MR/上线. close_requested drives terminal (D-14).
      return base;
    default:
      return base;
  }
}

function redoPhase(item: WorkItem): Transition {
  // Re-run the current phase's work after a rejection.
  // 立项 gate 没有「审设计」式的真驳回（立项卡只有「立项完成」按钮）。防御性处理 approved=false
  // （只可能来自工作台/API）：料已齐，重弹立项 gate，杜绝「gate 被 resolve 后停在立项却无 open wait」死状态。
  if (item.phase === PHASE.intake) return raiseCheckpoint(PHASE.split, CHECKPOINT_WAIT_TTL_SEC);
  // 灯③ 打回 → 回集成验证重核。
  if (item.phase === PHASE.integrate) return { effects: [{ kind: 'integration_check' }] };
  return {};
}

function onHumanMessage(_item: WorkItem, ev: WorkItemEvent): Transition {
  const text = humanText(ev.payload).trim();
  if (text === '/cancel') {
    // 防误触: confirm before tearing down. The confirm card resolves with a cancel decision.
    return {
      waits: [{ kind: 'human', reason: 'cancel_confirm', deadlineTtlSec: CHECKPOINT_WAIT_TTL_SEC }],
    };
  }
  // 设计外置后已无「群内反馈改设计」的协调阶段（理解/合同/详设 已砍）。拆解阶段的重对账走病历 resolve、
  // 实现/集成阶段的反馈各由 worker / 集成 effect 回路负责，故其它群内消息只记录、不在此重跑 owner。
  return {};
}

function onClose(item: WorkItem): Transition {
  // 灯④ proceed: only the delivery phase honours close → done. Elsewhere a stray close is inert.
  return item.phase === PHASE.deliver ? { terminal: 'done' } : {};
}

// ── helpers (pure) ────────────────────────────────────────────────────────────────────

function ownerSpec(item: WorkItem, stage: string): AssignmentSpec {
  const t = ttlsOf(item);
  return {
    role: 'owner',
    deadlineTtlSec: t.deadlineTtlSec,
    wallclockCapSec: t.wallclockCapSec,
    payload: { stage },
  };
}

function workerDispatches(
  item: WorkItem,
  parentAssignmentId: string | undefined,
): AssignmentSpec[] {
  const t = ttlsOf(item);
  const repos = item.repos.length > 0 ? item.repos : [''];
  return repos.map((repo) => ({
    role: 'worker' as const,
    repo: repo || undefined,
    deadlineTtlSec: t.deadlineTtlSec,
    wallclockCapSec: t.wallclockCapSec,
    parentAssignmentId,
    payload: { stage: 'implement', repo },
  }));
}

function priorIntakeEventsOf(payload: unknown): unknown[] {
  const v = asObject(payload).priorIntakeEvents;
  return Array.isArray(v) ? v : [];
}

function openWaitReasonsOf(payload: unknown): string[] {
  const v = asObject(payload).openWaitReasons;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// 容器在 wait_resolved 上注入的「被解析 wait 的原始 reason」。纯单测手造事件无此注入 → undefined。
function resolvedWaitReasonOf(payload: unknown): string | undefined {
  const v = asObject(payload).resolvedWaitReason;
  return typeof v === 'string' ? v : undefined;
}

function roleOf(payload: unknown): string | undefined {
  const o = asObject(payload);
  return typeof o.role === 'string' ? o.role : undefined;
}

// In-flight sibling-worker count the container injects onto an owner-workers run conclusion
// (reducer.enrichEventForType, T4). Absent ⇒ 0: a hand-built event in a pure unit test, or a
// single-worker batch, both mean "no siblings left" → treat this conclusion as the last.
function runningWorkersOf(payload: unknown): number {
  const v = asObject(payload).runningWorkers;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

// WS-0.4: run 结论透传的 stage（emitRunConclusion 平铺）。缺失（历史事件 / 单测手造）→ undefined。
function stageOf(payload: unknown): string | undefined {
  const v = asObject(payload).stage;
  return typeof v === 'string' ? v : undefined;
}

// WS-0.4: run_completed 结论携带的报告 artifact 路径（steer_apply 据它读 steer 报告）。
function reportPathOf(payload: unknown): string | undefined {
  const v = asObject(payload).reportPath;
  return typeof v === 'string' ? v : undefined;
}

function ownerAssignmentIdOf(ev: WorkItemEvent | undefined): string | undefined {
  if (!ev) return undefined;
  const o = asObject(ev.payload);
  return typeof o.assignmentId === 'string' ? o.assignmentId : undefined;
}

function isCancelDecision(decision: { approved: boolean; payload?: unknown }): boolean {
  const p = asObject(decision.payload);
  return p.action === 'cancel';
}

function humanText(payload: unknown): string {
  const o = asObject(payload);
  return typeof o.text === 'string' ? o.text : '';
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function numberField(payload: unknown, key: string): number | undefined {
  const v = asObject(payload)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function stringArrayField(payload: unknown, key: string): string[] {
  const v = asObject(payload)[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
