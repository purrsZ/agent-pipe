import { describe, expect, it } from 'vitest';
import { contractFingerprint } from '../../src/worktypes/requirement/contract.js';
import {
  type InternalApiEntry,
  promoteToContract,
  reposFromContract,
  sliceByRepo,
} from '../../src/worktypes/requirement/design.js';

const entries: InternalApiEntry[] = [
  {
    id: 'createOrder',
    signature: 'POST /orders',
    providerRepo: 'backend',
    consumerRepos: ['frontend'],
    fields: [{ name: 'amount', type: 'number', optional: false }],
  },
  {
    id: 'pay',
    signature: 'POST /pay',
    providerRepo: 'payments',
    consumerRepos: ['backend'],
    fields: [],
  },
];

describe('design-phase 升格', () => {
  it('promotes internal-apis into a frozen-able ContractSnapshot with a stable fingerprint', () => {
    const snap = promoteToContract('v1', entries);
    expect(snap.interfaces).toHaveLength(2);
    expect(snap.interfaces[0]).toMatchObject({
      providerRepo: 'backend',
      consumerRepos: ['frontend'],
    });
    expect(snap.fingerprint).toBe(contractFingerprint(snap.interfaces)); // 固化 indeptly recomputable
  });
});

describe('design-phase 按端切片', () => {
  it('slices the contract per repo into provides + consumes', () => {
    const slices = sliceByRepo(promoteToContract('v1', entries));
    const byRepo = new Map(slices.map((s) => [s.repo, s]));

    expect(byRepo.get('backend')!.provides.map((i) => i.id)).toEqual(['createOrder']);
    expect(byRepo.get('backend')!.consumes.map((i) => i.id)).toEqual(['pay']); // backend calls payments
    expect(byRepo.get('frontend')!.provides).toHaveLength(0); // frontend only consumes
    expect(byRepo.get('frontend')!.consumes.map((i) => i.id)).toEqual(['createOrder']);
    expect(byRepo.get('payments')!.provides.map((i) => i.id)).toEqual(['pay']);
  });

  it('reposFromContract drives the worker fan-out (every touched repo, one worker each)', () => {
    expect(reposFromContract(promoteToContract('v1', entries)).sort()).toEqual([
      'backend',
      'frontend',
      'payments',
    ]);
  });
});
