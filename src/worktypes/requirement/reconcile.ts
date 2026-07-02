import type { EffectContext, EffectHandler } from '../../workitems/effects.js';
import { type ContractSnapshot, EMPTY_SNAPSHOT } from './contract.js';
import { type InternalApiEntry, promoteToContract } from './design.js';

// owner 跨仓「拼凑 + 对账」域（PIVOT《设计外置·实现聚焦》§3.1，worktypes 层）。
//
// 设计已摘出 agent-pipe（人在 Claude Code 用 /spec-design 产出**各仓一个设计目录**）。立项 gate 通过、进
// 「拆解」phase 后，owner 的第一件事不再是「产设计」，而是**读各仓设计目录的「外部方契约」节，拼凑 + 对账**
// 成需求层级的一份跨仓契约：
//   - 全咬合 → 跨仓契约定稿 → 按仓分发施工（worker 各领一仓 + 它的 provides/consumes 切片）；
//   - 发现 冲突（两边对不上）/ 悬空（一边声明、对方无应答）→ raise 人（病历），人改对应单仓设计后重对账。
//
// 这正好补上「砍掉合同冻结引擎后灯③ 靠什么对账」：这份 owner 对账契约就是灯③（集成验证）的对账基准
// （写进 contract/contract.json，integration.ts 原样消费，contractStructuralDiff 留用）。本质是 contract.json
// 换了产地——从「contract 相位 afterRun 升格」挪到「owner 对账」，复杂度搬家、复用既有 owner，比专门相位轻。
//
// 本文件 = 该域的纯核心（prompt 组装 + 报告/JSON 解析 + 结构化对账判定）+ 一个 idempotent（recovery:'rerun'）
// 的 reconcile_check effect handler。owner「拼凑 + 对账」是 AI 活（读散文形式的「外部方契约」节），那是 live 半；
// 这里 reconcile_check 做的是**纯结构化安全网**（providerRepo/consumerRepos 必须落在立项仓库清单内，否则悬空），
// 与 owner 自报的 unresolved 取并集——疑则判大、raise 人，绝不空转放行。

export type ReconcileKind = 'conflict' | 'dangling';

export interface ReconcileUnresolved {
  kind: ReconcileKind; // conflict=两边声明对不上；dangling=一边声明、对方无应答（更危险）
  interfaceId: string;
  detail: string; // 人类可读的「哪不咬合」一句话（晨审病历直接展示）
  repos: string[]; // 涉及的仓（供人定位回改哪个单仓设计）
}

export interface ReconcileResult {
  interfaces: InternalApiEntry[]; // 拼凑出的需求层级跨仓契约（全咬合部分）
  unresolved: ReconcileUnresolved[]; // owner 自报的冲突/悬空
}

const EMPTY_RECONCILE: ReconcileResult = { interfaces: [], unresolved: [] };

// ── compose：owner 跨仓对账 prompt（替代被砍的 composeSpecDesignPrompt）。owner 只读浏览所有相关仓 ────
//    （--add-dir 已把每个仓加进可读目录），找到各仓 ai-specs 设计目录、读其「外部方契约 / 跨仓依赖」节，
//    拼成一份跨仓契约 + 把不咬合处列成 unresolved。不产设计、不改代码。
export function composeReconcilePrompt(input: {
  title: string;
  repos: string[];
  intakeBrief?: string;
  priorReport?: string; // 上一轮对账结论（多轮收敛时延续）
  followups?: string[]; // 人在群里 / 病历上补的对账提示
}): string {
  const repoList = input.repos.filter((r) => typeof r === 'string' && r.trim().length > 0);
  const lines: string[] = [
    '你是这个需求的包工头（协调者）。设计已由人在各仓用 /spec-design 完成——**每个相关仓自己有一个设计',
    '目录**（通常在该仓的 `ai-specs/<feature>/` 下，含 design/index、internal-apis、domains、requirements 等）。',
    '你的任务**不是产设计**，而是**跨仓对账**：只读浏览每个相关仓、找到它的设计目录，读其中描述「本仓对外',
    '提供什么 / 依赖外部方什么」的部分（「外部方契约」「跨仓依赖」「强依赖后端」等表述），把各仓的对外声明',
    '**拼凑**成一份需求层级的跨仓接口契约，并**对账**：一仓声明「我要 B 给 X」，就要在 B 仓找到「我对外给 X」。',
    '',
    '# 需求',
    input.title,
  ];
  if (input.intakeBrief && input.intakeBrief.trim().length > 0) {
    lines.push(
      '',
      '# 立项书（前置已收齐的需求材料：背景/验收/UI/边界/多仓；据此定位各仓设计目录，不要再向用户索要）',
      input.intakeBrief.trim(),
    );
  }
  if (repoList.length > 0) {
    lines.push(
      '',
      '# 涉及的仓库（绝对路径，全部需只读浏览各自的设计目录——不要只看第一个）',
      ...repoList.map((r) => `- ${r}`),
    );
  }
  if (input.priorReport && input.priorReport.trim().length > 0) {
    lines.push('', '# 上一轮对账结论（延续，不要重复已咬合的部分）', input.priorReport.trim());
  }
  if (input.followups && input.followups.length > 0) {
    lines.push(
      '',
      '# 人对本次对账的补充 / 已改的单仓设计（最高优先级，据此重新对账）',
      ...input.followups.map((f) => `- ${f}`),
    );
  }
  lines.push(
    '',
    '# 产出要求（务必遵守）',
    '1. 先给出人类可读的对账结论：跨仓接口清单、各仓 provides/consumes、以及**逐条对账状态**',
    '   （全咬合 / 冲突 / 悬空）。冲突=两仓声明对不上（字段、方向、签名）；悬空=一仓声明依赖，但对方仓的',
    '   设计里找不到对应的对外提供（或反之）。**拿不准是否咬合时，一律计入 unresolved 上报人，不要替双方脑补。**',
    '2. 在报告最末尾，输出且仅输出一个 ```json 代码块，承载本需求的「跨仓对接契约 + 对账结论」，结构如下：',
    '```json',
    '{',
    '  "interfaces": [',
    '    {',
    '      "id": "接口唯一标识",',
    '      "signature": "方法/路由签名，如 GET /usage/report/v2",',
    '      "providerRepo": "提供该接口的仓 key（取自上面的仓库清单的绝对路径）",',
    '      "consumerRepos": ["调用该接口的仓 key"],',
    '      "fields": [{ "name": "字段名", "type": "类型", "optional": false }]',
    '    }',
    '  ],',
    '  "unresolved": [',
    '    { "kind": "conflict|dangling", "interfaceId": "接口标识", "detail": "哪不咬合（一句话）", "repos": ["相关仓 key"] }',
    '  ]',
    '}',
    '```',
    '3. providerRepo / consumerRepos 一律用上面清单里的**仓库绝对路径**做 key（禁用「前端/后端」等业务端名）。',
    '4. 契约只登记接口/字段/类型；不要把 UI 像素、文案等实现细节写进契约。',
    '5. 全咬合的接口放 interfaces；任何冲突/悬空放 unresolved（两者可并存：已咬合的照常分发，未决的挂起等人）。',
  );
  return lines.join('\n');
}

// ── parse：从 owner 报告（markdown，末尾一个 ```json 块）抽出对账结论。永不抛——解析不到 → 空结果 ─────
export function parseReconcileResult(report: string): ReconcileResult {
  if (typeof report !== 'string' || report.length === 0) return EMPTY_RECONCILE;
  let result = EMPTY_RECONCILE;
  for (const body of jsonBlocks(report)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const coerced = coerceReconcile(parsed);
    // 取「最后一个有内容」的块（agent 在报告末尾产权威块，前面可能有示例）。
    if (coerced.interfaces.length > 0 || coerced.unresolved.length > 0) result = coerced;
  }
  return result;
}

// reconcile_check 读 afterRun 落的 contract/reconcile.json（已是干净 JSON），coerce 回 ReconcileResult。
export function readReconcileArtifact(raw: string | undefined): ReconcileResult {
  if (!raw) return EMPTY_RECONCILE;
  try {
    return coerceReconcile(JSON.parse(raw));
  } catch {
    return EMPTY_RECONCILE;
  }
}

// ── 结构化对账安全网（纯）：providerRepo/consumerRepos 必须落在立项仓库清单内，否则悬空（dangling）。──
//    owner 自报的 unresolved 之外，这层兜底——agent 漏报、或拼出一个引用了清单外仓的接口，也会被逮住。
export function structuralDangling(
  interfaces: InternalApiEntry[],
  repos: string[],
): ReconcileUnresolved[] {
  const repoSet = new Set(repos.filter((r) => typeof r === 'string' && r.trim().length > 0));
  const out: ReconcileUnresolved[] = [];
  for (const i of interfaces) {
    const provider = (i.providerRepo ?? '').trim();
    if (!provider) {
      out.push({
        kind: 'dangling',
        interfaceId: i.id,
        detail: `接口「${i.signature}」没有 providerRepo（声明了调用方、却无人提供）`,
        repos: i.consumerRepos,
      });
    } else if (!repoSet.has(provider)) {
      out.push({
        kind: 'dangling',
        interfaceId: i.id,
        detail: `接口「${i.signature}」的提供方仓不在立项仓库清单内：${provider}`,
        repos: [provider],
      });
    }
    for (const c of i.consumerRepos) {
      const consumer = (c ?? '').trim();
      if (consumer && !repoSet.has(consumer)) {
        out.push({
          kind: 'dangling',
          interfaceId: i.id,
          detail: `接口「${i.signature}」的调用方仓不在立项仓库清单内：${consumer}`,
          repos: [consumer],
        });
      }
    }
  }
  return out;
}

// owner 对账结论 → 冻结进 contract/contract.json 的跨仓契约快照（灯③ 对账基准）。空 entries → 空快照。
export function reconcileToContract(result: ReconcileResult): ContractSnapshot {
  if (result.interfaces.length === 0) return EMPTY_SNAPSHOT;
  return promoteToContract('reconciled', result.interfaces);
}

// 全部未决（owner 自报 unresolved ∪ 结构化悬空 ∪ 多仓零接口疑则判大），去重后给晨审病历用。
export function reconcileVerdict(
  result: ReconcileResult,
  repos: string[],
): { passed: boolean; unresolved: ReconcileUnresolved[] } {
  const realRepos = repos.filter((r) => typeof r === 'string' && r.trim().length > 0);
  const all = [...result.unresolved, ...structuralDangling(result.interfaces, realRepos)];
  // 多仓需求却一条跨仓接口都没对出（owner 漏读「外部方契约」节 / 报告 json 块解析坏）→ 疑则判大：
  // 多仓本应至少有跨仓边界，0 接口 + 0 未决极可能是「该对账却没对上」被静默吞，raise 人核对（PIVOT §3.1
  // 铁律：悬空比冲突更危险、拿不准就上报），绝不当成「全咬合」放行。单仓需求无此约束（0 接口正常）。
  if (realRepos.length >= 2 && result.interfaces.length === 0 && all.length === 0) {
    all.push({
      kind: 'dangling',
      interfaceId: '(整体)',
      detail: `多仓需求（${realRepos.length} 仓）但未对出任何跨仓接口，疑漏读「外部方契约」节或解析失败，请人工核对各仓设计是否真无跨仓依赖`,
      repos: realRepos,
    });
  }
  const seen = new Set<string>();
  const unresolved = all.filter((u) => {
    const key = `${u.kind}:${u.interfaceId}:${u.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { passed: unresolved.length === 0, unresolved };
}

// ── reconcile_check effect（与 integration_check 同构）：纯只读对账，crash 后重跑幂等。 ──────────────
//    读 owner afterRun 落的 contract/reconcile.json + workitem.repos → emit reconcile_passed / _conflict。
export function createReconcileCheckHandler(): EffectHandler {
  return {
    kind: 'reconcile_check',
    recovery: 'rerun',
    run: reconcileCheck,
  };
}

async function reconcileCheck(ctx: EffectContext): Promise<void> {
  const raw = ctx.readArtifact('contract/reconcile.json');
  if (raw === undefined) {
    // 防御兜底：正常流程下 owner 对账 run 的 afterRun 必落一份 reconcile.json（哪怕空），故 reconcile.json
    // 缺失只发生在「对账 run 在 afterRun 落档前异常退出」——此时该 run 已 emit run_failed → onRunFailed 已
    // raise 病历，这里不再叠加，放行让流程不卡死（真正的多仓零接口疑点由下面 verdict 的「疑则判大」兜住）。
    ctx.emit('reconcile_passed', { reason: 'no_reconcile' });
    return;
  }
  const result = readReconcileArtifact(raw);
  const verdict = reconcileVerdict(result, ctx.workitem.repos);
  ctx.writeArtifact(
    'contract/reconcile-report.md',
    renderReconcileReport(result, verdict.unresolved),
    'owner 跨仓对账报告',
  );
  if (verdict.passed) {
    ctx.emit('reconcile_passed', { interfaces: result.interfaces.length });
  } else {
    ctx.emit('reconcile_conflict', { unresolved: verdict.unresolved });
  }
}

// ── helpers (pure) ──────────────────────────────────────────────────────────────────────
function jsonBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec drain loop
  while ((m = re.exec(text)) !== null) {
    const tag = (m[1] ?? '').trim();
    if (/^json\b/i.test(tag) || tag === '') out.push(m[2] ?? '');
  }
  // 也兜一手裸 JSON（无围栏）。
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) out.push(text.slice(first, last + 1));
  return out;
}

function coerceReconcile(value: unknown): ReconcileResult {
  if (typeof value !== 'object' || value === null) return EMPTY_RECONCILE;
  const o = value as Record<string, unknown>;
  const interfaces = Array.isArray(o.interfaces)
    ? o.interfaces.map(coerceEntry).filter((e): e is InternalApiEntry => e !== undefined)
    : [];
  const unresolved = Array.isArray(o.unresolved)
    ? o.unresolved.map(coerceUnresolved).filter((u): u is ReconcileUnresolved => u !== undefined)
    : [];
  return { interfaces, unresolved };
}

function coerceEntry(value: unknown): InternalApiEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const id = asString(v.id);
  const signature = asString(v.signature);
  const providerRepo = asString(v.providerRepo);
  if (!id || !signature) return undefined;
  const consumerRepos = Array.isArray(v.consumerRepos)
    ? v.consumerRepos.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    : [];
  const fields = Array.isArray(v.fields)
    ? v.fields
        .map((f) => {
          if (typeof f !== 'object' || f === null) return undefined;
          const ff = f as Record<string, unknown>;
          const name = asString(ff.name);
          const type = asString(ff.type);
          if (!name || !type) return undefined;
          return { name, type, optional: ff.optional === true };
        })
        .filter((f): f is { name: string; type: string; optional: boolean } => f !== undefined)
    : [];
  return {
    id,
    signature,
    providerRepo,
    consumerRepos,
    fields,
    ...(v.semanticBreaking === true ? { semanticBreaking: true } : {}),
  };
}

function coerceUnresolved(value: unknown): ReconcileUnresolved | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const kind = v.kind === 'conflict' || v.kind === 'dangling' ? v.kind : 'conflict';
  const interfaceId = asString(v.interfaceId) || '(未指明接口)';
  const detail = asString(v.detail);
  if (!detail) return undefined;
  const repos = Array.isArray(v.repos)
    ? v.repos.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    : [];
  return { kind, interfaceId, detail, repos };
}

function renderReconcileReport(result: ReconcileResult, unresolved: ReconcileUnresolved[]): string {
  const lines = [
    '# 跨仓契约 · owner 对账报告',
    `跨仓接口: ${result.interfaces.length} 条`,
    `对账状态: ${unresolved.length === 0 ? '✅ 全咬合' : `⚠️ ${unresolved.length} 处未决`}`,
  ];
  if (unresolved.length > 0) {
    lines.push('', '## 未决（冲突 / 悬空）— 需人裁决后回改对应单仓设计');
    for (const u of unresolved) {
      const tag = u.kind === 'dangling' ? '悬空' : '冲突';
      lines.push(
        `- [${tag}] ${u.interfaceId}: ${u.detail}${u.repos.length ? `（${u.repos.join(', ')}）` : ''}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
