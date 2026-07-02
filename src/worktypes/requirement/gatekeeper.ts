import type { EffectContext, EffectHandler } from '../../workitems/effects.js';
import type { WorkItemEvent } from '../../workitems/types.js';
import { type ContractSnapshot, EMPTY_SNAPSHOT } from './contract.js';

// 监工科层域（PIVOT《设计外置·实现聚焦》§4，worktypes 层）。
//
// 实现中发现小问题可以就地修正、继续跑；但「小 vs 大」由谁判定是命门——不能交给写实现的工人（运动员当
// 裁判会自我宽容偷工），要交给一个**与实现解耦的独立监工**。本机制：
//   工人（图纸只读，无编辑权）撞到图纸疑问 → 「疑则上报」（报告末尾一个 ```gatekeeper 块）→
//   监工 review → 判「小」：回写图纸 + 继续 / 判「大」：raise 人 wait。**跨仓外溢 ≈ 自动判大**。
//
// 五条铁律的落点：
//   #1 监工疑则判大（疑罪从有）：工人声明了 interfaceId（自认碰了跨仓契约）→ 一律判大（在契约里=确凿跨仓
//      外溢；不在契约里=拿不准，仍判大）。只有「纯本仓、没碰任何契约接口」才判小。
//   #2 放行必留痕 + 回写图纸：每次裁决（含判小放行）都写进 contract/gatekeeper-log.md。
//   #3 人划红线锚：冻结的跨仓契约（contract.json 的 interfaces）就是红线；碰它即大。
//   #4 跨仓外溢 ≈ 自动判大：见 #1（结构化、确定）。
//   #5 工人疑则上报做廉价一级分流：工人只判「要不要上报」（疑则报、只会多报），不判放行。
//
// 本文件 = 该域纯核心（上报解析 + 结构化判定 + 回写渲染）+ 一个 idempotent 的 gatekeeper_review effect。
// **独立监工 AI subagent**（对灰色地带——「本仓改动会不会隐性外溢」——做对抗式判断）是 live 半，叠在这层
// 结构化骨架之上（与 integration_check「读各端代码做更深对账」是 live 同构）。

export type GatekeeperVerdict = 'big' | 'small';

export interface WorkerRaise {
  repo: string; // 上报的工人仓（可空——非判定要素，仅供病历定位）
  interfaceId: string; // 碰到的跨仓契约接口 id（非空 ⇒ 跨仓外溢/疑则 ⇒ 大；空 ⇒ 纯本仓 ⇒ 小）
  question: string; // 上报内容（要偏离/要协调什么）
}

export interface GatekeeperResult {
  big: WorkerRaise[]; // 判大（跨仓外溢/疑则）→ raise 人
  small: WorkerRaise[]; // 判小（纯本仓）→ owner 自治放行 + 回写图纸留痕
}

// ── 上报解析：从工人报告里抽 ```gatekeeper 块。永不抛——无块/坏 JSON → []。 ──────────────────────
export function parseWorkerRaises(report: string): WorkerRaise[] {
  if (typeof report !== 'string' || report.length === 0) return [];
  let result: WorkerRaise[] = [];
  for (const body of gatekeeperBlocks(report)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const raises = coerceRaises(parsed);
    if (raises.length > 0) result = raises; // 取最后一个有内容的块
  }
  return result;
}

// ── 结构化判定（纯，rule #1/#4）：声明了 interfaceId ⇒ 大（碰跨仓契约/疑则判大）；否则纯本仓 ⇒ 小。 ──
//    contract 仅用于在日志里区分「确凿跨仓外溢（接口在契约里）」与「疑则判大（接口不在契约里）」，判定都为大。
export function gatekeeperVerdict(raise: WorkerRaise): GatekeeperVerdict {
  return raise.interfaceId.trim().length > 0 ? 'big' : 'small';
}

export function partitionRaises(raises: WorkerRaise[]): GatekeeperResult {
  const big: WorkerRaise[] = [];
  const small: WorkerRaise[] = [];
  for (const r of raises) (gatekeeperVerdict(r) === 'big' ? big : small).push(r);
  return { big, small };
}

// 是否「确凿跨仓外溢」（接口在冻结契约里）vs「疑则判大」（接口名不在契约里）——仅影响日志措辞。
function spilloverKind(raise: WorkerRaise, contract: ContractSnapshot): string {
  if (raise.interfaceId.trim().length === 0) return '本仓';
  return contract.interfaces.some((i) => i.id === raise.interfaceId) ? '跨仓外溢' : '疑则判大';
}

export function renderGatekeeperLog(result: GatekeeperResult, contract: ContractSnapshot): string {
  const lines = [
    '# 监工裁决 · 回写图纸（留痕）',
    `判大（raise 人）: ${result.big.length} 件 ｜ 判小（自治放行）: ${result.small.length} 件`,
  ];
  if (result.small.length > 0) {
    lines.push('', '## 判小 · 已放行（纯本仓，owner 自治；下次拿图纸者据此知现状）');
    for (const r of result.small) {
      lines.push(`- [${r.repo || '本仓'}] ${r.question}`);
    }
  }
  if (result.big.length > 0) {
    lines.push('', '## 判大 · 已 raise 人（待裁决后改图纸 / 返工）');
    for (const r of result.big) {
      lines.push(
        `- [${spilloverKind(r, contract)}] ${r.interfaceId}: ${r.question}${r.repo ? `（${r.repo}）` : ''}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

// ── gatekeeper_review effect（与 integration_check 同构）：纯只读裁决，crash 后重跑幂等。 ─────────────
//    扫各仓工人完成回执（run_completed 报告）→ 抽上报 → 判大/小 → 回写图纸 → emit gatekeeper_passed/_big。
export function createGatekeeperReviewHandler(): EffectHandler {
  return {
    kind: 'gatekeeper_review',
    recovery: 'rerun',
    run: gatekeeperReview,
  };
}

async function gatekeeperReview(ctx: EffectContext): Promise<void> {
  const raises: WorkerRaise[] = [];
  for (const reportPath of reportPathsFrom(ctx.eventsSince(0))) {
    const report = ctx.readArtifact(reportPath);
    if (report) raises.push(...parseWorkerRaises(report));
  }
  const result = partitionRaises(raises);
  const contract = readSnapshot(ctx.readArtifact('contract/contract.json'));
  ctx.writeArtifact(
    'contract/gatekeeper-log.md',
    renderGatekeeperLog(result, contract),
    '监工裁决回写图纸',
  );
  if (result.big.length > 0) {
    ctx.emit('gatekeeper_big', { raises: result.big });
  } else {
    ctx.emit('gatekeeper_passed', { approved: result.small.length });
  }
}

// ── helpers (pure) ──────────────────────────────────────────────────────────────────────
function reportPathsFrom(events: WorkItemEvent[]): string[] {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.kind !== 'run_completed') continue;
    const p = ev.payload;
    if (isObject(p) && typeof p.reportPath === 'string') out.push(p.reportPath);
  }
  return out;
}

function gatekeeperBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec drain loop
  while ((m = re.exec(text)) !== null) {
    const tag = (m[1] ?? '').trim();
    if (/^gatekeeper\b/i.test(tag) || /^json\b/i.test(tag)) out.push(m[2] ?? '');
  }
  return out;
}

function coerceRaises(value: unknown): WorkerRaise[] {
  if (!isObject(value) || !Array.isArray(value.raises)) return [];
  const out: WorkerRaise[] = [];
  for (const r of value.raises) {
    if (!isObject(r)) continue;
    const question = asString(r.question);
    if (!question) continue; // 没说清要协调什么 → 丢
    out.push({
      repo: asString(r.repo),
      interfaceId: asString(r.interfaceId),
      question,
    });
  }
  return out;
}

function readSnapshot(raw: string | undefined): ContractSnapshot {
  if (!raw) return EMPTY_SNAPSHOT;
  try {
    const parsed = JSON.parse(raw) as ContractSnapshot;
    return parsed && Array.isArray(parsed.interfaces) ? parsed : EMPTY_SNAPSHOT;
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
