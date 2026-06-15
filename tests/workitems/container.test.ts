import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkitemsContainer } from '../../src/workitems/container.js';
import { registerNoop } from '../../src/worktypes/noop/index.js';
import type {
  Clock,
  Transition,
  WorkItem,
  WorkItemEvent,
  WorkType,
} from '../../src/workitems/types.js';

let tmpDir: string;
const clock: Clock = { now: () => 1000 };
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-container-test-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function paths(): { dbPath: string; workitemsDir: string; backupsDir: string } {
  return {
    dbPath: path.join(tmpDir, 'workitems.sqlite'),
    workitemsDir: path.join(tmpDir, 'workitems'),
    backupsDir: path.join(tmpDir, 'backups'),
  };
}

describe('WorkitemsContainer', () => {
  it('assembles workitems store, artifacts, registry, reducer, effects, watchdog, and api', () => {
    const container = createWorkitemsContainer({ ...paths(), clock, logger });
    registerNoop(container.registry);

    const created = container.api.createWorkItem({
      type: 'noop',
      title: 'Container',
      source: {},
    });

    expect(created.created).toBe(true);
    expect(container.store.getWorkItem(created.item.id)).toBeTruthy();
    expect(fs.existsSync(path.join(container.artifacts.repoPath(created.item.id), '.git'))).toBe(
      true,
    );
    expect(container.reducer).toBeTruthy();
    expect(container.effects).toBeTruthy();
    expect(container.watchdog).toBeTruthy();
    container.stop();
  });

  it('starts recovery before watchdog processing', () => {
    const container = createWorkitemsContainer({ ...paths(), clock, logger });
    const order: string[] = [];
    logger.info.mockImplementation((obj) => {
      if (typeof obj === 'string' && obj.startsWith('recovery:')) order.push(obj);
    });
    vi.spyOn(container.watchdog, 'start').mockImplementation(() => order.push('watchdog.start'));

    container.start();

    expect(order).toEqual([
      'recovery: step 2 rebuild',
      'recovery: step 3 outbox',
      'recovery: step 4 reconcile',
      'watchdog.start',
    ]);
    container.stop();
  });

  it('stops watchdog, intake, inflight handlers, and store in order', () => {
    const container = createWorkitemsContainer({ ...paths(), clock, logger });
    const order: string[] = [];
    vi.spyOn(container.watchdog, 'stop').mockImplementation(() => order.push('watchdog.stop'));
    vi.spyOn(container.effects, 'stopIntake').mockImplementation(() =>
      order.push('effects.stopIntake'),
    );
    vi.spyOn(container.effects, 'abortInflight').mockImplementation(() =>
      order.push('effects.abortInflight'),
    );
    vi.spyOn(container.store, 'close').mockImplementation(() => order.push('store.close'));

    container.stop();

    expect(order).toEqual([
      'watchdog.stop',
      'effects.stopIntake',
      'effects.abortInflight',
      'store.close',
    ]);
  });

  it('leaves running effects in the database on stop and recovers them on next start', async () => {
    const p = paths();
    const first = createWorkitemsContainer({ ...p, clock, logger });
    first.registry.register(testWorkType());
    const aborted = new Promise<void>((resolve) => {
      first.effects.registerHandler({
        kind: 'run',
        recovery: 'resume-or-redispatch',
        canResume: () => false,
        run: async (ctx) => {
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          await new Promise<void>((finish) =>
            ctx.signal.addEventListener('abort', () => finish(), { once: true }),
          );
        },
      });
    });
    const item = first.api.createWorkItem({ type: 'test', title: 'Running', source: {} }).item;
    const effect = first.store.listInflightEffects(item.id)[0]!;
    first.effects.poke(item.id);
    await waitFor(() => expect(first.store.getEffect(effect.id)!.status).toBe('running'));

    first.stop();
    await aborted;

    const second = createWorkitemsContainer({ ...p, clock, logger });
    second.registry.register(testWorkType());
    second.effects.registerHandler({
      kind: 'run',
      recovery: 'resume-or-redispatch',
      canResume: () => true,
      resume: async () => {},
      run: async () => {},
    });
    expect(second.store.getEffect(effect.id)!.status).toBe('running');

    second.start();

    await waitFor(() => expect(second.store.getEffect(effect.id)!.status).toBe('done'));
    second.stop();
  });

  it('returns a workitems backup job for kernel backup extraJobs', async () => {
    const container = createWorkitemsContainer({ ...paths(), clock, logger });
    registerNoop(container.registry);
    const item = container.api.createWorkItem({ type: 'noop', title: 'Backup', source: {} }).item;
    container.artifacts.writeFile(item.id, 'note.md', 'backup me', 'note');
    const job = container.backupJob();

    await job.run(new Date(2026, 0, 10, 1, 0, 0));

    expect(job.label).toBe('workitems');
    expect(fs.existsSync(path.join(tmpDir, 'backups', 'workitems-20260110-010000.sqlite'))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(tmpDir, 'backups', 'workitems-files-20260110-010000.tar.gz')),
    ).toBe(true);
    container.stop();
  });
});

function testWorkType(): WorkType {
  return {
    id: 'test',
    triggers: { api: true },
    initialPhase: () => 'test:idle',
    onEvent: (_item: WorkItem, ev: WorkItemEvent): Transition => {
      if (ev.kind === 'workitem_created') {
        return { dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }] };
      }
      if (ev.kind === 'run_completed') return { terminal: 'done' };
      return {};
    },
    isDecisionStale: () => false,
    topology: () => 'solo',
    permissions: { mode: 'readonly' },
    checkpoints: { requiredBefore: [] },
    artifacts: { reportRequired: false },
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1000;
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
