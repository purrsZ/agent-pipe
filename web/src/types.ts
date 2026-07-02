// 需求管控台数据模型。这就是后端投影层 (workitems 层的 requirement-board projection) 要产出的
// 契约形状 —— 前端 seed 假数据与真 API 返回同一结构，切换只换数据源不改组件。

export type LightState = 'passed' | 'active-human' | 'active-agent' | 'pending';
export type WorkerState = 'running' | 'paused' | 'blocked' | 'done';
export type SelfTest = 'green' | 'amber' | 'red' | 'na';
export type Health = 'ok' | 'attention' | 'blocked';
export type EventKind = 'human' | 'agent' | 'system' | 'ok' | 'error';
export type WorkitemState = 'done' | 'running' | 'paused' | 'blocked' | 'todo';
export type DecisionType = '拍板' | '自治';
export type Accent = 'cyan' | 'blue' | 'violet';

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
  status: string; // '未开始' | '修复中' | '通过' ...
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

// 看板级数据：在途 + 归档 + 每条需求的详情扩展。后端 /api/requirement-board 返回此形状。
export interface BoardData {
  reqs: Requirement[];
  extra: Record<string, ReqExtra>;
}

export function isInflight(r: Requirement): r is InflightReq {
  return r.status === 'inflight';
}

export function isDone(r: Requirement): r is DoneReq {
  return r.status === 'done';
}
