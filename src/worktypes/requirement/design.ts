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

// ── spec-design run 输出契约 (R15.AC-1/AC-2, T5/A2 — the LIVE half) ───────────────────────
// 合同 phase 调起一个跑 spec-design 流程的 readonly managed run（design-phase §5.1）。它产出人类
// 可读的设计说明，并在报告最末尾输出一个结构化的"对接合同草案"块。这里成对设计 prompt + parser：
//   - composeSpecDesignPrompt 指示 agent 按 spec-design 六阶段产设计 + 末尾输出一个 ```json 合同块；
//   - parseInternalApis 把那个块抽成 InternalApiEntry[]（升格输入，喂 promoteToContract）。
// 成对设计正是"沙箱可测"的关键：合成 agent 输出 → entries 断言；真 agent 是否真按此形态产出留
// Stage 7 live 校验。parser 永不抛——解析不到 → 空数组 → 空合同草案，由灯②人审兜底，不让 run 崩。

export function composeSpecDesignPrompt(input: {
  title: string;
  priorReport?: string; // 理解 phase 的 owner 产物（延续，不重复）
  knowledge?: string; // 各仓已有知识 map（代码考古复用，D-08）
  repos: string[]; // 涉及的仓（升格补 providerRepo/consumerRepos 的候选 key 集，D-29）
  intakeBrief?: string; // 立项书（buildIntakeBrief 产物：背景/仓库/PRD摘要/验收/UI/边界），从立项阶段装配
}): string {
  const repoList = input.repos.filter((r) => typeof r === 'string' && r.trim().length > 0);
  const lines: string[] = [
    '你是这个需求的设计专员。请用 spec-design 方法论（理解 → 代码考古 → Requirement 规划 → 详细设计 →',
    '决策台账 → AI 装配）把下面的需求转成面向实现的跨端设计：先只读浏览相关仓库做代码考古，再产出',
    '结构化设计与"前后端对接合同"。你以只读方式工作，不修改任何文件（写代码是后续各仓 worker 的事）。',
    '',
    '# 需求',
    input.title,
  ];
  // 立项书是前置已收齐的需求材料（PRD 摘要/验收/UI/边界/多仓），优先据它设计，而非裸标题硬考古。
  if (input.intakeBrief && input.intakeBrief.trim().length > 0) {
    lines.push(
      '',
      '# 立项书（前置已收齐的需求材料，请据此设计；下面是结构化背景，不要重复无据猜测）',
      input.intakeBrief.trim(),
    );
  }
  if (repoList.length > 0) {
    lines.push(
      '',
      '# 涉及的仓库（合同里的 providerRepo / consumerRepos 必须用下列仓 key，禁用"前端/后端"等业务端名）',
      ...repoList.map((r) => `- ${r}`),
    );
  }
  if (input.knowledge && input.knowledge.trim().length > 0) {
    lines.push('', '# 各仓已有知识（架构/约定，供代码考古复用）', input.knowledge.trim());
  }
  if (input.priorReport && input.priorReport.trim().length > 0) {
    lines.push('', '# 上一轮理解产物（延续，不要重复）', input.priorReport.trim());
  }
  lines.push(
    '',
    '# 产出要求（务必遵守）',
    '1. 先给出人类可读的设计说明：需求理解、跨端接口清单、各端职责与详设要点、关键决策。',
    '2. 在报告最末尾，输出且仅输出一个 ```json 代码块，承载本需求的"跨端对接合同草案"，结构如下：',
    '```json',
    '{',
    '  "interfaces": [',
    '    {',
    '      "id": "接口唯一标识",',
    '      "signature": "方法/路由签名，如 POST /orders",',
    '      "providerRepo": "提供该接口的仓 key（取自上面的仓库清单）",',
    '      "consumerRepos": ["调用该接口的仓 key"],',
    '      "fields": [{ "name": "字段名", "type": "类型", "optional": false }],',
    '      "semanticBreaking": false',
    '    }',
    '  ]',
    '}',
    '```',
    '3. 合同只登记接口/字段/类型；不要把 UI 像素、文案等实现细节写进合同。',
    '4. providerRepo / consumerRepos 一律用仓 key（不可用业务端名）。',
  );
  return lines.join('\n');
}

// 从 spec-design run 的报告里抽取对接合同草案。扫描所有 fenced 代码块，优先 ```json（或无标签）块；
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
