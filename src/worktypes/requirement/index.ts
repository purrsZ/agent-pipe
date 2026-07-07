import type {
  AssignmentSpec,
  Transition,
  WorkItem,
  WorkItemEvent,
  WorkType,
} from '../../workitems/types.js';
import {
  ADVISE_STAGE,
  GATEKEEPER_BIG_REASON,
  INTEGRATION_UNRESOLVED_REASON,
  RECONCILE_CONFLICT_REASON,
  renderGatekeeperIncident,
  renderIntegrationIncident,
  renderReconcileIncident,
} from './advisor.js';
import {
  checkpointDecisionOf,
  checkpointReason,
  crossesCheckpoint,
  raiseCheckpoint,
  ttlsOf,
} from './checkpoint.js';
import { isRequirementDecisionStale } from './contract.js';
import { AWAITING_CLOSE_REASON, delegationGuardFor } from './delegation.js';
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
  // ENHANCE E1：事故参谋 = 只读 owner run，读全部上下文出解读 + 建议，零行动权（收尾无流转）。
  // 常量取自 advisor.ts（E4 的 advisorRunInFlight 按同一值识别在途参谋 run，单一来源防漂移）。
  advise: ADVISE_STAGE,
  // ENHANCE E5：集成实证质检员 = 只读 owner run，进各仓 worktree 读真实改动、对照契约取证（收尾无流转）。
  inspect: 'inspect',
  // INTAKE L1：立项勘探员 = 只读 owner run（立项相位），在搜索根内找候选仓、验 git、拿证据（收料辅助，
  // 收尾走 scout_apply effect emit scout_result，桥层消费；run 本身零状态机流转）。
  scout: 'scout',
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
  // DELEGATE（审查修复）：watchdog 到点先问业务 guard——guard 不过就不 enqueue delegation_due，否则
  // 被拦事件每窗口重发一次、整夜空转刷锚点卡（lite 单灯③ 永不放行是常态）。与桥层消费方共用同一函数。
  delegationGuard: delegationGuardFor,
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
      // 容器对 run_failed 不自动重试（只对 stall/abort 重试）。WS-8：worktype 首败自动重试一次（瞬时错误自愈），
      // 再败 / write-guard fail-closed → raise 人病历（不静默卡死全流程）。
      return onRunFailed(item, ev);
    case 'repos_set':
      // 立项收尾把 repos 提升进 workitem 后才触发首个 owner 对账 run（确保 run 读到的 repos 已就位）。
      return onReposSet(item, ev);
    case 'reconcile_passed':
      // 拆解阶段：owner 跨仓对账全咬合 → 拆解→并行实现（按仓分发）。
      // WS-5 implement 阶段：监工判大后人改图纸的重对账通过 → gatekeeper_rework effect 提取受影响仓 → 定向返工。
      return item.phase === PHASE.implement
        ? { effects: [{ kind: 'gatekeeper_rework' }] }
        : requestAdvance(
            item,
            PHASE.split,
            PHASE.implement,
            'reconcile_passed',
            openWaitReasonsOf(ev.payload),
          );
    case 'reconcile_conflict':
      return onReconcileConflict(item, ev);
    case 'gatekeeper_passed':
      // 监工放行（无跨仓外溢上报；判小的已回写图纸）。多仓 → 叫 owner 评估批次（assess）；WS-6 单仓 lite →
      // 跳过 assess（单仓无跨仓契约、impl-claims 无对象）直接进集成验证。
      if (item.phase !== PHASE.implement) return {};
      return isLite(item)
        ? enterPhase(item, PHASE.integrate, 'lite_skip_assess', ev)
        : { dispatch: [ownerSpec(item, STAGE.assess)] };
    case 'gatekeeper_big':
      return onGatekeeperBig(item, ev);
    case 'integration_check_passed':
      return onIntegrationPassed(item, ev);
    case 'integration_check_failed':
      return onIntegrationFailed(item, ev);
    case 'human_message':
      return onHumanMessage(item, ev);
    case 'steer_directive':
      // WS-2：steer_apply effect 解析包工头报告后 emit 的结构化指令（redo_reconcile / rework / raise_human / none）。
      return onSteerDirective(item, ev);
    case 'rework_requested':
      // WS-5：gatekeeper_rework effect 提取受影响仓后 emit → 定向重派这些仓的 worker（同 WS-2.3 rework 幂等姿势）。
      return onReworkRequested(item, ev);
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
    // steer 自己收尾：读报告落指令，**不**追加新 steer（它刚消费完这批消息；期间又来的新消息由到达时
    // owner 空闲走 onHumanMessage）。
    if (stage === STAGE.steer) {
      return {
        effects: [{ kind: 'steer_apply', payload: { reportPath: reportPathOf(ev.payload) } }],
      };
    }
    // ENHANCE E1：参谋（advise）收尾零流转——建议只进人眼、不进状态机（D-1）。仍包 withPendingSteer：参谋
    // 跑动期间攒下的未消费群消息由补派 steer 消费（消息必达，不因参谋占 owner 窗口而漏）。
    if (stage === STAGE.advise) {
      return withPendingSteer(item, ev, {});
    }
    // ENHANCE E5：实证质检（inspect）收尾同参谋——零流转（实证报告已由流式卡贴群 + report.md 存档，只进人眼、
    // 不进状态机）。仍包 withPendingSteer：质检跑动期间攒下的未消费群消息由补派 steer 消费（消息必达）。
    if (stage === STAGE.inspect) {
      return withPendingSteer(item, ev, {});
    }
    // INTAKE L1：立项勘探（scout）收尾——读报告 → scout_apply effect emit scout_result（桥层消费入表 / 出
    // 歧义卡）。**不**包 withPendingSteer：勘探是立项相位专属，而立项相位没有 steer 消费方（steer 靠契约/
    // 各仓上下文，立项期都不存在）；勘探跑动期间若来了未消费 human_message（如再发一次 /scout、/cancel），
    // 补派 steer 会在无 repos/无契约的立项相位跑一个空转 owner run（真实缺陷，审查暴露）。这些消息各有其
    // 归宿：/scout 由用户重发触发新勘探、/cancel 已 raise cancel_confirm、普通收料走 bridge，不需 steer 兜。
    if (stage === STAGE.scout) {
      return {
        effects: [{ kind: 'scout_apply', payload: { reportPath: reportPathOf(ev.payload) } }],
      };
    }
    // 其余 owner run（reconcile / assess / stage 缺失回落）：算出 base 后包 withPendingSteer——若期间来了
    // 未被消费的群消息，收尾时追加一个 steer run 去消费（消息必达，WS-2.2b）。
    if (stage === STAGE.reconcile) {
      return withPendingSteer(item, ev, { effects: [{ kind: 'reconcile_check' }] });
    }
    if (stage === STAGE.assess && item.phase === PHASE.implement) {
      return withPendingSteer(item, ev, enterPhase(item, PHASE.integrate, 'workers_done', ev));
    }
    // stage 缺失 → 回落旧 phase 路由（拆解 owner → reconcile_check；实现 owner → integrate），逐字节兼容 +
    // 同样包补派。
    if (item.phase === PHASE.split) {
      return withPendingSteer(item, ev, { effects: [{ kind: 'reconcile_check' }] });
    }
    if (item.phase === PHASE.implement) {
      return withPendingSteer(item, ev, enterPhase(item, PHASE.integrate, 'workers_done', ev));
    }
    return {};
  }
  // worker fan-in（owner 槽独立，不涉及 steer 补派）。
  switch (item.phase) {
    case PHASE.implement:
      // T4 owner-snapshot fan-in: only the LAST worker (no siblings still running — the container
      // injects `runningWorkers`) closes the batch → 先过监工 gate（gatekeeper_review），放行后才 assess。
      return role === 'worker' && runningWorkersOf(ev.payload) === 0
        ? { effects: [{ kind: 'gatekeeper_review' }] }
        : {};
    case PHASE.integrate:
      // A fix worker finished → re-run the static integration对账 (idempotent effect), but only once
      // the whole fix batch is in (runningWorkers===0) so a re-check never races a repo still fixing.
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
  // WS-5：放宽到 implement——监工判大返工链里人改的图纸重对账仍冲突 → 再弹对账病历（不止拆解阶段）。
  if (item.phase !== PHASE.split && item.phase !== PHASE.implement) return {};
  // 幂等：病历已 open 就别再 raise 一个孤儿 wait（reconcile_check 重跑、或并发触发）。
  if (openWaitReasonsOf(ev.payload).includes(RECONCILE_CONFLICT_REASON)) return {};
  // ENHANCE E1：raise 病历的同批派一个参谋 only-read run（读事故上下文出建议贴回群）。openWaitReasons 幂等守卫
  // 已保证事故只 raise 一次 → 参谋只派一次（crash 重跑不重复）。
  return {
    waits: [
      { kind: 'human', reason: RECONCILE_CONFLICT_REASON, deadlineTtlSec: CHECKPOINT_WAIT_TTL_SEC },
    ],
    dispatch: [adviseSpec(item, renderReconcileIncident(ev.payload))],
  };
}

// 三类「派参谋」事故 reason（RECONCILE_CONFLICT_REASON / GATEKEEPER_BIG_REASON /
// INTEGRATION_UNRESOLVED_REASON）移到 advisor.ts 单一来源（E1 派参谋 + E4 事故卡提示共用），见顶部 import。
// WS-1.3：容器活性看门自曝的「非终态却无路可走」病历 reason。
const STALLED_NO_PATH_REASON = 'stalled_no_path';
// WS-1.5：容器（reducer）raise 的两类病历 reason——此前无显式 onWaitResolved 分支 + 无飞书卡（PIVOT 承认
// 只能从管控台 resolve），补上后与其它病历同权，且防「未知 reason resolve 被误当 checkpoint 拍板」(#13)。
const RETRY_EXHAUSTED_REASON = 'retry_exhausted';
const THRASH_REASON = 'thrash';
// WS-2.3：包工头（steer）拿不准 / 用户要求超出范围 → 上报人裁决的病历 reason。
const STEER_ESCALATED_REASON = 'steer_escalated';
// DELEGATE：白名单 + 机器信号 guard + 灯③ 对账解读单一来源迁至 ./delegation.ts（审查修复——白名单与
// guard 同址同源、fail-closed；AWAITING_CLOSE_REASON 一并迁出供两处共用）。此处 re-export 保持既有导入路径。
export {
  DELEGABLE_WAIT_REASONS,
  delegationGuardFor,
  integrationCheckOutcome,
} from './delegation.js';

// 重弹一条同名 human 病历（declined 后防死状态：病历必须一直 open 到被 approve 或整单 /cancel）。
function reRaiseWait(reason: string): Transition {
  return { waits: [{ kind: 'human', reason, deadlineTtlSec: CHECKPOINT_WAIT_TTL_SEC }] };
}

// 监工判大（跨仓外溢/疑则）→ raise 人病历，停在并行实现、不进集成。人裁决（改图纸=人 / 返工=owner 派
// worker，本骨架简化为人拍板放行）后 resolve 病历 → 继续 assess（见 onWaitResolved）。idempotent。
function onGatekeeperBig(item: WorkItem, ev: WorkItemEvent): Transition {
  if (item.phase !== PHASE.implement) return {};
  if (openWaitReasonsOf(ev.payload).includes(GATEKEEPER_BIG_REASON)) return {};
  // ENHANCE E1：判大 raise 病历的同批派参谋 run（幂等同上）。
  return {
    waits: [
      { kind: 'human', reason: GATEKEEPER_BIG_REASON, deadlineTtlSec: CHECKPOINT_WAIT_TTL_SEC },
    ],
    dispatch: [adviseSpec(item, renderGatekeeperIncident(ev.payload))],
  };
}

// 集成验证 fix loop (R13.AC-4/AC-6, D-11): the failure's round (counted by the integration_check
// handler, NOT assignment.retries) decides fix vs escalate.
// 集成验证通过 → 升灯③（集成→交付 checkpoint）。WS-7：灯③ 首次 raise 时同批生成交付清单（deliver_manifest
// effect），人拍板前就把每仓分支/diffstat/接手命令备好；已 open（幂等重跑 base={}）不重复生成。
function onIntegrationPassed(item: WorkItem, ev: WorkItemEvent): Transition {
  const base = requestAdvance(
    item,
    PHASE.integrate,
    PHASE.deliver,
    'integration_passed',
    openWaitReasonsOf(ev.payload),
  );
  if (!base.waits || base.waits.length === 0) return base;
  // ENHANCE E5：灯③ 首次 raise（base.waits 非空）时，除生成交付清单外再同批派一个集成实证质检员 owner run
  // （stage=inspect），与 deliver_manifest 共享同一幂等守卫——已 open（幂等重跑 base={}）二者都不追加，rerun
  // 不重派。时序同参谋（D-3）：灯③卡先到、实证报告随后贴出；人手快先拍板也不冲突（inspect 收尾零流转）。
  return {
    ...base,
    effects: [...(base.effects ?? []), { kind: 'deliver_manifest' }],
    dispatch: [...(base.dispatch ?? []), ownerSpec(item, STAGE.inspect)],
  };
}

function onIntegrationFailed(item: WorkItem, ev: WorkItemEvent): Transition {
  if (item.phase !== PHASE.integrate) return {};
  const round = numberField(ev.payload, 'round') ?? 1;
  if (fixRoundExceeded(round)) {
    // 连续集成失败 → 契约/拆解可能有问题，升级 human wait（病历）。幂等：已 open 不重复 raise（integration_check
    // 是 recovery:'rerun'，崩溃重跑会再 emit failed）。
    if (openWaitReasonsOf(ev.payload).includes(INTEGRATION_UNRESOLVED_REASON)) return {};
    // ENHANCE E1：集成修不动升级 raise 时同批派参谋（从本条 integration_check_failed 的 round/affectedRepos/
    // breaking 渲染事故单）。幂等同上（已 open 则上面已 return {}，不重复派）。
    return {
      ...reRaiseWait(INTEGRATION_UNRESOLVED_REASON),
      dispatch: [adviseSpec(item, renderIntegrationIncident(ev.payload))],
    };
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
// WS-6：单仓（≤1）走 lite——跳过 owner 跨仓对账，直跳并行实现派 worker（split→implement 非 checkpoint
// 边界，直跳合法）。≥2 仓走满配（派 owner 对账）。注意：applyReposSet 只写 DB、不改内存 item，故此处
// item.repos 仍是提升前旧值——lite 判定 + worker 切分都以事件 payload 的 repos（正在提升的仓）为准。
function onReposSet(item: WorkItem, ev: WorkItemEvent): Transition {
  if (item.phase !== PHASE.split) return {};
  const repos = reposSetOf(ev.payload);
  if (repos.length <= 1) {
    return {
      phase: { to: PHASE.implement, reason: 'lite_single_repo' },
      dispatch: workerDispatches(item, undefined, repos),
    };
  }
  return { dispatch: [ownerSpec(item, STAGE.reconcile)] };
}

function isLite(item: WorkItem): boolean {
  return item.repos.length <= 1;
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
function onRunFailed(item: WorkItem, ev: WorkItemEvent): Transition {
  // WS-2.2(c)：steer run 只是答话，失败不值得弹病历（消息仍在窗口内，下一个 owner run 会带上；WS-8 的
  // 自动重试也不给 steer）。ENHANCE E1：参谋（advise）失败同理——事故 wait 本来就 open 着，人照常裁决，
  // 只是没建议可参考；不弹病历、不自动重试。ENHANCE E5：实证质检（inspect）失败同理——灯③ 还有机器 note
  // 和交付清单兜底，人照常拍板；不弹病历、不自动重试。
  const failedStage = stageOf(ev.payload);
  if (
    failedStage === STAGE.steer ||
    failedStage === STAGE.advise ||
    failedStage === STAGE.inspect ||
    // INTAKE L1：勘探（scout）失败同理——收料继续走人工（用户可给绝对路径或 /scout 重试），不弹病历、
    // 不自动重试（retryFailedRun 的 owner 回落会把 scout 错派成 assess，故必须在此拦下返回 {}）。
    failedStage === STAGE.scout
  ) {
    return {};
  }
  // WS-8（D-L）：瞬时错误（API 超时/网络抖动）自愈——首败（retries=0）自动重试一次，人只看到重复失败。
  // 但 write-guard fail-closed（安全护栏失效）不能靠重试糊过去，直接弹病历。与容器 stall 重试同用
  // assignment.retries 计数（那条覆盖 stall/abort，这条覆盖 run_failed），不会叠加成无限重试。
  const err = errorTextOf(ev.payload);
  if (!err.includes('write-guard fail-closed')) {
    const retries = numberField(ev.payload, 'assignmentRetries') ?? 0;
    if (retries === 0) return retryFailedRun(item, ev);
  }
  if (openWaitReasonsOf(ev.payload).includes(RUN_FAILED_REASON)) return {};
  return {
    waits: [{ kind: 'human', reason: RUN_FAILED_REASON, deadlineTtlSec: CHECKPOINT_WAIT_TTL_SEC }],
  };
}

// WS-8：按失败结论的 role/repo/stage 原样重派一次（retries:1）。重派后的 run 再失败时 retries=1 → 走病历。
function retryFailedRun(item: WorkItem, ev: WorkItemEvent): Transition {
  const stage = stageOf(ev.payload);
  const t = ttlsOf(item);
  if (roleOf(ev.payload) === 'worker') {
    const repo = repoOf(ev.payload);
    return {
      dispatch: [
        {
          role: 'worker',
          repo: repo || undefined,
          retries: 1,
          deadlineTtlSec: t.deadlineTtlSec,
          wallclockCapSec: t.wallclockCapSec,
          payload: { stage: stage ?? 'implement', repo },
        },
      ],
    };
  }
  // owner：ownerSpec 按 stage（缺失回落：拆解→reconcile，其它→assess）+ retries:1。
  const ownerStage = stage ?? (item.phase === PHASE.split ? STAGE.reconcile : STAGE.assess);
  return { dispatch: [{ ...ownerSpec(item, ownerStage), retries: 1 }] };
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
    // WS-5：放宽到 implement——监工判大返工链里人改图纸后重对账仍冲突，也能 resolve 重对账。
    return decision.approved && (item.phase === PHASE.split || item.phase === PHASE.implement)
      ? { dispatch: [ownerSpec(item, STAGE.reconcile)] }
      : reRaiseWait(RECONCILE_CONFLICT_REASON);
  }
  if (reason === GATEKEEPER_BIG_REASON) {
    if (!(decision.approved && item.phase === PHASE.implement)) {
      return reRaiseWait(GATEKEEPER_BIG_REASON);
    }
    // WS-5：红线出口不再只有「放行」。已改图纸·返工 → 派 owner 重对账人改过的图纸（reconcile_passed@implement
    // → gatekeeper_rework → 定向返工）；无需改·放行（proceed / 无 action）→ 继续 assess（现状）。
    return decisionActionOf(ev) === 'rework'
      ? { dispatch: [ownerSpec(item, STAGE.reconcile)] }
      : { dispatch: [ownerSpec(item, STAGE.assess)] };
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
  if (reason === STEER_ESCALATED_REASON) {
    // WS-2.3：包工头上报，人处理完就完了（approved → {}）；declined 重弹留观。若要继续推进，人再在群里
    // 说话即触发新 steer。
    return decision.approved ? {} : reRaiseWait(STEER_ESCALATED_REASON);
  }
  if (reason === AWAITING_CLOSE_REASON) {
    // WS-7.7 灯④：确认关单（approved）→ 整单 done（与 close_requested 等价出口）；declined「暂不关」→ 重弹
    // 新 awaiting_close（保持可点可催，reRaise 产生新 waitId → cardMsgId 空 → surfaceCheckpoints 重发新卡）。
    return decision.approved && item.phase === PHASE.deliver
      ? { terminal: 'done' }
      : reRaiseWait(AWAITING_CLOSE_REASON);
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
  // WS-6：lite 单在拆解阶段自愈（stalled_no_path 等 approve）→ 派 worker 而非 owner 对账（lite 从不过对账，
  // 派回 owner 会跑错流程）。此处 item.repos 已提升（非 onReposSet 的旧值），isLite 可信。
  if (item.phase === PHASE.split) {
    return isLite(item)
      ? { dispatch: workerDispatches(item, undefined) }
      : { dispatch: [ownerSpec(item, STAGE.reconcile)] };
  }
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
      // WS-7.7 灯④：交付相位挂一条 awaiting_close human wait——「安静等人关单」也必须是一条 open wait，否则
      // 既不可点、也不可催、活性看门也看不见。人点关单卡 / 发 /done 都能关；不点则 WS-3 催办覆盖。无自动 MR/上线。
      return {
        ...base,
        waits: [{ kind: 'human', reason: AWAITING_CLOSE_REASON, deadlineTtlSec: 7 * 86_400 }],
      };
    default:
      return base;
  }
}

function redoPhase(item: WorkItem): Transition {
  // Re-run the current phase's work after a rejection.
  // 立项 gate 没有「审设计」式的真驳回（立项卡只有「立项完成」按钮）。防御性处理 approved=false
  // （只可能来自工作台/API）：料已齐，重弹立项 gate，杜绝「gate 被 resolve 后停在立项却无 open wait」死状态。
  if (item.phase === PHASE.intake) return raiseCheckpoint(PHASE.split, CHECKPOINT_WAIT_TTL_SEC);
  // WS-5 灯③ 打回 → 派 steer（读 handleCheckpointAction 在 resolve 前注入的打回意见，按 WS-2 指令集决定
  // 返工哪些仓）；无意见时 steer prompt 规定 raise_human（打回但未说明原因，请群里补充）。不再空转 integration_check。
  if (item.phase === PHASE.integrate) return { dispatch: [ownerSpec(item, STAGE.steer)] };
  return {};
}

function onHumanMessage(item: WorkItem, ev: WorkItemEvent): Transition {
  const text = humanText(ev.payload).trim();
  if (text === '/cancel') {
    // 防误触: confirm before tearing down. The confirm card resolves with a cancel decision.
    return {
      waits: [{ kind: 'human', reason: 'cancel_confirm', deadlineTtlSec: CHECKPOINT_WAIT_TTL_SEC }],
    };
  }
  // INTAKE L1：/scout <线索> ——只在立项相位消费（勘探找仓，收料辅助）。放在下方 intake 早返回之前才能覆盖
  // 立项相位。owner 空闲立刻派勘探 run 消费；owner 忙 → {}（桥层回执已发，用户重发即可，不做队列）。非立项
  // 相位收到 /scout → {}（此时仓已定，勘探无对象）。自动触发（桥层防抖后 injectHumanMessage）与手动 /scout
  // 走同一条消费路径。
  if (text.startsWith('/scout')) {
    if (item.phase !== PHASE.intake) return {};
    if (runningOwnersOf(ev.payload) > 0) return {};
    return { dispatch: [scoutSpec(item, text.slice('/scout'.length).trim())] };
  }
  // WS-2 消息必达：立项相位走 bridge 收料（不经此）。其余相位（拆解/实现/集成/交付）——owner 空闲立刻派
  // steer run 消费这条消息；owner 忙则等它收尾补派（withPendingSteer）。owner 槽独立于 worker（reducer
  // owner single-flight 只看 owner），故 worker 忙不忙无关。deliver 相位也适用（交付后问「分支在哪」有人答）。
  if (item.phase === PHASE.intake) return {};
  if (runningOwnersOf(ev.payload) > 0) return {};
  return { dispatch: [ownerSpec(item, STAGE.steer)] };
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

// ENHANCE E1：事故参谋 spec——仿 ownerSpec（只读 owner 全套基建），payload 额外带渲染好的事故单 incident，
// 供 composeAdvisePrompt 织入。收尾无任何流转（onRunCompleted 的 advise 分支）；即便报告出现 ```steer 也无消费方。
function adviseSpec(item: WorkItem, incident: string): AssignmentSpec {
  return { ...ownerSpec(item, STAGE.advise), payload: { stage: STAGE.advise, incident } };
}

// INTAKE L1：立项勘探 spec——仿 adviseSpec（只读 owner 全套基建），payload 额外带线索 hints（用户 /scout
// 后的原文 / 抽取的 repoHints），供 composeScoutPrompt 织入。收尾走 scout_apply effect（onRunCompleted 的
// scout 分支）；失败零流转（onRunFailed 特判）。
function scoutSpec(item: WorkItem, hints: string): AssignmentSpec {
  return { ...ownerSpec(item, STAGE.scout), payload: { stage: STAGE.scout, hints } };
}

function workerDispatches(
  item: WorkItem,
  parentAssignmentId: string | undefined,
  // WS-6：onReposSet 的 lite 路径在 item.repos 提升前调用（applyReposSet 只写 DB），须显式传入正在提升的
  // 仓，否则读到旧的空 repos 会派 0 个 worker。其它调用点（reconcile_passed / retry）item.repos 已就位，省略即可。
  reposOverride?: string[],
): AssignmentSpec[] {
  const t = ttlsOf(item);
  const source = reposOverride ?? item.repos;
  const repos = source.length > 0 ? source : [''];
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

// WS-6：repos_set 事件 payload 携带的仓（正在提升进 workitem.repos 的仓）。onReposSet 据此判 lite + 切 worker。
function reposSetOf(payload: unknown): string[] {
  const v = asObject(payload).repos;
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

// WS-8：run 结论平铺的 repo（emitRunConclusion 带）。缺失 → ''。
function repoOf(payload: unknown): string {
  const v = asObject(payload).repo;
  return typeof v === 'string' ? v : '';
}

// WS-8：run_failed 结论的错误文本（emitRunConclusion 平铺 error）。缺失 → ''。
function errorTextOf(payload: unknown): string {
  const v = asObject(payload).error;
  return typeof v === 'string' ? v : '';
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

// ── WS-2 消息必达 ─────────────────────────────────────────────────────────────────────────

// steer_apply emit 的结构化指令消费（WS-2.3）。redo_reconcile → 派 owner 重对账；rework → 定向重派受影响
// 仓 worker（跳过 running / 清单外的仓）；raise_human → 上报病历；none → {}。幂等：redo_reconcile 靠
// runningOwners、rework 靠 runningWorkerRepos + 容器同 repo 去重，防 steer_apply(recovery:'rerun') 崩溃
// 重跑重复派。
function onSteerDirective(item: WorkItem, ev: WorkItemEvent): Transition {
  const action = steerActionOf(ev.payload);
  if (action === 'redo_reconcile') {
    // 仅拆解 / 并行实现相位可重对账；且 owner 空闲（幂等 + 防挤兑）。
    if (
      (item.phase === PHASE.split || item.phase === PHASE.implement) &&
      runningOwnersOf(ev.payload) === 0
    ) {
      return { dispatch: [ownerSpec(item, STAGE.reconcile)] };
    }
    return {};
  }
  if (action === 'rework') {
    if (item.phase !== PHASE.implement && item.phase !== PHASE.integrate) return {};
    const running = new Set(runningWorkerReposOf(ev.payload));
    const note = steerNoteOf(ev.payload);
    // 只派清单内、且当前无 running worker 的仓（有 running 的仓 note 已落 steering/<repo>.md，注入其后续轮次）。
    const targets = steerReposOf(ev.payload).filter(
      (r) => item.repos.includes(r) && !running.has(r),
    );
    return { dispatch: targets.map((repo) => workerReworkSpec(item, repo, note)) };
  }
  if (action === 'raise_human') {
    if (openWaitReasonsOf(ev.payload).includes(STEER_ESCALATED_REASON)) return {};
    return reRaiseWait(STEER_ESCALATED_REASON);
  }
  return {}; // none
}

// WS-5：gatekeeper_rework effect emit 的 rework_requested → 对 payload.repos 中仍在 item.repos 内、且当前
// 无 running worker 的仓定向重派 worker（stage=rework，带 note）。幂等姿势同 WS-2.3 rework：effect 是
// recovery:'rerun'，崩溃重跑会重 emit rework_requested，靠 runningWorkerRepos 守卫防重派（首跑派出的已 running）。
function onReworkRequested(item: WorkItem, ev: WorkItemEvent): Transition {
  if (item.phase !== PHASE.implement) return {};
  const running = new Set(runningWorkerReposOf(ev.payload));
  const note = steerNoteOf(ev.payload);
  const targets = steerReposOf(ev.payload).filter((r) => item.repos.includes(r) && !running.has(r));
  return { dispatch: targets.map((repo) => workerReworkSpec(item, repo, note)) };
}

// WS-5：从 checkpoint 决策 payload 读 action（监工判大三按钮把 value.action 透传进 decision.payload）。
function decisionActionOf(ev: WorkItemEvent): string | undefined {
  const v = asObject(checkpointDecisionOf(ev)?.payload).action;
  return typeof v === 'string' ? v : undefined;
}

// 定向重派某仓 worker（rework 轮，WS-2.3 / WS-5）。note 经 dispatch payload 传给 worker prompt。
function workerReworkSpec(item: WorkItem, repo: string, note: string): AssignmentSpec {
  const t = ttlsOf(item);
  return {
    role: 'worker',
    repo,
    deadlineTtlSec: t.deadlineTtlSec,
    wallclockCapSec: t.wallclockCapSec,
    payload: { stage: STAGE.rework, repo, note },
  };
}

// owner run（非 steer）收尾时，若期间来了未被消费的群消息，在其 transition 上追加一个 steer run 去消费
// （消息必达，WS-2.2b）。steer 自己收尾不追加（onRunCompleted 的 steer 分支不经此）。
function withPendingSteer(item: WorkItem, ev: WorkItemEvent, base: Transition): Transition {
  if (unconsumedHumanMessagesOf(ev.payload) === 0) return base;
  return { ...base, dispatch: [...(base.dispatch ?? []), ownerSpec(item, STAGE.steer)] };
}

// 容器 enrich 注入的中性字段（WS-0.2 / WS-2.3），防御式读取、缺失回落。
function runningOwnersOf(payload: unknown): number {
  const v = asObject(payload).runningOwners;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function unconsumedHumanMessagesOf(payload: unknown): number {
  const v = asObject(payload).unconsumedHumanMessages;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function runningWorkerReposOf(payload: unknown): string[] {
  const v = asObject(payload).runningWorkerRepos;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// steer_directive payload 读取（WS-2.3）。
function steerActionOf(payload: unknown): string {
  const v = asObject(payload).action;
  return typeof v === 'string' ? v : 'none';
}

function steerNoteOf(payload: unknown): string {
  const v = asObject(payload).note;
  return typeof v === 'string' ? v : '';
}

function steerReposOf(payload: unknown): string[] {
  const v = asObject(payload).repos;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
