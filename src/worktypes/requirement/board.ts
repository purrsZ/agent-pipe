import type { ArtifactStore } from '../../workitems/artifacts.js';
import type { WorkitemsStore } from '../../workitems/store.js';
import type { Assignment, WorkItemEvent } from '../../workitems/types.js';
import { checkpointGateLabel } from './lights.js';
import { PHASE, PHASE_SEQUENCE } from './phases.js';

// 需求管控台「看板投影」(worktypes 层 = requirement 专属视图逻辑；架构守卫允许 worktypes→workitems、
// 允许业务词与 phase 解释，和同目录的 IO effect handler integration.ts 一致)。把事件溯源的
// WorkItem/Assignment/Wait/Event + contract artifact fold 成前端 React 原型直接消费的 BoardData ——
// 形状镜像 web/src/types.ts。kernel 中立的 src/workbench / src/console/server 都不碰业务，故业务都落这里。
//
// Phase 1 原则：现成/可派生字段如实供数(灯/阶段/工人/待办/活动流/合同/集成/进度)；后端尚无来源的
// 字段(selftest/eta/risks/破坏性变更检测/细粒度 workitem tests 等)留空，由原型自带的空态优雅降级。

// ---- DTO（与 web/src/types.ts BoardData 同形）----
export type LightState = 'passed' | 'active-human' | 'active-agent' | 'pending';
export type WorkerState = 'running' | 'paused' | 'blocked' | 'done';
export type SelfTest = 'green' | 'amber' | 'red' | 'na';
export type Health = 'ok' | 'attention' | 'blocked';
export type EventKind = 'human' | 'agent' | 'system' | 'ok' | 'error';
export type WorkitemState = 'done' | 'running' | 'paused' | 'blocked' | 'todo';
export type DecisionType = '拍板' | '自治';

export interface Worker {
  repo: string;
  task: string;
  state: WorkerState;
  selftest: SelfTest;
  detail: string;
}
export interface Contract {
  frozen: boolean;
  version: string;
  breaking: boolean;
  note: string;
}
export interface Integration {
  round: number;
  diffs: number;
  status: string;
}
export interface Decision {
  type: DecisionType;
  text: string;
  who: string;
}
export interface HumanWait {
  waitId: string;
  title: string;
  desc: string;
  age: string;
}
export interface AgentWait {
  title: string;
  desc: string;
  age: string;
}
export interface ReqEvent {
  kind: EventKind;
  text: string;
  when: string;
}
export interface Workitem {
  code: string;
  repo: string;
  title: string;
  state: WorkitemState;
  tests: string;
}
export interface Risk {
  level: 'high' | 'mid';
  title: string;
  detail: string;
}
export interface FocusInfo {
  text: string;
  tone: 'human' | 'agent';
}
export interface InflightReq {
  id: string;
  name: string;
  status: 'inflight';
  stageIndex: number;
  lights: LightState[];
  waitOnHuman: boolean;
  waitReason: string;
  health: Health;
  summary: string;
  workers: Worker[];
  contract: Contract;
  integration: Integration;
  decisions: Decision[];
  humanWaits: HumanWait[];
  agentWaits: AgentWait[];
}
export interface DoneReq {
  id: string;
  name: string;
  status: 'done';
  when: string;
}
export type Requirement = InflightReq | DoneReq;
export interface ReqExtra {
  progress: number;
  wiDone: number;
  wiTotal: number;
  elapsed: string;
  eta: string;
  etaWarn: boolean;
  owner: string;
  focus: FocusInfo | null;
  events: ReqEvent[];
  workitems: Workitem[];
  risks: Risk[];
}
export interface BoardData {
  reqs: Requirement[];
  extra: Record<string, ReqExtra>;
}

const REQUIREMENT_TYPE = 'requirement';

// PIVOT 后端 5 段 phase → 原型 5 阶段(立项/拆解/并行实现/集成验证/交付) 序号。设计（理解/合同/详设）
// 已摘出 agent-pipe，故无对应阶段。
const STAGE_OF_PHASE: Record<string, number> = {
  [PHASE.intake]: 0,
  [PHASE.split]: 1,
  [PHASE.implement]: 2,
  [PHASE.integrate]: 3,
  [PHASE.deliver]: 4,
};

const PHASE_CN: Record<string, string> = {
  [PHASE.intake]: '立项',
  [PHASE.split]: '拆解',
  [PHASE.implement]: '并行实现',
  [PHASE.integrate]: '集成验证',
  [PHASE.deliver]: '交付',
};

// 「两灯一 gate」各自「越过即算通过」的 PHASE_SEQUENCE 序号阈值（含立项共 5 段：intake=0/split=1/
// implement=2/integrate=3/deliver=4）：
//   立项 gate=进入拆解(1) · 灯③验收=进入交付(4) · 灯④上线=终态 done(Infinity)
const LIGHT_PASSED_SEQ = [1, 4, Number.POSITIVE_INFINITY];

export interface RequirementBoardDeps {
  store: WorkitemsStore;
  artifacts: ArtifactStore;
  now?: () => number;
}

export function buildRequirementBoard(deps: RequirementBoardDeps): BoardData {
  const now = deps.now?.() ?? Date.now();
  const items = deps.store.listNonTerminal().filter((i) => i.type === REQUIREMENT_TYPE);
  const reqs: Requirement[] = [];
  const extra: Record<string, ReqExtra> = {};
  for (const item of items) {
    const built = buildOne(deps, item.id, item.title, item.phase, item.createdAt, now);
    reqs.push(built.req);
    extra[item.id] = built.ex;
  }
  return { reqs, extra };
}

function buildOne(
  deps: RequirementBoardDeps,
  id: string,
  title: string,
  phase: string,
  createdAt: number,
  now: number,
): { req: InflightReq; ex: ReqExtra } {
  const assignments = deps.store.listAssignments(id);
  const workerAssignments = assignments.filter(
    (a) => a.role === 'worker' && a.status !== 'superseded' && a.status !== 'cancelled',
  );
  const openWaits = deps.store.listOpenWaits(id);
  const humanWaitsRaw = openWaits.filter((w) => w.kind === 'human');
  const agentWaitsRaw = openWaits.filter((w) => w.kind === 'agent' || w.kind === 'timer');
  const events = deps.store.listEvents(id);

  const hasHumanWait = humanWaitsRaw.length > 0;
  const hasRunning = assignments.some((a) => a.status === 'running');
  const hasAgentSignal = hasRunning || agentWaitsRaw.length > 0;
  const hasFailed = assignments.some((a) => a.status === 'failed');

  const seq = Math.max(0, PHASE_SEQUENCE.indexOf(phase as never));
  const stageIndex = STAGE_OF_PHASE[phase] ?? 0;
  const passed = LIGHT_PASSED_SEQ.map((threshold) => seq >= threshold);
  const lights = deriveLights(passed, hasHumanWait, hasAgentSignal);

  const firstHuman = humanWaitsRaw[0];
  const waitReason = firstHuman ? friendlyReason(firstHuman.reason) : '';
  const health: Health = hasFailed ? 'blocked' : hasHumanWait ? 'attention' : 'ok';
  const summary = `${PHASE_CN[phase] ?? '推进中'} · ${
    hasHumanWait ? '等你拍板' : hasRunning ? '进行中' : '等待中'
  }`;

  const workers: Worker[] = workerAssignments.map((a) => ({
    repo: a.repo ?? '—',
    task: '',
    state: workerState(a.status),
    selftest: 'na',
    detail: '',
  }));

  const contract = readContract(deps, id);
  const failed = events.filter((e) => e.kind === 'integration_check_failed').length;
  const passedIntegration = events.some((e) => e.kind === 'integration_check_passed');
  const integration: Integration = {
    round: failed,
    diffs: 0,
    status: passedIntegration ? '通过' : failed > 0 ? '修复中' : '未开始',
  };

  const decisions = foldDecisions(events, now);
  const humanWaits: HumanWait[] = humanWaitsRaw.map((w) => ({
    waitId: w.id,
    title: waitTitle(w.reason),
    desc: friendlyReason(w.reason),
    age: `已等待 ${durLabel(now - w.createdAt)}`,
  }));
  const agentWaits: AgentWait[] = agentWaitsRaw.map((w) => ({
    title: '系统进行中',
    desc: w.reason,
    age: `已等待 ${durLabel(now - w.createdAt)}`,
  }));

  const req: InflightReq = {
    id,
    name: title,
    status: 'inflight',
    stageIndex,
    lights,
    waitOnHuman: hasHumanWait,
    waitReason,
    health,
    summary,
    workers,
    contract,
    integration,
    decisions,
    humanWaits,
    agentWaits,
  };

  const wiTotal = workerAssignments.length;
  const wiDone = workerAssignments.filter((a) => a.status === 'done').length;
  const focus: FocusInfo | null = firstHuman
    ? { text: friendlyReason(firstHuman.reason), tone: 'human' }
    : hasAgentSignal
      ? { text: '系统自治推进中，暂不需要你介入。', tone: 'agent' }
      : null;
  const ex: ReqExtra = {
    progress: PHASE_SEQUENCE.length > 1 ? Math.round((seq / (PHASE_SEQUENCE.length - 1)) * 100) : 0,
    wiDone,
    wiTotal,
    elapsed: durLabel(now - createdAt),
    eta: '—',
    etaWarn: false,
    owner: 'agent-pipe',
    focus,
    events: foldEvents(events, now),
    workitems: workerAssignments.map((a, i) => ({
      code: `W${i + 1}`,
      repo: a.repo ?? '—',
      title: '',
      state: workitemState(a.status),
      tests: '',
    })),
    risks: [],
  };

  return { req, ex };
}

function deriveLights(passed: boolean[], hasHuman: boolean, hasAgent: boolean): LightState[] {
  const firstUnpassed = passed.findIndex((p) => !p);
  return passed.map((p, i) => {
    if (p) return 'passed';
    if (i !== firstUnpassed) return 'pending';
    return hasHuman ? 'active-human' : hasAgent ? 'active-agent' : 'pending';
  });
}

function workerState(status: Assignment['status']): WorkerState {
  if (status === 'done') return 'done';
  if (status === 'failed') return 'blocked';
  return 'running';
}

function workitemState(status: Assignment['status']): WorkitemState {
  if (status === 'done') return 'done';
  if (status === 'failed') return 'blocked';
  return 'running';
}

// 「对接合同」面板 → 「跨仓契约 · owner 对账」面板（PIVOT §7.1）。读 owner 对账产物 contract/reconcile.json：
// interfaces=拼出的跨仓契约条目，unresolved=冲突/悬空。frozen=已定稿(≥1 条且无未决)；breaking=尚有未决；
// note=对账状态（全咬合 / 冲突·悬空 N）。无对账产物（单仓/无跨仓接口）→ 空态优雅降级。
function readContract(deps: RequirementBoardDeps, id: string): Contract {
  const raw = deps.artifacts.readFile(id, 'contract/reconcile.json');
  if (!raw) return { frozen: false, version: '—', breaking: false, note: '' };
  try {
    const r = JSON.parse(raw) as { interfaces?: unknown; unresolved?: unknown };
    const ifaceCount = Array.isArray(r.interfaces) ? r.interfaces.length : 0;
    const unresolvedCount = Array.isArray(r.unresolved) ? r.unresolved.length : 0;
    if (ifaceCount === 0 && unresolvedCount === 0) {
      return { frozen: false, version: '—', breaking: false, note: '' };
    }
    return {
      frozen: ifaceCount > 0 && unresolvedCount === 0,
      version: `${ifaceCount} 条接口`,
      breaking: unresolvedCount > 0,
      note: unresolvedCount > 0 ? `${unresolvedCount} 处未决（冲突/悬空）` : '全咬合',
    };
  } catch {
    return { frozen: false, version: '—', breaking: false, note: '' };
  }
}

function friendlyReason(reason: string): string {
  if (reason.startsWith('checkpoint:')) {
    return `${checkpointGateLabel(reason.slice('checkpoint:'.length))} — 等你确认`;
  }
  if (reason === 'reconcile_conflict') return '跨仓对账有冲突/悬空 — 等你裁决后回改单仓设计';
  if (reason === 'gatekeeper_big') return '监工发现跨仓外溢 — 等你裁决后改图纸/返工';
  if (reason === 'integration_unresolved') return '集成验证未通过 — 等你裁决';
  if (reason === 'run_failed') return '一次执行报错 — 等你裁决（处理后可重试）';
  if (reason === 'cancel_confirm') return '确认终止该需求？';
  return reason;
}

function waitTitle(reason: string): string {
  if (reason.startsWith('checkpoint:')) {
    return checkpointGateLabel(reason.slice('checkpoint:'.length));
  }
  if (reason === 'reconcile_conflict') return '跨仓对账裁决';
  if (reason === 'gatekeeper_big') return '监工裁决（跨仓外溢）';
  if (reason === 'integration_unresolved') return '集成验证裁决';
  if (reason === 'run_failed') return '执行报错裁决';
  if (reason === 'cancel_confirm') return '取消确认';
  return '待处理';
}

const DECISION_LABEL: Record<string, { type: DecisionType; text: string }> = {
  checkpoint_decision: { type: '拍板', text: '关卡拍板' },
  reconcile_passed: { type: '自治', text: '跨仓契约全咬合' },
  intake_field_set: { type: '自治', text: '立项收料' },
};

function foldDecisions(events: WorkItemEvent[], now: number): Decision[] {
  const out: Decision[] = [];
  for (const e of events) {
    const label = DECISION_LABEL[e.kind];
    if (!label) continue;
    out.push({
      type: label.type,
      text: label.text,
      who: `${label.type === '拍板' ? '你' : '系统'} · ${relTime(e.createdAt, now)}`,
    });
  }
  return out.slice(-8).reverse();
}

const EVENT_CAT: Record<string, EventKind> = {
  integration_check_passed: 'ok',
  integration_check_failed: 'error',
  reconcile_passed: 'ok',
  reconcile_conflict: 'error',
  gatekeeper_passed: 'ok',
  gatekeeper_big: 'error',
  checkpoint_reached: 'human',
  checkpoint_decision: 'human',
  worker_report: 'agent',
  intake_field_set: 'system',
  run_completed: 'ok',
  run_failed: 'error',
  human_message: 'human',
  wait_resolved: 'human',
  // OVERHAUL 新事件（WS-2/5/7 + 容器活性看门）。
  steer_directive: 'agent',
  rework_requested: 'agent',
  manifest_ready: 'ok',
  liveness_stalled: 'error',
  // INTAKE L1 立项勘探结果（找仓）。
  scout_result: 'system',
};

const EVENT_TEXT: Record<string, string> = {
  integration_check_passed: '集成验证通过',
  integration_check_failed: '集成验证未通过，进入修复',
  reconcile_passed: '跨仓契约对账全咬合',
  reconcile_conflict: '跨仓对账发现冲突/悬空，等你裁决',
  gatekeeper_passed: '监工放行（无跨仓外溢上报）',
  gatekeeper_big: '监工发现跨仓外溢，等你裁决',
  checkpoint_reached: '到达关卡，等待你拍板',
  checkpoint_decision: '关卡已拍板',
  worker_report: '工人提交进度报告',
  intake_field_set: '立项收料更新',
  run_completed: '一次执行完成',
  run_failed: '一次执行失败',
  human_message: '你发来一条留言',
  wait_resolved: '一个等待已处理',
  steer_directive: '包工头处理了你的留言',
  rework_requested: '监工判大后定向返工',
  manifest_ready: '交付清单已生成',
  liveness_stalled: '流程卡死（系统自检出）',
  scout_result: '立项勘探找仓结果',
};

function foldEvents(events: WorkItemEvent[], now: number): ReqEvent[] {
  return events
    .slice(-12)
    .reverse()
    .map((e) => ({
      kind: EVENT_CAT[e.kind] ?? 'system',
      text: EVENT_TEXT[e.kind] ?? e.kind,
      when: relTime(e.createdAt, now),
    }));
}

function durLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 时`;
  if (h > 0) return `${h} 时 ${m} 分`;
  if (m > 0) return `${m} 分`;
  return '刚刚';
}

function relTime(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return '刚刚';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 时前`;
  return `${Math.floor(h / 24)} 天前`;
}
