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

function setup(maxConcurrent?: number, maxHot = 8) {
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
    { maxHot, maxConcurrent },
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
