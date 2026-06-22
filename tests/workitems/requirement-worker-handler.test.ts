import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreePathFor } from '../../src/agents/worktree.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';
import { createRequirementRunStrategy } from '../../src/worktypes/requirement/worker-handler.js';
import { makeAssignment, makeWorkItem } from '../helpers/workitems.js';

let tmpDir: string;
let repoPath: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-req-worker-'));
  repoPath = path.join(tmpDir, 'backend-repo');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 't@t']);
  git(repoPath, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), 'base\n');
  git(repoPath, ['add', '-A']);
  git(repoPath, ['commit', '-m', 'base']);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('requirement worker run strategy (write profile + worktree)', () => {
  const worktreesDir = () => path.join(tmpDir, 'worktrees');
  const strategy = () => createRequirementRunStrategy({ worktreesDir: worktreesDir() });
  const item = () => makeWorkItem('wi-1', { type: 'requirement', repos: [repoPath] });
  const worker = () => makeAssignment('as-w1', 'wi-1', { role: 'worker', repo: repoPath });
  const owner = () => makeAssignment('as-o1', 'wi-1', { role: 'owner' });

  it('worker: cwd is its own worktree, options are WRITE (never full), prompt has no readonly句', () => {
    const s = strategy();
    const cwd = s.resolveCwd({ workitem: item(), assignment: worker(), defaultCwd: '/x' });
    expect(cwd).toBe(worktreePathFor(worktreesDir(), 'wi-1', 'as-w1', repoPath));

    const opts = s.runOptions({ workitem: item(), assignment: worker(), cwd });
    expect(opts.permission).toEqual({ mode: 'write' });
    expect(opts.writableDirs).toEqual([cwd]);

    const prompt = s.composePrompt({
      title: '加下单接口',
      followups: [],
      workitem: item(),
      assignment: worker(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(prompt).not.toContain('只读');
    expect(prompt).toContain('加下单接口');
  });

  it('owner: readonly, cwd falls back to repo, prompt is the coordinator句', () => {
    const s = strategy();
    const opts = s.runOptions({ workitem: item(), assignment: owner(), cwd: repoPath });
    expect(opts.permission).toEqual({ mode: 'readonly' });
    const prompt = s.composePrompt({
      title: 't',
      followups: [],
      workitem: item(),
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(prompt).toContain('包工头');
  });

  it('prepareWorkspace creates the worktree off base; canResume tracks dirty + session', () => {
    const s = strategy();
    const wi = item();
    const w = worker();
    const cwd = s.resolveCwd({ workitem: wi, assignment: w, defaultCwd: '/x' });

    s.prepareWorkspace({ workitem: wi, assignment: w, cwd });
    expect(fs.existsSync(path.join(cwd, 'README.md'))).toBe(true); // worktree checked out

    // no session yet → cannot resume.
    expect(s.canResume({}, w, wi)).toBe(false);

    // session present + clean worktree → resume OK.
    const withSession = makeAssignment('as-w1', 'wi-1', {
      role: 'worker',
      repo: repoPath,
      agentSessionId: 'sess-1',
    });
    expect(s.canResume({}, withSession, wi)).toBe(true);

    // dirty worktree → must reset+redispatch, not resume.
    fs.writeFileSync(path.join(cwd, 'dirty.txt'), 'x');
    expect(s.canResume({}, withSession, wi)).toBe(false);
  });

  it('composePrompt renders the frozen contract slice from the artifact repo', () => {
    const s = strategy();
    const contract = JSON.stringify({
      version: 'v1',
      fingerprint: 'fp',
      interfaces: [
        {
          id: 'getOrder',
          signature: 'GET /orders/:id',
          providerRepo: repoPath,
          consumerRepos: [],
          fields: [{ name: 'id', type: 'string', optional: false }],
        },
      ],
    });
    const prompt = s.composePrompt({
      title: 't',
      followups: [],
      workitem: item(),
      assignment: worker(),
      batch: [],
      readArtifact: (rel) => (rel === 'contract/contract.json' ? contract : undefined),
    });
    expect(prompt).toContain('GET /orders/:id');
    expect(prompt).toContain('冻结的对接合同');
  });

  it('worker prompt injects the repo knowledge block from knowledgeFor (Stage 5 选择性注入)', () => {
    const s = createRequirementRunStrategy({
      worktreesDir: worktreesDir(),
      knowledgeFor: (repo) => (repo === repoPath ? '## runbook\nnpm test' : undefined),
    });
    const prompt = s.composePrompt({
      title: 't',
      followups: [],
      workitem: item(),
      assignment: worker(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(prompt).toContain('该仓知识'); // the knowledge section header in composeWorkerPrompt
    expect(prompt).toContain('npm test');
  });

  it('the owner COORDINATOR prompt (非合同 phase) never consults knowledgeFor', () => {
    const seen: string[] = [];
    const s = createRequirementRunStrategy({
      worktreesDir: worktreesDir(),
      knowledgeFor: (repo) => {
        seen.push(repo);
        return 'X';
      },
    });
    s.composePrompt({
      title: 't',
      followups: [],
      workitem: item(), // default phase 'noop:idle' → coordinator branch, not the spec-design run
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(seen).toEqual([]); // coordinator branch returns before touching knowledgeFor
  });
});

describe('requirement spec-design run (合同 phase owner) — T5/A2', () => {
  const worktreesDir = () => path.join(tmpDir, 'worktrees');
  const contractItem = () =>
    makeWorkItem('wi-1', {
      type: 'requirement',
      phase: PHASE.contract,
      repos: ['backend', 'frontend'],
    });
  const owner = () => makeAssignment('as-o1', 'wi-1', { role: 'owner' });

  it('composePrompt for an owner in the 合同 phase is the spec-design run (consults knowledgeFor)', () => {
    const seen: string[] = [];
    const s = createRequirementRunStrategy({
      worktreesDir: worktreesDir(),
      knowledgeFor: (repo) => {
        seen.push(repo);
        return repo === 'backend' ? '## map\nNestJS' : undefined;
      },
    });
    const prompt = s.composePrompt({
      title: '加跨端下单接口',
      followups: [],
      workitem: contractItem(),
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(prompt).toContain('spec-design');
    expect(prompt).toContain('```json'); // structured contract draft instruction
    expect(prompt).toContain('- backend');
    expect(prompt).toContain('NestJS'); // knowledge injected for代码考古
    expect(prompt).not.toContain('包工头'); // not the coordinator prompt
    expect(seen.sort()).toEqual(['backend', 'frontend']); // consulted for every repo
  });

  it('the spec-design run weaves in 立项书 from intake/intake.md (优雅降级 when absent)', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const brief = '# 立项书：下单\n\n## 验收标准 / 完成定义\n下单成功返回单号';
    const withBrief = s.composePrompt({
      title: '加跨端下单接口',
      followups: [],
      workitem: contractItem(),
      assignment: owner(),
      batch: [],
      readArtifact: (rel) => (rel === 'intake/intake.md' ? brief : undefined),
    });
    expect(withBrief).toContain('立项书'); // 立项书装配进 spec-design 输入
    expect(withBrief).toContain('下单成功返回单号');

    // intake.md 不存在（立项书尚未落档）→ 不输出立项书段，回落裸标题，绝不报错。
    const without = s.composePrompt({
      title: '加跨端下单接口',
      followups: [],
      workitem: contractItem(),
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(without).not.toContain('立项书');
  });

  it('afterRun 升格 the report contract block → contract/contract.json (only owner + 合同 phase)', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const report = [
      '设计说明……',
      '```json',
      JSON.stringify({
        interfaces: [
          {
            id: 'createOrder',
            signature: 'POST /orders',
            providerRepo: 'backend',
            consumerRepos: ['frontend'],
            fields: [{ name: 'amount', type: 'number', optional: false }],
          },
        ],
      }),
      '```',
    ].join('\n');
    const writes: Array<{ relPath: string; content: string }> = [];
    s.afterRun?.({
      report,
      workitem: contractItem(),
      assignment: owner(),
      writeArtifact: (relPath, content) => writes.push({ relPath, content }),
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.relPath).toBe('contract/contract.json');
    const snap = JSON.parse(writes[0]?.content ?? '{}');
    expect(snap.interfaces).toHaveLength(1);
    expect(snap.interfaces[0]).toMatchObject({ id: 'createOrder', providerRepo: 'backend' });
    expect(typeof snap.fingerprint).toBe('string'); // promoteToContract computed it
  });

  it('afterRun is inert for a worker, or for an owner outside the 合同 phase', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const report =
      '```json\n{"interfaces":[{"id":"x","signature":"s","providerRepo":"backend"}]}\n```';
    const writes: string[] = [];
    const sink = (relPath: string) => writes.push(relPath);
    // worker in 合同 phase → no contract升格
    s.afterRun?.({
      report,
      workitem: contractItem(),
      assignment: makeAssignment('as-w', 'wi-1', { role: 'worker', repo: 'backend' }),
      writeArtifact: sink,
    });
    // owner outside 合同 phase → no contract升格
    s.afterRun?.({
      report,
      workitem: makeWorkItem('wi-1', {
        type: 'requirement',
        phase: PHASE.design,
        repos: ['backend'],
      }),
      assignment: owner(),
      writeArtifact: sink,
    });
    expect(writes).toEqual([]);
  });

  it('afterRun on a report with no contract block writes an EMPTY contract (灯②兜底, never throws)', () => {
    const s = createRequirementRunStrategy({ worktreesDir: worktreesDir() });
    const writes: Array<{ relPath: string; content: string }> = [];
    s.afterRun?.({
      report: '设计说明，但忘了输出合同块',
      workitem: contractItem(),
      assignment: owner(),
      writeArtifact: (relPath, content) => writes.push({ relPath, content }),
    });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.content ?? '{}').interfaces).toEqual([]);
  });
});
