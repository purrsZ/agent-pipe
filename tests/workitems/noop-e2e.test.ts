import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkitemsContainer,
  type WorkitemsContainer,
} from '../../src/workitems/container.js';
import { registerNoop } from '../../src/worktypes/noop/index.js';
import { createNoopRunHandler } from '../../src/worktypes/noop/run-handler.js';
import type { Clock, WorkItem } from '../../src/workitems/types.js';

let tmpDir: string;
let now = 1000;
const clock: Clock = { now: () => now };
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-noop-e2e-test-'));
  now = 1000;
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function harness(env: Record<string, string | undefined> = {}): WorkitemsContainer {
  const container = createWorkitemsContainer({
    dbPath: path.join(tmpDir, 'workitems.sqlite'),
    workitemsDir: path.join(tmpDir, 'workitems'),
    backupsDir: path.join(tmpDir, 'backups'),
    clock,
    logger,
    env: {
      WORKITEMS_HEARTBEAT_TIMEOUT_SEC: '1',
      WORKITEMS_RETRY_BUDGET: '1',
      WORKITEMS_HUMAN_WAIT_TTL_SEC: '2',
      WORKITEMS_MAX_OPEN: '8',
      ...env,
    },
  });
  registerNoop(container.registry);
  container.effects.registerHandler(createNoopRunHandler());
  container.start();
  return container;
}

function createNoop(container: WorkitemsContainer, title: string, context: unknown): WorkItem {
  return container.api.createWorkItem({ type: 'noop', title, source: {}, context }).item;
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1500;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('waitFor timed out');
}

function advance(container: WorkitemsContainer, ms: number): void {
  now += ms;
  container.watchdog.tick();
}

describe('noop in-process e2e', () => {
  it('completes the normal delay + timer journey with continuous event seq and git artifacts', async () => {
    const container = harness();
    const item = createNoop(container, 'Normal', { delayMs: 100, timerWaitSec: 1 });
    const effect = container.store.listInflightEffects(item.id)[0]!;

    await waitFor(() => expect(container.store.getEffect(effect.id)!.status).toBe('running'));
    advance(container, 100);
    await waitFor(() => expect(container.store.getEffect(effect.id)!.status).toBe('done'));
    expect(container.api.getWorkItem(item.id)).toMatchObject({
      status: 'waiting',
      statusDetail: 'timer',
    });

    advance(container, 1000);

    await waitFor(() => expect(container.api.getWorkItem(item.id)!.status).toBe('done'));
    expect(container.store.listOpenWaits(item.id)).toHaveLength(0);
    expect(container.store.listEvents(item.id).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(container.store.listEvents(item.id).map((event) => event.kind)).toEqual([
      'workitem_created',
      'run_completed',
      'timer_fired',
    ]);
    const commitCount = Number(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], {
        cwd: container.artifacts.repoPath(item.id),
        encoding: 'utf8',
      }).trim(),
    );
    expect(commitCount).toBeGreaterThanOrEqual(3);
    container.stop();
  });

  it('fails permanently with auditable run_failed events and a replaces chain', async () => {
    const container = harness();
    const item = createNoop(container, 'Always fails', {
      failAt: 'before-report',
      failCount: 'Infinity',
      noopMaxRetries: 1,
    });

    await waitFor(() => expect(container.api.getWorkItem(item.id)!.status).toBe('failed'));

    const events = container.store.listEvents(item.id);
    expect(events.filter((event) => event.kind === 'run_failed')).toHaveLength(2);
    const assignments = [...container.store.listAssignments(item.id)].sort(
      (left, right) => left.retries - right.retries,
    );
    expect(assignments).toHaveLength(2);
    expect(assignments[1]).toMatchObject({
      status: 'failed',
      replacesAssignmentId: assignments[0]!.id,
      retries: 1,
    });
    container.stop();
  });

  it('runs mixed concurrent noop workitems independently', async () => {
    const container = harness();
    const a = createNoop(container, 'A', { delayMs: 0, timerWaitSec: 1 });
    const b = createNoop(container, 'B', {
      delayMs: 0,
      failAt: 'before-report',
      failCount: 1,
      noopMaxRetries: 1,
      timerWaitSec: 1,
    });
    const c = createNoop(container, 'C', { delayMs: 50, timerWaitSec: 1 });

    advance(container, 50);
    await waitFor(() => {
      expect(container.api.getWorkItem(a.id)!.statusDetail).toBe('timer');
      expect(container.api.getWorkItem(b.id)!.statusDetail).toBe('timer');
      expect(container.api.getWorkItem(c.id)!.statusDetail).toBe('timer');
    });
    advance(container, 1000);

    await waitFor(() => {
      expect(container.api.getWorkItem(a.id)!.status).toBe('done');
      expect(container.api.getWorkItem(b.id)!.status).toBe('done');
      expect(container.api.getWorkItem(c.id)!.status).toBe('done');
    });
    expect(container.store.listEvents(a.id).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(
      container.store.listEvents(b.id).filter((event) => event.kind === 'run_failed'),
    ).toHaveLength(1);
    expect(container.store.listEvents(c.id).map((event) => event.seq)).toEqual([1, 2, 3]);
    container.stop();
  });

  it('escalates repeated heartbeat-silent stalls to a human wait that can be renewed', async () => {
    const container = harness();
    const item = createNoop(container, 'Silent', {
      delayMs: 100_000,
      heartbeatMode: 'silent',
      deadlineTtlSec: 1000,
      wallclockCapSec: 1000,
    });

    await waitFor(() => expect(container.store.listAssignments(item.id)).toHaveLength(1));
    advance(container, 1000);
    await waitFor(() => {
      expect(container.store.listAssignments(item.id)).toHaveLength(2);
      expect(container.store.listAssignments(item.id)[0]!.status).toBe('superseded');
    });
    // No manual poke: the stalled replacement must be driven by the runtime itself
    // (post-commit poke + unconditional drain after the old handler unwinds).
    await waitFor(() => {
      expect(
        container.store.listInflightEffects(item.id).some((effect) => effect.status === 'running'),
      ).toBe(true);
    });

    advance(container, 1000);
    await waitFor(() => {
      expect(container.store.listAssignments(item.id).at(-1)!.status).toBe('failed');
      expect(container.store.listOpenWaits(item.id)[0]).toMatchObject({
        kind: 'human',
        reason: 'retry_exhausted',
      });
    });

    const wait = container.store.listOpenWaits(item.id)[0]!;
    // WS-3: 提醒改为 createdAt + waitRemindAfterSec（默认 4h）触发，跨过首催窗口。
    advance(container, 14_400_000);
    expect(container.store.getWait(wait.id)).toMatchObject({ remindedAt: now });
    container.api.renewWait(wait.id, { operator: 'codex', deadlineTtlSec: 2 });
    expect(container.store.getWait(wait.id)).toMatchObject({ renewedCount: 1, remindedAt: null });
    expect(container.store.listEvents(item.id).map((event) => event.kind)).toContain(
      'wait_renewed',
    );
    container.stop();
  });

  it('uses wallclock_exceeded instead of heartbeat_silent when heartbeats continue', async () => {
    const container = harness();
    const item = createNoop(container, 'Wallclock', {
      heartbeatMode: 'beat-no-finish',
      heartbeatIntervalMs: 1,
      deadlineTtlSec: 1000,
      wallclockCapSec: 2,
    });

    await waitFor(() => expect(container.store.listAssignments(item.id)).toHaveLength(1));
    now += 3000;
    await new Promise((resolve) => setTimeout(resolve, 20));
    container.watchdog.tick();

    await waitFor(() =>
      expect(container.store.listEvents(item.id).map((event) => event.kind)).toContain(
        'assignment_stalled',
      ),
    );
    const stalledPayloads = container.store
      .listEvents(item.id)
      .filter((event) => event.kind === 'assignment_stalled')
      .map((event) => event.payload as { reason: string });
    expect(stalledPayloads.map((payload) => payload.reason)).toContain('wallclock_exceeded');
    expect(stalledPayloads.map((payload) => payload.reason)).not.toContain('heartbeat_silent');
    container.stop();
  });
});
