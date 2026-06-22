import * as fs from 'node:fs';
import { worktreeAdd, worktreeIsDirty, worktreePathFor } from '../../agents/worktree.js';
import type { Assignment, WorkItem } from '../../workitems/types.js';
import type { RunStrategy } from '../agent-run/run-handler.js';
import { type ContractSnapshot, EMPTY_SNAPSHOT } from './contract.js';
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
    composePrompt: ({ title, assignment, priorReport, readArtifact }) => {
      if (assignment.role !== 'worker') return composeOwnerPrompt(title, priorReport);
      const contract = readContract(readArtifact);
      return composeWorkerPrompt({
        title,
        repo: assignment.repo ?? '',
        contract,
        // 选择性注入: only workers get repo knowledge, keyed by the repo they own.
        knowledge: assignment.repo ? opts.knowledgeFor?.(assignment.repo) : undefined,
        reworkNote: assignment.replacesAssignmentId ? priorReport : undefined,
      });
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
  };
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
