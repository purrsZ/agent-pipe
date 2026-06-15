import * as fs from 'node:fs';
import * as path from 'node:path';
import { createWorkitemsContainer } from '../../src/workitems/container.js';
import { registerNoop } from '../../src/worktypes/noop/index.js';
import { createNoopRunHandler } from '../../src/worktypes/noop/run-handler.js';

const dataDir = requiredEnv('DATA_DIR');
const readyFile = process.env.READY_FILE;
const params = parseJson(process.env.NOOP_PARAMS ?? '{}');

fs.mkdirSync(dataDir, { recursive: true });

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const container = createWorkitemsContainer({
  dbPath: path.join(dataDir, 'workitems.sqlite'),
  workitemsDir: path.join(dataDir, 'workitems'),
  backupsDir: path.join(dataDir, 'backups'),
  logger,
  env: {
    ...process.env,
    WORKITEMS_WATCHDOG_INTERVAL_MS: process.env.WORKITEMS_WATCHDOG_INTERVAL_MS ?? '100',
    WORKITEMS_HEARTBEAT_TIMEOUT_SEC: process.env.WORKITEMS_HEARTBEAT_TIMEOUT_SEC ?? '1',
    WORKITEMS_RETRY_BUDGET: process.env.WORKITEMS_RETRY_BUDGET ?? '1',
    WORKITEMS_MAX_OPEN: process.env.WORKITEMS_MAX_OPEN ?? '8',
  },
});
registerNoop(container.registry);
container.effects.registerHandler(createNoopRunHandler());
container.start();

if (process.env.WINDOW === 'pending') {
  container.effects.stopIntake();
}

let itemId = container.store.listNonTerminal()[0]?.id;
if (!itemId && process.env.CREATE_ON_START !== '0') {
  itemId = container.api.createWorkItem({
    type: 'noop',
    title: 'Fixture noop',
    source: {},
    context: params,
  }).item.id;
}

if (itemId && process.env.MAKE_DIRTY === '1') {
  fs.writeFileSync(path.join(container.artifacts.repoPath(itemId), 'dirty.txt'), 'dirty artifact');
}

if (readyFile) {
  fs.mkdirSync(path.dirname(readyFile), { recursive: true });
  fs.writeFileSync(readyFile, JSON.stringify({ pid: process.pid, itemId }));
}

const keepalive = setInterval(() => {}, 1000);

process.on('SIGTERM', () => {
  clearInterval(keepalive);
  container.stop();
  process.exit(0);
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}
