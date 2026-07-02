import { C, LIGHTS, STAGES, accentColor, hex } from './theme.js';
import type {
  Accent,
  BoardData,
  Contract,
  DoneReq,
  HumanWait,
  AgentWait,
  InflightReq,
  Integration,
  ReqExtra,
} from './types.js';
import { isDone, isInflight } from './types.js';

// 原型 build()/renderVals() 的纯函数移植：把领域数据折算成展示态视图模型（颜色/标签/状态）。
// 不含交互句柄（open/resolve/toggle）与 worker 展开态 —— 那些留给 React 组件用 state 接管。

export interface StageVM {
  name: string;
  status: 'done' | 'active' | 'todo';
  color: string;
  dotColor: string;
  haloColor: string;
  nameColor: string;
  statusLabel: string;
  line: boolean;
  lineColor: string;
}

export interface LightVM {
  n: string;
  label: string;
  statusLabel: string;
  color: string;
  haloColor: string;
}

export interface WorkerVM {
  repo: string;
  task: string;
  detail: string;
  stateColor: string;
  stateLabel: string;
  stateBg: string;
  selfColor: string;
  selfLabel: string;
}

export interface DecisionVM {
  typeLabel: string;
  typeColor: string;
  text: string;
  who: string;
}

export interface EventVM {
  color: string;
  icon: string;
  text: string;
  when: string;
}

export interface WorkitemVM {
  code: string;
  repo: string;
  title: string;
  tests: string;
  stateColor: string;
  stateLabel: string;
  stateBg: string;
}

export interface RiskVM {
  level: string;
  title: string;
  detail: string;
  color: string;
  bg: string;
  border: string;
}

export interface ContractVM extends Contract {
  frozenLabel: string;
  frozenColor: string;
}

export interface IntegrationVM extends Integration {
  statusColor: string;
  diffColor: string;
}

export interface MetricsVM {
  progress: number;
  progressColor: string;
  wiText: string;
  elapsed: string;
  eta: string;
  etaColor: string;
}

export interface ReqVM {
  id: string;
  name: string;
  idMono: string;
  healthColor: string;
  healthLabel: string;
  waitOnHuman: boolean;
  waitBadge: string;
  summary: string;
  stageLabel: string;
  stages: StageVM[];
  lights: LightVM[];
  workers: WorkerVM[];
  workerDots: Array<{ color: string }>;
  contract: ContractVM;
  decisions: DecisionVM[];
  humanWaits: HumanWait[];
  agentWaits: AgentWait[];
  hasHumanWaits: boolean;
  hasAgentWaits: boolean;
  noWaits: boolean;
  integration: IntegrationVM;
  metrics: MetricsVM;
  focusText: string;
  hasFocus: boolean;
  focusColor: string;
  focusIcon: string;
  focusBg: string;
  focusBorder: string;
  events: EventVM[];
  hasEvents: boolean;
  workitems: WorkitemVM[];
  hasWorkitems: boolean;
  noWorkitems: boolean;
  wiText: string;
  risks: RiskVM[];
  hasRisks: boolean;
}

const EMPTY_EXTRA: ReqExtra = {
  progress: 0,
  wiDone: 0,
  wiTotal: 0,
  elapsed: '—',
  eta: '—',
  etaWarn: false,
  owner: 'agent-pipe',
  focus: null,
  events: [],
  workitems: [],
  risks: [],
};

export function buildVM(r: InflightReq, extraMap: Record<string, ReqExtra>, accent: Accent): ReqVM {
  const A = accentColor(accent);

  const stages: StageVM[] = STAGES.map((name, i) => {
    const status = i < r.stageIndex ? 'done' : i === r.stageIndex ? 'active' : 'todo';
    const color = status === 'done' ? C.green : status === 'active' ? A : '#262c37';
    const dotColor = status === 'todo' ? C.dim : color;
    return {
      name,
      status,
      color,
      dotColor,
      haloColor: status === 'active' ? hex(A, '33') : 'transparent',
      nameColor: status === 'active' ? A : status === 'done' ? '#dfe3e9' : '#5b626f',
      statusLabel: status === 'done' ? '已完成' : status === 'active' ? '进行中' : '待开始',
      line: i < STAGES.length - 1,
      lineColor: status === 'done' ? hex(C.green, '66') : '#222831',
    };
  });

  const lights: LightVM[] = LIGHTS.map((l, i) => {
    const st = r.lights[i] ?? 'pending';
    const color =
      st === 'passed'
        ? C.green
        : st === 'active-human'
          ? C.amber
          : st === 'active-agent'
            ? A
            : C.dim;
    const statusLabel =
      st === 'passed'
        ? '已通过'
        : st === 'active-human'
          ? '等你确认'
          : st === 'active-agent'
            ? '系统推进中'
            : '未开始';
    return {
      n: l.n,
      label: l.label,
      statusLabel,
      color,
      haloColor: st === 'active-human' || st === 'active-agent' ? hex(color, '2e') : 'transparent',
    };
  });

  const healthMap: Record<string, [string, string]> = {
    ok: [C.green, '正常'],
    attention: [C.amber, '需关注'],
    blocked: [C.red, '受阻'],
  };
  const [healthColor, healthLabel] = healthMap[r.health] ?? [C.dim, '—'];

  const wState: Record<string, [string, string]> = {
    running: [A, '运行中'],
    paused: [C.amber, '已暂停'],
    blocked: [C.red, '受阻'],
    done: [C.green, '完成'],
  };
  const wSelf: Record<string, [string, string]> = {
    green: [C.green, '自测通过'],
    amber: [C.amber, '自测部分'],
    red: [C.red, '自测失败'],
    na: [C.dim, '—'],
  };
  const workers: WorkerVM[] = r.workers.map((w) => {
    const [stateColor, stateLabel] = wState[w.state] ?? [C.dim, w.state];
    const [selfColor, selfLabel] = wSelf[w.selftest] ?? [C.dim, '—'];
    return {
      repo: w.repo,
      task: w.task,
      detail: w.detail,
      stateColor,
      stateLabel,
      stateBg: hex(stateColor, '1a'),
      selfColor,
      selfLabel,
    };
  });

  const intColor =
    r.integration.status === '修复中'
      ? C.amber
      : r.integration.status === '未开始'
        ? C.dim
        : C.green;
  const contract: ContractVM = {
    ...r.contract,
    frozenLabel: r.contract.frozen
      ? `已定稿 · ${r.contract.version}`
      : r.contract.breaking
        ? '对账未决'
        : '对账中',
    frozenColor: r.contract.frozen ? C.green : r.contract.breaking ? C.red : C.dim,
  };
  const decisions: DecisionVM[] = r.decisions.map((d) => ({
    typeLabel: d.type,
    typeColor: d.type === '自治' ? C.violet : C.blue,
    text: d.text,
    who: d.who,
  }));
  const humanWaits = r.humanWaits ?? [];
  const agentWaits = r.agentWaits ?? [];
  const ex = extraMap[r.id] ?? EMPTY_EXTRA;

  const evKind: Record<string, [string, string]> = {
    human: [C.amber, '⚑'],
    agent: [A, '▸'],
    system: [C.violet, '⟳'],
    ok: [C.green, '✓'],
    error: [C.red, '✕'],
  };
  const events: EventVM[] = ex.events.map((e) => {
    const [color, icon] = evKind[e.kind] ?? [C.dim, '·'];
    return { color, icon, text: e.text, when: e.when };
  });

  const wiMap: Record<string, [string, string]> = {
    done: [C.green, '完成'],
    running: [A, '进行中'],
    paused: [C.amber, '暂停'],
    blocked: [C.red, '受阻'],
    todo: [C.dim, '待开始'],
  };
  const workitems: WorkitemVM[] = ex.workitems.map((w) => {
    const [stateColor, stateLabel] = wiMap[w.state] ?? [C.dim, w.state];
    return {
      code: w.code,
      repo: w.repo,
      title: w.title,
      tests: w.tests,
      stateColor,
      stateLabel,
      stateBg: hex(stateColor, '1a'),
    };
  });

  const risks: RiskVM[] = ex.risks.map((k) => ({
    level: k.level,
    title: k.title,
    detail: k.detail,
    color: k.level === 'high' ? C.red : C.amber,
    bg: k.level === 'high' ? '#1f0f0e' : '#1a1408',
    border: k.level === 'high' ? '#5a201c' : '#4a3a12',
  }));

  const focusHuman = !!ex.focus && ex.focus.tone === 'human';

  return {
    id: r.id,
    name: r.name,
    idMono: r.id,
    healthColor,
    healthLabel,
    waitOnHuman: r.waitOnHuman,
    waitBadge: r.waitReason,
    summary: r.summary,
    stageLabel: STAGES[r.stageIndex] ?? '—',
    stages,
    lights,
    workers,
    workerDots: workers.map((w) => ({ color: w.stateColor })),
    contract,
    decisions,
    humanWaits,
    agentWaits,
    hasHumanWaits: humanWaits.length > 0,
    hasAgentWaits: agentWaits.length > 0,
    noWaits: humanWaits.length === 0 && agentWaits.length === 0,
    integration: {
      ...r.integration,
      statusColor: intColor,
      diffColor: r.integration.diffs > 0 ? C.amber : '#e8eaed',
    },
    metrics: {
      progress: ex.progress,
      progressColor: ex.progress >= 80 ? C.green : A,
      wiText: ex.wiTotal > 0 ? `${ex.wiDone}/${ex.wiTotal}` : '待拆解',
      elapsed: ex.elapsed,
      eta: ex.eta,
      etaColor: ex.etaWarn ? C.amber : '#dfe3e9',
    },
    focusText: ex.focus ? ex.focus.text : '',
    hasFocus: !!ex.focus,
    focusColor: ex.focus ? (focusHuman ? C.amber : A) : C.dim,
    focusIcon: focusHuman ? '⚑' : '▸',
    focusBg: focusHuman ? '#1a1408' : '#0f1620',
    focusBorder: focusHuman ? '#4a3a12' : hex(A, '33'),
    events,
    hasEvents: events.length > 0,
    workitems,
    hasWorkitems: workitems.length > 0,
    noWorkitems: workitems.length === 0,
    wiText: ex.wiTotal > 0 ? `${ex.wiDone} / ${ex.wiTotal} 完成` : '待拆解',
    risks,
    hasRisks: risks.length > 0,
  };
}

export interface HistoryVM {
  name: string;
  idMono: string;
  when: string;
}

export interface BoardVM {
  items: ReqVM[];
  capacityText: string;
  historyItems: HistoryVM[];
  hasHistory: boolean;
  decisionItems: ReqVM[];
  decisionCount: number;
  hasDecisions: boolean;
}

export function buildBoard(data: BoardData, accent: Accent, showHistory: boolean): BoardVM {
  const inflight = data.reqs.filter(isInflight);
  const items = inflight.map((r) => buildVM(r, data.extra, accent));
  const history = data.reqs.filter(isDone);
  const decisionItems = items.filter((it) => it.waitOnHuman);
  return {
    items,
    capacityText: `${inflight.length}/3 在途`,
    historyItems: history.map((h: DoneReq) => ({ name: h.name, idMono: h.id, when: h.when })),
    hasHistory: showHistory && history.length > 0,
    decisionItems,
    decisionCount: decisionItems.length,
    hasDecisions: decisionItems.length > 0,
  };
}
