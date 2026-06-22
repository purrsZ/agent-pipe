import * as fs from 'node:fs';
import { worktreeAdd, worktreeIsDirty, worktreePathFor } from '../../agents/worktree.js';
import type { Assignment, WorkItem } from '../../workitems/types.js';
import type { RunStrategy } from '../agent-run/run-handler.js';
import { type ContractSnapshot, EMPTY_SNAPSHOT } from './contract.js';
import { composeSpecDesignPrompt, parseInternalApis, promoteToContract } from './design.js';
import { PHASE } from './phases.js';
import { composeWorkerPrompt, mapWritePermission } from './worker.js';

// requirement run strategy (worker-runtime). Workers run in their own worktree under the
// WRITE profile (D-04/R04/R05); the owner/coordinator runs readonly. The kernel worktree
// primitives do the git (this file stays clear of child_process — effect-handler red-line);
// here we only decide cwd / options / prompt / resume. The actual agent run is the live half.
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
    composePrompt: ({ title, assignment, priorReport, readArtifact, workitem }) => {
      if (assignment.role === 'worker') {
        const contract = readContract(readArtifact);
        return composeWorkerPrompt({
          title,
          repo: assignment.repo ?? '',
          contract,
          // 选择性注入: only workers get repo knowledge, keyed by the repo they own.
          knowledge: assignment.repo ? opts.knowledgeFor?.(assignment.repo) : undefined,
          reworkNote: assignment.replacesAssignmentId ? priorReport : undefined,
        });
      }
      // owner: the 合同-phase owner run IS the spec-design run (design-phase §5.1 / D-15). It
      // browses readonly, produces the design narrative, and emits a structured contract draft
      // block (afterRun 升格 it). Other owner phases (理解/详设/拆解/assess) keep the包工头 prompt.
      if (workitem.phase === PHASE.contract) {
        return composeSpecDesignPrompt({
          title,
          priorReport,
          knowledge: knowledgeForRepos(workitem.repos, opts.knowledgeFor),
          repos: workitem.repos,
          // 立项书（立项 gate 通过时落 intake/intake.md，M-I3 live 写）。不存在则优雅降级回裸标题。
          intakeBrief: readArtifact('intake/intake.md'),
        });
      }
      return composeOwnerPrompt(title, priorReport);
    },

    runOptions: ({ assignment, cwd }) =>
      // worker → write + the worktree as the only writable dir (never full). owner → readonly.
      assignment.role === 'worker' ? mapWritePermission(cwd) : { permission: { mode: 'readonly' } },

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

    // design-phase §5.1/§5.2: the 合同-phase spec-design (owner) run 收尾时把报告里的对接合同草案块
    // 升格成 frozen-able contract/contract.json（T5/A2）。其它 phase / role 的 run 不产合同。健壮：
    // 解析不到 → 空快照，灯②人审兜底而非 run 崩溃。（draft → 灯②approval-冻结的语义细分是
    // contract-engine 域后续；此处直接写 contract.json 让 worker/集成对账端到端可读。）
    afterRun: ({ report, workitem, assignment, writeArtifact }) => {
      if (assignment.role !== 'owner' || workitem.phase !== PHASE.contract) return;
      const entries = parseInternalApis(report);
      const snapshot = promoteToContract('draft', entries);
      writeArtifact(
        'contract/contract.json',
        `${JSON.stringify(snapshot, null, 2)}\n`,
        `spec-design 升格合同（${entries.length} 条接口）`,
      );
    },
  };
}

// 设计 run 的代码考古复用各仓已有知识 map（D-08）：把涉及仓的知识块拼接，无则 undefined。
function knowledgeForRepos(
  repos: string[],
  knowledgeFor: ((repoKey: string) => string | undefined) | undefined,
): string | undefined {
  if (!knowledgeFor) return undefined;
  const blocks = repos
    .map((r) => knowledgeFor(r))
    .filter((b): b is string => typeof b === 'string' && b.trim().length > 0);
  return blocks.length > 0 ? blocks.join('\n\n') : undefined;
}

function branchFor(workitem: WorkItem, assignment: Assignment): string {
  const repo = (assignment.repo ?? 'repo').replace(/[^A-Za-z0-9._-]+/g, '-');
  return `req/${workitem.id.slice(3, 15)}/${repo}-${assignment.id.slice(3, 11)}`;
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

function composeOwnerPrompt(title: string, priorReport?: string): string {
  const lines = [
    '你是这个需求的包工头（协调者）。基于当前结构化现状，产出本阶段的协调结论：理解/合同/拆解/集成判定。',
    '你以只读方式浏览，不直接改代码（改代码是各仓 worker 的事）。',
    '',
    '# 需求',
    title,
  ];
  if (priorReport) lines.push('', '# 上一轮现状', priorReport);
  return lines.join('\n');
}
