import { describe, expect, it } from 'vitest';
import type { WorkItemEvent } from '../../src/workitems/types.js';
import {
  type ContractInterface,
  computeImpact,
  contractFingerprint,
  contractStructuralDiff,
  isBreakingChange,
  isRequirementDecisionStale,
  makeSnapshot,
  repoOf,
} from '../../src/worktypes/requirement/contract.js';

function iface(over: Partial<ContractInterface> = {}): ContractInterface {
  return {
    id: 'getOrder',
    signature: 'getOrder(id): Order',
    providerRepo: 'backend',
    consumerRepos: ['frontend'],
    fields: [
      { name: 'id', type: 'string', optional: false },
      { name: 'amount', type: 'number', optional: false },
    ],
    ...over,
  };
}

describe('contractFingerprint', () => {
  it('is content-equal regardless of interface / field / consumer order', () => {
    const a = contractFingerprint([
      iface({
        id: 'a',
        consumerRepos: ['x', 'y'],
        fields: [
          { name: 'b', type: 'string', optional: false },
          { name: 'a', type: 'number', optional: true },
        ],
      }),
      iface({ id: 'b' }),
    ]);
    const b = contractFingerprint([
      iface({ id: 'b' }),
      iface({
        id: 'a',
        consumerRepos: ['y', 'x'],
        fields: [
          { name: 'a', type: 'number', optional: true },
          { name: 'b', type: 'string', optional: false },
        ],
      }),
    ]);
    expect(a).toBe(b);
  });

  it('changes when a field type changes', () => {
    const a = contractFingerprint([iface()]);
    const b = contractFingerprint([
      iface({
        fields: [
          { name: 'id', type: 'string', optional: false },
          { name: 'amount', type: 'string', optional: false }, // number → string
        ],
      }),
    ]);
    expect(a).not.toBe(b);
  });
});

describe('contractStructuralDiff + 小改/大改判定', () => {
  it('pure additions (new field, new interface, required→optional) are NOT breaking', () => {
    const prev = makeSnapshot('v1', [iface()]);
    const next = makeSnapshot('v2', [
      iface({
        fields: [
          { name: 'id', type: 'string', optional: false },
          { name: 'amount', type: 'number', optional: true }, // relaxed
          { name: 'currency', type: 'string', optional: true }, // new field
        ],
      }),
      iface({ id: 'newOne', providerRepo: 'backend', consumerRepos: [] }), // new interface
    ]);
    const diff = contractStructuralDiff(prev, next);
    expect(diff.breaking).toHaveLength(0);
    expect(isBreakingChange(diff)).toBe(false); // 小改 → Owner 自治
    expect(diff.added.length).toBeGreaterThan(0);
  });

  it('removed field / type change / optional→required / removed interface are breaking', () => {
    const prev = makeSnapshot('v1', [
      iface(),
      iface({ id: 'legacy', providerRepo: 'backend', consumerRepos: ['mobile'] }),
    ]);
    const next = makeSnapshot('v2', [
      iface({
        fields: [
          { name: 'id', type: 'number', optional: false }, // type change
          // amount removed
        ],
      }),
      // legacy interface removed
    ]);
    const diff = contractStructuralDiff(prev, next);
    expect(isBreakingChange(diff)).toBe(true); // 大改 → 回灯②
    const kinds = diff.breaking.map((b) => b.kind).sort();
    expect(kinds).toContain('removed-field');
    expect(kinds).toContain('type-changed');
    expect(kinds).toContain('interface-removed');
    // affected repos = provider + consumers of the changed interfaces
    expect(diff.affectedRepos).toEqual(expect.arrayContaining(['backend', 'frontend', 'mobile']));
  });

  it('a human semanticBreaking flag forces 大改 even with no structural change', () => {
    const prev = makeSnapshot('v1', [iface()]);
    const next = makeSnapshot('v2', [iface({ semanticBreaking: true })]);
    const diff = contractStructuralDiff(prev, next);
    expect(diff.breaking).toHaveLength(0);
    expect(diff.semanticFlagged).toEqual(['getOrder']);
    expect(isBreakingChange(diff)).toBe(true);
    expect(computeImpact(diff)).toEqual(expect.arrayContaining(['backend', 'frontend']));
  });

  it('computeImpact returns only affected repos (others keep running)', () => {
    const prev = makeSnapshot('v1', [
      iface({ id: 'a', providerRepo: 'backend', consumerRepos: ['frontend'] }),
      iface({ id: 'b', providerRepo: 'payments', consumerRepos: ['frontend'] }),
    ]);
    const next = makeSnapshot('v2', [
      iface({ id: 'a', providerRepo: 'backend', consumerRepos: ['frontend'], fields: [] }), // breaking on a
      iface({ id: 'b', providerRepo: 'payments', consumerRepos: ['frontend'] }), // unchanged
    ]);
    const diff = contractStructuralDiff(prev, next);
    expect(computeImpact(diff)).toEqual(expect.arrayContaining(['backend', 'frontend']));
    expect(computeImpact(diff)).not.toContain('payments'); // b untouched
  });
});

describe('isRequirementDecisionStale (pure, decision.data + eventsSince)', () => {
  const evt = (kind: string, payload: unknown): WorkItemEvent => ({
    id: 1,
    workitemId: 'wi',
    seq: 1,
    kind,
    payload,
    createdAt: 1,
  });

  it('is never stale without a contract basis (理解 phase)', () => {
    expect(
      isRequirementDecisionStale({ data: {} }, [
        evt('contract_change_applied', { fingerprint: 'x' }),
      ]),
    ).toBe(false);
  });

  it('is stale when a contract change since the p板 carries a different fingerprint', () => {
    const decision = { data: { fingerprint: 'fp-old', boundary: 'requirement:合同' } };
    expect(
      isRequirementDecisionStale(decision, [
        evt('contract_change_applied', { fingerprint: 'fp-new' }),
      ]),
    ).toBe(true);
  });

  it('is NOT stale when the change carries the same fingerprint', () => {
    const decision = { data: { fingerprint: 'fp-old' } };
    expect(
      isRequirementDecisionStale(decision, [evt('contract_patched', { fingerprint: 'fp-old' })]),
    ).toBe(false);
  });
});

describe('repoOf', () => {
  it('归一s to the repo key', () => {
    expect(repoOf({ repo: 'backend' })).toBe('backend');
    expect(repoOf({ repo: null })).toBe('');
    expect(repoOf(undefined)).toBe('');
  });
});
