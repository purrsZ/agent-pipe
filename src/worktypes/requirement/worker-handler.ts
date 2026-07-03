import * as fs from 'node:fs';
import { worktreeAdd, worktreeIsDirty, worktreePathFor } from '../../agents/worktree.js';
import type { Assignment, WorkItem, WorkItemEvent } from '../../workitems/types.js';
import type { RunStrategy } from '../agent-run/run-handler.js';
import { composeAdvisePrompt, composeInspectPrompt, renderEventDigest } from './advisor.js';
import { branchFor } from './branch.js';
import { type ContractSnapshot, EMPTY_SNAPSHOT } from './contract.js';
import { parseInternalApis, promoteToContract } from './design.js';
import { PHASE } from './phases.js';
import { composeReconcilePrompt, parseReconcileResult, reconcileToContract } from './reconcile.js';
import { composeSteerPrompt, renderContractSummary, steeringNotePath } from './steering.js';
import { composeWorkerPrompt, mapWritePermission } from './worker.js';

// requirement run strategy (worker-runtime). Workers run in their own worktree under the
// WRITE profile (D-04/R04/R05); the owner/coordinator runs readonly. The kernel worktree
// primitives do the git (this file stays clear of child_process — effect-handler red-line);
// here we only decide cwd / options / prompt / resume. The actual agent run is the live half.
//
// PIVOT：owner 不再「产设计」（spec-design 已摘出 agent-pipe）。「拆解」phase 的 owner run 是**跨仓对账**
// run（composeReconcilePrompt + afterRun 升格跨仓契约，见 reconcile.ts）；其它 owner run（实现批次 assess）
// 用通用包工头 prompt。worker run 仍按冻结的跨仓契约切片施工。

// assess 聚合工人回执的上界（防 prompt 随工人数 × 重跑轮数线性膨胀）：最多 N 份、每份最多 M 字符。
const MAX_ASSESS_REPORTS = 16;
const MAX_ASSESS_REPORT_CHARS = 6000;
export function createRequirementRunStrategy(opts: {
  worktreesDir: string;
  baseRef?: string; // feature base ref in the target repo; default HEAD
  // Stage 5 选择性注入: returns the budget-bounded repo-knowledge block (or undefined) for a
  // worker's repo. Injected as a function so this worktypes-layer file never imports the
  // knowledge layer — index.ts wires the real KnowledgeStore-backed reader (composeRepoKnowledge).
  knowledgeFor?: (repoKey: string) => string | undefined;
}): RunStrategy {
  const base = opts.baseRef ?? 'HEAD';

  const workerCwd = (workitem: WorkItem, assignment: Assignment): string | undefined => {
    const repo = assignment.repo;
    if (assignment.role !== 'worker' || !repo) return undefined;
    return worktreePathFor(opts.worktreesDir, workitem.id, assignment.id, repo);
  };

  return {
    composePrompt: ({
      title,
      assignment,
      priorReport,
      priorReportPaths,
      followups,
      readArtifact,
      workitem,
      effectPayload,
      events,
    }) => {
      if (assignment.role === 'worker') {
        const contract = readContract(readArtifact);
        // WS-2.5：rework/fix 轮的返工说明优先取 dispatch payload 的 note（steer/fix 显式指令），回落到
        // stall 重派的 priorReport；用户中途给本仓的指示从 steering/<repo>.md 读（steer_apply 落）。
        const note = noteFromPayload(effectPayload);
        return composeWorkerPrompt({
          title,
          repo: assignment.repo ?? '',
          contract,
          // 选择性注入: only workers get repo knowledge, keyed by the repo they own.
          knowledge: assignment.repo ? opts.knowledgeFor?.(assignment.repo) : undefined,
          reworkNote: note || (assignment.replacesAssignmentId ? priorReport : undefined),
          steeringNote: assignment.repo
            ? readArtifact(steeringNotePath(assignment.repo))
            : undefined,
        });
      }
      // owner run 按 stage 优先分流（WS-0.4）：拆解 = 跨仓对账 run（读各仓设计「外部方契约」节，拼凑+对账），
      // WS-5 起 implement 相位内也可重对账（stage=reconcile）。afterRun 升格写 contract.json + reconcile.json。
      const stage = stageFromPayload(effectPayload);
      // WS-2.4：steer run（包工头答复用户 + 决定是否调整施工）——读契约摘要 / 监工日志 / 集成报告 / 各仓回执，
      // followups 是用户这批话（run-handler 已算好）。产出面向用户的答复 + 末尾 steer 指令块（steer_apply 消费）。
      if (stage === 'steer') {
        return composeSteerPrompt({
          title,
          phase: workitem.phase,
          repos: workitem.repos,
          intakeBrief: readArtifact('intake/intake.md'),
          followups,
          contractSummary: renderContractSummary(readContract(readArtifact)),
          gatekeeperLog: readArtifact('contract/gatekeeper-log.md'),
          integrationReport: readArtifact('contract/integration-report.md'),
          recentReports: boundedReports(priorReportPaths, readArtifact),
          priorSteerReport: priorReport,
          // E2 大事记：包工头据此了解全程来龙去脉（解决「记忆靠接力、长链衰减」）。
          digest: renderEventDigest(events ?? []),
        });
      }
      // ENHANCE E1：参谋 run（stage=advise）——与 steer 同款全景上下文 + 事故单（incident，adviseSpec 从事故
      // payload 渲染好放 dispatch payload）。产出解读 + 建议贴回群，收尾无流转（index.ts advise 分支 → {}）。
      if (stage === 'advise') {
        return composeAdvisePrompt({
          title,
          phase: workitem.phase,
          repos: workitem.repos,
          intakeBrief: readArtifact('intake/intake.md'),
          followups,
          contractSummary: renderContractSummary(readContract(readArtifact)),
          gatekeeperLog: readArtifact('contract/gatekeeper-log.md'),
          integrationReport: readArtifact('contract/integration-report.md'),
          recentReports: boundedReports(priorReportPaths, readArtifact),
          priorSteerReport: priorReport,
          // E2 大事记：参谋据此知晓全程，建议更贴合上下文。
          digest: renderEventDigest(events ?? []),
          incident: incidentFromPayload(effectPayload),
        });
      }
      // ENHANCE E5：集成实证质检员 run（stage=inspect）——契约全文 + 立项书（验收标准）+ 大事记 + 各仓
      // worktree 清单（runOptions 已把这些 worktree 加进 readableDirs，质检员由此看得见实物）。产出实证报告
      // 贴回群，收尾无流转（index.ts inspect 分支 → {}）。灯③ 由此从「纯自述链」升级为三层证据。
      if (stage === 'inspect') {
        return composeInspectPrompt({
          title,
          repos: workitem.repos,
          intakeBrief: readArtifact('intake/intake.md'),
          contract: readArtifact('contract/contract.json'),
          digest: renderEventDigest(events ?? []),
          worktrees: lastWorkerWorktrees(events ?? [], opts.worktreesDir, workitem.id),
          followups,
        });
      }
      if (stage === 'reconcile' || workitem.phase === PHASE.split) {
        return composeReconcilePrompt({
          title,
          repos: workitem.repos,
          intakeBrief: readArtifact('intake/intake.md'),
          priorReport,
          followups,
        });
      }
      // 其它 owner run（实现批次 assess）：立项书 + 多仓清单 + 人类追问 + **各仓工人完成回执**。工人的
      // 改动落在各自 worktree、owner 只读读不到，故批次评估 + impl-claims 登记靠读工人 run 的 report.md
      // （priorReportPaths = 全历史 run_completed 报告路径，含跨仓对账报告 + 各仓工人回执，B 阶段）。
      // 有界：只取最近 N 份（最新的就是各仓工人回执；最老的跨仓对账报告在仓多/多轮时自然落出）+ 每份截断，
      // 防 prompt 随工人数 × 重跑轮数线性膨胀撞 context window。
      const workerReports = boundedReports(priorReportPaths, readArtifact);
      return composeOwnerPrompt({
        title,
        repos: workitem.repos,
        intakeBrief: readArtifact('intake/intake.md'),
        priorReport,
        followups,
        workerReports,
        // 监工裁决回写图纸（C，rule #2）：assess 据它知道哪些本仓偏离已被监工自治放行、哪些跨仓外溢已 raise 人。
        gatekeeperLog: readArtifact('contract/gatekeeper-log.md'),
      });
    },

    runOptions: ({ workitem, assignment, cwd, effectPayload, events }) => {
      // worker → write + the worktree as the only writable dir (never full). owner → readonly,
      // but with EVERY involved repo as a readable dir (--add-dir) so a cross-repo 包工头 can read
      // all repos, not just cwd=repos[0]（真机暴露：理解 run 只看了第一个仓）。
      if (assignment.role === 'worker') return mapWritePermission(cwd);
      // ENHANCE E5：集成实证质检员（stage=inspect）readonly 不变，但 readableDirs 除全仓外再加各仓最后一轮
      // worker 的 worktree——质检员由此成为全流程第一个「既见图纸又见实物」的角色。worktree 已被 GC / 不存在
      // 的路径照传（agent 读不到会自己降级，与 diffstat 占位串同理）。
      if (stageFromPayload(effectPayload) === 'inspect') {
        const worktrees = lastWorkerWorktrees(events ?? [], opts.worktreesDir, workitem.id).map(
          (w) => w.worktreePath,
        );
        return {
          permission: { mode: 'readonly' },
          readableDirs: [...reposReadable(workitem), ...worktrees],
        };
      }
      return { permission: { mode: 'readonly' }, readableDirs: reposReadable(workitem) };
    },

    resolveCwd: ({ workitem, assignment, defaultCwd }) =>
      workerCwd(workitem, assignment) ?? assignment.repo ?? workitem.repos[0] ?? defaultCwd,

    prepareWorkspace: ({ workitem, assignment, cwd }) => {
      const wt = workerCwd(workitem, assignment);
      if (wt && assignment.repo) {
        // idempotent: a resume reuses the existing worktree; a fresh dispatch creates it.
        if (!fs.existsSync(wt)) {
          worktreeAdd(assignment.repo, wt, branchFor(workitem, assignment), base);
        }
      } else {
        fs.mkdirSync(cwd, { recursive: true });
      }
    },

    // Non-idempotent (write): resume only when the session id is on the assignment (onSession,
    // D-30) AND the worktree is clean; otherwise the caller resets the worktree + redispatch
    // (D-09). owner/non-worker runs are readonly-idempotent → never resume (redispatch).
    canResume: (_payload, assignment, workitem) => {
      if (!assignment || assignment.role !== 'worker') return false;
      if (assignment.agentSessionId == null) return false;
      const wt = workerCwd(workitem, assignment);
      if (!wt || !fs.existsSync(wt)) return false;
      try {
        return !worktreeIsDirty(wt);
      } catch {
        return false;
      }
    },

    // owner run 收尾的两件结构化产物（artifact-only，绝不把 run 翻成 failure；解析不到优雅降级）：
    afterRun: ({ report, workitem, assignment, writeArtifact, effectPayload }) => {
      if (assignment.role !== 'owner') return;
      const stage = stageFromPayload(effectPayload);
      // 跨仓对账（拆解，或 WS-5 implement 相位内重对账 stage=reconcile）→ 落两份：reconcile.json（完整对账
      // 结果，reconcile_check 据它判定）+ contract.json（升格的跨仓契约快照，灯③ 对账基准 + worker 切片）。
      // 复核 R1：phase 回落必须限定 stage 缺失（对齐下方 assess 分支的守卫）——否则 split 相位收尾的
      // steer/advise（答话/建议报告）会被 parseReconcileResult 解析成 EMPTY 覆盖写契约产物（零行动权泄漏）。
      if (stage === 'reconcile' || (stage === undefined && workitem.phase === PHASE.split)) {
        const result = parseReconcileResult(report);
        writeArtifact(
          'contract/reconcile.json',
          `${JSON.stringify(result, null, 2)}\n`,
          `owner 跨仓对账（${result.interfaces.length} 条接口 / ${result.unresolved.length} 处未决）`,
        );
        const snapshot = reconcileToContract(result);
        writeArtifact(
          'contract/contract.json',
          `${JSON.stringify(snapshot, null, 2)}\n`,
          `跨仓契约定稿（${snapshot.interfaces.length} 条接口）`,
        );
        return;
      }
      // 并行实现：owner assess（所有 worker 完成后唯一一次跑的批次评估 run）登记**各仓实际已实现/对外
      // 提供**的接口 → contract/impl-claims.json，作为灯③ 集成对账的「实现侧」输入（契约=应实现，claims=
      // 实际实现，contractStructuralDiff 比出缺失/错配 → 灯③ 长牙）。单写口、无并发竞争（worker 不写）。
      // 解析不到 ≥1 条则不写——integration_check 走 no_claims 优雅放行（skeleton），不强行判失败。
      if (stage === 'assess' || (stage === undefined && workitem.phase === PHASE.implement)) {
        const entries = parseInternalApis(report);
        if (entries.length === 0) return;
        const claims = promoteToContract('impl', entries);
        writeArtifact(
          'contract/impl-claims.json',
          `${JSON.stringify(claims, null, 2)}\n`,
          `assess 登记实现接口（${entries.length} 条）`,
        );
      }
    },
  };
}

// WS-0.4: read the dispatch payload's stage so composePrompt/afterRun route by (role, stage) rather
// than by phase — the precondition for WS-5's in-implement re-reconcile round. undefined ⇒ 回落 phase。
function stageFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const v = (payload as Record<string, unknown>).stage;
  return typeof v === 'string' ? v : undefined;
}

// WS-2.4/2.5：dispatch payload 的 note（rework/fix 轮的返工说明）。空/缺失 → undefined。
function noteFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const v = (payload as Record<string, unknown>).note;
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

// ENHANCE E1：dispatch payload 的 incident（adviseSpec 渲染好的事故单）。空/缺失 → ''（composeAdvisePrompt
// 内部回落「(事故详情缺失)」，不抛）。仿 noteFromPayload 防御式。
function incidentFromPayload(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const v = (payload as Record<string, unknown>).incident;
  return typeof v === 'string' ? v : '';
}

// ENHANCE E5：每仓取最后一条 role==='worker' 的 run_completed（byRepo 覆盖写，多轮 fix/rework 后以最终为准；
// 先例 deliver.ts:33-45），用 worktreePathFor 推出该仓最新 worker worktree 路径。质检员 run 据此把这些实物
// 目录列进 readableDirs + prompt。纯函数（path.join，无 IO）：worktreesDir/workitemId 由调用方从 opts 闭包传入。
export function lastWorkerWorktrees(
  events: WorkItemEvent[],
  worktreesDir: string,
  workitemId: string,
): Array<{ repo: string; worktreePath: string }> {
  const byRepo = new Map<string, { repo: string; worktreePath: string }>();
  for (const ev of events) {
    if (ev.kind !== 'run_completed') continue;
    const p = ev.payload;
    if (typeof p !== 'object' || p === null) continue;
    const o = p as Record<string, unknown>;
    if (o.role !== 'worker') continue;
    const repo = typeof o.repo === 'string' ? o.repo : '';
    const assignmentId = typeof o.assignmentId === 'string' ? o.assignmentId : '';
    if (!repo || !assignmentId) continue;
    byRepo.set(repo, {
      repo,
      worktreePath: worktreePathFor(worktreesDir, workitemId, assignmentId, repo),
    });
  }
  return [...byRepo.values()];
}

// assess / steer 共用：全历史 run_completed 报告路径 → 有界回执（最近 N 份、每份截断），防 prompt 随工人数 ×
// 重跑轮数线性膨胀撞 context window。
function boundedReports(
  priorReportPaths: string[] | undefined,
  readArtifact: (rel: string) => string | undefined,
): string[] {
  return (priorReportPaths ?? [])
    .slice(-MAX_ASSESS_REPORTS)
    .map((p) => readArtifact(p))
    .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    .map((r) =>
      r.length > MAX_ASSESS_REPORT_CHARS
        ? `${r.slice(0, MAX_ASSESS_REPORT_CHARS)}\n…（回执已截断）`
        : r,
    );
}

function readContract(readArtifact: (rel: string) => string | undefined): ContractSnapshot {
  const raw = readArtifact('contract/contract.json');
  if (!raw) return EMPTY_SNAPSHOT;
  try {
    const parsed = JSON.parse(raw) as ContractSnapshot;
    return parsed && Array.isArray(parsed.interfaces) ? parsed : EMPTY_SNAPSHOT;
  } catch {
    return EMPTY_SNAPSHOT;
  }
}

// 涉及仓库去空白：owner 只读档要把这些仓全部作为可读目录（--add-dir），不止 repos[0]。
function reposReadable(workitem: WorkItem): string[] {
  return workitem.repos.filter((r) => typeof r === 'string' && r.trim().length > 0);
}

function composeOwnerPrompt(input: {
  title: string;
  repos: string[];
  intakeBrief?: string;
  priorReport?: string;
  followups?: string[];
  workerReports?: string[]; // 各仓工人完成回执（report.md 全文），B 阶段 assess 据它评估 + 登记实现
  gatekeeperLog?: string; // 监工裁决回写图纸（C，gatekeeper-log.md），assess 据它知监工放行/上报了什么
}): string {
  const repoList = input.repos.filter((r) => typeof r === 'string' && r.trim().length > 0);
  const lines = [
    '你是这个需求的包工头（协调者）。各仓 worker 已并行完成本仓实现 + 自测，现在请你做**集成前的批次评估**：',
    '依据下面各仓工人的完成回执 + 只读浏览各仓改动与自测结果，判断是否可进入集成验证、列出需重点核对的',
    '跨仓接口与风险。你以只读方式浏览所有相关仓库，不直接改代码（改代码是各仓 worker 的事）。',
    '',
    '# 需求',
    input.title,
  ];
  // 立项书是前置已收齐的需求材料（PRD 摘要/验收/UI/边界/多仓），据它推进，别再向用户索要已有材料。
  if (input.intakeBrief && input.intakeBrief.trim().length > 0) {
    lines.push(
      '',
      '# 立项书（前置已收齐的需求材料，请据此推进；不要再向用户索要这里已有的 PRD / 验收 / 仓库等）',
      input.intakeBrief.trim(),
    );
  }
  if (repoList.length > 0) {
    lines.push(
      '',
      '# 涉及的仓库（绝对路径，全部需只读考古——不要只看第一个）',
      ...repoList.map((r) => `- ${r}`),
    );
  }
  // 各仓工人完成回执：工人改动落在各自 worktree、owner 读不到，故批次评估 + 实现登记靠这些回执。
  const reports = (input.workerReports ?? []).filter((r) => r && r.trim().length > 0);
  if (reports.length > 0) {
    lines.push('', '# 各仓工人完成回执（改了什么 / 依据契约哪几条 / 自测结果）');
    reports.forEach((r, i) => {
      lines.push('', `## 回执 ${i + 1}`, r.trim());
    });
  }
  if (input.gatekeeperLog && input.gatekeeperLog.trim().length > 0) {
    lines.push(
      '',
      '# 监工裁决（回写图纸：哪些本仓偏离已自治放行 / 哪些跨仓外溢已 raise 人）',
      input.gatekeeperLog.trim(),
    );
  }
  if (input.priorReport && input.priorReport.trim().length > 0) {
    lines.push('', '# 上一轮你的现状/结论（延续，不要重复）', input.priorReport.trim());
  }
  // 人类反馈/追问优先级最高：群里说的话经容器纳入本轮 run 的 followups，在这里喂给包工头据以调整。
  if (input.followups && input.followups.length > 0) {
    lines.push(
      '',
      '# 用户的反馈 / 追问（最高优先级，请据此调整本轮结论，不要重复已被认可的部分）',
      ...input.followups.map((f) => `- ${f}`),
    );
  }
  // 集成对账的「实现侧」输入：assess 在评估之外，于报告**最末尾**登记各仓**实际已实现/对外提供**的跨仓
  // 接口（afterRun 解析此块 → contract/impl-claims.json，喂灯③ 静态对账）。与对接契约同形。
  lines.push(
    '',
    '# 产出要求（实现登记）',
    '在上面的批次评估之外，请在报告**最末尾**输出且仅输出一个 ```json 块，登记各仓**实际已实现 / 对外提供**',
    '的跨仓接口（只登记真正落地的；没实现的别登记），用于集成对账：',
    '```json',
    '{ "interfaces": [ { "id": "接口标识", "signature": "签名", "providerRepo": "提供方仓绝对路径", "consumerRepos": ["调用方仓"], "fields": [{ "name": "字段", "type": "类型", "optional": false }] } ] }',
    '```',
  );
  return lines.join('\n');
}
