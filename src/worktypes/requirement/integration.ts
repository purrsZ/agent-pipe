import type { EffectContext, EffectHandler } from '../../workitems/effects.js';
import type { WorkItemEvent } from '../../workitems/types.js';
import {
  type ContractSnapshot,
  contractStructuralDiff,
  EMPTY_SNAPSHOT,
  isBreakingChange,
} from './contract.js';

// 集成验证 (R13). A dedicated, idempotent (recovery:'rerun') effect: the质检员 takes the
// cross-repo contract as the standard and does a STATIC对账 against each端's claimed
// implementation (the owner assess run writes contract/impl-claims.json — single writer, after
// the worker batch fans in), via the shared contractStructuralDiff (no re-implementation, D-06).
// Emits integration_check_passed /
// _failed; the worktype routes failures into the bounded fix loop. Reading各端 worktree code
// for a richer对账 is the live extension — the structure here is the testable skeleton.
//
// PIVOT：基准 contract/contract.json 不再来自被砍的「合同冻结」相位，而是「拆解」phase 的 owner 跨仓
// **对账**产物（reconcile.ts → afterRun 写同一路径）。这补上了「砍 contract 后灯③ 靠什么对账」——
// 无对账契约（单仓/无跨仓接口）时仍走 no_contract 放行，有则 contractStructuralDiff 给灯③ 长牙。

const MAX_FIX_ROUNDS = 2;

export function createIntegrationCheckHandler(): EffectHandler {
  return {
    kind: 'integration_check',
    recovery: 'rerun', // pure read-only对账 — safe to re-run after a crash
    run: integrationCheck,
  };
}

async function integrationCheck(ctx: EffectContext): Promise<void> {
  const frozen = readSnapshot(ctx.readArtifact('contract/contract.json'));
  // Nothing frozen yet → nothing to对账 against (skeleton: pass; the real flow always has a
  // frozen contract by 集成验证).
  if (frozen.interfaces.length === 0) {
    ctx.emit('integration_check_passed', { reason: 'no_contract' });
    return;
  }
  const claims = ctx.readArtifact('contract/impl-claims.json');
  if (claims === undefined) {
    // claims not produced (workers didn't declare) → treat as not-yet-verifiable, pass with a
    // note rather than a false failure (the live对账 reads code directly).
    ctx.emit('integration_check_passed', { reason: 'no_claims' });
    return;
  }
  const claimed = readSnapshot(claims);
  // prev=frozen contract, next=claimed impl: anything the contract requires but the impl is
  // missing / mistyped shows up as breaking.
  const diff = contractStructuralDiff(frozen, claimed);
  ctx.writeArtifact('contract/integration-report.md', renderDiffReport(diff), 'integration check');

  if (isBreakingChange(diff)) {
    const round = countIntegrationFailures(ctx.eventsSince(0)) + 1;
    ctx.emit('integration_check_failed', {
      round,
      affectedRepos: diff.affectedRepos,
      breaking: diff.breaking,
      semanticFlagged: diff.semanticFlagged,
    });
  } else {
    // WS-7.3：真对账通过时带上契约接口条数，灯③ note 据此显示「（契约 N 条接口）」。
    ctx.emit('integration_check_passed', { interfaceCount: frozen.interfaces.length });
  }
}

// Pure: how many integration_check_failed events已发生 (drives the fix-round counter — D-11,
// independent of assignment.retries; replacement继承 via the round carried in the event).
export function countIntegrationFailures(events: WorkItemEvent[]): number {
  return events.filter((e) => e.kind === 'integration_check_failed').length;
}

// Pure: given this failure's round, fix (≤MAX_FIX_ROUNDS) or escalate.
export function fixRoundExceeded(round: number): boolean {
  return round > MAX_FIX_ROUNDS;
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

function renderDiffReport(diff: ReturnType<typeof contractStructuralDiff>): string {
  return [
    '# 集成验证差异报告',
    `受影响 repo: ${diff.affectedRepos.join(', ') || '(无)'}`,
    `破坏性: ${diff.breaking.map((b) => `${b.interfaceId}:${b.kind}`).join(', ') || '(无)'}`,
    `语义标记: ${diff.semanticFlagged.join(', ') || '(无)'}`,
    `纯增: ${diff.added.length} 项`,
  ].join('\n');
}
