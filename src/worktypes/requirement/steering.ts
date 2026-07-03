import type { EffectContext, EffectHandler } from '../../workitems/effects.js';
import type { ContractSnapshot } from './contract.js';
import { PHASE } from './phases.js';

// WS-2 消息必达：owner steer 通道（OVERHAUL 核心）。非终态需求单的每条群消息都有真实消费路径——人可
// 随时插话（改方向 / 追问 / 给返工意见），包工头（steer run）读到后回话并可触发结构化动作。本文件 = 纯核心
// （prompt 组装 / 指令解析 / steering note 路径 / 契约摘要）+ 一个 idempotent（recovery:'rerun'）的
// steer_apply effect。包工头「读群消息 + 答复 + 判断是否调整」是 AI 活（live 半）；这里做的是解析它产出的
// 结构化指令 + 落 steering note + emit steer_directive（下游 worktype 分支按 action 精确路由）。

export type SteerAction = 'none' | 'redo_reconcile' | 'rework' | 'raise_human';

export interface SteerDirective {
  action: SteerAction;
  repos: string[]; // 仅 rework 有意义：受影响仓（已按 workitem.repos 过滤）
  note: string; // 给工人的返工说明 / raise_human 时要人裁决什么
}

const EMPTY_DIRECTIVE: SteerDirective = { action: 'none', repos: [], note: '' };

// steer/advise 共享的上下文输入（除各自的角色句 / followups / 产出要求外的中段）。参谋（advise）复用它，
// 保证它看到与包工头（steer）逐字节一致的全景（立项书 / 契约摘要 / 回执 / 监工日志 / 集成报告）。
export interface AdvisoryContext {
  title: string;
  phase: string;
  repos: string[];
  intakeBrief?: string;
  contractSummary?: string; // 条数 + 逐条 signature
  gatekeeperLog?: string;
  integrationReport?: string;
  recentReports?: string[]; // 各仓最近回执（已截断）
  priorSteerReport?: string;
  digest?: string; // ENHANCE E2：大事记摘要（renderEventDigest 产物），织入「当前阶段」之后、「涉及仓库」之前
}

// 共享上下文中段（从「# 需求」到「上一轮答复」）：steer 与 advise 织入同一份上下文。角色句、followups、
// 产出要求由各 compose 自己拼。返回以空行打头，供角色句之后直接 push（与旧 composeSteerPrompt 逐字节等价）。
export function buildContextLines(input: AdvisoryContext): string[] {
  const repoList = input.repos.filter((r) => typeof r === 'string' && r.trim().length > 0);
  const lines: string[] = ['', '# 需求', input.title];
  if (input.intakeBrief?.trim()) {
    lines.push('', '# 立项书（前置已收齐的需求材料，据此推进）', input.intakeBrief.trim());
  }
  lines.push('', '# 当前阶段', phaseHuman(input.phase));
  if (input.digest?.trim()) {
    lines.push('', '# 本单大事记（供你了解全程来龙去脉）', input.digest.trim());
  }
  if (repoList.length > 0) {
    lines.push('', '# 涉及的仓库（绝对路径）', ...repoList.map((r) => `- ${r}`));
  }
  if (input.contractSummary?.trim()) {
    lines.push('', '# 跨仓契约摘要', input.contractSummary.trim());
  }
  const reports = (input.recentReports ?? []).filter((r) => r?.trim());
  if (reports.length > 0) {
    lines.push('', '# 各仓最近回执（改了什么 / 自测结果）');
    reports.forEach((r, i) => {
      lines.push('', `## 回执 ${i + 1}`, r.trim());
    });
  }
  if (input.gatekeeperLog?.trim()) {
    lines.push('', '# 监工裁决日志', input.gatekeeperLog.trim());
  }
  if (input.integrationReport?.trim()) {
    lines.push('', '# 集成报告', input.integrationReport.trim());
  }
  if (input.priorSteerReport?.trim()) {
    lines.push('', '# 上一轮你的答复（延续，不要重复）', input.priorSteerReport.trim());
  }
  return lines;
}

// ── compose：包工头「答复用户 + 决定是否调整施工」的 prompt（纯函数，对齐 composeOwnerPrompt 织入风格）──
export function composeSteerPrompt(
  input: AdvisoryContext & {
    followups: string[]; // 用户这批话（run-handler 已算好）——最高优先级
  },
): string {
  const lines: string[] = [
    '你是这个需求的包工头，负责在推进过程中**答复用户在群里说的话**并决定是否调整施工。',
    '你只读浏览相关仓库，不改代码（改代码是各仓 worker 的事）。',
  ];
  lines.push(...buildContextLines(input));
  lines.push(
    '',
    '# 用户这批话（最高优先级，请据此答复 / 决定调整）',
    ...(input.followups.length > 0 ? input.followups.map((f) => `- ${f}`) : ['（无新消息）']),
  );
  lines.push(
    '',
    '# 产出要求（务必遵守）',
    '1. 报告主体 = 面向用户的中文答复（会以卡片贴回群，直接跟用户说话，别写内部术语流水账）。',
    '2. 在报告**最末尾**输出且仅输出一个 ```steer 代码块，承载结构化动作：',
    '```steer',
    '{ "action": "none | redo_reconcile | rework | raise_human",',
    '  "repos": ["受影响仓绝对路径（仅 rework 填，必须取自上面的涉及仓库清单）"],',
    '  "note": "给工人的返工说明 / 或 raise_human 时要人裁决什么" }',
    '```',
    '选择规则：只是答疑 / 确认 → none；用户对跨仓契约或拆解结论提出修改 → redo_reconcile；用户要求改某仓',
    '的实现方向 → rework（repos 只填清单内的仓）；拿不准、或用户要求超出当前需求范围 → raise_human（疑则上报）。',
  );
  return lines.join('\n');
}

// ── parse：从报告末尾抽 ```steer / ```json 块，取最后一个有效块。永不抛——坏块 / 无块 / 非法 action → none ─
export function parseSteerDirective(report: string): SteerDirective {
  if (typeof report !== 'string' || report.length === 0) return EMPTY_DIRECTIVE;
  let result = EMPTY_DIRECTIVE;
  for (const body of steerBlocks(report)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const coerced = coerceDirective(parsed);
    if (coerced) result = coerced; // 取最后一个有效块（前面可能有示例）
  }
  return result;
}

// steering note 路径：steering/<sanitized>.md。sanitize 与 worktree.ts 保持一致（纯核心不能 import agents 层）。
export function steeringNotePath(repo: string): string {
  return `steering/${sanitize(repo)}.md`;
}

// 契约摘要（喂 steer prompt）：条数 + 逐条 signature。空契约给一句话。
export function renderContractSummary(contract: ContractSnapshot): string {
  const n = contract.interfaces.length;
  if (n === 0) return '（本单无跨仓契约）';
  const lines = [`跨仓契约 ${n} 条接口：`];
  for (const i of contract.interfaces) lines.push(`- ${i.signature}`);
  return lines.join('\n');
}

// ── steer_apply effect（recovery:'rerun'，幂等：重跑重读同一报告 / 重写同一 note / 重 emit 同一事件）──
export function createSteerApplyHandler(): EffectHandler {
  return { kind: 'steer_apply', recovery: 'rerun', run: steerApply };
}

async function steerApply(ctx: EffectContext): Promise<void> {
  const payload = ctx.effect.payload;
  const reportPath =
    isObject(payload) && typeof payload.reportPath === 'string' ? payload.reportPath : undefined;
  if (!reportPath) return; // 防御：无报告路径无从消费
  const report = ctx.readArtifact(reportPath);
  if (!report) {
    ctx.emit('steer_directive', { action: 'none', repos: [], note: '' });
    return;
  }
  const d = parseSteerDirective(report);
  let repos = d.repos;
  if (d.action === 'rework') {
    const inScope = new Set(ctx.workitem.repos);
    repos = d.repos.filter((r) => inScope.has(r));
    for (const dropped of d.repos.filter((r) => !inScope.has(r))) {
      ctx.logger?.info?.({ repo: dropped }, 'steer rework 指向清单外的仓 → 丢弃');
    }
    const ts = new Date(ctx.clock.now()).toISOString();
    for (const repo of repos) {
      const notePath = steeringNotePath(repo);
      const prev = ctx.readArtifact(notePath) ?? '';
      ctx.writeArtifact(notePath, `${prev}\n\n## ${ts}\n${d.note}`.trimStart(), 'steer 指示追加');
    }
  }
  // action 为 none 也 emit（审计留痕 + 锚点刷新）；下游 worktype 分支需幂等消费（WS-2.3）。
  ctx.emit('steer_directive', { action: d.action, repos, note: d.note });
}

// ── helpers (pure) ──────────────────────────────────────────────────────────────────────
function phaseHuman(phase: string): string {
  switch (phase) {
    case PHASE.split:
      return '拆解中（跨仓对账）';
    case PHASE.implement:
      return '并行实现中（各仓施工）';
    case PHASE.integrate:
      return '集成验证中';
    case PHASE.deliver:
      return '交付待关单';
    default:
      return phase;
  }
}

function steerBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m = re.exec(text);
  while (m !== null) {
    const tag = (m[1] ?? '').trim();
    if (/^steer\b/i.test(tag) || /^json\b/i.test(tag)) out.push(m[2] ?? '');
    m = re.exec(text);
  }
  return out;
}

function coerceDirective(value: unknown): SteerDirective | undefined {
  if (!isObject(value)) return undefined;
  const action = value.action;
  if (
    action !== 'none' &&
    action !== 'redo_reconcile' &&
    action !== 'rework' &&
    action !== 'raise_human'
  ) {
    return undefined;
  }
  const repos = Array.isArray(value.repos)
    ? value.repos.filter((r): r is string => typeof r === 'string')
    : [];
  const note = typeof value.note === 'string' ? value.note : '';
  return { action, repos, note };
}

// 与 src/agents/worktree.ts 的 sanitize 保持一致（worktypes 纯核心不能 import agents 层，复制该正则）。
function sanitize(repo: string): string {
  return repo.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'repo';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
