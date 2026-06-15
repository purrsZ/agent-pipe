import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '../../src/workitems/artifacts.js';

let tmpDir: string;
let rootDir: string;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-artifacts-test-'));
  rootDir = path.join(tmpDir, 'workitems');
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ArtifactStore repositories', () => {
  it('initializes one independent git repo per workitem with local identity and an initial commit', () => {
    const artifacts = new ArtifactStore(rootDir, logger);
    artifacts.initRepo('wi-1');
    artifacts.initRepo('wi-2');

    const repo1 = artifacts.repoPath('wi-1');
    const repo2 = artifacts.repoPath('wi-2');
    expect(fs.existsSync(path.join(repo1, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(repo2, '.git'))).toBe(true);
    expect(git(repo1, ['config', '--get', 'user.name'])).toBe('agent-pipe');
    expect(git(repo1, ['config', '--get', 'user.email'])).toBe('agent-pipe@local');
    expect(git(repo1, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(git(repo2, ['rev-list', '--count', 'HEAD'])).toBe('1');
  });

  it('commits once for each write and reads files back from the repo', () => {
    const artifacts = new ArtifactStore(rootDir, logger);
    artifacts.initRepo('wi-1');
    artifacts.writeFile('wi-1', 'assignments/as-1/brief.md', 'brief v1', 'write brief v1');
    artifacts.writeFile('wi-1', 'assignments/as-1/report.md', 'report v1', 'write report v1');

    const repo = artifacts.repoPath('wi-1');
    expect(artifacts.readFile('wi-1', 'assignments/as-1/brief.md')).toBe('brief v1');
    expect(artifacts.readFile('wi-1', 'assignments/as-1/report.md')).toBe('report v1');
    expect(git(repo, ['rev-list', '--count', 'HEAD'])).toBe('3');
    expect(git(repo, ['log', '--format=%s'])).toContain(
      'wi-1 assignments/as-1/report.md write report v1',
    );
    expect(artifacts.isClean('wi-1')).toBe(true);
  });

  it('rejects absolute paths and paths that escape the repository', () => {
    const artifacts = new ArtifactStore(rootDir, logger);
    artifacts.initRepo('wi-1');

    expect(() => artifacts.writeFile('wi-1', '/tmp/outside.md', 'bad', 'bad')).toThrow(
      /relative artifact path/,
    );
    expect(() => artifacts.writeFile('wi-1', '../outside.md', 'bad', 'bad')).toThrow(
      /relative artifact path/,
    );
  });

  it('reconciles clean, dirty, and missing repositories idempotently', () => {
    const artifacts = new ArtifactStore(rootDir, logger);
    artifacts.initRepo('wi-1');
    expect(artifacts.reconcile('wi-1', 'startup')).toBe('noop');

    const repo = artifacts.repoPath('wi-1');
    fs.writeFileSync(path.join(repo, 'uncommitted.txt'), 'left behind');
    expect(artifacts.reconcile('wi-1', 'startup')).toBe('committed');
    expect(artifacts.isClean('wi-1')).toBe(true);
    expect(git(repo, ['log', '-1', '--format=%s'])).toContain('reconcile(wi-1): startup');

    fs.rmSync(repo, { recursive: true, force: true });
    expect(artifacts.reconcile('wi-1', 'startup')).toBe('recreated');
    expect(fs.existsSync(path.join(repo, '.git'))).toBe(true);
    expect(artifacts.isClean('wi-1')).toBe(true);
  });
});
