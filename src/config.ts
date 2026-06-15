import 'dotenv/config';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentKind } from './store.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少必填环境变量 ${name}，参见 .env.example`);
  return v;
}

export interface Config {
  feishu: { appId: string; appSecret: string };
  claude: { path: string; model: string; effort: string };
  codex: {
    path: string;
    model: string;
    reasoningEffort?: 'low' | 'medium' | 'high';
  };
  defaultAgent: AgentKind;
  maxHot: number;
  maxConcurrent: number;
  allowedOpenIds: Set<string>;
  allowedCwdPrefixes: string[];
  logLevel: string;
  dataDir: string;
  dbPath: string;
  sessionsDir: string;
  workitemsDbPath: string;
  workitemsDir: string;
}

function parseAgent(v: string | undefined): AgentKind {
  if (v === 'codex') return 'codex';
  return 'claude';
}

function parseEffort(v: string | undefined): 'low' | 'medium' | 'high' | undefined {
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return undefined;
}

// Parse an optional positive-integer env var: fall back when unset/blank, fail fast on
// garbage. Mirrors workitems/config.ts positiveInt. The old `Number.parseInt(env ?? '4')`
// let a blank or non-numeric value become NaN, which then flowed into the AgentPool
// concurrency Semaphore (active < NaN is always false) and deadlocked every send — a
// silent, hard-to-diagnose freeze. A bad value must surface at startup instead.
function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数，收到: ${raw}`);
  }
  return value;
}

export function loadConfig(): Config {
  const appId = required('FEISHU_APP_ID');
  const appSecret = required('FEISHU_APP_SECRET');

  const allowed = (process.env.ALLOWED_OPEN_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) {
    throw new Error('ALLOWED_OPEN_IDS 至少需要一个 open_id');
  }

  const cwdPrefixes = (process.env.ALLOWED_CWD_PREFIXES ?? '')
    .split(':')
    .map((s) => expandHome(s.trim()))
    .filter(Boolean);

  const dataDir = expandHome(process.env.DATA_DIR ?? '~/.agent-pipe');
  const maxHot = parsePositiveInt(process.env.MAX_HOT, 4, 'MAX_HOT');
  const maxConcurrent = parsePositiveInt(process.env.MAX_CONCURRENT, maxHot, 'MAX_CONCURRENT');

  return {
    feishu: { appId, appSecret },
    claude: {
      path: process.env.CLAUDE_PATH ?? 'claude',
      model: process.env.CLAUDE_MODEL ?? 'claude-opus-4-7[1m]',
      effort: process.env.CLAUDE_EFFORT ?? 'xhigh',
    },
    codex: {
      path: process.env.CODEX_PATH ?? 'codex',
      model: process.env.CODEX_MODEL ?? 'gpt-5.1-codex',
      reasoningEffort: parseEffort(process.env.CODEX_REASONING_EFFORT),
    },
    defaultAgent: parseAgent(process.env.DEFAULT_AGENT),
    maxHot,
    maxConcurrent,
    allowedOpenIds: new Set(allowed),
    allowedCwdPrefixes: cwdPrefixes,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    dataDir,
    dbPath: path.join(dataDir, 'db.sqlite'),
    sessionsDir: path.join(dataDir, 'sessions'),
    workitemsDbPath: expandHome(
      process.env.WORKITEMS_DB_PATH ?? path.join(dataDir, 'workitems.sqlite'),
    ),
    workitemsDir: expandHome(process.env.WORKITEMS_DIR ?? path.join(dataDir, 'workitems')),
  };
}
