import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureSingleInstance } from '../../src/index.js';
import { removeOwnPidFile } from '../../src/lifecycle.js';

const dataDir = requiredEnv('DATA_DIR');
const readyFile = requiredEnv('READY_FILE');
const pidPath = path.join(dataDir, 'bot.pid');
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

fs.mkdirSync(dataDir, { recursive: true });
ensureSingleInstance(pidPath, logger as never);
fs.writeFileSync(readyFile, JSON.stringify({ pid: process.pid }));

const keepalive = setInterval(() => {}, 1000);

process.on('SIGTERM', () => {
  clearInterval(keepalive);
  try {
    fs.unlinkSync(readyFile);
  } catch {
    /* already gone */
  }
  removeOwnPidFile(pidPath);
  process.exit(0);
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
