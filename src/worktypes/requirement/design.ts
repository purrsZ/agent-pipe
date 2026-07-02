import {
  type ContractField,
  type ContractInterface,
  type ContractSnapshot,
  makeSnapshot,
} from './contract.js';

// design-phase (worktypes layer; pure). Two testable transforms (R15.AC-2/AC-3):
//   1. 升格: spec-design's single-repo internal-apis → the cross-repo 对接合同 (each §x.y → a
//      ContractInterface, with providerRepo/consumerRepos补全 — D-29).
//   2. 按端切片: split the frozen contract per repo so each worker领走 its slice (provides +
//      consumes). The spec-design run + the markdown extraction itself is the live half; these
//      operate on the already-structured draft the run produces.

export interface InternalApiEntry {
  id: string;
  signature: string;
  fields?: ContractField[];
  providerRepo: string; //补的 repo 维度 (spec-design internal-apis is single-repo)
  consumerRepos: string[];
  semanticBreaking?: boolean;
}

// 升格: build the待确认 ContractSnapshot草案 (灯②快拍 confirms it → contract-engine freezes it).
export function promoteToContract(version: string, entries: InternalApiEntry[]): ContractSnapshot {
  const interfaces: ContractInterface[] = entries.map((e) => ({
    id: e.id,
    signature: e.signature,
    providerRepo: e.providerRepo,
    consumerRepos: e.consumerRepos,
    fields: e.fields ?? [],
    ...(e.semanticBreaking ? { semanticBreaking: true } : {}),
  }));
  return makeSnapshot(version, interfaces);
}

export interface DesignSlice {
  repo: string;
  provides: ContractInterface[]; // interfaces this repo must implement
  consumes: ContractInterface[]; // upstream interfaces this repo depends on
}

// 按端切片 (D-29 repo维度, 不用业务端名). One repo = one worker's领活范围 (D-01).
export function sliceByRepo(contract: ContractSnapshot): DesignSlice[] {
  const repos = new Set<string>();
  for (const i of contract.interfaces) {
    if (i.providerRepo) repos.add(i.providerRepo);
    for (const c of i.consumerRepos) if (c) repos.add(c);
  }
  return [...repos].sort().map((repo) => ({
    repo,
    provides: contract.interfaces.filter((i) => i.providerRepo === repo),
    consumes: contract.interfaces.filter(
      (i) => i.providerRepo !== repo && i.consumerRepos.includes(repo),
    ),
  }));
}

// The repos a requirement must拆 workers for = every repo touched by the contract. Drives
// the拆解→并行实现 fan-out (one worker per repo).
export function reposFromContract(contract: ContractSnapshot): string[] {
  return sliceByRepo(contract).map((s) => s.repo);
}

// ── spec-design run 输出契约 parser (PIVOT 后保留为通用工具) ─────────────────────────────────
// 设计已摘出 agent-pipe（composeSpecDesignPrompt 已删——owner 不再产设计）。但「从一段报告里抽出结构化
// 的跨端接口清单」这个 parser 仍是通用件：reconcile.ts 的对账块解析与它同形。parser 永不抛——解析不到
// → 空数组。
//
// 从报告里抽取接口清单。扫描所有 fenced 代码块，优先 ```json（或无标签）块；
// 取"最后一个解析出 ≥1 条有效接口"的块（agent 在报告末尾产权威块，前面可能有示例）。无有效块 → []。
export function parseInternalApis(report: string): InternalApiEntry[] {
  if (typeof report !== 'string' || report.length === 0) return [];
  const blocks = extractFencedBlocks(report);
  const jsonBlocks = blocks.filter((b) => /^json\b/i.test(b.tag) || b.tag === '');
  const candidates = jsonBlocks.length > 0 ? jsonBlocks : blocks;
  let result: InternalApiEntry[] = [];
  for (const b of candidates) {
    const entries = entriesFromJson(b.body);
    if (entries.length > 0) result = entries; // last non-empty wins
  }
  return result;
}

function extractFencedBlocks(text: string): Array<{ tag: string; body: string }> {
  const blocks: Array<{ tag: string; body: string }> = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec drain loop
  while ((m = re.exec(text)) !== null) {
    blocks.push({ tag: (m[1] ?? '').trim(), body: m[2] ?? '' });
  }
  return blocks;
}

function entriesFromJson(body: string): InternalApiEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const raw: unknown[] = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray((parsed as { interfaces?: unknown }).interfaces)
      ? ((parsed as { interfaces: unknown[] }).interfaces ?? [])
      : [];
  const out: InternalApiEntry[] = [];
  for (const item of raw) {
    const e = coerceEntry(item);
    if (e) out.push(e);
  }
  return out;
}

function coerceEntry(value: unknown): InternalApiEntry | undefined {
  if (!isObject(value)) return undefined;
  const id = asString(value.id);
  const signature = asString(value.signature);
  const providerRepo = asString(value.providerRepo);
  if (!id || !signature || !providerRepo) return undefined;
  const consumerRepos = Array.isArray(value.consumerRepos)
    ? value.consumerRepos.filter((r): r is string => typeof r === 'string' && r.length > 0)
    : [];
  const fields = Array.isArray(value.fields)
    ? value.fields.map(coerceField).filter((f): f is ContractField => f !== undefined)
    : [];
  return {
    id,
    signature,
    providerRepo,
    consumerRepos,
    fields,
    ...(value.semanticBreaking === true ? { semanticBreaking: true } : {}),
  };
}

function coerceField(value: unknown): ContractField | undefined {
  if (!isObject(value)) return undefined;
  const name = asString(value.name);
  const type = asString(value.type);
  if (!name || !type) return undefined;
  return { name, type, optional: value.optional === true };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
