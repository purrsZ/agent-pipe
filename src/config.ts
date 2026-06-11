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
  allowedOpenIds: Set<string>;
  allowedCwdPrefixes: string[];
  logLevel: string;
  dataDir: string;
  dbPath: string;
  sessionsDir: string;
}

function parseAgent(v: string | undefined): AgentKind {
  if (v === 'codex') return 'codex';
  return 'claude';
}

function parseEffort(v: string | undefined): 'low' | 'medium' | 'high' | undefined {
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return undefined;
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
    maxHot: Number.parseInt(process.env.MAX_HOT ?? '4', 10),
    allowedOpenIds: new Set(allowed),
    allowedCwdPrefixes: cwdPrefixes,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    dataDir,
    dbPath: path.join(dataDir, 'db.sqlite'),
    sessionsDir: path.join(dataDir, 'sessions'),
  };
}
