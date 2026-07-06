import type { EffectContext, EffectHandler } from '../../workitems/effects.js';

// INTAKE L1 勘探（scout）纯核心（worktypes 层；业务词可用，本文件保持纯：无 async/await/fs/child_process）。
// 立项收料时用户只给了仓名线索（「就在 alaeatposapp 里」）而非绝对路径、登记表也兜不住 → 派一个只读
// owner run 到搜索根内找候选仓、验证是 git 仓、拿证据帮用户确认。本文件做的是：
//   1) composeScoutPrompt —— 勘探员 prompt 组装（角色 / 线索 / 登记快照 / 搜索根 / 方法提示 / 产出格式）；
//   2) parseScoutResult —— 从报告末尾抽 ```scout 块的纯解析（永不抛，坏块 → 全空）；
//   3) scout_apply effect —— 读报告 → parse → emit scout_result（桥层据它当场校验入表 / 出歧义卡）。
// AI 真「浏览磁盘找仓 + 判断」是 live 半（run 自己干）；这里只组 prompt / 解析结构化产物 / 中性搬运。
//
// D-1 红线：勘探只读、只产候选；一切候选入表**必须过桥层既有的当场校验**（真 git 仓），gate 与必填清单不动。

export interface ScoutAmbiguity {
  question: string; // 「找到两个 alaeatposapp，用哪个？」
  options: string[]; // 带证据的候选（「/a/alaeatposapp（3 天前有提交）」…）
}

// INTAKE L2：确定仓后顺路进仓找到的立项材料候选（path 为仓内相对路径，summary ≤200 字）。桥层对**空字段**
// 才注入，值带来源标记，人可覆盖。诚实边界：只把「料在哪」递到人眼前，gate 必填语义不变。
export interface ScoutMaterialItem {
  path: string;
  summary: string;
}
export interface ScoutMaterials {
  prd?: ScoutMaterialItem;
  acceptance?: ScoutMaterialItem;
  background?: { summary: string }; // 背景无固定文件，只给摘要
}

export interface ScoutResult {
  repos: string[]; // 确定无歧义的仓绝对路径（唯一命中 / 证据压倒性）
  ambiguities: ScoutAmbiguity[]; // 拿不准 → 问人（疑则问，与监工同姿态）
  notFound: string[]; // 实在找不到的线索原词
  materials?: ScoutMaterials; // INTAKE L2 仓内收料（可选）
}

const EMPTY_RESULT: ScoutResult = { repos: [], ambiguities: [], notFound: [] };

// ── compose：勘探员 prompt（纯函数，对齐 composeAdvise/composeReconcile 织入风格）─────────────────
export function composeScoutPrompt(input: {
  title: string;
  hints: string; // 用户给的仓库线索原文（/scout 后的文字 / 抽取的 repoHints 拼接）
  roots: string[]; // 可读搜索根（登记表父目录去重 ∪ env INTAKE_SCOUT_ROOTS）
  registrySnapshot: string; // 已知仓库登记表快照（先查表再搜盘）
  summary?: string; // 需求一句话摘要（帮它判断哪个仓更相关）
}): string {
  const lines: string[] = [
    '你是立项勘探员。用户提到了仓库线索但没给绝对路径，你的任务：在给定搜索根内找到候选仓、验证它是',
    'git 仓、拿证据帮用户确认。你只读浏览，不改任何东西（不 clone、不写文件、不跑构建）。',
    '',
    '# 需求',
    input.title,
  ];
  if (input.summary?.trim()) {
    lines.push('', '# 一句话摘要（帮你判断哪个仓更相关）', input.summary.trim());
  }
  lines.push('', '# 用户给的仓库线索', input.hints.trim() || '（未给具体线索，请据需求标题推断）');
  lines.push(
    '',
    '# 已知仓库登记表（先查这里，命中直接用；兜不住再搜盘）',
    input.registrySnapshot.trim() || '（登记表为空）',
  );
  if (input.roots.length > 0) {
    lines.push('', '# 可搜索的根目录（只在这些目录内浏览）', ...input.roots.map((r) => `- ${r}`));
  } else {
    lines.push('', '# 可搜索的根目录', '（无——无法搜盘，只能靠上面的登记表）');
  }
  lines.push(
    '',
    '# 方法提示',
    '- 先用 `ls` 在搜索根内找同名/近名目录；对每个候选用 `git -C <路径> rev-parse --show-toplevel` 确认是 git 仓。',
    '- 用 `git -C <路径> log -1 --format=%ci` 看最近提交时间判断活跃度；同名多候选时比较最近提交、远端、',
    '  README 与本需求的相关性，帮用户区分。',
    '- 确定仓后（repos 唯一），可**顺路进仓找立项材料**：设计文档 / PRD / README 里的验收标准与范围/背景',
    '  描述，把「料在哪 + 一句话摘要」递到用户眼前（仅候选，人在立项卡上确认；找不到就不填）。',
    '',
    '# 产出要求（务必遵守）',
    '1. 报告主体 = 面向用户的中文说明：你找到了什么、凭什么判断（会以卡片贴回群，直接跟用户说话）。',
    '2. 在报告**最末尾**输出且仅输出一个 ```scout 代码块，承载结构化结果：',
    '```scout',
    '{ "repos": ["确定无歧义的仓绝对路径"],',
    '  "ambiguities": [{ "question": "找到两个 alaeatposapp，用哪个？",',
    '                    "options": ["/a/alaeatposapp（3 天前有提交）", "/b/alaeatposapp（半年未动）"] }],',
    '  "notFound": ["实在找不到的线索原词"],',
    '  "materials": { "prd": {"path": "仓内相对路径", "summary": "≤200字摘要"},',
    '                 "acceptance": {"path": "仓内相对路径", "summary": "≤200字摘要"},',
    '                 "background": {"summary": "≤200字背景摘要"} } }',
    '```',
    '规则：确定 = 唯一命中或证据压倒性 → 放 repos；拿不准一律进 ambiguities 问人（疑则问）；实在找不到的',
    '进 notFound。materials 全部可选，只填真在仓里找到的（没找到就省略该键，别编）。**绝不编造路径**——',
    '没在磁盘上验证过是 git 仓的路径，绝不放进 repos。',
  );
  return lines.join('\n');
}

// ── parse：从报告末尾抽 ```scout / ```json 块，取最后一个有效块。永不抛——坏块 / 无块 → 全空 ─────────
export function parseScoutResult(report: string): ScoutResult {
  if (typeof report !== 'string' || report.length === 0) return EMPTY_RESULT;
  let result = EMPTY_RESULT;
  for (const body of scoutBlocks(report)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const coerced = coerceResult(parsed);
    if (coerced) result = coerced; // 取最后一个有效块（前面可能有示例）
  }
  return result;
}

// ── scout_apply effect（recovery:'rerun'，幂等：重跑重读同一报告、重 emit 同一结果，emit-only 天然幂等）──
export function createScoutApplyHandler(): EffectHandler {
  return { kind: 'scout_apply', recovery: 'rerun', run: scoutApply };
}

async function scoutApply(ctx: EffectContext): Promise<void> {
  const payload = ctx.effect.payload;
  const reportPath =
    isObject(payload) && typeof payload.reportPath === 'string' ? payload.reportPath : undefined;
  // 无报告路径 / 报告读不到 → emit 全空（审计留痕 + 锚点刷新）；桥层消费全空是 no-op（notFound 也空）。
  const report = reportPath ? ctx.readArtifact(reportPath) : undefined;
  const r = report ? parseScoutResult(report) : EMPTY_RESULT;
  ctx.emit('scout_result', {
    repos: r.repos,
    ambiguities: r.ambiguities,
    notFound: r.notFound,
    // INTAKE L2：materials 一并透传（可选）；无则省略，桥层消费缺省是 no-op。
    ...(r.materials ? { materials: r.materials } : {}),
  });
}

// ── helpers (pure) ────────────────────────────────────────────────────────────────────────
function scoutBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m = re.exec(text);
  while (m !== null) {
    const tag = (m[1] ?? '').trim();
    if (/^scout\b/i.test(tag) || /^json\b/i.test(tag)) out.push(m[2] ?? '');
    m = re.exec(text);
  }
  return out;
}

function coerceResult(value: unknown): ScoutResult | undefined {
  if (!isObject(value)) return undefined;
  const repos = stringArray(value.repos);
  const notFound = stringArray(value.notFound);
  const ambiguities = Array.isArray(value.ambiguities)
    ? value.ambiguities.map(coerceAmbiguity).filter((a): a is ScoutAmbiguity => a !== undefined)
    : [];
  const materials = coerceMaterials(value.materials);
  // 四者全空的块视为无效（防把只含空数组的坏块当有效结果覆盖）——但下游允许全空 emit（scoutApply 兜底）。
  if (repos.length === 0 && ambiguities.length === 0 && notFound.length === 0 && !materials) {
    return undefined;
  }
  return materials ? { repos, ambiguities, notFound, materials } : { repos, ambiguities, notFound };
}

// INTAKE L2：解析 materials（全部可选；path/summary 非字符串或空则丢该键；无有效键 → undefined）。
function coerceMaterials(value: unknown): ScoutMaterials | undefined {
  if (!isObject(value)) return undefined;
  const out: ScoutMaterials = {};
  const prd = coerceMaterialItem(value.prd);
  if (prd) out.prd = prd;
  const acceptance = coerceMaterialItem(value.acceptance);
  if (acceptance) out.acceptance = acceptance;
  const bg = isObject(value.background) ? value.background.summary : undefined;
  if (typeof bg === 'string' && bg.trim().length > 0) out.background = { summary: bg.trim() };
  return out.prd || out.acceptance || out.background ? out : undefined;
}

function coerceMaterialItem(value: unknown): ScoutMaterialItem | undefined {
  if (!isObject(value)) return undefined;
  const path = typeof value.path === 'string' ? value.path.trim() : '';
  const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
  if (path.length === 0 || summary.length === 0) return undefined;
  return { path, summary };
}

function coerceAmbiguity(value: unknown): ScoutAmbiguity | undefined {
  if (!isObject(value)) return undefined;
  const question = typeof value.question === 'string' ? value.question.trim() : '';
  const options = stringArray(value.options);
  // 问题为空或选项 < 2 的歧义无意义（无从出选择卡）→ 丢弃。
  if (question.length === 0 || options.length < 2) return undefined;
  return { question, options };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
    : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
