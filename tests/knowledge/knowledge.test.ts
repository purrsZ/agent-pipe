import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assessFreshness,
  DEFAULT_FRESHNESS_POLICY,
  loadFreshnessPolicy,
} from '../../src/knowledge/freshness.js';
import { renderInjection, selectInjection } from '../../src/knowledge/injection.js';
import { KnowledgeStore } from '../../src/knowledge/store.js';
import type { RepoKnowledge } from '../../src/knowledge/types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-knowledge-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const manifest = (over: Partial<RepoKnowledge> = {}): RepoKnowledge => ({
  repoKey: 'backend',
  generatedAtCommit: 'abc',
  generatedAt: 1000,
  docs: { map: 'm', conventions: 'c', runbook: 'r', pitfalls: 'p' },
  ...over,
});

describe('freshness (pure)', () => {
  it('flags never-indexed / missing', () => {
    expect(assessFreshness('backend', undefined, undefined, DEFAULT_FRESHNESS_POLICY).reason).toBe(
      'never-indexed',
    );
    expect(assessFreshness('backend', manifest(), undefined, DEFAULT_FRESHNESS_POLICY).reason).toBe(
      'missing',
    );
  });

  it('flags commits / days exceeded, else fresh', () => {
    const policy = { maxCommitsBehind: 200, maxDaysSince: 30 };
    expect(
      assessFreshness('backend', manifest(), { commitsBehind: 201, daysSince: 0 }, policy).reason,
    ).toBe('commits-exceeded');
    expect(
      assessFreshness('backend', manifest(), { commitsBehind: 0, daysSince: 31 }, policy).reason,
    ).toBe('days-exceeded');
    const ok = assessFreshness('backend', manifest(), { commitsBehind: 5, daysSince: 5 }, policy);
    expect(ok.fresh).toBe(true);
  });

  it('loads + env-overrides the policy', () => {
    expect(loadFreshnessPolicy({})).toEqual(DEFAULT_FRESHNESS_POLICY);
    expect(
      loadFreshnessPolicy({ KNOWLEDGE_STALE_MAX_COMMITS: '50', KNOWLEDGE_STALE_MAX_DAYS: '7' }),
    ).toEqual({ maxCommitsBehind: 50, maxDaysSince: 7 });
  });
});

describe('selective injection (pure, budget-bounded)', () => {
  it('prioritises runbook > pitfalls > conventions > map and truncates by budget', () => {
    const out = selectInjection({
      repoKey: 'backend',
      docs: { map: 'M'.repeat(100), conventions: 'C', runbook: 'R', pitfalls: 'P' },
      stale: false,
      budgetChars: 5, // fits R+P+C (3 chars) but not the 100-char map
    });
    expect(out.sections.map((s) => s.doc)).toEqual(['runbook', 'pitfalls', 'conventions']);
    expect(out.truncatedByBudget).toBe(true);
  });

  it('renders a stale note when stale', () => {
    const out = selectInjection({ repoKey: 'b', docs: { runbook: 'npm test' }, stale: true, budgetChars: 100 });
    const text = renderInjection(out);
    expect(text).toContain('可能已过时');
    expect(text).toContain('npm test');
  });
});

describe('KnowledgeStore (git-backed)', () => {
  it('writes/reads docs + manifest and lists indexed repos', () => {
    const store = new KnowledgeStore(path.join(tmpDir, 'knowledge'));
    store.ensureRepo();
    store.writeDoc('backend', 'runbook', 'npm test', 'index backend runbook');
    expect(store.readDoc('backend', 'runbook')).toBe('npm test');
    expect(store.readDoc('backend', 'map')).toBeUndefined();
    store.writeManifest('backend', manifest());
    expect(store.readManifest('backend')?.repoKey).toBe('backend');
    expect(store.listIndexedRepos()).toEqual(['backend']);
  });

  it('assess is fresh at the anchor commit and stale after enough drift', () => {
    // a target repo to measure drift against.
    const repo = path.join(tmpDir, 'target');
    fs.mkdirSync(repo, { recursive: true });
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@t']);
    git(repo, ['config', 'user.name', 't']);
    fs.writeFileSync(path.join(repo, 'a.txt'), '1');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'c1']);
    const head = git(repo, ['rev-parse', 'HEAD']).trim();

    const store = new KnowledgeStore(path.join(tmpDir, 'knowledge'));
    store.ensureRepo();
    store.writeManifest('target', manifest({ repoKey: 'target', generatedAtCommit: head, generatedAt: 1000 }));

    // at the anchor: 0 commits behind, 0 days → fresh.
    expect(store.assess('target', repo, { maxCommitsBehind: 200, maxDaysSince: 30 }, 1000).fresh).toBe(
      true,
    );

    // drift the target by 3 commits, tighten the policy → stale.
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(repo, 'a.txt'), String(i + 2));
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-m', `c${i + 2}`]);
    }
    const verdict = store.assess('target', repo, { maxCommitsBehind: 2, maxDaysSince: 30 }, 1000);
    expect(verdict.fresh).toBe(false);
    expect(verdict.reason).toBe('commits-exceeded');
    expect(verdict.commitsBehind).toBe(3);
  });
});
