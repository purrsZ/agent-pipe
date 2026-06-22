import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequirementRunStrategy } from '../../src/worktypes/requirement/worker-handler.js';
import { worktreePathFor } from '../../src/agents/worktree.js';
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

  it('only workers consult knowledgeFor — the owner coordinator prompt never does', () => {
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
      workitem: item(),
      assignment: owner(),
      batch: [],
      readArtifact: () => undefined,
    });
    expect(seen).toEqual([]); // owner branch returns before touching knowledgeFor
  });
});
