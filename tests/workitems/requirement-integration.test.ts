import { describe, expect, it } from 'vitest';
import type { EffectContext } from '../../src/workitems/effects.js';
import type { WorkItemEvent } from '../../src/workitems/types.js';
import { makeSnapshot } from '../../src/worktypes/requirement/contract.js';
import {
  countIntegrationFailures,
  createIntegrationCheckHandler,
  fixRoundExceeded,
} from '../../src/worktypes/requirement/integration.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';
import { requirementWorkType } from '../../src/worktypes/requirement/index.js';
import { makeWorkItem } from '../helpers/workitems.js';

function ev(kind: string, payload: unknown = {}): WorkItemEvent {
  return { id: 1, workitemId: 'wi-1', seq: 9, kind, payload, createdAt: 1000 };
}

// Minimal fake EffectContext capturing emits + a fixed artifact map + a prior-events list.
function fakeCtx(artifacts: Record<string, string>, priorEvents: WorkItemEvent[] = []) {
  const emitted: Array<{ kind: string; payload: unknown }> = [];
  const written: Record<string, string> = {};
  const ctx = {
    effect: {
      id: 1,
      workitemId: 'wi-1',
      seq: 9,
      kind: 'integration_check',
      payload: {},
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
    },
    workitem: makeWorkItem('wi-1', { type: 'requirement', phase: PHASE.integrate }),
    signal: new AbortController().signal,
    clock: { now: () => 1000 },
    logger: {},
    batchFromSeq: 0,
    heartbeat: () => {},
    eventsSince: () => priorEvents,
    setAgentSessionId: () => {},
    writeArtifact: (rel: string, content: string) => {
      written[rel] = content;
    },
    readArtifact: (rel: string) => artifacts[rel],
    emit: (kind: string, payload: unknown) => emitted.push({ kind, payload }),
  } as unknown as EffectContext;
  return { ctx, emitted, written };
}

const contractJson = JSON.stringify(
  makeSnapshot('v1', [
    {
      id: 'getOrder',
      signature: 'GET /orders/:id',
      providerRepo: 'backend',
      consumerRepos: ['frontend'],
      fields: [{ name: 'id', type: 'string', optional: false }],
    },
  ]),
);

describe('integration_check handler', () => {
  const handler = createIntegrationCheckHandler();

  it('passes when there is no frozen contract (nothing to对账)', async () => {
    const { ctx, emitted } = fakeCtx({});
    await handler.run(ctx);
    expect(emitted).toEqual([
      { kind: 'integration_check_passed', payload: { reason: 'no_contract' } },
    ]);
  });

  it('passes when claims match the contract', async () => {
    const { ctx, emitted, written } = fakeCtx({
      'contract/contract.json': contractJson,
      'contract/impl-claims.json': contractJson, // impl claims exactly the contract
    });
    await handler.run(ctx);
    expect(emitted[0]!.kind).toBe('integration_check_passed');
    expect(emitted[0]!.payload).toMatchObject({ interfaceCount: 1 }); // WS-7.3：真通过带契约条数
    expect(written['contract/integration-report.md']).toContain('集成验证差异报告');
  });

  it('fails with round + affectedRepos when the impl is missing a contract interface', async () => {
    const claims = JSON.stringify(makeSnapshot('impl', [])); // impl claims nothing → missing getOrder
    const { ctx, emitted } = fakeCtx(
      { 'contract/contract.json': contractJson, 'contract/impl-claims.json': claims },
      [ev('integration_check_failed')], // one prior failure → this is round 2
    );
    await handler.run(ctx);
    expect(emitted[0]!.kind).toBe('integration_check_failed');
    expect(emitted[0]!.payload).toMatchObject({ round: 2 });
    expect((emitted[0]!.payload as { affectedRepos: string[] }).affectedRepos).toContain('backend');
  });
});

describe('fix-loop counting (D-11, independent of retries)', () => {
  it('counts integration_check_failed events', () => {
    expect(
      countIntegrationFailures([
        ev('integration_check_failed'),
        ev('x'),
        ev('integration_check_failed'),
      ]),
    ).toBe(2);
  });

  it('escalates only after MAX_FIX_ROUNDS (2)', () => {
    expect(fixRoundExceeded(1)).toBe(false);
    expect(fixRoundExceeded(2)).toBe(false);
    expect(fixRoundExceeded(3)).toBe(true);
  });
});

describe('requirementTransition integration_check_failed → fix vs escalate', () => {
  it('round ≤ 2 dispatches a fix worker for the affected repo', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate, repos: ['backend', 'frontend'] });
    const out = requirementWorkType.onEvent(
      item,
      ev('integration_check_failed', { round: 1, affectedRepos: ['backend'] }),
    );
    expect(out.dispatch).toHaveLength(1);
    expect(out.dispatch?.[0]).toMatchObject({ role: 'worker', repo: 'backend' });
    expect((out.dispatch?.[0]?.payload as { stage: string }).stage).toBe('fix');
  });

  it('round > 2 escalates to a human wait instead of more fixes', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate, repos: ['backend'] });
    const out = requirementWorkType.onEvent(
      item,
      ev('integration_check_failed', { round: 3, affectedRepos: ['backend'] }),
    );
    expect(out.dispatch).toBeUndefined();
    expect(out.waits?.[0]).toMatchObject({ kind: 'human', reason: 'integration_unresolved' });
  });
});
