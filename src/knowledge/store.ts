import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assessFreshness } from './freshness.js';
import type {
  FreshnessPolicy,
  FreshnessVerdict,
  KnowledgeDoc,
  RepoKnowledge,
} from './types.js';

// $DATA_DIR/knowledge/ is ONE git repo (write即commit, version史 free), with <repoKey>/ +
// _system/ subdirs. NOT an ArtifactStore instance (that anchors a workitemId; this anchors a
// repoKey, tracks the repo not the work item — D-16). The cold-index task (an agent run that
// fills the four docs) is the live half; this store is its persistence + the freshness read.
export class KnowledgeStore {
  constructor(private readonly baseDir: string) {}

  ensureRepo(): void {
    fs.mkdirSync(this.baseDir, { recursive: true });
    if (!fs.existsSync(path.join(this.baseDir, '.git'))) {
      this.git(['init', '-b', 'main']);
      // identity so commits work in CI / fresh machines
      this.git(['config', 'user.email', 'agent-pipe@local']);
      this.git(['config', 'user.name', 'agent-pipe']);
      // seed an empty commit so the repo has a HEAD
      fs.writeFileSync(path.join(this.baseDir, '.gitkeep'), '');
      this.git(['add', '-A']);
      this.git(['commit', '--allow-empty', '-m', 'init knowledge']);
    }
  }

  private repoSubdir(repoKey: string): string {
    return sanitize(repoKey);
  }

  private docRelPath(repoKey: string, doc: KnowledgeDoc): string {
    return path.posix.join(this.repoSubdir(repoKey), `${doc}.md`);
  }

  writeDoc(repoKey: string, doc: KnowledgeDoc, content: string, message: string): void {
    this.ensureRepo();
    const rel = this.docRelPath(repoKey, doc);
    const abs = path.join(this.baseDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    this.commitAll(message);
  }

  readDoc(repoKey: string, doc: KnowledgeDoc): string | undefined {
    const abs = path.join(this.baseDir, this.docRelPath(repoKey, doc));
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : undefined;
  }

  writeManifest(repoKey: string, manifest: RepoKnowledge): void {
    this.ensureRepo();
    const rel = path.posix.join(this.repoSubdir(repoKey), 'manifest.json');
    const abs = path.join(this.baseDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(manifest, null, 2));
    this.commitAll(`knowledge manifest: ${repoKey}`);
  }

  readManifest(repoKey: string): RepoKnowledge | undefined {
    const abs = path.join(this.baseDir, this.repoSubdir(repoKey), 'manifest.json');
    if (!fs.existsSync(abs)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(abs, 'utf8')) as RepoKnowledge;
    } catch {
      return undefined;
    }
  }

  listIndexedRepos(): string[] {
    if (!fs.existsSync(this.baseDir)) return [];
    return fs
      .readdirSync(this.baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== '.git' && e.name !== '_system')
      .filter((e) => fs.existsSync(path.join(this.baseDir, e.name, 'manifest.json')))
      .map((e) => e.name);
  }

  // Freshness read for a repo: combine the stored manifest with the target repo's live HEAD.
  assess(repoKey: string, repoPath: string, policy: FreshnessPolicy, now: number): FreshnessVerdict {
    const manifest = this.readManifest(repoKey);
    if (!manifest) return assessFreshness(repoKey, undefined, undefined, policy);
    const head = this.headDrift(repoPath, manifest.generatedAtCommit, manifest.generatedAt, now);
    return assessFreshness(repoKey, manifest, head, policy);
  }

  private headDrift(
    repoPath: string,
    sinceCommit: string,
    generatedAt: number,
    now: number,
  ): { commitsBehind: number; daysSince: number } | undefined {
    try {
      const out = execFileSync('git', ['rev-list', '--count', `${sinceCommit}..HEAD`], {
        cwd: repoPath,
        encoding: 'utf8',
      });
      const commitsBehind = Number.parseInt(out.trim(), 10) || 0;
      const daysSince = Math.max(0, Math.floor((now - generatedAt) / 86_400_000));
      return { commitsBehind, daysSince };
    } catch {
      return undefined; // sinceCommit missing / not a repo → 'missing'
    }
  }

  currentHeadOf(repoPath: string): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
  }

  private commitAll(message: string): void {
    this.git(['add', '-A']);
    this.git(['commit', '--allow-empty', '-m', message]);
  }

  private git(args: string[]): string {
    return execFileSync('git', args, { cwd: this.baseDir, encoding: 'utf8' });
  }
}

function sanitize(repoKey: string): string {
  return repoKey.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'repo';
}
