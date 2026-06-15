import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tmpDir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-pid-takeover-test-'));
});

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => stopChild(child, 'SIGTERM')));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PID takeover process behavior', () => {
  it('lets a new process take over the lock without the old process deleting it', async () => {
    const pidPath = path.join(tmpDir, 'bot.pid');
    const readyA = path.join(tmpDir, 'ready-a.json');
    const readyB = path.join(tmpDir, 'ready-b.json');
    const a = spawnPidApp(readyA);
    await waitForReady(readyA);
    const pidA = readReadyPid(readyA);
    expect(Number(fs.readFileSync(pidPath, 'utf8'))).toBe(pidA);
    expect(isAlive(pidA)).toBe(true);

    const b = spawnPidApp(readyB);
    await waitForReady(readyB);
    const pidB = readReadyPid(readyB);
    await waitForExit(a);

    expect(a.exitCode).toBe(0);
    expect(Number(fs.readFileSync(pidPath, 'utf8'))).toBe(pidB);
    expect(isAlive(pidB)).toBe(true);
    expect(activeReadyPids([readyA, readyB])).toEqual([pidB]);

    await stopChild(b, 'SIGTERM');

    expect(fs.existsSync(pidPath)).toBe(false);
  }, 15_000);
});

function spawnPidApp(readyFile: string): ChildProcess {
  const child = spawn(
    path.join(process.cwd(), 'node_modules/.bin/tsx'),
    [path.join(process.cwd(), 'tests/fixtures/pid-app.ts')],
    {
      env: {
        ...process.env,
        DATA_DIR: tmpDir,
        READY_FILE: readyFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  return child;
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill(signal);
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

async function waitForReady(file: string): Promise<void> {
  await waitFor(() => expect(fs.existsSync(file)).toBe(true), 5000);
}

async function waitFor(assertion: () => void, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('waitFor timed out');
}

function readReadyPid(file: string): number {
  return JSON.parse(fs.readFileSync(file, 'utf8')).pid;
}

function activeReadyPids(files: string[]): number[] {
  return files
    .filter((file) => fs.existsSync(file))
    .map(readReadyPid)
    .filter(isAlive);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
