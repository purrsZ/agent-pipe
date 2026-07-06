import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClaudeFactory } from './agents/claude/runner.js';
import { createCodexFactory } from './agents/codex/runner.js';
import { AgentPool } from './agents/pool.js';
import type { AskUserQuestion, ProgressCallbacks } from './agents/types.js';
import { scheduleDailyBackup } from './backup.js';
import { CommandHandler, currentTaskKey } from './bridge/commands.js';
import { loadConfig, type Config } from './config.js';
import {
  anchorAction,
  AUQ_ACTION_KIND,
  AUQ_WORKITEM_ACTION_KIND,
  buildAnchorCard,
  buildCancelConfirmCard,
  buildCaseFileAnsweredCard,
  buildCaseFileCard,
  buildGatekeeperBigCard,
  buildCheckpointAnsweredCard,
  buildCheckpointCard,
  buildClosureCard,
  buildProcessingCard,
  buildQuestionAnsweredCard,
  buildQuestionFormCard,
  buildReportCard,
  buildWorkitemQuestionCard,
  buildResultCard,
  buildStatusCard,
  CHECKPOINT_ACTION_KIND,
} from './feishu/card.js';
import { createFeishuClients } from './feishu/client.js';
import { startWsReconnectGuard } from './feishu/ws-health.js';
import {
  adaptListMessageToEventData,
  createDispatcher,
  isBotBackfillMessage,
  parseIncomingMessage,
} from './feishu/event-router.js';
import { ProgressCards } from './feishu/progress-cards.js';
import { Sender } from './feishu/sender.js';
import { StreamingCard } from './feishu/stream-card.js';
import type { CardAction, IncomingMessage } from './feishu/types.js';
import { installCrashGuard, removeOwnPidFile, startHeartbeat } from './lifecycle.js';
import { createLogger, type Logger } from './logger.js';
import type { Task } from './store.js';
import { Store } from './store.js';
import { composeRepoKnowledge, KNOWLEDGE_BUDGET_CHARS } from './knowledge/compose.js';
import { loadFreshnessPolicy } from './knowledge/freshness.js';
import { KnowledgeStore } from './knowledge/store.js';
import { loadWorkitemsConfig } from './workitems/config.js';
import { createWorkitemsContainer, type WorkitemsContainer } from './workitems/container.js';
import { createConsoleServer } from './console/server.js';
import { buildRequirementBoard } from './worktypes/requirement/board.js';
import { createWorkbenchAdapter } from './workitems/workbench-adapter.js';
import { createTokenAuth } from './workbench/auth.js';
import { createWorkbenchServer } from './workbench/server.js';
import { OpenLimitError } from './workitems/errors.js';
import { isTerminalStatus } from './workitems/shared.js';
import type { WorkItem, WorkItemEvent } from './workitems/types.js';
import { createAgentRunHandler } from './worktypes/agent-run/run-handler.js';
import { registerProbe } from './worktypes/probe/index.js';
import { checkpointBoundaryOf, checkpointReason } from './worktypes/requirement/checkpoint.js';
import { DELEGABLE_WAIT_REASONS, registerRequirement } from './worktypes/requirement/index.js';
import { INCIDENT_REASONS } from './worktypes/requirement/advisor.js';
import { createIntegrationCheckHandler } from './worktypes/requirement/integration.js';
import {
  createGatekeeperReviewHandler,
  createGatekeeperReworkHandler,
} from './worktypes/requirement/gatekeeper.js';
import { createReconcileCheckHandler } from './worktypes/requirement/reconcile.js';
import { createSteerApplyHandler } from './worktypes/requirement/steering.js';
import { checkpointGateLabel, checkpointRail } from './worktypes/requirement/lights.js';
import { createDeliverManifestHandler } from './worktypes/requirement/deliver.js';
import { runWorktreeGc } from './worktypes/requirement/worktree-gc.js';
import { createRequirementRunStrategy } from './worktypes/requirement/worker-handler.js';
import { PendingIntakeStore } from './bridge/pending-intake.js';
import { buildIntakeChecklistCard, type IntakeChecklistView } from './feishu/intake-card.js';
import {
  composeIntakeExtractPrompt,
  foldIntake,
  INTAKE_CHECKLIST,
  isDefRequired,
  intakeReposOf,
  isFieldSatisfied,
  isGateReady,
  nextRequiredToFill,
  parseIntakeExtraction,
  requiredMissing,
  requiredProgress,
} from './worktypes/requirement/intake.js';
import { createIntakeFinalizeHandler } from './worktypes/requirement/intake-finalize.js';
import {
  createScoutApplyHandler,
  type ScoutAmbiguity,
} from './worktypes/requirement/intake-scout.js';
import { isIntakePhase, PHASE } from './worktypes/requirement/phases.js';

const COMPACT_PROMPT = [
  '请把我们到目前为止的完整对话压缩成一份结构化摘要，供新会话继续使用。',
  '务必覆盖：',
  '1. 用户的目标与需求；',
  '2. 关键决策与结论（含放弃的方案及原因）；',
  '3. 已完成的工作：改动过的文件、运行过的命令及其结果；',
  '4. 进行中的任务与下一步计划；',
  '5. 重要的上下文、约束与未决事项。',
  '只输出摘要正文，不要任何寒暄或额外说明。',
].join('\n');

// WI-A /diag-mcp (admin-only): resolve the echo MCP fixture relative to this module
// (not cwd), injected for one turn to confirm per-run tool injection reaches Claude.
const DIAG_ECHO_MCP_PATH = fileURLToPath(new URL('../scripts/diag-echo-mcp.mjs', import.meta.url));

const DIAG_MCP_PROMPT = [
  '这是一次 MCP 工具注入自检。请：',
  '1) 列出你当前能看到的 MCP 工具名；',
  "2) 调用名为 echo 的工具，参数 message 设为 'mcp-injection-ok'，把返回原样贴出来；",
  '3) 如果完全看不到任何 MCP 工具，直接说明“未注入”。',
].join('\n');

const DIAG_READONLY_PROMPT = [
  '这是一次 readonly 权限档的【边界】自检。它是弱档：预期写工具(Write/Edit)被工具级拦截，',
  '但 Bash 这类不受工具级限制的路径可能仍能写——目的就是如实暴露拦住了什么、没拦住什么，别美化。',
  '请在当前工作目录内，分别独立尝试一次（不重试、互不依赖）：',
  '1) 用 Write 工具创建 probe-write.txt；',
  '2) 用 Edit 工具创建/修改 probe-edit.txt；',
  '3) 用 Bash 执行 `echo probe > probe-bash.txt`。',
  '然后逐项如实报告每一项落在哪一档：「成功落盘 / 被工具级拒绝 / 被要求人工批准 / 卡住无返回」，',
  '并把系统的原始拒绝信息原文贴出。最后给一句总结：这个档到底算不算只读。',
].join('\n');

async function fetchBotOpenId(client: any, logger: Logger): Promise<string> {
  for (let i = 0; i < 3; i++) {
    try {
      const resp = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      const openId = resp?.data?.bot?.open_id ?? resp?.bot?.open_id ?? '';
      if (openId) return openId;
    } catch (err) {
      logger.warn({ err, attempt: i + 1 }, 'fetch bot info failed, retrying');
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return '';
}

// Anchor-card header noun by unit type: requirement reads "需求", everything else keeps the
// historical "调查" (probe). Lives in index (kernel-exempt) so the neutral card builder stays
// type-agnostic — it just takes the rendered noun.
export function anchorNoun(type: string): string {
  return type === 'requirement' ? '需求' : '调查';
}

// WS-3 催办文案用：把毫秒时长压成人话（分钟 / 小时 / 天 X 小时）。永不抛，负数归零。
export function humanizeMs(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  if (totalMin < 60) return `${totalMin} 分钟`;
  const totalHour = Math.floor(totalMin / 60);
  if (totalHour < 24) return `${totalHour} 小时`;
  const days = Math.floor(totalHour / 24);
  const hours = totalHour % 24;
  return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
}

// 带超时的 Promise 竞速：p 按时 settle → 返回其值；ms 内未决 → 返回 'timeout'（不抛）。抽出来为可测；
// 竞速前给 p 挂一个吞异常的 catch —— 超时侧赢下后 p 若再 reject 不会成 unhandled rejection。
export async function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  p.catch(() => {}); // race 输家兜底
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// WS-4 持久 inbox 的入站处理一环：recordInbox 权威去重 → handle → markInboxProcessed。首见返回
// 'ingested'，重复 'duplicate'（含补拉重投同一条），handle 抛错 'error'（不标记 → 重启补投）。
export async function ingestMessage(
  deps: {
    store: Pick<Store, 'recordInbox' | 'markInboxProcessed'>;
    handle: (msg: IncomingMessage) => Promise<void>;
    logger: Pick<Logger, 'error'>;
  },
  msg: IncomingMessage,
): Promise<'ingested' | 'duplicate' | 'error'> {
  if (
    !deps.store.recordInbox({
      messageId: msg.messageId,
      chatId: msg.chatId,
      createTime: msg.createTime,
      payloadJson: JSON.stringify(msg),
    })
  ) {
    return 'duplicate';
  }
  try {
    await deps.handle(msg);
    deps.store.markInboxProcessed(msg.messageId);
    return 'ingested';
  } catch (err) {
    // 不 markProcessed → 该行留在未处理列表，重启时 replayInbox 再投一次（重启级重试，非紧循环）。
    deps.logger.error({ err, messageId: msg.messageId }, 'ingest handler error');
    return 'error';
  }
}

// INTAKE L0.2：启动一次性回填仓库登记表——遍历全部单元已收齐的 repos，逐仓 upsert（source='backfill'）。
// 登记来源本身已是校验过的事实（立项 gate 通过才提升进 workitem.repos），写前不再校验。幂等：重复启动
// 重 upsert 同值。返回回填条数（供日志）。
export function backfillRepoRegistry(deps: {
  listAllRepos: () => string[];
  upsertRepoRegistry: (repoPath: string, name: string, now: number, source: string) => void;
  now: () => number;
}): number {
  const repos = deps.listAllRepos();
  const ts = deps.now();
  for (const p of repos) deps.upsertRepoRegistry(p, path.basename(p), ts, 'backfill');
  return repos.length;
}

// INTAKE L1：勘探搜索根自举——登记表仓的**父目录**去重 ∪ env INTAKE_SCOUT_ROOTS（冒号分隔）。两者皆空 →
// []（勘探不可用：自动触发跳过、手动 /scout 报告会说找不到）。不全盘扫（D-4），只在这些根内浏览。
export function scoutRootsFrom(registryPaths: string[], envValue: string | undefined): string[] {
  const parents = registryPaths.map((p) => path.dirname(p));
  const fromEnv = (envValue ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set([...parents, ...fromEnv])];
}

// INTAKE L1：登记表快照渲染（仓名 → 绝对路径，逐行），织入勘探 prompt 让它先查表再搜盘。空 → 空串。
export function renderRegistrySnapshot(rows: Array<{ name: string; path: string }>): string {
  if (rows.length === 0) return '';
  return rows.map((r) => `- ${r.name} → ${r.path}`).join('\n');
}

// INTAKE L1 防抖（D-7）：数事件流里 stage=scout 的 run 结论数（run_completed/run_failed 平铺 stage）。桥层
// 自动触发前查它，每单自动派勘探 ≤ 2 次（防循环烧 token）；手动 /scout 不受此限。纯函数。
export function scoutConclusionCount(events: WorkItemEvent[]): number {
  let n = 0;
  for (const ev of events) {
    if (ev.kind !== 'run_completed' && ev.kind !== 'run_failed') continue;
    const p = ev.payload;
    if (typeof p === 'object' && p !== null && (p as { stage?: unknown }).stage === 'scout') n++;
  }
  return n;
}

// WS-4 断线补拉（对抗「飞书 WS 不重放离线事件」）：对 managed 认领过的每个 chat 主动拉 im.message.list，
// 跳过 bot 自己的、经 recordInbox 去重后只投未见过的。since 水位 = max(该 chat inbox 最新 create_time,
// now-lookback)，回看窗口防首启动全量灌；再减 60s 重叠靠 inbox 去重兜。整段永不抛：单 chat 失败只 log 跳过。
export async function backfillClaimedChats(deps: {
  store: Pick<
    Store,
    | 'listManagedClaimChatIds'
    | 'managedChatType'
    | 'latestInboxCreateTime'
    | 'recordInbox'
    | 'markInboxProcessed'
  >;
  listMessages: (chatId: string, startTimeSec: number) => Promise<unknown[]>;
  botOpenId: string;
  handle: (msg: IncomingMessage) => Promise<void>;
  logger: Pick<Logger, 'error' | 'info'>;
  now: () => number;
  reason: string;
  lookbackMs?: number;
}): Promise<{ pulled: number; ingested: number }> {
  const lookback = deps.lookbackMs ?? 24 * 60 * 60 * 1000;
  let pulled = 0;
  let ingested = 0;
  for (const chatId of deps.store.listManagedClaimChatIds()) {
    // C7: 用 claim 记录的 chat_type 还原 p2p/group（list item 不带 chat_type），否则 p2p 会话被误判 group。
    const chatType = deps.store.managedChatType(chatId) === 'p2p' ? 'p2p' : 'group';
    const since = Math.max(deps.store.latestInboxCreateTime(chatId), deps.now() - lookback);
    const startTimeSec = Math.floor(since / 1000) - 60; // 60s 重叠窗口，靠 inbox 去重防重放
    let raws: unknown[];
    try {
      raws = await deps.listMessages(chatId, startTimeSec);
    } catch (err) {
      deps.logger.error({ err, chatId, reason: deps.reason }, 'backfill listMessages failed');
      continue;
    }
    for (const raw of raws) {
      pulled++;
      if (isBotBackfillMessage(raw, deps.botOpenId)) continue;
      const msg = parseIncomingMessage(adaptListMessageToEventData(raw, chatType), deps.botOpenId);
      if (!msg) continue;
      const outcome = await ingestMessage(
        { store: deps.store, handle: deps.handle, logger: deps.logger },
        msg,
      );
      if (outcome === 'ingested') ingested++;
    }
  }
  deps.logger.info({ reason: deps.reason, pulled, ingested }, 'backfill claimed chats done');
  return { pulled, ingested };
}

// 病历(非 checkpoint 的 human wait)的飞书卡标签。返回 undefined ⇒ 不是病历(不发病历卡)。
// 放 index(kernel-exempt 桥层),故可用业务词。
export function caseFileLabel(reason: string): string | undefined {
  switch (reason) {
    case 'reconcile_conflict':
      return '跨仓对账 · 冲突/悬空';
    case 'gatekeeper_big':
      return '监工 · 跨仓外溢';
    case 'run_failed':
      return '执行报错';
    case 'integration_unresolved':
      return '集成验证 · 未通过';
    // WS-1.3/1.5：活性看门自曝 + 两类容器病历（此前无飞书卡，只能从管控台 resolve）→ 补齐同权。
    case 'stalled_no_path':
      return '流程卡死（系统自检出，无在途工作）';
    case 'retry_exhausted':
      return '重试用尽（stall/超时连续失败）';
    case 'thrash':
      return '决策震荡（连续被判过期）';
    case 'steer_escalated':
      return '包工头上报（需你裁决）';
    default:
      return undefined;
  }
}

// ENHANCE E4：三类业务事故（INCIDENT_REASONS，与 E1 派参谋同一份常量）弹卡时，参谋已同批派出——在
// 卡片详情尾部注明「建议在路上」，避免人拿到最生的事故单就急着独自想方案。机械故障病历（run_failed 等）
// 不派参谋，也不加此行。纯函数。
export function withAdvisorHint(reason: string, detail: string | undefined): string | undefined {
  if (!INCIDENT_REASONS.includes(reason)) return detail;
  const hint = '🧭 参谋正在分析，建议稍后以卡片贴出——可参考后在上方意见框写下你的修正再点按钮。';
  return detail ? `${detail}\n${hint}` : hint;
}

// 从事件历史里抽一句人类可读的病历详情(为什么卡住),喂进病历卡。永不抛,抽不到 → undefined。
export function caseFileDetail(events: WorkItemEvent[], reason: string): string | undefined {
  const kind =
    reason === 'integration_unresolved'
      ? 'integration_check_failed'
      : reason === 'steer_escalated'
        ? 'steer_directive' // 包工头上报的详情来自最近一条 steer_directive 的 note
        : reason;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || ev.kind !== kind) continue;
    const p = (typeof ev.payload === 'object' && ev.payload ? ev.payload : {}) as Record<
      string,
      unknown
    >;
    const pick = (arr: unknown, key: string): string | undefined => {
      if (!Array.isArray(arr)) return undefined;
      const parts = arr
        .map((x) => (typeof x === 'object' && x ? (x as Record<string, unknown>)[key] : undefined))
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .slice(0, 3);
      return parts.length > 0 ? parts.join('；') : undefined;
    };
    if (reason === 'reconcile_conflict') {
      // WS-10.2：病历详情带上受影响仓（unresolved[].repos 是 string[]，拍平去重）。
      const detail = pick(p.unresolved, 'detail');
      const repos = Array.isArray(p.unresolved)
        ? [
            ...new Set(
              p.unresolved.flatMap((u) =>
                typeof u === 'object' && u && Array.isArray((u as Record<string, unknown>).repos)
                  ? ((u as { repos: unknown[] }).repos.filter(
                      (r): r is string => typeof r === 'string' && r.length > 0,
                    ) as string[])
                  : [],
              ),
            ),
          ].join('、')
        : '';
      return detail && repos ? `${detail}（涉及：${repos}）` : detail;
    }
    if (reason === 'gatekeeper_big') {
      // WS-10.2：带上跨仓外溢涉及的仓（raises[].repo 为标量）。
      const q = pick(p.raises, 'question');
      const repos = pick(p.raises, 'repo');
      return q && repos ? `${q}（涉及：${repos}）` : q;
    }
    if (reason === 'steer_escalated') {
      return typeof p.note === 'string' && p.note.length > 0 ? p.note : undefined;
    }
    if (reason === 'integration_unresolved') {
      return Array.isArray(p.breaking) ? `破坏性变更 ${p.breaking.length} 处` : undefined;
    }
    return undefined; // run_failed：无结构化详情，卡上只给类型 + 处理指引
  }
  return undefined;
}

// WS-7.3 灯③（集成→交付 gate）证据 note：读最后一条 integration_check_passed 的 reason，把「静态对账是否
// 生效」如实注在灯③卡上。no_contract/no_claims = 静态对账未生效（单仓/无跨仓契约/各仓未声明改动）→ 提醒
// 以交付清单人工验收；无 reason（真对账通过）→ 通过。
export function deliverGateNote(events: WorkItemEvent[]): string | undefined {
  let reason: string | undefined;
  let interfaceCount: number | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.kind !== 'integration_check_passed') continue;
    const p = ev.payload;
    if (typeof p === 'object' && p !== null) {
      reason = (p as { reason?: unknown }).reason?.toString();
      const n = (p as { interfaceCount?: unknown }).interfaceCount;
      if (typeof n === 'number' && n > 0) interfaceCount = n;
    }
    break;
  }
  if (reason === 'no_contract') {
    return '⚠️ 静态跨仓对账未生效（本单无跨仓契约）——请以下方交付清单与工人回执为准人工验收';
  }
  if (reason === 'no_claims') {
    return '⚠️ 静态跨仓对账未生效（各仓未声明改动）——请以下方交付清单人工验收';
  }
  // 真对账通过：有条数（新事件）→ 标注契约规模；读不到（历史事件无 interfaceCount）→ 回落原文案。
  return interfaceCount !== undefined
    ? `✅ 静态跨仓对账通过（契约 ${interfaceCount} 条接口）`
    : '✅ 静态跨仓对账通过';
}

// WS-10.3（审查修复 T3）：把「open human wait 的 reason → 出哪张专属卡」的判定抽成纯函数——surfaceCheckpoints
// 按它分发，case-file 全覆盖断言据此钉死「每个会 raise 的 human wait reason 都有卡」（新 reason 忘配卡 →
// 返回 null → 测试红，无卡暗仓防线长牙）。gatekeeper_big 也有 caseFileLabel，故须在 case-file 之前判定。
export function waitCardKindFor(
  reason: string,
): 'closure' | 'cancel-confirm' | 'checkpoint' | 'gatekeeper-big' | 'case-file' | null {
  if (reason === 'awaiting_close') return 'closure';
  if (reason === 'cancel_confirm') return 'cancel-confirm';
  if (checkpointBoundaryOf(reason) !== undefined) return 'checkpoint';
  if (reason === 'gatekeeper_big') return 'gatekeeper-big';
  if (caseFileLabel(reason) !== undefined) return 'case-file';
  return null;
}

// WS-5 意见回灌（审查修复 T1，抽出为可测）：拍板/打回时把操作员在卡片输入框写的意见作为一条 human_message
// 注入，供下一轮 run（灯③ 打回派的 steer / rework worker）在 batch 窗口内消费。仅在 wait 仍 open 时注入——防
// 卡片双击把同一意见注入两遍（第二击 wait 已 resolved）。调用方须在 resolveWait 之前调它（D-E 的 seq 保证：
// 注入落在 resolve 引发的后续 dispatch effect 之前）。返回是否注入。
export function applyCheckpointOpinion(deps: {
  workitems: {
    store: { getWait(id: string): { resolvedAt: number | null } | undefined };
    api: { injectHumanMessage(itemId: string, msg: { text: string }): void };
  };
  itemId: string;
  waitId: string;
  approved: boolean;
  opinion: string;
}): boolean {
  const { workitems, itemId, waitId, approved, opinion } = deps;
  if (opinion && workitems.store.getWait(waitId)?.resolvedAt === null) {
    workitems.api.injectHumanMessage(itemId, {
      text: `【${approved ? '拍板意见' : '打回意见'}】${opinion}`,
    });
    return true;
  }
  return false;
}

// ── DELEGATE 委托模式（睡前放权）────────────────────────────────────────────────────────────
// 人预先拍板（/delegate Nh）→ 容器 watchdog 到点发中性 delegation_due → 本桥层做业务 guard 后走
// resolveWait 唯一写口自动通过。委托只会「通过」、永不「打回」（D-1）；白名单只含推进型三灯（D-2，
// 声明在 requirement 纯核心）；guard 只认机器信号不认 AI 报告（D-4）。

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// DELEGATE D2.2：/delegate 时长解析。Nh/Nm；上限 24h（过夜够用，防「永久放权」）→ 'over-cap'；
// 坏格式/非正数 → undefined（调用方回用法提示）。纯函数。
export function parseDelegationDuration(raw: string): number | 'over-cap' | undefined {
  const m = /^(\d+)(h|m)$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (n <= 0) return undefined;
  const ms = m[2]!.toLowerCase() === 'h' ? n * 3_600_000 : n * 60_000;
  return ms > 24 * 3_600_000 ? 'over-cap' : ms;
}

// DELEGATE D2.2：/delegate 命令主体（依赖注入式导出，先例 applyCheckpointOpinion）。item 由调用方
// resolveManagedItem 解出；找不到单/终态的文案复用 /cancel 的两条。写入即 upsert（每单一条生效，
// 新授权覆盖旧的）；grantNote 存命令原文（留痕：事后可审计"这个灯凭什么批的"）。
export async function runDelegateCommand(
  deps: {
    item: WorkItem | undefined;
    store: {
      upsertDelegation(
        workitemId: string,
        input: { reasons: string[]; grantNote: string; expiresAt: number; createdBy: string },
      ): void;
      revokeDelegation(workitemId: string): number;
    };
    reply: (text: string) => Promise<unknown>;
    delegableReasons: readonly string[];
    delaySec: number;
    now?: () => number;
  },
  msg: { text: string; userId: string },
  args: string[],
): Promise<void> {
  const { item } = deps;
  if (!item) {
    await deps.reply('本会话没有进行中的需求单。');
    return;
  }
  if (isTerminalStatus(item.status)) {
    await deps.reply('该单元已结束，回复 `/done` 关闭后可重新发起。');
    return;
  }
  const arg = (args[0] ?? '').trim();
  if (arg.toLowerCase() === 'off') {
    const revoked = deps.store.revokeDelegation(item.id);
    await deps.reply(revoked > 0 ? '已撤销本单委托，三灯恢复等你拍板。' : '本单没有生效中的委托。');
    return;
  }
  const dur = parseDelegationDuration(arg);
  if (dur === undefined) {
    await deps.reply(
      '用法：/delegate <时长>（Nh/Nm，如 8h、30m，上限 24h）开启本单委托；/delegate off 撤销。',
    );
    return;
  }
  if (dur === 'over-cap') {
    await deps.reply(
      '委托时长上限 24h（过夜够用，防「永久放权」）。请用不超过 24h 的时长，如 /delegate 8h。',
    );
    return;
  }
  const expiresAt = (deps.now?.() ?? Date.now()) + dur;
  deps.store.upsertDelegation(item.id, {
    reasons: [...deps.delegableReasons],
    grantNote: msg.text.trim(),
    expiresAt,
    createdBy: msg.userId,
  });
  // 确认文案诚实交代边界（D2.2）：三灯范围 + 冷静期 + 灯③ 机器 guard + 判大/病历不受委托。
  const mins = Math.round(deps.delaySec / 60);
  await deps.reply(
    `已开启委托至 ${hhmm(expiresAt)}——拆解/验收/关单三灯在无人处理 ${mins} 分钟后自动通过` +
      '（验收灯需静态对账真通过才放行）；**监工判大与一切病历仍会等你**。随时 /delegate off 撤销。',
  );
}

// DELEGATE D-4：委托 guard——**只认机器信号，不认 AI 报告**（AI 质检/参谋报告只进人眼，E5 D-1）。
// 灯③ 自动通过的前提 = 最后一条 integration_check_passed 是真通过（payload 无 reason；no_contract /
// no_claims = 静态对账未生效 → 不放行，等人。推论：lite 单仓的灯③ 永不自动过，设计上有意保守）。
// 灯②/灯④ 无 guard（拆解结论有对账 effect 兜底、关单前灯③已人批或真通过）；非白名单恒 false（双保险，
// 白名单本身已在命令入口约束）。扫描姿势同 deliverGateNote。纯函数。
export function delegationGuardFor(reason: string, events: WorkItemEvent[]): boolean {
  if (!DELEGABLE_WAIT_REASONS.includes(reason)) return false;
  if (reason !== checkpointReason(PHASE.deliver)) return true;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.kind !== 'integration_check_passed') continue;
    const p = ev.payload;
    const r = typeof p === 'object' && p !== null ? (p as { reason?: unknown }).reason : undefined;
    return r === undefined;
  }
  return false; // 从无 integration_check_passed → 不放行
}

// DELEGATE D2.3：delegation_due 的桥层执行器（依赖注入式导出，先例 backfillClaimedChats）。幂等：
// wait 已 resolve（人抢先手动 / watchdog 节流重发竞态）→ return；授权已撤销/到期 → return；guard 不过
// → 静默 return（催办照常，人醒来正常处理）。通过则走 resolveWait 唯一写口（operator=delegation 留痕）
// 并群内通知；通知失败只 log——resolve 已生效，通知是尽力而为。
export async function runDelegationDue(
  deps: {
    workitems: {
      store: {
        getWait(
          id: string,
        ): { workitemId: string; reason: string; resolvedAt: number | null } | undefined;
        activeDelegation(
          workitemId: string,
          now: number,
        ): { grantNote: string; expiresAt: number } | undefined;
      };
      api: {
        listEvents(id: string): WorkItemEvent[];
        resolveWait(
          waitId: string,
          input: { operator: string; reason: string; decision?: { approved: boolean } },
        ): { resolved: boolean };
      };
    };
    notify: (text: string) => Promise<unknown>;
    logger: Pick<Logger, 'error' | 'info'>;
    now?: () => number;
  },
  event: WorkItemEvent,
): Promise<void> {
  const payload = event.payload;
  const waitId =
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as { waitId?: unknown }).waitId === 'string'
      ? (payload as { waitId: string }).waitId
      : undefined;
  if (!waitId) return;
  const wait = deps.workitems.store.getWait(waitId);
  if (!wait || wait.resolvedAt !== null) return;
  const grant = deps.workitems.store.activeDelegation(wait.workitemId, deps.now?.() ?? Date.now());
  if (!grant) return;
  if (!delegationGuardFor(wait.reason, deps.workitems.api.listEvents(wait.workitemId))) return;
  const r = deps.workitems.api.resolveWait(waitId, {
    operator: 'delegation',
    reason: `【委托】${grant.grantNote}（至 ${hhmm(grant.expiresAt)}）`,
    decision: { approved: true },
  });
  if (!r.resolved) return;
  deps.logger.info({ waitId, reason: wait.reason }, 'delegation auto-approved wait');
  const boundary = checkpointBoundaryOf(wait.reason);
  const label = boundary
    ? checkpointGateLabel(boundary)
    : wait.reason === 'awaiting_close'
      ? '交付待关单（灯④）'
      : wait.reason;
  try {
    await deps.notify(
      `⏱ 已按你的委托自动通过「${label}」（授权：${grant.grantNote}）。有异议可在群里直接说，包工头会处理。`,
    );
  } catch (err) {
    deps.logger.error({ err, waitId }, 'delegation notify failed (resolve already committed)');
  }
}

// INTAKE L1（D-6）：scout_result 的桥层执行器（依赖注入式导出，先例 runDelegationDue）。勘探产出经此消费：
//   repos[]      → 逐条跑**桥层既有当场校验**（isGitRepo，D-1 红线：候选入表必须过校验）→ 通过的与现有
//                  repos 合并去重后 injectIntakeField（与人工输入同一写口同一校验）+ upsert 登记表（source
//                  ='scout'）；校验失败的降级为群内说明，绝不入表。
//   ambiguities[]→ 每条出一张 AUQ 表单卡（buildQuestionCard，routing 带 workitemId）——人点选后走既有 auq-wi
//                  回灌 → 下一轮抽取命中登记表/原路径。防重贴成本高，接受 rerun 极端场景重贴（recovery 重跑
//                  仅崩溃后发生）。
//   notFound[]   → 群内如实说没找到，请给绝对路径或补线索后 /scout 重试。
// 幂等：injectIntakeField 重复注入同值由 fold 语义天然吸收；upsert 幂等；notify 失败只 log（不影响入表）。
export async function runScoutResult(
  deps: {
    currentRepos: string[];
    isGitRepo: (repoPath: string) => boolean;
    injectRepos: (repos: string[]) => void;
    upsertRepo: (repoPath: string) => void;
    buildQuestionCard: (question: string, options: string[]) => object;
    postCard: (card: object) => Promise<unknown>;
    notify: (text: string) => Promise<unknown>;
    // INTAKE L2：仓内收料——对应 intake 字段**为空时**才注入候选（带来源标记，人可覆盖）；已有值绝不覆盖。
    isFieldEmpty?: (key: 'prd' | 'acceptance' | 'summary') => boolean;
    injectField?: (key: 'prd' | 'acceptance' | 'summary', value: string) => void;
    logger: Pick<Logger, 'error' | 'info'>;
  },
  event: WorkItemEvent,
): Promise<void> {
  const p = event.payload;
  const obj = typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : {};
  const repos = Array.isArray(obj.repos)
    ? obj.repos.filter((r): r is string => typeof r === 'string')
    : [];
  const notFound = Array.isArray(obj.notFound)
    ? obj.notFound.filter((r): r is string => typeof r === 'string')
    : [];
  const ambiguities = Array.isArray(obj.ambiguities)
    ? (obj.ambiguities as ScoutAmbiguity[]).filter(
        (a) => a && typeof a.question === 'string' && Array.isArray(a.options),
      )
    : [];

  const lines: string[] = [];

  // 1) 确定仓：当场校验（D-1）→ 通过的与现有 repos 合并去重后入表 + 登记。失败的降级为说明，不入表。
  const valid = repos.filter((r) => deps.isGitRepo(r));
  const invalid = repos.filter((r) => !deps.isGitRepo(r));
  if (valid.length > 0) {
    const merged = [...new Set([...deps.currentRepos, ...valid])];
    deps.injectRepos(merged);
    for (const r of valid) deps.upsertRepo(r);
    lines.push(`✅ 勘探已确认并填入仓库：\n${valid.map((r) => `- ${r}`).join('\n')}`);
  }
  if (invalid.length > 0) {
    lines.push(
      `⚠️ 勘探给出的这些路径未通过校验（需绝对路径 + 是 git 仓），已跳过：\n${invalid
        .map((r) => `- ${r}`)
        .join('\n')}`,
    );
  }

  // 2) 歧义：每条一张 AUQ 选择卡（人点选 → auq-wi 回灌 → 下轮抽取命中）。
  for (const a of ambiguities) {
    try {
      await deps.postCard(deps.buildQuestionCard(a.question, a.options));
    } catch (err) {
      deps.logger.error({ err }, 'scout ambiguity card post failed');
    }
  }

  // 3) notFound：如实说，请给绝对路径或补线索后 /scout 重试。
  if (notFound.length > 0) {
    lines.push(
      `🔍 没找到这些线索对应的仓：${notFound.join('、')}。请直接发绝对路径，或补充线索后发 \`/scout <线索>\` 重试。`,
    );
  }

  // 4) INTAKE L2 仓内收料：materials 候选**只在对应字段为空时**注入（带来源标记，人可覆盖）；已有值不动。
  const materials =
    typeof obj.materials === 'object' && obj.materials !== null
      ? (obj.materials as Record<string, unknown>)
      : undefined;
  if (materials && deps.isFieldEmpty && deps.injectField) {
    const applied: string[] = [];
    const itemOf = (v: unknown): { path: string; summary: string } | undefined =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as { path?: unknown }).path === 'string' &&
      typeof (v as { summary?: unknown }).summary === 'string'
        ? { path: (v as { path: string }).path, summary: (v as { summary: string }).summary }
        : undefined;
    const tryInject = (
      key: 'prd' | 'acceptance' | 'summary',
      label: string,
      path: string | undefined,
      summary: string,
    ): void => {
      if (!deps.isFieldEmpty!(key)) return; // 已有值绝不覆盖
      const tag = path ? `【AI 从 ${path} 提取，立项卡上请确认】` : '【AI 提取，立项卡上请确认】';
      deps.injectField!(key, `${tag}${summary}`);
      applied.push(label);
    };
    const prd = itemOf(materials.prd);
    if (prd) tryInject('prd', 'PRD', prd.path, prd.summary);
    const acceptance = itemOf(materials.acceptance);
    if (acceptance) tryInject('acceptance', '验收标准', acceptance.path, acceptance.summary);
    const bg =
      typeof materials.background === 'object' && materials.background !== null
        ? (materials.background as { summary?: unknown }).summary
        : undefined;
    if (typeof bg === 'string' && bg.trim().length > 0) {
      tryInject('summary', '一句话需求 + 背景', undefined, bg.trim());
    }
    if (applied.length > 0) {
      lines.push(`📎 顺路从仓里找到候选材料（已作为待确认草稿填入）：${applied.join('、')}`);
    }
  }

  if (lines.length > 0) {
    try {
      await deps.notify(lines.join('\n'));
    } catch (err) {
      deps.logger.error({ err }, 'scout notify failed');
    }
  }
}

// DELEGATE D3（可选项，已做）：灯卡/关单卡尾部的「委托生效中」灰字提示。只在真会自动过时才提示——
// 有生效授权 ∧ reason 命中 ∧ guard 放行（灯③ no_contract/no_claims 不提示，否则卡上承诺自动通过而
// 实际 guard 拦住，不诚实）∧ 到点时授权还活着。纯函数。
export function delegationCardHint(
  wait: { reason: string; createdAt: number },
  grant: { reasons: string[]; expiresAt: number } | undefined,
  events: WorkItemEvent[],
  delaySec: number,
): string | undefined {
  if (!grant || !grant.reasons.includes(wait.reason)) return undefined;
  if (!delegationGuardFor(wait.reason, events)) return undefined;
  const autoAt = wait.createdAt + delaySec * 1000;
  if (autoAt >= grant.expiresAt) return undefined; // 到点前授权已过期 → 不会自动过
  return `⏱ 委托生效中：无人处理将于 ${hhmm(autoAt)} 后自动通过（/delegate off 可撤销）`;
}

// WS-9：AUQ 表单答案组装（bridge task 与 workitem run 两条回灌路径共用，避免两份逻辑漂移）。每题 input
// 自定义优先、否则下拉 select、都空则占位；lines = 喂回 agent 的完整文本，brief = 卡片补丁的简报。纯函数。
export function assembleAuqAnswers(
  formValue: Record<string, unknown>,
  total: number,
  headers: unknown[],
): { lines: string[]; brief: string[] } {
  const selVal = (raw: unknown): string => {
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      if (typeof o.value === 'string') return o.value;
      if (typeof o.option === 'string') return o.option;
    }
    return '';
  };
  const lines: string[] = [];
  const brief: string[] = [];
  for (let i = 0; i < total; i++) {
    const customRaw = formValue[`q${i}_custom`];
    const custom = typeof customRaw === 'string' ? customRaw.trim() : '';
    const picked = selVal(formValue[`q${i}_pick`]);
    const hdr = typeof headers[i] === 'string' ? (headers[i] as string) : `问题${i + 1}`;
    if (custom) {
      lines.push(`${i + 1}. 【${hdr}】→ ${custom}（自定义回答，请按字面采纳，不要套到预设选项上）`);
      brief.push(`${hdr}：${custom}`);
    } else if (picked) {
      lines.push(`${i + 1}. 【${hdr}】→ ${picked}（选自预设）`);
      brief.push(`${hdr}：${picked}`);
    } else {
      lines.push(`${i + 1}. 【${hdr}】→ (未作答)`);
      brief.push(`${hdr}：(未作答)`);
    }
  }
  return { lines, brief };
}

// 立项清单事件流 → feishu 清单卡的中性视图。kernel-exempt：index 可 import worktypes 的 intake 纯核心，
// 把领域状态压成 feishu 层只认的 view（feishu 层不做 fold、不 import worktypes）。
function foldIntakeState(events: WorkItemEvent[]): ReturnType<typeof foldIntake> {
  return foldIntake(events.filter((e) => e.kind === 'intake_field_set').map((e) => e.payload));
}

function buildIntakeView(title: string, state: ReturnType<typeof foldIntake>): IntakeChecklistView {
  const byKey = new Map(state.fields.map((f) => [f.key, f]));
  const items = INTAKE_CHECKLIST.map((d) => {
    const f = byKey.get(d.key);
    const value = f ? (Array.isArray(f.value) ? f.value.join('、') : f.value) : undefined;
    return {
      label: d.label,
      done: isFieldSatisfied(f),
      // WS-6.3：与 requiredDefs 共用 isDefRequired 单一判定（含 multi-conditional 随 repos 数变），杜绝漂移。
      required: isDefRequired(d, state),
      pending: f?.filledBy === 'ai-extracted' && !f.confirmed,
      value,
    };
  });
  const prog = requiredProgress(state);
  return {
    title,
    items,
    filled: prog.filled,
    total: prog.total,
    ready: isGateReady(state),
    missing: requiredMissing(state).map((d) => d.label),
  };
}

// 立项收料的仓库项校验：绝对路径 + 是 git 仓 + 有 HEAD（当场退回不合格项）。副作用（git/fs）放在
// index(kernel-exempt) 里做，不进 worktype 纯核心。校验失败一律当「不是有效仓库」处理。
function isGitRepo(repoPath: string): boolean {
  if (!path.isAbsolute(repoPath)) return false;
  try {
    const head = execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return head.toString().trim().length > 0;
  } catch {
    return false;
  }
}

export function ensureSingleInstance(pidPath: string, logger: Logger): void {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  try {
    const oldPid = Number.parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 'SIGTERM');
        logger.info({ oldPid }, 'killed previous instance');
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* no previous pid file */
  }
  fs.writeFileSync(pidPath, String(process.pid));
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  fs.mkdirSync(config.sessionsDir, { recursive: true });

  const pidPath = path.join(config.dataDir, 'bot.pid');
  ensureSingleInstance(pidPath, logger);

  const store = new Store(config.dbPath);

  if (store.whitelistCount() === 0) {
    for (const id of config.allowedOpenIds) store.addWhitelist(id, 'bootstrap');
    logger.info({ count: config.allowedOpenIds.size }, 'seeded whitelist from .env');
  }
  // WS-4: onWsRecovered 必须在建 ws 时就绑定，但断线补拉依赖的 sender/store/handleIncoming 要到很后面
  // 才装配好。用一个可变持有变量做晚绑定：这里传稳定闭包，等补拉函数就绪后再把它挂上（首连不触发，见
  // createWsHealthLogger 的 everHealthy 守卫）。
  let onWsRecovered: () => void = () => {};
  const { client, wsClient, wsHealth } = createFeishuClients(
    config.feishu.appId,
    config.feishu.appSecret,
    logger,
    { onWsRecovered: () => onWsRecovered() },
  );
  const sender = new Sender(client, logger);

  const botOpenId = await fetchBotOpenId(client, logger);
  if (!botOpenId) {
    logger.warn('could not fetch bot open_id (not fatal, but /bot/v3/info failed)');
  }

  const claudeFactory = createClaudeFactory({
    binPath: config.claude.path,
    defaultModel: config.claude.model,
    effort: config.claude.effort,
  });
  const codexFactory = createCodexFactory({
    binPath: config.codex.path,
    defaultModel: config.codex.model,
    reasoningEffort: config.codex.reasoningEffort,
  });
  const pool = new AgentPool(
    { claude: claudeFactory, codex: codexFactory },
    { maxHot: config.maxHot, maxConcurrent: config.maxConcurrent },
    store,
    logger,
  );
  // workitems runtime drives real agent runs through the pool (managed shadow tasks),
  // so it must be wired after the pool exists. defaultCwd is the fallback dir the
  // readonly probe agent browses when a workitem declares no repo.
  const workitems = createWorkitemsRuntime({
    config,
    logger,
    pool,
    sender,
    kernelStore: store,
    defaultCwd: config.allowedCwdPrefixes[0] ?? process.cwd(),
  });
  const runningTasks = new Set<string>();
  // INTAKE L0.2：启动一次性回填仓库登记表（用历史单元收齐的仓做立项抽取快路径 + 勘探搜索起点）。
  try {
    const n = backfillRepoRegistry({
      listAllRepos: () => workitems.store.listAllRepos(),
      upsertRepoRegistry: (p, name, now, source) => store.upsertRepoRegistry(p, name, now, source),
      now: () => Date.now(),
    });
    logger.info({ count: n }, 'repo registry backfilled from workitems');
  } catch (err) {
    logger.warn({ err }, 'repo registry backfill failed');
  }
  // /req 后「等群名」的临时待答态（M-I2，keyed by 用户+会话，带 TTL，纯内存）。
  const pendingIntake = new PendingIntakeStore();
  const botStartTime = Date.now();

  // HTML 工作台 (R17/R18): SSR 读视图 + 单写入口（funnels through resolveWait/injectHumanMessage，
  // 页面只读投影、agent 不碰页面）。读开放、写要本人 token（Authorization: Bearer 或 wb_token
  // cookie）。绑定地址/端口可配；公司外访问走内网穿透（在外，R17.AC-6）。WORKBENCH_ENABLED=false
  // 可整体关停。listen 在 ws 就绪后进行（见下）。
  // Single write path shared by the board (T2) and the feishu 灯卡 (T3): both funnel a checkpoint
  // p板 through workbenchAdapter.actions.resolve → resolveWait. Built unconditionally (cheap, no
  // IO) so card-action handling works even when the HTTP board is disabled.
  const workbenchAdapter = createWorkbenchAdapter({
    store: workitems.store,
    artifacts: workitems.artifacts,
    api: workitems.api,
  });
  const workbenchServer = config.workbench.enabled
    ? createWorkbenchServer({
        data: workbenchAdapter.data,
        actions: workbenchAdapter.actions,
        auth: createTokenAuth(config.workbench),
        logger,
      })
    : null;

  // 需求管控台（React SPA 的 JSON API + 静态托管）。与 workbench 并存，复用同一 resolveWait 单写口、
  // 同一本人 token。最佳努力：bind 失败不拖垮 bot（见下方 listen 的 error 监听）。
  const consoleServer = config.console.enabled
    ? createConsoleServer({
        board: () =>
          buildRequirementBoard({ store: workitems.store, artifacts: workitems.artifacts }),
        resolve: ({ waitId, approved, reason }, operator) => {
          const r = workitems.api.resolveWait(waitId, {
            operator,
            reason,
            decision: { approved, payload: { reason } },
          });
          return { ok: r.resolved };
        },
        auth: createTokenAuth(config.workbench),
        staticDir: config.console.staticDir,
        logger,
      })
    : null;

  const releaseResources = createReleaseResources({
    pool,
    workitems,
    store,
    pidPath,
    workbenchServer,
    consoleServer,
  });
  installCrashGuard(logger, releaseResources);
  scheduleDailyBackup(store, path.join(config.dataDir, 'backups'), logger, [
    workitems.backupJob(),
    // WS-4: 顺带清 30 天前的已处理 inbox 行（未处理行永远保留等补投）。
    {
      label: 'inbox-purge',
      run: async (now: Date) => {
        store.purgeInboxBefore(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        return undefined;
      },
    },
    // WS-7.4: 终态且 7 天以上的单清 worktree（分支保留）；孤目录 30 天才清。
    {
      label: 'worktree-gc',
      run: async (now: Date) => {
        const r = runWorktreeGc({
          store: workitems.store,
          worktreesDir: path.join(config.dataDir, 'worktrees'),
          logger,
          now: now.getTime(),
        });
        return `removed=${r.removed} kept=${r.kept}`;
      },
    },
  ]);

  const ATTACHMENT_TTL_MS = 30 * 60 * 1000;
  const pendingAttachments = new Map<string, Array<{ path: string; expiresAt: number }>>();
  const drainPending = (chatId: string): string[] => {
    const now = Date.now();
    const list = pendingAttachments.get(chatId) ?? [];
    const fresh = list.filter((e) => e.expiresAt > now);
    pendingAttachments.delete(chatId);
    return fresh.map((e) => e.path);
  };
  const sanitizeName = (name: string): string =>
    name
      // biome-ignore lint/suspicious/noControlCharactersInRegex: 故意剥离文件名里的控制字符
      .replace(/[/\\\x00-\x1f]/g, '_')
      .replace(/^\.+/, '_')
      .slice(0, 120) || 'file';

  // ---- per-task serial execution: queue while busy, drain after each turn ----
  type TurnInput = {
    chatId: string;
    messageId: string;
    text: string;
    parentId?: string;
  };
  const MAX_QUEUE = 10;
  const queues = new Map<string, TurnInput[]>();
  const cancelledTasks = new Set<string>();
  const enqueue = (taskId: string, input: TurnInput): boolean => {
    const list = queues.get(taskId) ?? [];
    if (list.length >= MAX_QUEUE) return false;
    list.push(input);
    queues.set(taskId, list);
    return true;
  };
  const dequeue = (taskId: string): TurnInput | undefined => {
    const list = queues.get(taskId);
    if (!list || list.length === 0) return undefined;
    const next = list.shift();
    if (list.length === 0) queues.delete(taskId);
    return next;
  };
  const clearQueue = (taskId: string): number => {
    const n = queues.get(taskId)?.length ?? 0;
    queues.delete(taskId);
    return n;
  };
  // /stop: 清空排队 + 中断当前轮，并标记取消，让 runOneTurn 收尾成"已中断"卡。
  const requestStop = (taskId: string): { aborted: boolean; dropped: number } => {
    const dropped = clearQueue(taskId);
    const aborted = pool.abort(taskId);
    if (aborted) cancelledTasks.add(taskId);
    return { aborted, dropped };
  };

  const compactKey = (taskId: string): string => `compact_summary:${taskId}`;

  const escapeAttr = (v: string): string =>
    v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // 拉取被引用消息渲染成 <replied_message> 块；图片/文件下载进任务 inbox 并带上本地路径。
  // best-effort：拉取失败返回 null（跳过注入，不阻塞本轮）。
  async function buildRepliedBlock(parentId: string, task: Task): Promise<string | null> {
    const m = await sender.getMessage(parentId);
    if (!m) return null;
    const lines: string[] = [];
    if (m.text) lines.push(m.text);
    if (m.imageKey || m.fileKey) {
      const inboxDir = path.join(task.cwd, 'inbox');
      try {
        fs.mkdirSync(inboxDir, { recursive: true });
      } catch (err) {
        logger.warn({ err, inboxDir }, 'mkdir inbox for replied attachment failed');
      }
      if (m.imageKey) {
        const dest = path.join(inboxDir, `replied-${parentId}.png`);
        const ok = await sender.downloadAttachment(parentId, m.imageKey, 'image', dest);
        lines.push(ok ? `📎 引用图片: ${dest}` : '📎 引用图片: (下载失败)');
      }
      if (m.fileKey) {
        const dest = path.join(
          inboxDir,
          `replied-${parentId}-${sanitizeName(m.fileName ?? 'file')}`,
        );
        const ok = await sender.downloadAttachment(parentId, m.fileKey, 'file', dest);
        lines.push(ok ? `📎 引用文件: ${dest}` : `📎 引用文件: (下载失败) ${m.fileName ?? ''}`);
      }
    }
    if (lines.length === 0) lines.push(`(${m.msgType || '未知类型'} 消息，无文本)`);
    const attrs = [`sender_type="${escapeAttr(m.senderType || 'unknown')}"`];
    if (m.createTime) attrs.push(`sent_at="${escapeAttr(m.createTime)}"`);
    return `<replied_message ${attrs.join(' ')}>\n${lines.join('\n')}\n</replied_message>`;
  }

  // Run one turn for a task: processing card → throttled streaming progress → result
  // card. Injects replied-message + pending compact summary + attachment paths into
  // the prompt. Never throws — failures are reported as a reply/card so drain keeps going.
  async function runOneTurn(taskId: string, input: TurnInput): Promise<void> {
    const task = store.getTask(taskId);
    if (!task) return;
    let ackCardId: string | null = null;
    try {
      ackCardId = await sender.replyCard(
        input.messageId,
        buildProcessingCard(task.display_name, task.agent_kind),
      );
      if (ackCardId) store.recordTaskMessage(task.id, ackCardId);

      let prompt = input.text;
      const pendingPaths = drainPending(input.chatId);
      if (pendingPaths.length > 0) {
        prompt = `[已附加文件，请读取以下路径后继续处理]\n${pendingPaths
          .map((p) => `- ${p}`)
          .join('\n')}\n\n${prompt}`;
      }
      // 引用消息注入：仅当用户回复的是「非本任务线程内」的消息（外部内容）时注入；
      // 回复本任务自己的卡/历史（已在 agent 上下文里）则跳过，避免冗余 token。
      if (input.parentId) {
        const owner = store.getTaskByMessageId(input.parentId);
        if (!owner || owner.id !== task.id) {
          const block = await buildRepliedBlock(input.parentId, task);
          if (block) prompt = `${block}\n\n${prompt}`;
        }
      }
      const summary = store.getState(compactKey(task.id));
      if (summary) {
        store.deleteState(compactKey(task.id));
        prompt = `[以下是之前对话的压缩摘要，请基于它继续]\n${summary}\n\n${prompt}`;
      }

      const streaming = ackCardId
        ? new StreamingCard(sender, ackCardId, task.display_name, task.agent_kind)
        : null;
      let pendingQuestion: AskUserQuestion | null = null;
      const callbacks: ProgressCallbacks = {
        // Claude asked the user mid-turn (AskUserQuestion). The headless CLI auto-closes the
        // tool so this turn still ends normally — we render the choices as the final card and
        // resume the picked answer as the next message (see handleCardAction).
        onAskUser: (_id, q) => {
          pendingQuestion = q;
        },
      };
      if (streaming) {
        callbacks.onToolUse = (_id, t) => streaming.onToolUse(t.name);
        callbacks.onText = (_id, full) => streaming.onText(full);
      }

      let result: Awaited<ReturnType<typeof pool.send>>;
      try {
        result = await pool.send(task, prompt, callbacks, undefined, () => {
          // WI-C/R2: global concurrency slot full — tell the user instead of going silent.
          void sender.reply(
            input.messageId,
            `[${task.display_name}] 全局繁忙，排队等待空闲运行槽…`,
          );
        });
      } finally {
        await streaming?.stop();
      }

      // If Claude asked a question this turn, replace the result card (which would otherwise be
      // the CLI's "弹窗关闭了" degrade text) with an interactive choice card.
      const card = pendingQuestion
        ? buildQuestionFormCard(task.display_name, pendingQuestion, {
            taskId: task.id,
            chatId: input.chatId,
          })
        : buildResultCard(task.display_name, result);
      if (ackCardId) {
        const ok = await sender.updateCard(ackCardId, card);
        if (!ok) {
          const replyId = await sender.replyCard(input.messageId, card);
          if (replyId) store.recordTaskMessage(task.id, replyId);
        }
      } else {
        const replyId = await sender.replyCard(input.messageId, card);
        if (replyId) store.recordTaskMessage(task.id, replyId);
      }
      cancelledTasks.delete(task.id); // consume any stale /stop flag on success
    } catch (err) {
      const cancelled = cancelledTasks.delete(task.id);
      if (cancelled) {
        logger.info({ taskId: task.id }, 'task turn cancelled via /stop');
      } else {
        logger.error({ err, taskId: task.id }, 'task execution failed');
      }
      const statusCard = cancelled
        ? buildStatusCard(task.display_name, 'cancelled', '已手动中断当前轮。')
        : buildStatusCard(task.display_name, 'error', (err as Error).message);
      let patched = false;
      if (ackCardId) patched = await sender.updateCard(ackCardId, statusCard);
      if (!patched) {
        const replyId = await sender.replyCard(input.messageId, statusCard);
        if (replyId) store.recordTaskMessage(task.id, replyId);
      }
    }
  }

  // Hold the task's serial slot, run the turn, then drain queued messages FIFO.
  async function runWithDrain(taskId: string, input: TurnInput): Promise<void> {
    runningTasks.add(taskId);
    try {
      let cur: TurnInput | undefined = input;
      while (cur) {
        await runOneTurn(taskId, cur);
        cur = dequeue(taskId);
      }
    } finally {
      runningTasks.delete(taskId);
    }
  }

  // /compact: drive the agent to emit a structured summary, persist it, reset the
  // session, and let the next message resume from the summary. Shares runningTasks so
  // it can't race a normal turn; drains anything queued during the compact turn.
  async function runCompact(taskId: string, replyMsgId: string): Promise<void> {
    const task = store.getTask(taskId);
    if (!task) {
      await sender.reply(replyMsgId, `任务不存在: ${taskId}`);
      return;
    }
    if (runningTasks.has(taskId)) {
      await sender.reply(replyMsgId, `[${task.display_name}] 正忙，等当前消息处理完再 /compact`);
      return;
    }
    runningTasks.add(taskId);
    try {
      await sender.reply(replyMsgId, `[${task.display_name}] 正在压缩上下文…`);
      const r = await pool.send(task, COMPACT_PROMPT);
      if (r.error) {
        await sender.reply(replyMsgId, `[${task.display_name}] 压缩失败: ${r.error}`);
        return;
      }
      const summary = (r.fullText ?? '').trim();
      if (!summary) {
        await sender.reply(replyMsgId, `[${task.display_name}] 压缩失败: 摘要为空，会话未重置`);
        return;
      }
      store.setState(compactKey(taskId), summary);
      store.clearAgentSessionId(taskId);
      pool.respawn(taskId);
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] 已压缩上下文，原会话重置，下条消息会带着摘要继续。`,
      );
    } catch (err) {
      await sender.reply(replyMsgId, `[${task.display_name}] 压缩失败: ${(err as Error).message}`);
    } finally {
      cancelledTasks.delete(taskId); // /stop during compact must not leak the flag
      runningTasks.delete(taskId);
      const next = dequeue(taskId);
      if (next) void runWithDrain(taskId, next);
    }
  }

  // /diag-mcp: inject the echo MCP server for one turn and report the agent's output.
  // Shares runningTasks (can't race a normal turn); the injected options change the
  // fingerprint → pool rebuilds the Claude proc with --mcp-config (§2.1 / WI-A).
  async function runDiagMcp(taskId: string, replyMsgId: string): Promise<void> {
    const task = store.getTask(taskId);
    if (!task) {
      await sender.reply(replyMsgId, `任务不存在: ${taskId}`);
      return;
    }
    if (runningTasks.has(taskId)) {
      await sender.reply(replyMsgId, `[${task.display_name}] 正忙，等当前消息处理完再 /diag-mcp`);
      return;
    }
    runningTasks.add(taskId);
    try {
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] 注入 MCP server「diag-echo」跑一轮自检…（会触发 runner 重建）`,
      );
      const result = await pool.send(task, DIAG_MCP_PROMPT, undefined, {
        mcpServers: [{ name: 'diag-echo', command: 'node', args: [DIAG_ECHO_MCP_PATH] }],
      });
      if (result.error) {
        await sender.reply(replyMsgId, `[${task.display_name}] /diag-mcp 失败: ${result.error}`);
        return;
      }
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] /diag-mcp 完成，agent 输出：\n${(result.fullText ?? '').slice(0, 1500)}`,
      );
    } catch (err) {
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] /diag-mcp 异常: ${(err as Error).message}`,
      );
    } finally {
      cancelledTasks.delete(taskId);
      runningTasks.delete(taskId);
      const next = dequeue(taskId);
      if (next) void runWithDrain(taskId, next);
    }
  }

  // /diag-readonly: run one turn under the readonly permission profile and report the
  // agent's output — confirms the write-tool deny works (and surfaces reject-vs-hang, D6).
  async function runDiagReadonly(taskId: string, replyMsgId: string): Promise<void> {
    const task = store.getTask(taskId);
    if (!task) {
      await sender.reply(replyMsgId, `任务不存在: ${taskId}`);
      return;
    }
    if (runningTasks.has(taskId)) {
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] 正忙，等当前消息处理完再 /diag-readonly`,
      );
      return;
    }
    runningTasks.add(taskId);
    try {
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] 以 readonly 权限档跑一轮写入自检…（会触发 runner 重建）`,
      );
      const result = await pool.send(task, DIAG_READONLY_PROMPT, undefined, {
        permission: { mode: 'readonly' },
      });
      if (result.error) {
        await sender.reply(
          replyMsgId,
          `[${task.display_name}] /diag-readonly 失败: ${result.error}`,
        );
        return;
      }
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] /diag-readonly 完成，agent 输出：\n${(result.fullText ?? '').slice(0, 1500)}`,
      );
    } catch (err) {
      await sender.reply(
        replyMsgId,
        `[${task.display_name}] /diag-readonly 异常: ${(err as Error).message}`,
      );
    } finally {
      cancelledTasks.delete(taskId);
      runningTasks.delete(taskId);
      const next = dequeue(taskId);
      if (next) void runWithDrain(taskId, next);
    }
  }

  // M1b WI-4: /probe creates a managed read-only investigation, posts an anchor card, and
  // claims the thread so follow-ups route into it (WI-5). /done closes it and MUST release
  // the claim — otherwise a closed thread keeps a stale managed claim and later follow-ups
  // hit the terminal short-circuit and silently vanish.
  async function runProbe(
    msg: IncomingMessage,
    opts: { repo?: string; description: string },
  ): Promise<void> {
    const repos = opts.repo ? [opts.repo] : [config.allowedCwdPrefixes[0] ?? process.cwd()];

    // 1) 先发占位锚点卡，建话题（群聊 reply_in_thread）/普通回复（p2p），拿 anchorMsgId + threadId。
    //    必须先于 createWorkItem：run 一派发就要从 source 读 thread/anchor 定位去发流式卡，所以
    //    这些定位得在创建工作项之前就备好（彻底避开 claim 登记晚于发卡的时序竞态）。
    const placeholder = buildAnchorCard({
      id: '创建中…',
      title: opts.description,
      stage: 'probe:looking',
      status: 'open',
    });
    let anchorMsgId: string | null;
    let threadId: string | undefined;
    if (msg.chatType === 'group') {
      const res = await sender.replyCardInThread(msg.messageId, placeholder);
      anchorMsgId = res?.messageId ?? null;
      threadId = res?.threadId ?? undefined;
    } else {
      anchorMsgId = await sender.replyCard(msg.messageId, placeholder);
    }
    if (!anchorMsgId) {
      await sender.reply(msg.messageId, '锚点卡发送失败，请重试 /probe。');
      return;
    }

    // 2) createWorkItem：把 thread/anchor 定位写进 source，随 run 下发给 run-handler → ProgressCards。
    let item: WorkItem;
    try {
      item = workitems.api.createWorkItem({
        type: 'probe',
        title: opts.description,
        source: {
          kind: 'feishu',
          userId: msg.userId,
          chatId: msg.chatId,
          messageId: msg.messageId,
          threadId,
          anchorMsgId,
        },
        repos,
        context: {},
      }).item;
    } catch (err) {
      const why =
        err instanceof OpenLimitError
          ? `${err.message}（先用 /done 关掉几个再来）`
          : `调查创建失败: ${(err as Error).message}`;
      if (!(err instanceof OpenLimitError)) logger.error({ err }, 'probe create failed');
      await sender.updateCard(anchorMsgId, buildStatusCard(opts.description, 'error', why));
      return;
    }

    // 3) 同步建 claim（入站路由）：话题内追问带同一 thread_id（群聊）或回复根（p2p）即可匹配。
    // WS-4: 记 chat_id（≠ claimKey，probe 的 key 多为 thread/root）→ 断线补拉据此枚举该会话。
    const claimKey = threadId ?? msg.rootId ?? msg.messageId;
    store.claimThread(claimKey, 'managed', item.id, anchorMsgId, msg.chatId, msg.chatType);

    // 4) 把占位锚点卡补全为真实 id / 状态。
    await sender.updateCard(
      anchorMsgId,
      buildAnchorCard({ id: item.id, title: item.title, stage: item.phase, status: item.status }),
    );
    logger.info({ workitemId: item.id, threadId, anchorMsgId }, 'probe anchor posted');
  }

  async function runDone(msg: IncomingMessage, threadRoot: string): Promise<void> {
    const claim = store.getThreadClaim(threadRoot);
    if (!claim || claim.owner_kind !== 'managed') {
      await sender.reply(msg.messageId, '当前话题不是调查，无需 /done。');
      return;
    }
    const item = workitems.api.getWorkItem(claim.owner_id);
    if (!item) {
      store.releaseThreadClaim(threadRoot);
      await sender.reply(msg.messageId, '该调查已不存在，已清理话题认领。');
      return;
    }
    workitems.api.injectClose(item.id);
    store.releaseThreadClaim(threadRoot);
    // WI-8: refresh the anchor card via its own message id, not the thread root — updateCard
    // targets the original card message.
    if (claim.anchor_msg_id) {
      await sender.updateCard(
        claim.anchor_msg_id,
        buildAnchorCard({
          id: item.id,
          title: item.title,
          stage: item.phase,
          status: 'done',
          closed: true,
          noun: anchorNoun(item.type),
        }),
      );
    }
    await sender.reply(msg.messageId, `已关闭调查 ${item.id}。`);
  }

  // /req (立项重塑, M-I2/3): /req 不再直接建单。bridge 先在原会话问群名（临时待答态），用户下一条
  // 普通消息即群名 → startIntakeGroup 建专属群发起立项。createWorkItem + claim + 清单卡都在
  // startIntakeGroup 里（建群成功后才建单）。
  async function runRequirement(
    msg: IncomingMessage,
    opts: { description: string },
  ): Promise<void> {
    pendingIntake.set(msg.userId, msg.chatId, opts.description, Date.now());
    const tail = opts.description ? `\n需求一句话：${opts.description}` : '';
    await sender.reply(
      msg.messageId,
      `好，咱们给这个需求建个专属群来推进立项。请直接回一条消息作为群名（比如「订单导出」）。${tail}`,
    );
  }

  // M-I2: 用户回了群名 → 建专属群（拉发起人）→ 群里发立项清单卡 → 建立项单（type=requirement，
  // 起步阶段=立项）→ claim 群 chatId（群内消息/卡回调据此路由）→ 预填 name(=群名)+summary(=一句话)
  // → 群里引导收下一项。建群是唯一硬前置（im:chat scope），失败兜底回原会话报错、不建单。
  async function startIntakeGroup(
    msg: IncomingMessage,
    description: string,
    groupName: string,
  ): Promise<void> {
    const groupChatId = await sender.createGroup(groupName, [msg.userId]);
    if (!groupChatId) {
      await sender.reply(
        msg.messageId,
        '建群失败（多半是未开通 im:chat 权限）。开通后重发 /req 再试。',
      );
      return;
    }
    // 预置 name(=群名)+summary(=一句话) 的初始清单视图，先把清单卡发进群拿到 anchorMsgId（同 runProbe
    // 的「建单前先备好出站定位」时序）。
    const seed: Array<{ key: string; value: string }> = [{ key: 'name', value: groupName }];
    if (description) seed.push({ key: 'summary', value: description });
    const view0 = buildIntakeView(groupName, foldIntake(seed));
    const anchorMsgId = await sender.sendCard(groupChatId, buildIntakeChecklistCard(view0));
    if (!anchorMsgId) {
      await sender.reply(
        msg.messageId,
        `群「${groupName}」已建好，但清单卡发送失败，请在群里发一条消息或重发 /req。`,
      );
      return;
    }
    let item: WorkItem;
    try {
      item = workitems.api.createWorkItem({
        type: 'requirement',
        title: groupName,
        source: {
          kind: 'feishu',
          userId: msg.userId,
          chatId: groupChatId,
          messageId: anchorMsgId,
          anchorMsgId,
        },
        repos: [],
        context: {},
      }).item;
    } catch (err) {
      const why =
        err instanceof OpenLimitError
          ? `${err.message}（先用 /done 关掉几个再来）`
          : `需求创建失败: ${(err as Error).message}`;
      if (!(err instanceof OpenLimitError)) logger.error({ err }, 'requirement create failed');
      await sender.updateCard(anchorMsgId, buildStatusCard(groupName, 'error', why));
      return;
    }
    // claim key = 群 chatId（立项群一需求一群；群内消息常无 thread/root/parent，按 chatId 路由）。
    // WS-4: 立项群 claimKey 即 chatId，仍显式记 chat_id（统一 backfill 枚举，别让它去猜 key 是不是 chatId）。
    const claimKey = groupChatId;
    store.claimThread(claimKey, 'managed', item.id, anchorMsgId, groupChatId, 'group');
    // 预填项进事件流（立项书 fold + gate 判定都靠它）。立项阶段 postStatus 是 no-op，清单卡由本路径就地维护。
    for (const f of seed) workitems.api.injectIntakeField(item.id, f);
    logger.info(
      { workitemId: item.id, groupChatId, anchorMsgId },
      'requirement intake group started',
    );
    await sender.reply(
      msg.messageId,
      `已建群「${groupName}」并发起立项，请到群里继续把前置料收齐。`,
    );
    await promptNextIntake(item.id, groupChatId);
  }

  // M-I3 群内收料（AI 抽取版）：用户在群里发的自由描述喂给一次性 AI run，让它**一次抽多个字段**——这样
  // 一条消息把仓库/PRD/验收都甩进来也能拆开。仓库项仍当场校验 git 仓+HEAD；文本项落为 ai-extracted
  // （「立项完成」这一步就是人工兜底确认）。AI 没起来/没抽到 → 回退确定性逐项填。文件附件走 PRD 分支。
  async function handleIntakeMessage(item: WorkItem, msg: IncomingMessage): Promise<void> {
    if (msg.attachments.length > 0) {
      await handleIntakePrd(item, msg);
      return;
    }
    const text = msg.text.trim();
    if (!text) return;
    await sender.sendText(msg.chatId, '🤔 正在从你的描述里提取立项信息…');
    const ex = await aiExtractIntake(item.id, item.title, text, msg);
    if (!ex || ex.fields.length === 0) {
      if (ex?.uiRequired !== undefined) {
        workitems.api.injectIntakeField(item.id, { uiRequired: ex.uiRequired });
      }
      // INTAKE L1：只给了仓名线索（无其它字段，主场景「就在 alaeatposapp 里」）→ 自动派勘探找仓，
      // 不再逐项 nag（勘探回来经 scout_result 入表 / 出歧义卡）。
      if (ex && injectAutoScoutIfNeeded(item, ex.repoHints ?? [])) {
        await sender.sendText(msg.chatId, '🔍 没认出这个仓，我去本地找找，稍等…');
        return;
      }
      await fillIntakeDeterministic(item, msg, text);
      return;
    }
    const applied: string[] = [];
    const badRepos: string[] = [];
    if (ex.uiRequired !== undefined) {
      workitems.api.injectIntakeField(item.id, { uiRequired: ex.uiRequired });
    }
    for (const f of ex.fields) {
      if (f.key === 'repos') {
        const paths = (Array.isArray(f.value) ? f.value : [f.value])
          .map((s) => String(s).trim())
          .filter((s) => s.length > 0);
        const good = paths.filter((p) => isGitRepo(p));
        for (const p of paths) if (!isGitRepo(p)) badRepos.push(p);
        if (good.length > 0) {
          workitems.api.injectIntakeField(item.id, { key: 'repos', value: good });
          applied.push(`涉及代码仓库（${good.length} 个）`);
        }
      } else {
        const value = Array.isArray(f.value) ? f.value.join('、') : f.value;
        workitems.api.injectIntakeField(item.id, {
          key: f.key,
          value,
          filledBy: 'ai-extracted',
          confirmed: true,
        });
        applied.push(INTAKE_CHECKLIST.find((d) => d.key === f.key)?.label ?? f.key);
      }
    }
    await refreshIntakeCard(item.id);
    const lines: string[] = [];
    if (applied.length > 0) lines.push(`✅ 已从你的描述里填入：${applied.join('、')}`);
    if (badRepos.length > 0) {
      lines.push(
        `⚠️ 这些仓库路径无效（需绝对路径 + 是 git 仓）：\n${badRepos.map((p) => `- ${p}`).join('\n')}`,
      );
    }
    // INTAKE L1：填完字段后 repos 仍缺且带未识别线索 → 自动派勘探找仓（与逐项提示并存）。
    if (injectAutoScoutIfNeeded(item, ex.repoHints ?? [])) {
      lines.push('🔍 没认出这个仓，我去本地找找，稍等…');
    }
    const after = foldIntakeState(workitems.api.listEvents(item.id));
    const miss = requiredMissing(after).map((d) => d.label);
    lines.push(
      miss.length > 0
        ? `还差：${miss.join('、')}`
        : '必填已齐 ✅ 核对清单卡无误后点「立项完成 · 开始开发」开跑。',
    );
    await sender.sendText(msg.chatId, lines.join('\n'));
  }

  // INTAKE L1 自动触发（D-7 防抖）：repos 仍缺 ∧ 有未识别仓名线索(repoHints) ∧ 每个线索登记表都未命中或
  // 多命中（单命中说明抽取本应已解析，交回抽取而非勘探）∧ 本单已派勘探 run 结论 < 2 次 ∧ 搜索根非空 →
  // injectHumanMessage('/scout <线索>')（worktype 立项相位 onHumanMessage 派勘探 run）。返回是否已触发。
  // 手动 /scout 不走此路（不受防抖限）。
  function injectAutoScoutIfNeeded(item: WorkItem, repoHints: string[]): boolean {
    if (repoHints.length === 0) return false;
    const events = workitems.api.listEvents(item.id);
    if (intakeReposOf(foldIntakeState(events)).length > 0) return false; // repos 已有 → 不勘探
    // 「单命中登记表 → 交回抽取（AI 本应已解析）」的判据必须对齐 AI 实际看到的**同一窗口**（抽取 prompt 只
    // 织入 listRepoRegistry(20)）——否则命中行落在前 20 之外时，AI 没见到会塞进 repoHints，而全表 matchRepo
    // 又算它单命中 → 既不勘探也没人填，repos 静默卡缺失（审查暴露）。故这里用同一 20 窗口做包含匹配。
    const snapshot = store.listRepoRegistry(20);
    const snapshotMatchCount = (hint: string): number => {
      const needle = hint.trim().toLowerCase();
      return needle.length === 0 ? 0 : snapshot.filter((r) => r.name.includes(needle)).length;
    };
    if (!repoHints.every((h) => snapshotMatchCount(h) !== 1)) return false; // 快照内单命中 → 交回抽取
    if (scoutConclusionCount(events) >= 2) return false; // 防抖：每单自动派 ≤ 2 次
    const roots = scoutRootsFrom(
      store.listRepoRegistry(200).map((r) => r.path),
      process.env.INTAKE_SCOUT_ROOTS,
    );
    if (roots.length === 0) return false; // 无搜索根 → 勘探不可用
    workitems.api.injectHumanMessage(item.id, { text: `/scout ${repoHints.join(' ')}` });
    return true;
  }

  // 起一次性 readonly AI run 把自由描述抽成立项字段（managed 影子 task，每次清会话保持独立）。失败返 null。
  async function aiExtractIntake(
    itemId: string,
    title: string,
    text: string,
    msg: IncomingMessage,
  ): Promise<ReturnType<typeof parseIntakeExtraction>> {
    const state = foldIntakeState(workitems.api.listEvents(itemId));
    const filled = state.fields.map(
      (f) => INTAKE_CHECKLIST.find((d) => d.key === f.key)?.label ?? f.key,
    );
    const missing = requiredMissing(state).map((d) => d.label);
    // INTAKE L0.3：织入已知仓库登记表快照（最近使用前 20）——命中仓名 AI 直接输出绝对路径（免勘探快路径）。
    const registry = store.listRepoRegistry(20).map((r) => ({ name: r.name, path: r.path }));
    const prompt = composeIntakeExtractPrompt(text, filled, missing, registry);
    const taskId = `managed:intake-extract:${itemId}`;
    const task = store.upsertTask({
      id: taskId,
      display_name: `立项抽取:${title}`.slice(0, 60),
      agent_kind: 'claude',
      owner_kind: 'managed',
      mode: 'project',
      cwd: config.allowedCwdPrefixes[0] ?? process.cwd(),
      root_msg_id: null,
      root_chat_id: null,
      agent_session_id: null,
      status: 'suspended',
      model: null,
    });
    store.clearAgentSessionId(taskId); // 每次抽取独立、无上轮串扰
    // WS-10.1（诊断 #14）：该 run 不是 workitem effect，watchdog 管不到——pool.send 无超时会让用户永远停在
    // 「🤔 正在提取…」。加 90s 超时（env INTAKE_EXTRACT_TIMEOUT_MS 可调）→ abort + 返回 null 落 fillIntakeDeterministic。
    const timeoutMs = Number(process.env.INTAKE_EXTRACT_TIMEOUT_MS) || 90_000;
    try {
      const raced = await raceWithTimeout(
        pool.send(task, prompt, undefined, { permission: { mode: 'readonly' } }),
        timeoutMs,
      );
      if (raced === 'timeout') {
        pool.abort(taskId);
        logger.warn(
          { itemId, timeoutMs },
          'intake extract timed out; falling back to deterministic',
        );
        // spec §WS-10.1：超时不再静默——群里明说改逐项收料，别让用户干等「🤔 正在提取…」。通知失败只忽略。
        const hint = 'AI 提取超时，改为逐项收料。';
        try {
          await sender.reply(msg.messageId, hint);
        } catch {
          await sender.sendText(msg.chatId, hint).catch(() => {});
        }
        return null;
      }
      if (raced.error) {
        logger.warn({ err: raced.error, itemId }, 'intake extract run error');
        return null;
      }
      return parseIntakeExtraction(raced.fullText ?? '');
    } catch (err) {
      logger.warn({ err, itemId }, 'intake extract failed');
      return null;
    }
  }

  // 回退：AI 不可用时按「当前待填项」确定性填。仓库项只认绝对路径 token（杜绝把整段话当路径刷垃圾列表）。
  async function fillIntakeDeterministic(
    item: WorkItem,
    msg: IncomingMessage,
    text: string,
  ): Promise<void> {
    const state = foldIntakeState(workitems.api.listEvents(item.id));
    const next = nextRequiredToFill(state);
    if (!next) {
      await sender.sendText(
        msg.chatId,
        '必填项已齐 ✅ 点上方清单卡「立项完成 · 开始开发」即可开跑。',
      );
      return;
    }
    if (next.key === 'repos') {
      const paths = text
        .split(/[\s,，、]+/)
        .map((s) => s.trim())
        .filter((s) => s.startsWith('/'));
      const good = paths.filter((p) => isGitRepo(p));
      const bad = paths.filter((p) => !isGitRepo(p));
      if (good.length === 0) {
        await sender.sendText(
          msg.chatId,
          '没识别到有效仓库——请发仓库的**绝对路径**（一行或空格分隔一个，需是 git 仓）。',
        );
        return;
      }
      workitems.api.injectIntakeField(item.id, { key: 'repos', value: good });
      if (bad.length > 0) {
        await sender.sendText(
          msg.chatId,
          `已收 ${good.length} 个仓库；这些路径无效已跳过：\n${bad.map((p) => `- ${p}`).join('\n')}`,
        );
      }
    } else {
      workitems.api.injectIntakeField(item.id, { key: next.key, value: text });
    }
    await refreshIntakeCard(item.id);
    await promptNextIntake(item.id, msg.chatId);
  }

  // M-I3 PRD：群里上传 MD → 下载 → 存进 artifact 仓 intake/prd.md → 填 prd 项（AI 摘要/预填留后续增强）。
  async function handleIntakePrd(item: WorkItem, msg: IncomingMessage): Promise<void> {
    const md = msg.attachments.find(
      (a) => a.kind === 'file' && /\.(md|markdown|txt)$/i.test(a.name),
    );
    if (!md) {
      await sender.sendText(msg.chatId, '📎 PRD 请上传 .md 文件，或直接发文字描述。');
      return;
    }
    const inbox = path.join(config.dataDir, 'intake-inbox');
    try {
      fs.mkdirSync(inbox, { recursive: true });
    } catch (err) {
      logger.warn({ err, inbox }, 'mkdir intake-inbox failed');
    }
    const tmp = path.join(inbox, `${item.id}-${sanitizeName(md.name)}`);
    const ok = await sender.downloadAttachment(msg.messageId, md.fileKey, 'file', tmp);
    if (!ok) {
      await sender.sendText(msg.chatId, 'PRD 下载失败，请重试。');
      return;
    }
    let content = '';
    try {
      content = fs.readFileSync(tmp, 'utf8');
    } catch (err) {
      logger.warn({ err, tmp }, 'read prd failed');
    }
    workitems.artifacts.writeFile(item.id, 'intake/prd.md', content, '立项上传 PRD');
    workitems.api.injectIntakeField(item.id, {
      key: 'prd',
      value: `见 intake/prd.md（${md.name}）`,
    });
    await sender.sendText(msg.chatId, `📄 已收下 PRD「${md.name}」并存档（intake/prd.md）。`);
    await refreshIntakeCard(item.id);
    await promptNextIntake(item.id, msg.chatId);
  }

  // 引导：群里追下一个还缺的必填项；全齐则提示点「立项完成」。
  async function promptNextIntake(itemId: string, chatId: string): Promise<void> {
    const state = foldIntakeState(workitems.api.listEvents(itemId));
    const next = nextRequiredToFill(state);
    if (next) {
      await sender.sendText(chatId, `📋 还差「${next.label}」：${next.hint ?? '请补充'}`);
    } else {
      await sender.sendText(chatId, '✅ 必填已齐，点上方清单卡「立项完成 · 开始开发」即可开跑。');
    }
  }

  // 就地刷新立项清单卡（料齐时带上立项 gate 路由 → 卡上出「立项完成」按钮）。
  async function refreshIntakeCard(itemId: string): Promise<void> {
    const it = workitems.api.getWorkItem(itemId);
    if (!it) return;
    const anchorMsgId = store.getThreadAnchorByOwner(itemId);
    if (anchorMsgId) await sender.updateCard(anchorMsgId, buildIntakeCard(itemId, it.title));
  }

  function buildIntakeCard(itemId: string, title: string): object {
    const state = foldIntakeState(workitems.api.listEvents(itemId));
    const view = buildIntakeView(title, state);
    if (!view.ready) return buildIntakeChecklistCard(view);
    // 料齐：找立项 gate 的 open human wait（立项阶段仅此一种 checkpoint wait），把路由带进按钮。
    const wait = workitems.store
      .listOpenWaits(itemId)
      .find((w) => w.kind === 'human' && checkpointBoundaryOf(w.reason) !== undefined);
    if (!wait) return buildIntakeChecklistCard(view);
    return buildIntakeChecklistCard(view, {
      itemId,
      waitId: wait.id,
      boundary: checkpointBoundaryOf(wait.reason)!,
    });
  }

  const commands = new CommandHandler(
    store,
    sender,
    config,
    logger,
    pool,
    (taskId, replyMsgId) => {
      void runCompact(taskId, replyMsgId);
    },
    (taskId) => requestStop(taskId),
    (taskId, replyMsgId) => {
      void runDiagMcp(taskId, replyMsgId);
    },
    (taskId, replyMsgId) => {
      void runDiagReadonly(taskId, replyMsgId);
    },
    (msg, opts) => {
      void runProbe(msg, opts);
    },
    (msg, threadRoot) => {
      void runDone(msg, threadRoot);
    },
    (msg, opts) => {
      void runRequirement(msg, opts);
    },
    (msg) => {
      void onCancelUnit(msg);
    },
    (msg, hints) => {
      void onScout(msg, hints);
    },
    (msg, args) => {
      void onDelegate(msg, args);
    },
  );

  // Card button callbacks (R06/D-12) all arrive through one onCardAction; route by value.kind.
  // The whitelist gate is common to every kind; kind-specific handling follows.
  async function handleCardAction(action: CardAction): Promise<void> {
    const value = (action.value ?? {}) as Record<string, unknown>;
    if (!config.allowedOpenIds.has(action.operatorId) && !store.isAllowed(action.operatorId)) {
      logger.warn({ operatorId: action.operatorId }, 'unauthorized card action, ignoring');
      return;
    }
    if (value.kind === CHECKPOINT_ACTION_KIND) {
      await handleCheckpointAction(action, value);
      return;
    }
    // WS-9：workitem run 的 AskUserQuestion 表单提交——组装答案 → injectHumanMessage 回灌下一轮 run
    // （提问的那个 run 多半已收尾，答案自然进下一轮：reconcile 重跑 / steer / rework）。
    if (value.kind === AUQ_WORKITEM_ACTION_KIND) {
      const workitemId = typeof value.workitemId === 'string' ? value.workitemId : '';
      const total = typeof value.total === 'number' ? value.total : 0;
      const headers = Array.isArray(value.headers) ? (value.headers as unknown[]) : [];
      if (!workitemId || total <= 0) {
        logger.warn({ workitemId, total }, 'auq-wi form submit missing workitemId/total');
        return;
      }
      const item = workitems.api.getWorkItem(workitemId);
      const { lines, brief } = assembleAuqAnswers(
        (action.formValue ?? {}) as Record<string, unknown>,
        total,
        headers,
      );
      if (action.messageId) {
        await sender.updateCard(
          action.messageId,
          buildQuestionAnsweredCard(item?.title ?? workitemId, brief.join('；')),
        );
      }
      // INTAKE L1（D-5）：立项相位的 auq-wi 回灌 = 勘探歧义卡的人选答案，要进**下一轮抽取**（走
      // handleIntakeMessage，命中登记表/原路径），而非 worktype human_message（立项相位 onHumanMessage 对
      // 普通消息返回 {} 会把答案吞掉）。合成一条群消息喂抽取路径。thread_root=群 chatId（立项 claimKey）。
      if (item && isIntakePhase(item.phase)) {
        const chatId = store.getThreadRootByOwner(workitemId);
        if (chatId) {
          await handleIntakeMessage(item, {
            messageId: action.messageId ?? '',
            chatId,
            chatType: 'group',
            userId: action.operatorId,
            text: lines.join('\n'),
            isMentioned: false,
            mentions: [],
            attachments: [],
            createTime: Date.now(),
          });
          return;
        }
      }
      workitems.api.injectHumanMessage(workitemId, {
        text: `这是对你上一轮提问的回答：\n${lines.join('\n')}`,
      });
      return;
    }
    if (value.kind !== AUQ_ACTION_KIND) {
      logger.warn({ kind: value.kind }, 'unhandled card action kind');
      return;
    }
    // auq 表单卡提交：凑齐每题答案（input 自定义优先、否则下拉 select），拼成一段文本一次回灌。
    const taskId = typeof value.taskId === 'string' ? value.taskId : '';
    const chatId = typeof value.chatId === 'string' ? value.chatId : '';
    const total = typeof value.total === 'number' ? value.total : 0;
    const headers = Array.isArray(value.headers) ? (value.headers as unknown[]) : [];
    if (!taskId || total <= 0) {
      logger.warn({ taskId, total }, 'auq form submit missing taskId/total');
      return;
    }
    const task = store.getTask(taskId);
    if (!task) {
      logger.warn({ taskId }, 'auq form submit for unknown task');
      return;
    }
    const { lines, brief } = assembleAuqAnswers(
      (action.formValue ?? {}) as Record<string, unknown>,
      total,
      headers,
    );
    // Patch the form card to a terminal "已选 …" so it can't be submitted twice.
    if (action.messageId) {
      await sender.updateCard(
        action.messageId,
        buildQuestionAnsweredCard(task.display_name, brief.join('；')),
      );
    }
    // Feed all answers back as the next turn — same --resume path as a normal reply (the CLI
    // already auto-closed the AskUserQuestion tool, so a tool_result can't go back in).
    const text =
      '这是我对你刚才提问的回答（下列即为最终答复；凡标「自定义回答」的，请按我写的字面采纳，' +
      `不要再归类或套用到你给的预设选项上）：\n${lines.join('\n')}`;
    const turnInput: TurnInput = {
      chatId,
      messageId: action.messageId ?? '',
      text,
    };
    if (runningTasks.has(taskId)) {
      enqueue(taskId, turnInput);
    } else {
      void runWithDrain(taskId, turnInput);
    }
  }

  // Checkpoint 灯卡 click (T3): 通过/打回 funnels through the same single write path the board
  // uses (workbenchAdapter.actions.resolve → resolveWait). The card carries the exact waitId, so
  // no lookup is needed; an already-resolved wait (board / double click) resolves to ok=false and
  // the card is patched to a neutral "已处理".
  async function handleCheckpointAction(
    action: CardAction,
    value: Record<string, unknown>,
  ): Promise<void> {
    const itemId = typeof value.itemId === 'string' ? value.itemId : '';
    const waitId = typeof value.waitId === 'string' ? value.waitId : '';
    if (!itemId || !waitId) {
      logger.warn({ itemId, waitId }, 'checkpoint card action missing itemId/waitId');
      return;
    }
    const title = workitems.api.getWorkItem(itemId)?.title ?? itemId;
    const caseLabel = typeof value.caseLabel === 'string' ? value.caseLabel : '';
    // 立项 gate 的「立项完成」按钮就在清单卡（= 单元锚点卡）上：点完不在此就地打补丁，交给 postStatus
    // 把它 morph 成锚点卡，避免对同一张卡双改打架。独立卡（≠锚点卡）才就地补「已处理」。
    const anchorId = store.getThreadAnchorByOwner(itemId);
    const patch = async (card: object): Promise<void> => {
      if (action.messageId && action.messageId !== anchorId) {
        await sender.updateCard(action.messageId, card);
      }
    };

    // 病历「终止需求」：resolve wait 带 cancel 决策 → onWaitResolved 认出 isCancelDecision → terminal cancelled。
    if (value.cancel === true) {
      const r = workitems.api.resolveWait(waitId, {
        operator: action.operatorId,
        reason: '飞书：终止需求',
        decision: { approved: true, payload: { action: 'cancel' } },
      });
      await patch(buildCaseFileAnsweredCard(title, caseLabel || '病历', r.resolved));
      return;
    }

    // WS-5 通过/打回（关卡灯 / 病历「已处理·继续」/ 监工判大三按钮）。opinion 输入框（form_value）在 resolve
    // 之前经 injectHumanMessage 注入 → seq 落在 resolve 引发的后续 dispatch effect 之前 → 下一轮 run（灯③打回派
    // 的 steer / rework worker）的 batch 窗口内被消费（D-E）。cancel 分支不注入（上面已 return）。
    const approved = value.approved === true;
    const rawOpinion = (action.formValue as { opinion?: unknown } | undefined)?.opinion;
    const opinion = typeof rawOpinion === 'string' ? rawOpinion.trim() : '';
    // WS-5 意见回灌：抽出为可测的 applyCheckpointOpinion。注入须在下方 resolveWait 之前调用（D-E 的 seq
    // 保证：注入落在 resolve 引发的后续 dispatch effect 之前），且它内部只在 wait 仍 open 时注入（防双击）。
    applyCheckpointOpinion({ workitems, itemId, waitId, approved, opinion });
    const reason = opinion || (approved ? '飞书拍板：通过' : '飞书拍板：打回，请按反馈修改');
    // 监工判大三按钮把 value.action（rework/proceed）透传进 decision.payload，worktype 据此路由（走 resolveWait
    // 单写口，与 cancel 分支同源）；其余检查点走 workbenchAdapter（板与飞书共用同一口）。
    const decisionAction = typeof value.action === 'string' ? value.action : undefined;
    const ok = decisionAction
      ? workitems.api.resolveWait(waitId, {
          operator: action.operatorId,
          reason,
          decision: { approved, payload: { reason, action: decisionAction } },
        }).resolved
      : workbenchAdapter.actions.resolve({
          itemId,
          waitId,
          operator: action.operatorId,
          approved,
          reason,
        }).ok;
    if (caseLabel) {
      await patch(buildCaseFileAnsweredCard(title, caseLabel, false));
    } else {
      const boundary = typeof value.boundary === 'string' ? value.boundary : '';
      const gateLabel = boundary ? checkpointGateLabel(boundary) : '检查点';
      await patch(buildCheckpointAnsweredCard(title, gateLabel, ok ? approved : null));
    }
  }

  // WS-10.8：把「按 threadRoot claim → 群 chatId claim 找 managed 单元」的解析抽成 helper，dispatcher 普通消息
  // 路由与 /cancel 命令两处共用，防两份判定漂移。owner 消失但 claim 残留 → 释放并回落普通路由。
  const resolveManagedItem = (msg: IncomingMessage): WorkItem | undefined => {
    const threadRoot = msg.threadId ?? msg.rootId ?? msg.parentId;
    let managedKey: string | undefined;
    let claim = threadRoot ? store.getThreadClaim(threadRoot) : undefined;
    if (claim?.owner_kind === 'managed') {
      managedKey = threadRoot;
    } else if (msg.chatType === 'group') {
      const byChat = store.getThreadClaim(msg.chatId);
      if (byChat?.owner_kind === 'managed') {
        claim = byChat;
        managedKey = msg.chatId;
      }
    }
    if (claim?.owner_kind !== 'managed' || !managedKey) return undefined;
    const item = workitems.api.getWorkItem(claim.owner_id);
    if (item) return item;
    logger.warn({ managedKey, ownerId: claim.owner_id }, 'managed claim with missing owner');
    store.releaseThreadClaim(managedKey);
    return undefined;
  };

  // WS-10.8：群里发 /cancel 发起终止需求（修死代码——以 / 开头的消息先进 commands.dispatch，早于 managed 路由，
  // 故 worktype 的 /cancel 分支从飞书路径本是死代码）。找不到 managed 单 → 提示；终态 → 复用「已结束」文案；
  // 否则 injectHumanMessage('/cancel') → worktype raise cancel_confirm → surfaceCheckpoints 出确认卡。
  async function onCancelUnit(msg: IncomingMessage): Promise<void> {
    const item = resolveManagedItem(msg);
    if (!item) {
      await sender.reply(msg.messageId, '本会话没有进行中的需求单。');
      return;
    }
    if (isTerminalStatus(item.status)) {
      await sender.reply(msg.messageId, '该单元已结束，回复 `/done` 关闭后可重新发起。');
      return;
    }
    workitems.api.injectHumanMessage(item.id, { text: '/cancel' });
  }

  // INTAKE L1：/scout <线索> —— 立项群里让 AI 找仓（手动触发，不受自动防抖限）。找单姿势与 /cancel 同源
  // （resolveManagedItem）；只在立项相位有意义（worktype onHumanMessage 对非立项相位的 /scout 返回 {}）。
  // 透传 '/scout <线索>' 给 worktype，owner 空闲则派勘探 run；忙则回执提示重发。
  async function onScout(msg: IncomingMessage, hints: string): Promise<void> {
    const item = resolveManagedItem(msg);
    if (!item) {
      await sender.reply(msg.messageId, '本会话没有进行中的需求单。');
      return;
    }
    if (isTerminalStatus(item.status)) {
      await sender.reply(msg.messageId, '该单元已结束，无法勘探。');
      return;
    }
    if (!isIntakePhase(item.phase)) {
      await sender.reply(msg.messageId, '勘探只在立项收料阶段可用（此单已过立项）。');
      return;
    }
    const roots = scoutRootsFrom(
      store.listRepoRegistry(200).map((r) => r.path),
      process.env.INTAKE_SCOUT_ROOTS,
    );
    if (roots.length === 0) {
      await sender.reply(
        msg.messageId,
        '勘探不可用：没有可搜索的根目录。请配置环境变量 INTAKE_SCOUT_ROOTS（冒号分隔的目录），或直接发仓库绝对路径。',
      );
      return;
    }
    workitems.api.injectHumanMessage(item.id, { text: `/scout ${hints}` });
    await sender.reply(msg.messageId, '🔍 收到，我去本地找找这个仓，稍等…');
  }

  // DELEGATE D2.2：/delegate 开启/撤销本单委托（写入与文案在 runDelegateCommand，依赖注入式导出可测）。
  // 找单姿势与 /cancel 同源（resolveManagedItem）；delaySec 与容器 watchdog 读同一 env，确认文案里的
  // 冷静期分钟数不会与实际行为漂移。
  async function onDelegate(msg: IncomingMessage, args: string[]): Promise<void> {
    await runDelegateCommand(
      {
        item: resolveManagedItem(msg),
        store: workitems.store,
        reply: (text) => sender.reply(msg.messageId, text),
        delegableReasons: DELEGABLE_WAIT_REASONS,
        delaySec: loadWorkitemsConfig().delegationDelaySec,
      },
      msg,
      args,
    );
  }

  // WS-4: 入站处理主体抽成具名闭包，让「ws 推送（经 ingestMessage 持久去重）」「启动补投」「断线补拉」
  // 三条入口共用同一份处理。dispatcher 收到消息后走 ingestMessage(record→handle→mark)。
  const handleIncoming = async (msg: IncomingMessage): Promise<void> => {
    if (msg.chatType === 'group' && !msg.isMentioned) {
      // 已被 managed 认领的群（立项群：一需求一群，bot 是群成员）内的消息不强制 @bot——收料/追问是
      // 高频多轮，逐条 @ 体验差，且文件消息（PRD）无法附带 @。其它群仍需 @bot 才响应；下方白名单门仍生效。
      if (store.getThreadClaim(msg.chatId)?.owner_kind !== 'managed') {
        return;
      }
    }
    const isAdmin = config.allowedOpenIds.has(msg.userId);
    if (!isAdmin && !store.isAllowed(msg.userId)) {
      logger.warn(
        {
          userId: msg.userId,
          chatType: msg.chatType,
          text: msg.text.slice(0, 50),
        },
        'unauthorized sender, ignoring',
      );
      return;
    }

    if (msg.text.startsWith('/')) {
      await commands.dispatch(msg);
      return;
    }

    // M-I2: /req 后「等群名」待答——用户下一条普通消息即群名 → 建专属群发起立项。先于一切路由，
    // 因为此刻还没有 claim/任务可路由。空群名（如发了张图）→ 保留待答、回提示。
    if (pendingIntake.has(msg.userId, msg.chatId, Date.now())) {
      const groupName = msg.text.trim();
      if (!groupName) {
        await sender.reply(
          msg.messageId,
          '群名不能为空，请回一条文字作为群名（比如「订单导出」）。',
        );
        return;
      }
      const naming = pendingIntake.take(msg.userId, msg.chatId, Date.now());
      await startIntakeGroup(msg, naming?.description ?? '', groupName);
      return;
    }

    // WI-D/WI-5 + M-I2/3: consult the thread-claim registry BEFORE the bridge task fallback. A
    // managed (workitems) claim must not be swallowed by the bridge's root→task / recent-task
    // fallback. probe 按飞书话题 thread 认领；立项群按群 chatId 认领（群内消息常无 thread/root/
    // parent，故 thread 找不到再按 chatId 找）。
    const managedItem = resolveManagedItem(msg);
    if (managedItem) {
      // WI-7 P1: a terminal item (e.g. failed) keeps its claim until /done. Injecting a
      // follow-up would hit the reducer terminal short-circuit (recorded, never dispatched)
      // — so reply honestly instead of promising a report that never comes.
      if (isTerminalStatus(managedItem.status)) {
        await sender.reply(msg.messageId, '该单元已结束，回复 `/done` 关闭后可重新发起。');
        return;
      }
      // 立项收料：群内普通消息当作「当前待填项」的值（缺哪项填哪项），写 intake_field_set 事件并
      // 刷新清单卡；非立项阶段才走普通追问注入。
      if (isIntakePhase(managedItem.phase)) {
        await handleIntakeMessage(managedItem, msg);
        return;
      }
      workitems.api.injectHumanMessage(managedItem.id, {
        text: msg.text,
        feishuMsgId: msg.messageId,
      });
      await sender.reply(
        msg.messageId,
        '已收到，交给包工头处理；他的回应稍后会以卡片形式出现在本群。',
      );
      return;
    }

    const candidates = [msg.rootId, msg.parentId].filter((v): v is string => !!v);
    let task = candidates.length > 0 ? store.getTaskByRootMsg(candidates[0]!) : undefined;
    if (!task) {
      for (const id of candidates) {
        task = store.getTaskByMessageId(id);
        if (task) break;
      }
    }
    if (!task) {
      const currentId = store.getState(currentTaskKey(msg.chatId));
      if (currentId) {
        task = store.getBridgeTask(currentId);
        if (task) {
          logger.info(
            { fallbackTo: task.id, chatId: msg.chatId },
            'routed to current task in chat',
          );
        }
      }
    }
    if (!task) {
      task = store.mostRecentTaskInChat(msg.chatId);
      if (task) {
        logger.info(
          { fallbackTo: task.id, chatId: msg.chatId },
          'fallback to most recent task in chat',
        );
      }
    }
    if (!task) {
      await sender.reply(msg.messageId, '本会话没有任务，用 /new <name> 新建一个。');
      return;
    }

    store.recordTaskMessage(task.id, msg.messageId);
    store.logEvent(task.id, 'user', undefined, {
      text: msg.text,
      attachments: msg.attachments,
    });
    store.touchTask(task.id);

    if (msg.attachments.length > 0) {
      const inboxDir = path.join(task.cwd, 'inbox');
      try {
        fs.mkdirSync(inboxDir, { recursive: true });
      } catch (err) {
        logger.error({ err, inboxDir }, 'mkdir inbox failed');
        await sender.reply(msg.messageId, `[${task.display_name}] 创建 inbox 目录失败`);
        return;
      }
      const downloaded: string[] = [];
      for (let i = 0; i < msg.attachments.length; i++) {
        const a = msg.attachments[i]!;
        const safe = sanitizeName(a.name);
        const dest = path.join(inboxDir, `${msg.messageId}-${i}-${safe}`);
        const ok = await sender.downloadAttachment(msg.messageId, a.fileKey, a.kind, dest);
        if (ok) downloaded.push(dest);
      }
      if (downloaded.length === 0) {
        await sender.reply(msg.messageId, `[${task.display_name}] 附件下载失败`);
        return;
      }
      const expiresAt = Date.now() + ATTACHMENT_TTL_MS;
      const list = pendingAttachments.get(msg.chatId) ?? [];
      for (const p of downloaded) list.push({ path: p, expiresAt });
      pendingAttachments.set(msg.chatId, list);
      const ackLines = downloaded.map((p) => `- \`${p}\``).join('\n');
      const agentLabel = task.agent_kind === 'codex' ? 'Codex' : 'Claude';
      await sender.reply(
        msg.messageId,
        `[${task.display_name}] 已收到附件，存放在：\n${ackLines}\n\n下条消息会自动把这些路径告诉 ${agentLabel}。`,
      );
      if (!msg.text) return;
    }

    const input: TurnInput = {
      chatId: msg.chatId,
      messageId: msg.messageId,
      text: msg.text,
      parentId: msg.parentId,
    };
    if (runningTasks.has(task.id)) {
      const ok = enqueue(task.id, input);
      const depth = queues.get(task.id)?.length ?? 0;
      await sender.reply(
        msg.messageId,
        ok
          ? `[${task.display_name}] 正忙，已排队（队列第 ${depth} 位），处理完会自动接着跑。`
          : `[${task.display_name}] 队列已满（上限 ${MAX_QUEUE}），请稍后再发。`,
      );
      return;
    }
    void runWithDrain(task.id, input);
  };
  const dispatcher = createDispatcher(
    botOpenId,
    logger,
    botStartTime,
    // 持久 inbox：ws 推送先落库权威去重，再处理、再标记（掉电重启补投）。
    async (msg) => {
      await ingestMessage({ store, handle: handleIncoming, logger }, msg);
    },
    handleCardAction,
  );

  await wsClient.start({ eventDispatcher: dispatcher });

  // WS-4 启动补投：上一进程收下但未处理完就崩溃的 inbox 行，按落库顺序重放（已 recordInbox → 不再去重，
  // 直接走 handleIncoming 再标记）。逐条隔离，坏行只 log。用 id 游标分批 drain 全部未处理行（C5 审查修复：
  // 原来只取前 200 条、余量本次运行永不补投）；游标跨过失败行（失败行等下次重启再试），避免死循环。
  const replayInbox = async (): Promise<void> => {
    let afterId = 0;
    for (;;) {
      const rows = store.listInboxUnprocessed(200, afterId);
      if (rows.length === 0) break;
      for (const row of rows) {
        afterId = row.id;
        try {
          await handleIncoming(JSON.parse(row.payload) as IncomingMessage);
          store.markInboxProcessed(row.message_id);
        } catch (err) {
          logger.error({ err, messageId: row.message_id }, 'inbox replay failed');
        }
      }
    }
  };
  // WS-4 断线补拉：对 managed 认领过的会话主动拉 im.message.list（飞书 WS 不重放离线事件）。绕过 ws
  // 推送路径（那条有 botStartTime 时间门会吞掉离线消息），直接喂 handleIncoming。
  const runBackfill = (reason: string): Promise<{ pulled: number; ingested: number }> =>
    backfillClaimedChats({
      store,
      listMessages: (chatId, startTimeSec) => sender.listMessages(chatId, startTimeSec),
      botOpenId,
      handle: handleIncoming,
      logger,
      now: () => Date.now(),
      reason,
    });
  // C8 审查修复：先绑定 onWsRecovered，再跑（可能耗时的）启动补投/补拉——否则 start 到绑定之间若 ws 掉线
  // 恢复只会命中 no-op。backfill 幂等（recordInbox 去重），提前绑定即使与 startup 补拉重叠也无害。
  onWsRecovered = () => {
    void runBackfill('ws-recovered').catch((err) =>
      logger.error({ err }, 'recovered backfill failed'),
    );
  };
  await replayInbox();
  await runBackfill('startup').catch((err) => logger.error({ err }, 'startup backfill failed'));

  // WS reconnect guard: the SDK's reconnect interval is a hard-coded 120s, so a dropped ws
  // leaves the bot "deaf" for up to 2 min. This proactively re-starts the ws once it's been
  // unhealthy past the grace window — start() is re-entrant (see feishu/ws-health.ts).
  startWsReconnectGuard({
    reconnect: () => wsClient.start({ eventDispatcher: dispatcher }),
    health: wsHealth,
    logger,
  });
  logger.info(
    { botOpenId, appId: config.feishu.appId, dataDir: config.dataDir },
    'agent-pipe ready',
  );

  // Bring up the workbench last, after the bridge is live. An 'error' listener keeps a bind
  // failure (e.g. EADDRINUSE) from taking down the whole bot — the board is best-effort.
  if (workbenchServer) {
    workbenchServer.on('error', (err) => {
      logger.error(
        { err, host: config.workbench.host, port: config.workbench.port },
        'workbench server error',
      );
    });
    workbenchServer.listen(config.workbench.port, config.workbench.host, () => {
      logger.info(
        { host: config.workbench.host, port: config.workbench.port },
        'workbench listening',
      );
    });
  }

  // 需求管控台同样最后拉起、best-effort（bind 失败只记日志，不拖垮 bot）。
  if (consoleServer) {
    consoleServer.on('error', (err) => {
      logger.error({ err, port: config.console.port }, 'requirement console server error');
    });
    consoleServer.listen(config.console.port, config.workbench.host, () => {
      logger.info(
        { host: config.workbench.host, port: config.console.port },
        'requirement console listening',
      );
    });
  }

  startHeartbeat(logger, () => ({
    uptimeSec: Math.floor(process.uptime()),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
    runningTurns: runningTasks.size,
    queuedMessages: [...queues.values()].reduce((n, q) => n + q.length, 0),
    hotRunners: pool.hotCount(),
  }));

  const shutdown = () => {
    logger.info('shutting down');
    releaseResources();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// M1b WI-6: extract the IM chat id from a work item's source for the report fallback path
// (used when the anchor-card thread can't be reverse-looked-up).
export function createWorkitemsRuntime(deps: {
  config: Pick<Config, 'workitemsDbPath' | 'workitemsDir' | 'dataDir'>;
  logger: Logger;
  pool: AgentPool;
  sender: Pick<Sender, 'replyCard' | 'sendCard' | 'updateCard' | 'replyCardInThread' | 'reply'>;
  kernelStore: Store;
  defaultCwd: string;
  createContainer?: typeof createWorkitemsContainer;
}): WorkitemsContainer {
  const createContainer = deps.createContainer ?? createWorkitemsContainer;
  // WI-7: post-commit observer. Late-bound via a thunk because postStatus needs `workitems`
  // (the createContainer return value); the thunk defers the lookup until events actually
  // fire (well after assembly — create-time never emits onCommitted).
  let postStatus: (workitemId: string, event: WorkItemEvent) => void = () => {};
  const workitems = createContainer({
    dbPath: deps.config.workitemsDbPath,
    workitemsDir: deps.config.workitemsDir,
    backupsDir: path.join(deps.config.dataDir, 'backups'),
    logger: deps.logger,
    onCommitted: (workitemId, event) => postStatus(workitemId, event),
  });
  // M2 进度可见性：ProgressCards 是 run-handler 中性 RunProgressSink 的 feishu 实现。每轮 run
  // 一张实时流式卡（onRunStart 发卡 → onText/onToolUse 流式刷新 → onRunEnd 原地收尾成报告/失败/
  // 中断卡），合并了 WI-6 的报告回贴（不再独立 replyCard，报告就是流式卡的终态）。出站定位全部
  // 由 onRunStart 携带（run-handler 从 source 提取），本组件零 store 反查。
  const progressCards = new ProgressCards({
    sender: deps.sender,
    logger: deps.logger,
  });
  // WS-3: 灯卡 dedup 从内存 Set 改为 DB 上的 wait.cardMsgId——重启后不重发（DB 记得），发送失败
  // cardMsgId 仍空、下次事件/提醒重试。一个 checkpoint human wait 只发一张卡；打回 re-raise 新 wait id
  // → cardMsgId 为空 → 自动发新卡，语义正确。
  // Surface any new human checkpoint wait as an interactive 灯卡 replied under the anchor (so it
  // lands in the thread). The worktype owns the phase→灯 mapping (checkpointBoundaryOf/lights);
  // this kernel-exempt observer only renders + routes.
  const surfaceCheckpoints = async (
    workitemId: string,
    title: string,
    anchorMsgId: string,
  ): Promise<void> => {
    // DELEGATE D3：灯卡/关单卡出卡时若该单有生效授权且该灯真会自动过，尾部注灰字提示（delaySec 与
    // 容器 watchdog 读同一 env，卡上时刻不与实际行为漂移）。
    const grant = workitems.store.activeDelegation(workitemId, Date.now());
    const delegationDelaySec = loadWorkitemsConfig().delegationDelaySec;
    for (const w of workitems.store.listOpenWaits(workitemId)) {
      if (w.kind !== 'human' || w.cardMsgId !== null) continue;
      // WS-10.3：选卡判定收敛到 waitCardKindFor（纯函数，全覆盖断言据此钉死每个 reason 都有专属卡）。
      const cardKind = waitCardKindFor(w.reason);
      if (cardKind === null) continue; // 非关卡灯 / 非病历 / 无专属卡 → 跳过
      let card: object;
      if (cardKind === 'closure') {
        // WS-7.7 灯④：交付待关单卡。D3：可自动关单时带委托提示。
        const note = delegationCardHint(
          w,
          grant,
          workitems.api.listEvents(workitemId),
          delegationDelaySec,
        );
        card = buildClosureCard({ title, note }, { itemId: workitemId, waitId: w.id });
      } else if (cardKind === 'cancel-confirm') {
        // WS-10.9 取消确认卡。
        card = buildCancelConfirmCard(title, { itemId: workitemId, waitId: w.id });
      } else if (cardKind === 'checkpoint') {
        // 关卡灯(checkpoint:*) → 灯卡(通过/打回)。WS-7.3 灯③ 厚化：交付 gate 卡带对账证据 note，人拍板有据。
        // D3：委托生效且 guard 会放行时追加提示行（lite/no_contract 的灯③ 不提示——guard 拦住不会自动过）。
        const boundary = checkpointBoundaryOf(w.reason)!;
        const events = workitems.api.listEvents(workitemId);
        const note =
          [
            boundary === PHASE.deliver ? deliverGateNote(events) : undefined,
            delegationCardHint(w, grant, events, delegationDelaySec),
          ]
            .filter((s): s is string => !!s)
            .join('\n') || undefined;
        card = buildCheckpointCard(
          { title, gateLabel: checkpointGateLabel(boundary), rail: checkpointRail(boundary), note },
          { itemId: workitemId, waitId: w.id, boundary },
        );
      } else if (cardKind === 'gatekeeper-big') {
        // WS-5：监工判大用三按钮卡（已改图纸·重对账并返工 / 无需改·放行 / 终止需求），红线出口不再只有放行。
        // E4：判大属 INCIDENT_REASONS，detail 尾部注明参谋在路上。
        const detail = withAdvisorHint(
          w.reason,
          caseFileDetail(workitems.api.listEvents(workitemId), w.reason),
        );
        card = buildGatekeeperBigCard(
          { title, label: caseFileLabel(w.reason)!, detail },
          { itemId: workitemId, waitId: w.id },
        );
      } else {
        // 病历(对账冲突/执行报错/集成未决/…) → 病历卡(已处理·继续/终止需求)。E4：仅三类业务事故加参谋提示。
        const detail = withAdvisorHint(
          w.reason,
          caseFileDetail(workitems.api.listEvents(workitemId), w.reason),
        );
        card = buildCaseFileCard(
          { title, label: caseFileLabel(w.reason)!, detail },
          { itemId: workitemId, waitId: w.id },
        );
      }
      const posted = await deps.sender.replyCard(anchorMsgId, card);
      // 发卡成功 → 记 cardMsgId（重启不重发）；失败 → cardMsgId 仍空、下次事件/提醒重试。
      if (posted) workitems.store.updateWait(w.id, { cardMsgId: posted });
    }
  };
  // M1b WI-7 → M2: outbound status bridge — subscribe to committed events and refresh the
  // anchor card per anchorAction. M2: the failure card is now the streaming card's own
  // onRunEnd(failed) terminal patch (ProgressCards, one card per run), so this observer no
  // longer replies its own error card — anchorAction collapses run_failed to update-only.
  // The anchor refresh can't fall back (updateCard needs the original message id) so it logs.
  // T3: after the anchor refresh, surface any pending checkpoint as a 灯卡.
  postStatus = (workitemId, event) => {
    void (async () => {
      try {
        const item = workitems.api.getWorkItem(workitemId);
        if (!item) return;
        // INTAKE L1（D-6）：scout_result 在**立项相位** emit，必须放在下面 intake 早退之前消费（否则被短路）。
        // 桥层据它当场校验入表 / 出歧义 AUQ 卡 / notFound 文案（runScoutResult）。消费完 return，不走下方锚点
        // 刷新（立项清单卡由 bridge 收料路径维护，不该被观察者覆盖）。
        if (event.kind === 'scout_result') {
          const scoutAnchor = deps.kernelStore.getThreadAnchorByOwner(workitemId);
          await runScoutResult(
            {
              // 立项相位仓库存在 **intake 字段**里（item.repos 要到 finalize 才提升，此时恒为 []）——合并基必须
              // 取 intake 字段现值，否则手动 /scout 追加新仓时会用 [] 覆盖已收的仓（丢仓）。
              currentRepos: intakeReposOf(foldIntakeState(workitems.api.listEvents(workitemId))),
              isGitRepo,
              injectRepos: (repos) =>
                workitems.api.injectIntakeField(workitemId, { key: 'repos', value: repos }),
              upsertRepo: (repoPath) =>
                deps.kernelStore.upsertRepoRegistry(
                  repoPath,
                  path.basename(repoPath),
                  Date.now(),
                  'scout',
                ),
              // INTAKE L2：仓内收料——「空字段才注入」判定 + 注入（ai-extracted 草稿，立项完成 gate 兜底确认）。
              isFieldEmpty: (key) => {
                const st = foldIntakeState(workitems.api.listEvents(workitemId));
                const f = st.fields.find((x) => x.key === key);
                if (!f) return true;
                return Array.isArray(f.value) ? f.value.length === 0 : f.value.trim().length === 0;
              },
              injectField: (key, value) =>
                workitems.api.injectIntakeField(workitemId, {
                  key,
                  value,
                  filledBy: 'ai-extracted',
                  confirmed: true,
                }),
              buildQuestionCard: (question, options) =>
                buildWorkitemQuestionCard(
                  item.title,
                  {
                    toolUseId: '',
                    questions: [
                      {
                        question,
                        header: '仓库选择',
                        options: options.map((label) => ({ label })),
                      },
                    ],
                  },
                  { workitemId },
                ),
              postCard: async (card) => {
                if (scoutAnchor) await deps.sender.replyCard(scoutAnchor, card);
                else deps.logger.warn({ workitemId }, 'scout ambiguity card skipped: no anchor');
              },
              notify: async (text) => {
                if (scoutAnchor) await deps.sender.reply(scoutAnchor, text);
                else deps.logger.warn({ workitemId }, 'scout notify skipped: no anchor');
              },
              logger: deps.logger,
            },
            event,
          );
          return;
        }
        // 立项阶段：清单卡由 bridge 收料路径就地刷新（含立项 gate 按钮），观察者不插手，否则会用锚点卡
        // 覆盖清单卡。立项 gate 通过 → 进理解（非立项）→ 下面常规锚点刷新接管（卡 morph 成锚点卡）。
        if (isIntakePhase(item.phase)) return;
        // WI-8: anchor / 灯卡 both target the anchor card's own message id, not the thread root
        // (which keys routing / report replies).
        const anchorMsgId = deps.kernelStore.getThreadAnchorByOwner(workitemId);
        const { update } = anchorAction(event.kind, isTerminalStatus(item.status));
        if (update && anchorMsgId) {
          await deps.sender.updateCard(
            anchorMsgId,
            buildAnchorCard({
              id: item.id,
              title: item.title,
              stage: item.phase,
              status: item.status,
              noun: anchorNoun(item.type),
            }),
          );
        } else if (update) {
          deps.logger.warn({ workitemId }, 'no anchor to refresh');
        }
        // WS-3: wait_reminder 事件的飞书出口——系统在等人时会催（回在锚点卡下，群内可见）。
        // 取不到 label（如 cancel_confirm 走专属确认流）则跳过不催。cardMsgId 为空的卡由下面的
        // surfaceCheckpoints 自愈补发（提醒事件成为卡片重发的触发器）。
        if (event.kind === 'wait_reminder' && anchorMsgId) {
          const payload = event.payload;
          const waitId =
            typeof payload === 'object' &&
            payload !== null &&
            typeof (payload as { waitId?: unknown }).waitId === 'string'
              ? (payload as { waitId: string }).waitId
              : undefined;
          const wait = waitId ? workitems.store.getWait(waitId) : undefined;
          if (wait && wait.resolvedAt === null) {
            const boundary = checkpointBoundaryOf(wait.reason);
            // WS-7.7：awaiting_close（灯④）非 checkpoint 非病历，补一条 label，否则催办因取不到 label 被跳过。
            const label = boundary
              ? checkpointGateLabel(boundary)
              : wait.reason === 'awaiting_close'
                ? '交付待关单（灯④）'
                : caseFileLabel(wait.reason);
            if (label) {
              await deps.sender.reply(
                anchorMsgId,
                `⏰ 这单已等你 ${humanizeMs(Date.now() - wait.createdAt)}：${label}`,
              );
            }
          }
        }
        // DELEGATE D2.3：delegation_due 的桥层消费（与 wait_reminder 分支并排）——业务 guard（灯③需
        // 静态对账真通过）+ resolveWait 唯一写口自动通过 + 群内通知。guard 不过/已 resolve/授权已撤 →
        // 执行器内静默 return，催办照常。
        if (event.kind === 'delegation_due') {
          await runDelegationDue(
            {
              workitems,
              notify: async (text) => {
                if (anchorMsgId) await deps.sender.reply(anchorMsgId, text);
                else deps.logger.warn({ workitemId }, 'delegation notify skipped: no anchor');
              },
              logger: deps.logger,
            },
            event,
          );
        }
        // INTAKE L0.2：repos_set（立项收尾把收齐的仓提升进 workitem.repos）→ 逐仓 upsert 登记表
        // （source='unit'，刷 last_used_at）。此时已过立项相位（split），未被上面的 intake 早退短路。
        if (event.kind === 'repos_set') {
          const p = event.payload;
          const repos =
            typeof p === 'object' && p !== null && Array.isArray((p as { repos?: unknown }).repos)
              ? (p as { repos: unknown[] }).repos.filter(
                  (r): r is string => typeof r === 'string' && r.trim().length > 0,
                )
              : [];
          const now = Date.now();
          for (const repo of repos)
            deps.kernelStore.upsertRepoRegistry(repo, path.basename(repo), now, 'unit');
        }
        // WS-7 交付清单：manifest_ready → 群内贴一张交付清单卡（每仓分支/diffstat/接手命令）。
        if (event.kind === 'manifest_ready' && anchorMsgId) {
          const summaryText =
            typeof event.payload === 'object' &&
            event.payload !== null &&
            typeof (event.payload as { summaryText?: unknown }).summaryText === 'string'
              ? (event.payload as { summaryText: string }).summaryText
              : '(交付清单为空)';
          await deps.sender.replyCard(
            anchorMsgId,
            buildReportCard(`交付清单 · ${item.title}`, summaryText),
          );
        }
        if (anchorMsgId) await surfaceCheckpoints(workitemId, item.title, anchorMsgId);
      } catch (err) {
        deps.logger.error({ err, workitemId }, 'post status failed');
      }
    })();
  };
  // Production wiring: the real agent-run handler (drives the pool) replaces the noop
  // run handler; noop stays a test-only fixture (M1b WI-2/WI-3).
  registerProbe(workitems.registry);
  // requirement worktype (D-15): reuses the generic agent-run handler for owner/worker runs;
  // its own effect handlers (worker write run / integration_check / checkpoint) are layered
  // in later stages. Registered after probe so the shared 'run' handler covers both.
  registerRequirement(workitems.registry);
  // requirement workers run under the WRITE profile in their own worktree (Stage 4); probe
  // keeps the default readonly strategy. strategyFor picks per workitem type. Stage 5: each
  // worker also gets budget-bounded, freshness-flagged repo knowledge (repoKey == repo path).
  // The cold-index run that FILLS the knowledge docs is the live half (Stage 7); here we only
  // read+inject — a never-indexed repo yields undefined and the prompt simply omits the block.
  const knowledgeStore = new KnowledgeStore(path.join(deps.config.dataDir, 'knowledge'));
  const freshnessPolicy = loadFreshnessPolicy();
  // WS-7：worker worktree 根目录——worker-handler（建 worktree）与 deliver_manifest（读 diffstat）+ worktree-gc
  // （清理）共用同一路径，抽成 const 避免三处写死字符串漂移。
  const worktreesDir = path.join(deps.config.dataDir, 'worktrees');
  const requirementStrategy = createRequirementRunStrategy({
    worktreesDir,
    knowledgeFor: (repo) =>
      composeRepoKnowledge(
        {
          store: knowledgeStore,
          policy: freshnessPolicy,
          budgetChars: KNOWLEDGE_BUDGET_CHARS,
          now: () => Date.now(),
        },
        repo,
        repo,
      ),
    // INTAKE L1：勘探搜索根 + 登记快照现算注入（反映最新登记表）。搜索根 = 登记父目录 ∪ INTAKE_SCOUT_ROOTS。
    scoutRoots: () =>
      scoutRootsFrom(
        deps.kernelStore.listRepoRegistry(200).map((r) => r.path),
        process.env.INTAKE_SCOUT_ROOTS,
      ),
    scoutRegistrySnapshot: () =>
      renderRegistrySnapshot(
        deps.kernelStore.listRepoRegistry(20).map((r) => ({ name: r.name, path: r.path })),
      ),
  });
  workitems.effects.registerHandler(
    createAgentRunHandler({
      pool: deps.pool,
      kernelStore: deps.kernelStore,
      defaultCwd: deps.defaultCwd,
      logger: deps.logger,
      progress: progressCards,
      strategyFor: (item) => (item.type === 'requirement' ? requirementStrategy : undefined),
    }),
  );
  // requirement 集成验证: static contract对账 effect (emits integration_check_passed/failed).
  workitems.effects.registerHandler(createIntegrationCheckHandler());
  // requirement 拆解阶段 owner 跨仓对账: static reconcile_check effect (PIVOT §3.1)。读 owner 对账产物
  // contract/reconcile.json + workitem.repos → emit reconcile_passed / reconcile_conflict（病历）。
  workitems.effects.registerHandler(createReconcileCheckHandler());
  // WS-2 消息必达: steer_apply effect——解析包工头 steer run 报告的结构化指令 → emit steer_directive。
  workitems.effects.registerHandler(createSteerApplyHandler());
  // requirement 并行实现阶段监工科层 (PIVOT §4): static gatekeeper_review effect。扫各仓工人「疑则上报」→
  // 跨仓外溢/疑则判大 emit gatekeeper_big（病历）/ 纯本仓判小回写图纸 emit gatekeeper_passed → owner assess。
  workitems.effects.registerHandler(createGatekeeperReviewHandler());
  // WS-5 监工判大返工：人已改图纸并重对账通过（reconcile_passed@implement）→ 提取最近 gatekeeper_big 的受影响仓 →
  // emit rework_requested → worktype 定向重派这些仓的 worker。设计仍只有人能改（agent 只重对账），红线不放松。
  workitems.effects.registerHandler(createGatekeeperReworkHandler());
  // WS-7 交付清单 effect: 灯③ 首次 raise 时生成每仓分支/diffstat/接手命令 → emit manifest_ready → postStatus 贴卡。
  workitems.effects.registerHandler(createDeliverManifestHandler({ worktreesDir }));
  // 立项收尾 effect: 立项 gate 通过 → fold 立项填项历史 → 落立项书 intake/intake.md + 提升 repos
  // (emit repos_set)。注册在这里，与 agent-run / integration_check 同批，进理解时由 worktype 发起。
  workitems.effects.registerHandler(createIntakeFinalizeHandler());
  // INTAKE L1 勘探收尾 effect：读勘探 run 报告 → 解析 ```scout 块 → emit scout_result（桥层 runScoutResult
  // 消费：当场校验入表 / 出歧义 AUQ 卡 / notFound 文案）。
  workitems.effects.registerHandler(createScoutApplyHandler());
  workitems.start();
  return workitems;
}

export function createReleaseResources(deps: {
  pool: Pick<AgentPool, 'killAll'>;
  workitems: Pick<WorkitemsContainer, 'stop'>;
  store: Pick<Store, 'close'>;
  pidPath: string;
  // HTML 工作台 server — closed first so it stops accepting requests before the store/pool it
  // reads through are torn down. Optional/nullable: absent when WORKBENCH_ENABLED=false.
  workbenchServer?: { close(): void } | null;
  // 需求管控台 server — 与 workbench 同样最先关停（停止读 store/pool）。可空：CONSOLE_ENABLED=false 时缺席。
  consoleServer?: { close(): void } | null;
  removePidFile?: typeof removeOwnPidFile;
}): () => void {
  return () => {
    try {
      deps.consoleServer?.close();
    } catch {
      /* ignore */
    }
    try {
      deps.workbenchServer?.close();
    } catch {
      /* ignore */
    }
    try {
      deps.pool.killAll();
    } catch {
      /* ignore */
    }
    try {
      deps.workitems.stop();
    } catch {
      /* ignore */
    }
    try {
      deps.store.close();
    } catch {
      /* ignore */
    }
    (deps.removePidFile ?? removeOwnPidFile)(deps.pidPath);
  };
}

function isCliEntrypoint(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCliEntrypoint()) {
  main().catch((err) => {
    console.error('fatal:', err);
    process.exit(1);
  });
}
