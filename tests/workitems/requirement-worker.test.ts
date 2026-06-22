import { describe, expect, it } from 'vitest';
import { makeSnapshot } from '../../src/worktypes/requirement/contract.js';
import {
  classifyTestResult,
  composeWorkerPrompt,
  mapWritePermission,
  renderContractForRepo,
  shouldRetry,
} from '../../src/worktypes/requirement/worker.js';

const contract = makeSnapshot('v1', [
  {
    id: 'getOrder',
    signature: 'GET /orders/:id → Order',
    providerRepo: 'backend',
    consumerRepos: ['frontend'],
    fields: [
      { name: 'id', type: 'string', optional: false },
      { name: 'amount', type: 'number', optional: false },
    ],
  },
]);

describe('composeWorkerPrompt (D-23: no readonly system句)', () => {
  it('never tells the worker to be read-only', () => {
    const p = composeWorkerPrompt({ title: '加下单接口', repo: 'backend', contract });
    expect(p).not.toContain('只读');
    expect(p).not.toContain('不要修改');
    expect(p).toContain('全栈工程师');
    expect(p).toContain('加下单接口');
    expect(p).toContain('backend');
  });

  it('renders the contract slice relevant to the repo, plus knowledge + rework when present', () => {
    const p = composeWorkerPrompt({
      title: 't',
      repo: 'backend',
      contract,
      knowledge: 'build: npm test',
      reworkNote: 'amount 改成了分',
    });
    expect(p).toContain('GET /orders/:id'); // backend provides it
    expect(p).toContain('该仓知识');
    expect(p).toContain('npm test');
    expect(p).toContain('返工说明');
    expect(p).toContain('amount 改成了分');
  });

  it('renderContractForRepo labels provide vs consume', () => {
    expect(renderContractForRepo(contract, 'backend')).toContain('[提供]');
    expect(renderContractForRepo(contract, 'frontend')).toContain('[调用]');
    expect(renderContractForRepo(contract, 'unrelated')).toBe('');
  });
});

describe('mapWritePermission (R04: write, never full)', () => {
  it('maps to agents write with the worktree as the only writable dir', () => {
    const opts = mapWritePermission('/work/wt/backend');
    expect(opts.permission).toEqual({ mode: 'write' });
    expect(opts.writableDirs).toEqual(['/work/wt/backend']);
    // explicit guard: never 'full'
    expect((opts.permission as { mode: string }).mode).not.toBe('full');
  });
});

describe('classifyTestResult (R11.AC-7: two classes of not-green)', () => {
  it('pass when it ran and passed', () => {
    expect(classifyTestResult({ ran: true, passed: true })).toBe('pass');
    expect(shouldRetry('pass')).toBe(false);
  });

  it('assertion-failed when it ran red (consumes a retry)', () => {
    expect(classifyTestResult({ ran: true, passed: false })).toBe('assertion-failed');
    expect(classifyTestResult({ ran: false, passed: false, hasResultArtifact: true })).toBe(
      'assertion-failed',
    );
    expect(shouldRetry('assertion-failed')).toBe(true);
  });

  it('cannot-execute when it never ran (raise hand, do NOT burn retries)', () => {
    expect(classifyTestResult({ ran: false, passed: false, reason: 'command not found' })).toBe(
      'cannot-execute',
    );
    expect(shouldRetry('cannot-execute')).toBe(false);
  });
});
