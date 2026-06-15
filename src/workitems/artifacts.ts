import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LoggerLike } from './shared.js';

export type ReconcileResult = 'noop' | 'committed' | 'recreated';

export class ArtifactStore {
  constructor(
    private readonly rootDir: string,
    private readonly logger: LoggerLike,
  ) {}

  repoPath(workitemId: string): string {
    if (path.isAbsolute(workitemId) || workitemId.includes('..') || workitemId.includes(path.sep)) {
      throw new Error(`Invalid workitem id for artifact repository: ${workitemId}`);
    }
    return path.join(this.rootDir, workitemId);
  }

  initRepo(workitemId: string): void {
    const repo = this.repoPath(workitemId);
    fs.mkdirSync(repo, { recursive: true });
    if (!fs.existsSync(path.join(repo, '.git'))) {
      this.git(repo, ['init', '-b', 'main']);
      this.git(repo, ['config', 'user.name', 'agent-pipe']);
      this.git(repo, ['config', 'user.email', 'agent-pipe@local']);
      this.git(repo, ['commit', '--allow-empty', '-m', `init(${workitemId}): artifact repository`]);
      this.logger.info?.({ workitemId, repo }, 'initialized artifact repository');
    }
  }

  writeFile(workitemId: string, relPath: string, content: string, message: string): void {
    const repo = this.repoPath(workitemId);
    this.assertRepo(repo, workitemId);
    const safeRelPath = this.safeRelPath(relPath);
    const target = path.join(repo, safeRelPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    this.git(repo, ['add', '-A']);
    this.git(repo, ['commit', '--allow-empty', '-m', `${workitemId} ${safeRelPath} ${message}`]);
  }

  readFile(workitemId: string, relPath: string): string | undefined {
    const repo = this.repoPath(workitemId);
    const target = path.join(repo, this.safeRelPath(relPath));
    if (!fs.existsSync(target)) return undefined;
    return fs.readFileSync(target, 'utf8');
  }

  isClean(workitemId: string): boolean {
    const repo = this.repoPath(workitemId);
    this.assertRepo(repo, workitemId);
    return this.git(repo, ['status', '--porcelain']) === '';
  }

  reconcile(workitemId: string, label: string): ReconcileResult {
    const repo = this.repoPath(workitemId);
    if (!fs.existsSync(path.join(repo, '.git'))) {
      this.initRepo(workitemId);
      return 'recreated';
    }
    if (this.isClean(workitemId)) return 'noop';

    this.git(repo, ['add', '-A']);
    this.git(repo, [
      'commit',
      '-m',
      `reconcile(${workitemId}): ${label} ${new Date().toISOString()}`,
    ]);
    return 'committed';
  }

  private safeRelPath(relPath: string): string {
    if (path.isAbsolute(relPath)) {
      throw new Error('Artifact path must be a relative artifact path within the repository');
    }
    const normalized = path.normalize(relPath);
    if (normalized === '.' || normalized.startsWith('..') || normalized.includes(`${path.sep}..`)) {
      throw new Error('Artifact path must be a relative artifact path within the repository');
    }
    return normalized;
  }

  private assertRepo(repo: string, workitemId: string): void {
    if (!fs.existsSync(path.join(repo, '.git'))) {
      throw new Error(`Artifact repository does not exist for workitem ${workitemId}`);
    }
  }

  private git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }
}
