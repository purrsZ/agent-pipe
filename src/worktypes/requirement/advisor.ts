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
