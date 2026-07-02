import { describe, expect, it } from 'vitest';
import { contractFingerprint } from '../../src/worktypes/requirement/contract.js';
import {
  type InternalApiEntry,
  parseInternalApis,
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

describe('spec-design 输出解析 (parseInternalApis)', () => {
  const block = (obj: unknown) => `前面是设计说明…\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`;

  it('extracts the contract draft from the trailing ```json block → InternalApiEntry[]', () => {
    const report = block({
      interfaces: [
        {
          id: 'createOrder',
          signature: 'POST /orders',
          providerRepo: 'backend',
          consumerRepos: ['frontend'],
          fields: [{ name: 'amount', type: 'number', optional: false }],
        },
      ],
    });
    const entries = parseInternalApis(report);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'createOrder',
      signature: 'POST /orders',
      providerRepo: 'backend',
      consumerRepos: ['frontend'],
      fields: [{ name: 'amount', type: 'number', optional: false }],
    });
    // round-trips into a promotable snapshot
    expect(promoteToContract('draft', entries).interfaces).toHaveLength(1);
  });

  it('accepts a bare top-level array form too', () => {
    const report = `\`\`\`json\n${JSON.stringify([
      { id: 'pay', signature: 'POST /pay', providerRepo: 'payments', consumerRepos: ['backend'] },
    ])}\n\`\`\``;
    expect(parseInternalApis(report).map((e) => e.id)).toEqual(['pay']);
  });

  it('takes the LAST valid block when an illustrative example precedes the real one', () => {
    const example = block({
      interfaces: [{ id: 'EXAMPLE', signature: 'x', providerRepo: 'demo' }],
    });
    const real = block({
      interfaces: [{ id: 'realOne', signature: 'GET /x', providerRepo: 'backend' }],
    });
    expect(parseInternalApis(example + real).map((e) => e.id)).toEqual(['realOne']);
  });

  it('drops entries missing required keys (id/signature/providerRepo) but keeps valid siblings', () => {
    const report = block({
      interfaces: [
        { signature: 'no id', providerRepo: 'backend' },
        { id: 'ok', signature: 'GET /ok', providerRepo: 'backend', consumerRepos: ['frontend', 7] },
      ],
    });
    const entries = parseInternalApis(report);
    expect(entries.map((e) => e.id)).toEqual(['ok']);
    expect(entries[0]?.consumerRepos).toEqual(['frontend']); // non-string consumer dropped
  });

  it('returns [] (never throws) on no block / malformed JSON / empty input', () => {
    expect(parseInternalApis('没有任何代码块的纯文本报告')).toEqual([]);
    expect(parseInternalApis('```json\n{ not valid json,, }\n```')).toEqual([]);
    expect(parseInternalApis('')).toEqual([]);
  });
});
