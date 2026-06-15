import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// config.ts side-effect-imports dotenv, which loads the repo's real .env on first
// import. To keep tests hermetic we explicitly set/delete every variable that
// loadConfig reads, in beforeEach, AFTER that one-time load already happened.
const MANAGED = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'ALLOWED_OPEN_IDS',
  'ALLOWED_CWD_PREFIXES',
  'DATA_DIR',
  'CLAUDE_PATH',
  'CLAUDE_MODEL',
  'CLAUDE_EFFORT',
  'CODEX_PATH',
  'CODEX_MODEL',
  'CODEX_REASONING_EFFORT',
  'DEFAULT_AGENT',
  'MAX_HOT',
  'MAX_CONCURRENT',
  'LOG_LEVEL',
  'WORKITEMS_DB_PATH',
  'WORKITEMS_DIR',
  'WORKITEMS_RETRY_BUDGET',
] as const;

const saved: Record<string, string | undefined> = {};
for (const k of MANAGED) saved[k] = process.env[k];

beforeEach(() => {
  for (const k of MANAGED) delete process.env[k];
  process.env.FEISHU_APP_ID = 'cli_test';
  process.env.FEISHU_APP_SECRET = 'secret_test';
  process.env.ALLOWED_OPEN_IDS = 'ou_admin';
});

afterAll(() => {
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('loadConfig: fail-fast on missing required vars', () => {
  it('throws when FEISHU_APP_ID is missing', () => {
    delete process.env.FEISHU_APP_ID;
    expect(() => loadConfig()).toThrow(/FEISHU_APP_ID/);
  });

  it('throws when FEISHU_APP_SECRET is missing', () => {
    delete process.env.FEISHU_APP_SECRET;
    expect(() => loadConfig()).toThrow(/FEISHU_APP_SECRET/);
  });

  it('throws when ALLOWED_OPEN_IDS is empty', () => {
    process.env.ALLOWED_OPEN_IDS = '  , ,';
    expect(() => loadConfig()).toThrow(/ALLOWED_OPEN_IDS/);
  });
});

describe('loadConfig: parsing & defaults', () => {
  it('splits and trims ALLOWED_OPEN_IDS', () => {
    process.env.ALLOWED_OPEN_IDS = ' ou_a , ou_b,ou_c ';
    const cfg = loadConfig();
    expect(cfg.allowedOpenIds).toEqual(new Set(['ou_a', 'ou_b', 'ou_c']));
  });

  it('expands ~ in DATA_DIR and ALLOWED_CWD_PREFIXES', () => {
    process.env.DATA_DIR = '~/custom-data';
    process.env.ALLOWED_CWD_PREFIXES = '~/projects:/opt/work';
    const cfg = loadConfig();
    expect(cfg.dataDir.startsWith('/')).toBe(true);
    expect(cfg.dataDir).not.toContain('~');
    expect(cfg.dataDir.endsWith('/custom-data')).toBe(true);
    expect(cfg.allowedCwdPrefixes).toHaveLength(2);
    expect(cfg.allowedCwdPrefixes[0]).not.toContain('~');
    expect(cfg.allowedCwdPrefixes[1]).toBe('/opt/work');
  });

  it('derives dbPath and sessionsDir from dataDir', () => {
    process.env.DATA_DIR = '/tmp/ap-data';
    const cfg = loadConfig();
    expect(cfg.dbPath).toBe('/tmp/ap-data/db.sqlite');
    expect(cfg.sessionsDir).toBe('/tmp/ap-data/sessions');
  });

  it('derives default workitems paths from dataDir', () => {
    process.env.DATA_DIR = '/tmp/ap-data';
    const cfg = loadConfig();
    expect(cfg.workitemsDbPath).toBe('/tmp/ap-data/workitems.sqlite');
    expect(cfg.workitemsDir).toBe('/tmp/ap-data/workitems');
  });

  it('allows workitems DB and artifact paths to be overridden', () => {
    process.env.DATA_DIR = '/tmp/ap-data';
    process.env.WORKITEMS_DB_PATH = '~/wi.sqlite';
    process.env.WORKITEMS_DIR = '~/wi-artifacts';
    const cfg = loadConfig();

    expect(cfg.workitemsDbPath.startsWith('/')).toBe(true);
    expect(cfg.workitemsDbPath.endsWith('/wi.sqlite')).toBe(true);
    expect(cfg.workitemsDir.startsWith('/')).toBe(true);
    expect(cfg.workitemsDir.endsWith('/wi-artifacts')).toBe(true);
  });

  it('leaves workitems behavioral tuning to workitems config', () => {
    process.env.WORKITEMS_RETRY_BUDGET = '99';
    const cfg = loadConfig();
    const source = fs.readFileSync(path.join(process.cwd(), 'src/config.ts'), 'utf8');

    expect('retryBudget' in cfg).toBe(false);
    expect(source).not.toContain('loadWorkitemsConfig');
  });

  it('defaultAgent falls back to claude on unknown values', () => {
    process.env.DEFAULT_AGENT = 'gemini';
    expect(loadConfig().defaultAgent).toBe('claude');
    process.env.DEFAULT_AGENT = 'codex';
    expect(loadConfig().defaultAgent).toBe('codex');
  });

  it('codex reasoningEffort only accepts low/medium/high', () => {
    process.env.CODEX_REASONING_EFFORT = 'turbo';
    expect(loadConfig().codex.reasoningEffort).toBeUndefined();
    process.env.CODEX_REASONING_EFFORT = 'high';
    expect(loadConfig().codex.reasoningEffort).toBe('high');
  });

  it('MAX_HOT parses as integer with default 4', () => {
    expect(loadConfig().maxHot).toBe(4);
    process.env.MAX_HOT = '8';
    expect(loadConfig().maxHot).toBe(8);
  });

  it('maxConcurrent defaults to maxHot, never NaN', () => {
    // unset → defaults to maxHot default 4
    expect(loadConfig().maxConcurrent).toBe(4);
    // unset MAX_CONCURRENT inherits a custom MAX_HOT
    process.env.MAX_HOT = '8';
    expect(loadConfig().maxConcurrent).toBe(8);
    // explicit MAX_CONCURRENT wins
    process.env.MAX_CONCURRENT = '3';
    expect(loadConfig().maxConcurrent).toBe(3);
  });

  it('blank MAX_HOT / MAX_CONCURRENT fall back instead of becoming NaN (deadlock guard)', () => {
    // A blank env var must NOT slip through `??` into Number.parseInt('') = NaN, which
    // would make the AgentPool concurrency Semaphore reject every acquire and freeze
    // the whole bridge.
    process.env.MAX_HOT = '';
    process.env.MAX_CONCURRENT = '';
    const cfg = loadConfig();
    expect(cfg.maxHot).toBe(4);
    expect(cfg.maxConcurrent).toBe(4);
    expect(Number.isNaN(cfg.maxHot)).toBe(false);
    expect(Number.isNaN(cfg.maxConcurrent)).toBe(false);
  });

  it('fails fast on non-numeric MAX_HOT / MAX_CONCURRENT', () => {
    process.env.MAX_HOT = 'eight';
    expect(() => loadConfig()).toThrow(/MAX_HOT/);
    process.env.MAX_HOT = '4';
    process.env.MAX_CONCURRENT = 'lots';
    expect(() => loadConfig()).toThrow(/MAX_CONCURRENT/);
  });

  it('rejects zero and negative concurrency', () => {
    process.env.MAX_HOT = '0';
    expect(() => loadConfig()).toThrow(/MAX_HOT/);
    process.env.MAX_HOT = '-1';
    expect(() => loadConfig()).toThrow(/MAX_HOT/);
  });
});
