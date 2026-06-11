import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

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
  'LOG_LEVEL',
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
});
