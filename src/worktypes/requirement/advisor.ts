import type { WorkItemEvent } from '../../workitems/types.js';
import { type AdvisoryContext, buildContextLines } from './steering.js';

// 事故参谋域（ENHANCE E1，worktypes 层纯核心）。
//
// 三权分立里参谋是新增的第三条链：判定 = 监工（机器，铁面）；裁决 + 改图纸 = 人；**建议 = 参谋（AI，只出主意）**。
// 出问题（监工判大 / 跨仓对账冲突 / 集成验证修不动）时，机器直出的事故卡先弹给人；同时自动派一个「参谋」只读
// owner run（stage=advise），读全部上下文 → 产出解读 + 建议方案贴回群，供人裁决前参考。参谋零行动权：收尾无
// 任何流转（见 index.ts 的 onRunCompleted advise 分支）；即便报告里出现 ```steer 块也无人消费。
//
// 本文件全是纯同步函数、无 IO：把三类事故事件的 payload 机械渲染成人话事故单（renderXxxIncident），再拼成
// 参谋 prompt（composeAdvisePrompt，复用 steering 的共享上下文中段——参谋看到与包工头逐字节一致的全景）。
// 渲染函数一律防御式：坏 payload 回落「(事故详情缺失)」，永不抛（事故单缺字段不该把参谋 run 拖崩）。

// ── 事故单渲染（纯，防御式）：从事故事件 payload 抽关键字段拼成人话 + 机械明细，喂参谋 prompt。 ──────────

// 监工判大：payload = { raises: WorkerRaise[] }（repo / interfaceId / question）。
export function renderGatekeeperIncident(payload: unknown): string {
  const head =
    '事故类型：监工判大——并行实现阶段，工人改动疑似跨仓外溢或触碰了冻结的跨仓契约，已被拦下等你裁决。';
  const items = asArray(asObject(payload).raises)
    .map((r) => {
      const o = asObject(r);
      const iface = asString(o.interfaceId);
      const q = asString(o.question);
      if (!iface && !q) return '';
      return `- [${asString(o.repo) || '本仓'}] ${iface ? `接口 ${iface}` : '（未指明接口）'}：${q || '(未说明)'}`;
    })
    .filter((s) => s.length > 0);
  return items.length > 0 ? [head, '判大明细：', ...items].join('\n') : `${head}\n(事故详情缺失)`;
}

// 跨仓对账冲突：payload = { unresolved: ReconcileUnresolved[] }（kind / interfaceId / detail / repos）。
export function renderReconcileIncident(payload: unknown): string {
  const head =
    '事故类型：跨仓对账冲突——拆解阶段，owner 对账发现各仓契约声明对不上或有悬空依赖，已被拦下等你裁决。';
  const items = asArray(asObject(payload).unresolved)
    .map((u) => {
      const o = asObject(u);
      const detail = asString(o.detail);
      if (!detail) return '';
      const repos = asStringList(o.repos);
      const kind = o.kind === 'dangling' ? '悬空' : '冲突';
      const iface = asString(o.interfaceId) || '(未指明接口)';
      return `- [${kind}] ${iface}：${detail}${repos.length ? `（涉及：${repos.join('、')}）` : ''}`;
    })
    .filter((s) => s.length > 0);
  return items.length > 0 ? [head, '未决明细：', ...items].join('\n') : `${head}\n(事故详情缺失)`;
}

// 集成验证修不动：payload = { round, affectedRepos, breaking:[{interfaceId,kind}], semanticFlagged }。
export function renderIntegrationIncident(payload: unknown): string {
  const o = asObject(payload);
  const head = '事故类型：集成验证修不动——集成阶段连续多轮修复仍有破坏性差异，已被拦下等你裁决。';
  const round = typeof o.round === 'number' && Number.isFinite(o.round) ? o.round : undefined;
  const repos = asStringList(o.affectedRepos);
  const breaking = asArray(o.breaking)
    .map((b) => {
      const bo = asObject(b);
      const iface = asString(bo.interfaceId);
      return iface ? `${iface}${asString(bo.kind) ? `:${asString(bo.kind)}` : ''}` : '';
    })
    .filter((s) => s.length > 0);
  const detail: string[] = [];
  if (round !== undefined) detail.push(`已到第 ${round} 轮仍未通过。`);
  if (repos.length) detail.push(`受影响仓：${repos.join('、')}`);
  if (breaking.length) detail.push(`破坏性差异：${breaking.join('；')}`);
  return detail.length > 0 ? [head, ...detail].join('\n') : `${head}\n(事故详情缺失)`;
}

// ── compose：参谋 prompt（只读、只出建议；复用 steering 的共享上下文中段，看到与包工头一致的全景）。 ─────
export function composeAdvisePrompt(
  input: AdvisoryContext & {
    followups: string[]; // 参谋跑动期间用户又说的话（steer 的超集姿态：一并回应，保证消息必达）
    incident: string; // 渲染好的事故单（renderXxxIncident 产物）
  },
): string {
  const lines: string[] = [
    '你是这个需求的参谋。流程出了一个需要人裁决的问题（见下方事故单）。你的任务是**替人把问题研究透并给出',
    '可执行的建议**，供他拍板参考。你只读浏览、只出建议——判定已由监工做出，裁决和改图纸的权力在人。你可以',
    '直接翻阅所有涉及仓的代码来验证你的判断。',
    '',
    '# 事故单（机器判定，未经解读）',
    input.incident.trim() || '(事故详情缺失)',
  ];
  lines.push(...buildContextLines(input));
  if (input.followups.length > 0) {
    lines.push(
      '',
      '# 用户这批话（参谋分析期间用户又说了话，请在建议里一并回应）',
      ...input.followups.map((f) => `- ${f}`),
    );
  }
  lines.push(
    '',
    '# 产出要求（你的建议会以卡片贴回群，供人参考）',
    '1. 这个问题是什么、为什么会被拦下（讲人话，别复述术语）；',
    '2. 影响面：波及哪些仓 / 哪些接口 / 哪些已完成的工作；',
    '3. 建议方案 A / B（各自的改法、代价、风险），并明确推荐哪一个；',
    '4. 若需要改图纸：具体建议改哪个文件的哪一节、怎么改（给出可直接抄的文字）；',
    '5. 结尾固定加上这句提示：「以上仅供参考。请在上方事故卡的意见框写下你的裁决理由或对建议的修正，再点',
    '按钮——你的话会被下一轮执行读到。」',
  );
  return lines.join('\n');
}

// ── 大事记摘要（ENHANCE E2）：把事件流渲染成人话时间线，供 steer/advise 了解全程来龙去脉（解决包工头「记忆
// 靠接力、长链衰减」的痛点，也让参谋知晓全程）。requirement 纯核心解释自己的事件流合规；容器/agent-run 层只
// opaque 透传事件（中性），解释权在这里。 ──────────────────────────────────────────────────────────────
const MAX_DIGEST_LINES = 40;
const MAX_DIGEST_CHARS = 2500;
const DIGEST_HEAD_KEEP = 6;

export function renderEventDigest(events: WorkItemEvent[]): string {
  const lines = asArray(events)
    .map((e) => renderEventLine(e))
    .filter((l) => l.length > 0);
  if (lines.length === 0) return '';
  return boundDigest(lines).join('\n');
}

// 上界：≤40 行 / ≤2500 字符，超出保头（立项/拆解节点）保尾（最近事件），中间折叠为「-（中间 N 件事略）」。
function boundDigest(lines: string[]): string[] {
  if (lines.length <= MAX_DIGEST_LINES && lines.join('\n').length <= MAX_DIGEST_CHARS) return lines;
  const head = lines.slice(0, DIGEST_HEAD_KEEP);
  const headChars = head.join('\n').length;
  const tail: string[] = [];
  let tailChars = 0;
  // 尾部从最近事件往前收，撞行数或字符上界即停（预留 40 字符给折叠行）。
  for (let i = lines.length - 1; i >= DIGEST_HEAD_KEEP; i--) {
    const line = lines[i] ?? '';
    if (head.length + tail.length + 1 >= MAX_DIGEST_LINES) break;
    if (headChars + tailChars + line.length + 40 > MAX_DIGEST_CHARS) break;
    tail.unshift(line);
    tailChars += line.length + 1;
  }
  const omitted = lines.length - head.length - tail.length;
  return omitted > 0 ? [...head, `-（中间 ${omitted} 件事略）`, ...tail] : [...head, ...tail];
}

// 单事件 → 一行「- [MM-DD HH:mm] 事实」。只渲染人关心的节点，其余跳过。防御式：坏 payload 降级为 kind 名。
function renderEventLine(ev: unknown): string {
  const e = asObject(ev);
  const kind = asString(e.kind);
  const prefix = `- [${stampOf(e.createdAt)}] `;
  const p = asObject(e.payload);
  try {
    switch (kind) {
      case 'phase_changed':
        return `${prefix}进入「${asString(p.to) || '?'}」${phaseReasonHuman(asString(p.reason))}`;
      case 'wait_resolved': {
        // 容器 resolve（origin_terminal 等）无 decision → 非人裁决，跳过。人裁决带 decision + reason(意见原文)。
        if (p.decision === undefined) return '';
        const opinion = asString(p.reason);
        const approved = asObject(p.decision).approved === true;
        return `${prefix}人裁决：${approved ? '通过' : '打回'}${opinion ? `（意见：${truncate(opinion, 60)}）` : ''}`;
      }
      case 'gatekeeper_big': {
        const r = asObject(asArray(p.raises)[0]);
        const iface = asString(r.interfaceId);
        const repo = asString(r.repo);
        return `${prefix}监工判大${iface ? `：接口 ${iface}` : ''}${repo ? `（${repo}）` : ''}`;
      }
      case 'steer_directive': {
        const action = asString(p.action) || 'none';
        if (action === 'none') return ''; // 审计留痕、无实质动作 → 跳过
        const note = asString(p.note);
        return `${prefix}包工头指令：${action}${note ? `（${truncate(note, 40)}）` : ''}`;
      }
      case 'rework_requested': {
        const repos = asStringList(p.repos);
        return `${prefix}定向返工${repos.length ? `：${repos.join('、')}` : ''}`;
      }
      case 'integration_check_failed':
        return `${prefix}集成验证第 ${numberOr(p.round, 1)} 轮未过`;
      case 'run_failed': {
        const role = asString(p.role);
        const repo = asString(p.repo);
        return `${prefix}执行报错${role ? `：${role}` : ''}${repo ? `（${repo}）` : ''}`;
      }
      case 'manifest_ready':
        return `${prefix}交付清单已生成`;
      default:
        return ''; // 其余 kind 一律跳过
    }
  } catch {
    return kind ? `${prefix}${kind}` : '';
  }
}

// phase_changed 的 reason → 人话（lite_single_repo=单仓直跳 等）。未知 reason 原样括号显示。
function phaseReasonHuman(reason: string): string {
  switch (reason) {
    case 'created':
      return '（立项）';
    case 'intake_ready':
      return '（立项料齐）';
    case 'lite_single_repo':
      return '（单仓直跳实现）';
    case 'reconcile_passed':
      return '（对账通过）';
    case 'lite_skip_assess':
      return '（单仓跳过评估）';
    case 'workers_done':
      return '（施工完成）';
    case 'integration_passed':
      return '（集成通过）';
    case 'checkpoint_approved':
      return '（关卡放行）';
    default:
      return reason ? `（${reason}）` : '';
  }
}

// 时间戳 MM-DD HH:mm（本地时区，供人看）。createdAt 缺失回落 epoch 0，永不抛。
function stampOf(createdAt: unknown): string {
  const ms = typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// ── helpers (pure, 防御式) ────────────────────────────────────────────────────────────────
function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringList(value: unknown): string[] {
  return asArray(value).filter((x): x is string => typeof x === 'string' && x.length > 0);
}
