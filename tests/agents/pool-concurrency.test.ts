import { describe, expect, it } from 'vitest';
import { AgentPool } from '../../src/agents/pool.js';
import type { AgentFactory } from '../../src/agents/types.js';
import type { Logger } from '../../src/logger.js';
import type { AgentKind, Store, Task } from '../../src/store.js';
import { FakeRunner } from './fake-runner.js';

function fakeTask(id: string, kind: AgentKind): Task {
  return {
    id,
    display_name: id,
    agent_kind: kind,
    owner_kind: 'bridge',
    mode: 'sandbox',
    cwd: '/tmp',
    root_msg_id: null,
    root_chat_id: null,
    agent_session_id: null,
    status: 'suspended',
    model: null,
    created_at: 0,
    last_active_at: 0,
  };
}

function setup(maxConcurrent?: number, maxHot = 8, reservedHighPrioritySlots?: number) {
  const created: FakeRunner[] = [];
  const releases: Array<() => void> = [];
  const factory = (kind: AgentKind): AgentFactory => ({
    kind,
    modelChangeRequiresRespawn: () => true,
    defaultModel: () => 'm',
    contextWindow: () => 1000,
    createRunner: (task) => {
      const r = new FakeRunner(task.id, kind);
      // Every runTurn hangs until its slot is explicitly released — lets the test hold
      // concurrency slots and observe queueing.
      r.hold = new Promise<void>((res) => releases.push(res));
      created.push(r);
      return r;
    },
  });
  const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
  // setStatus is hit when evictLRU runs (clamp test: 3rd runner created with hotCount == maxHot).
  const store = { setStatus() {} } as unknown as Store;
  const pool = new AgentPool(
    { claude: factory('claude'), codex: factory('codex') },
    { maxHot, maxConcurrent, reservedHighPrioritySlots },
    store,
    logger,
  );
  return { pool, created, releases };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('AgentPool global concurrency gate (WI-C / §2.1)', () => {
  it('caps concurrent runTurns and queues the rest FIFO (onQueued + no early createRunner)', async () => {
    const { pool, created, releases } = setup(1);
    const p1 = pool.send(fakeTask('t1', 'claude'), 'a'); // takes the only slot; runTurn hangs
    await tick();
    expect(created).toHaveLength(1);

    let queued = false;
    const p2 = pool.send(fakeTask('t2', 'claude'), 'b', undefined, undefined, () => {
      queued = true;
    });
    await tick();
    expect(queued).toBe(true); // slot full → onQueued fired once
    expect(created).toHaveLength(1); // §2.1: acquire BEFORE createRunner — t2 not built yet
    expect(pool.activeRuns()).toBe(1);
    expect(pool.queuedRuns()).toBe(1);

    releases[0]!(); // t1 completes → release hands the slot to t2's waiter
    await p1;
    await tick();
    expect(created).toHaveLength(2);
    expect(created[1]!.taskId).toBe('t2');

    releases[1]!();
    await p2;
    expect(pool.activeRuns()).toBe(0);
    expect(pool.queuedRuns()).toBe(0);
  });

  it('does not queue when under the cap (zero regression for low load)', async () => {
    const { pool, created, releases } = setup(2);
    let queued = false;
    const p1 = pool.send(fakeTask('t1', 'claude'), 'a');
    const p2 = pool.send(fakeTask('t2', 'claude'), 'b', undefined, undefined, () => {
      queued = true;
    });
    await tick();
    expect(queued).toBe(false); // cap=2 fits both
    expect(created).toHaveLength(2);
    expect(pool.activeRuns()).toBe(2);
    for (const r of releases.splice(0)) r();
    await Promise.all([p1, p2]);
    expect(pool.activeRuns()).toBe(0);
  });

  it('clamps maxConcurrent to maxHot (effective cap = min)', async () => {
    const { pool, releases } = setup(100, 2); // ask 100, maxHot 2 → cap 2
    const sends = [0, 1, 2].map((i) => pool.send(fakeTask(`t${i}`, 'claude'), 'x'));
    await tick();
    expect(pool.activeRuns()).toBe(2); // clamped, not 3
    expect(pool.queuedRuns()).toBe(1);
    for (const r of releases.splice(0)) r();
    await tick();
    for (const r of releases.splice(0)) r();
    await Promise.all(sends);
    expect(pool.activeRuns()).toBe(0);
  });
});

describe('AgentPool owner reserved slot (R07 / D-18)', () => {
  it('caps normal runs below the full cap, leaving a slot for high priority', async () => {
    // cap 2, reserve 1 → normal runs may take at most 1; the other is owner-only.
    const { pool, created } = setup(2, 8, 1);
    pool.send(fakeTask('w1', 'claude'), 'a'); // normal — takes the single low slot
    let w2queued = false;
    pool.send(fakeTask('w2', 'claude'), 'b', undefined, undefined, () => {
      w2queued = true;
    }); // normal — blocked by the reduced low cap, even though a raw slot is free
    await tick();
    expect(pool.activeRuns()).toBe(1);
    expect(w2queued).toBe(true);

    // an owner run lands immediately in the reserved slot — not starved behind w2.
    pool.send(fakeTask('owner', 'claude'), 'c', undefined, undefined, undefined, 'high');
    await tick();
    expect(pool.activeRuns()).toBe(2);
    expect(created.map((r) => r.taskId)).toContain('owner');
    expect(created.map((r) => r.taskId)).not.toContain('w2'); // still queued
  });

  it('serves a high-priority waiter before a queued normal one when a slot frees', async () => {
    const { pool, created, releases } = setup(1, 8, 0); // cap 1, no reserve → pure priority order
    pool.send(fakeTask('w1', 'claude'), 'a'); // holds the only slot
    await tick();
    pool.send(fakeTask('w2', 'claude'), 'b'); // normal, queued
    pool.send(fakeTask('owner', 'claude'), 'c', undefined, undefined, undefined, 'high'); // high, queued
    await tick();
    expect(pool.queuedRuns()).toBe(2);

    releases[0]!(); // free the slot → high waiter (owner) goes first
    await tick();
    expect(created.map((r) => r.taskId)).toContain('owner');
    expect(created.map((r) => r.taskId)).not.toContain('w2');
  });

  it('zero regression: reserved=0 keeps pure FIFO behaviour', async () => {
    const { pool } = setup(2, 8, 0);
    pool.send(fakeTask('t1', 'claude'), 'a');
    pool.send(fakeTask('t2', 'claude'), 'b');
    await tick();
    expect(pool.activeRuns()).toBe(2); // both normal runs fit (no reservation)
  });
});
