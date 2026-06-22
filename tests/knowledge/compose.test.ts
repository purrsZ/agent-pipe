import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeRepoKnowledge } from '../../src/knowledge/compose.js';
import { DEFAULT_FRESHNESS_POLICY } from '../../src/knowledge/freshness.js';
import { KnowledgeStore } from '../../src/knowledge/store.js';

let tmpDir: string;
let store: KnowledgeStore;
const deps = (budgetChars = 6000) => ({
  store,
  policy: DEFAULT_FRESHNESS_POLICY,
  budgetChars,
  now: () => 0,
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-knowledge-compose-'));
  store = new KnowledgeStore(path.join(tmpDir, 'knowledge'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('composeRepoKnowledge (Stage 5 选择性注入 live wiring)', () => {
  it('returns undefined for a repo with no indexed knowledge (prompt omits the block)', () => {
    expect(composeRepoKnowledge(deps(), '/repo/x', '/repo/x')).toBeUndefined();
  });

  it('renders indexed docs and flags stale knowledge when never-indexed (no manifest)', () => {
    store.writeDoc('/repo/a', 'runbook', 'npm test', 'index runbook');
    store.writeDoc('/repo/a', 'map', '# 架构地图', 'index map');

    // no manifest → assess returns never-indexed → injected with the stale caveat (not dropped).
    const block = composeRepoKnowledge(deps(), '/repo/a', path.join(tmpDir, 'nonexistent'));
    expect(block).toBeDefined();
    expect(block).toContain('npm test');
    expect(block).toContain('架构地图');
    expect(block).toContain('可能已过时'); // R16.AC-4 stale flag
  });

  it('drops whole docs that bust the budget (priority: runbook kept, oversized map dropped)', () => {
    store.writeDoc('/repo/b', 'runbook', 'RUN-CMD', 'm');
    store.writeDoc('/repo/b', 'map', 'M'.repeat(5000), 'm');

    const block = composeRepoKnowledge(deps(100), '/repo/b', '/x');
    expect(block).toBeDefined();
    expect(block).toContain('RUN-CMD'); // highest priority, fits
    expect(block).not.toContain('M'.repeat(5000)); // over budget → whole doc dropped
  });

  it('ignores blank docs (whitespace-only is treated as absent)', () => {
    store.writeDoc('/repo/c', 'runbook', '   \n  ', 'm');
    expect(composeRepoKnowledge(deps(), '/repo/c', '/x')).toBeUndefined();
  });
});
