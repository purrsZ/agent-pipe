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

function setup() {
  const created: FakeRunner[] = [];
  const factory = (kind: AgentKind): AgentFactory => ({
    kind,
    modelChangeRequiresRespawn: () => true,
    defaultModel: () => 'm',
    contextWindow: () => 1000,
    createRunner: (task) => {
      const r = new FakeRunner(task.id, kind);
      created.push(r);
      return r;
    },
  });
  const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
  const store = {} as unknown as Store;
  const pool = new AgentPool(
    { claude: factory('claude'), codex: factory('codex') },
    { maxHot: 8 },
    store,
    logger,
  );
  return { pool, created };
}

describe('AgentPool per-options rebuild (WI-A / §2.1)', () => {
  it('reuses the runner across turns when options are unchanged (zero regression)', async () => {
    const { pool, created } = setup();
    const task = fakeTask('t1', 'claude');
    await pool.send(task, 'a');
    await pool.send(task, 'b');
    expect(created).toHaveLength(1);
    expect(created[0]!.disposed).toBe(false);
    expect(created[0]!.calls.map((c) => c.text)).toEqual(['a', 'b']);
  });

  it('rebuilds (dispose + recreate) when the options fingerprint changes', async () => {
    const { pool, created } = setup();
    const task = fakeTask('t1', 'claude');
    await pool.send(task, 'a');
    await pool.send(task, 'b', undefined, { mcpServers: [{ name: 'x', command: 'echo' }] });
    expect(created).toHaveLength(2);
    expect(created[0]!.disposed).toBe(true);
    expect(created[1]!.disposed).toBe(false);
    expect(created[1]!.calls[0]!.options?.mcpServers?.[0]?.name).toBe('x');
  });

  it('rebuilds again when options return to default', async () => {
    const { pool, created } = setup();
    const task = fakeTask('t1', 'claude');
    await pool.send(task, 'a', undefined, { permission: { mode: 'readonly' } });
    await pool.send(task, 'b'); // default fingerprint '' ≠ readonly fingerprint
    expect(created).toHaveLength(2);
    expect(created[0]!.disposed).toBe(true);
  });

  it('does not rebuild for two order-equivalent option sets (stable fingerprint)', async () => {
    const { pool, created } = setup();
    const task = fakeTask('t1', 'claude');
    const opts1 = {
      mcpServers: [
        { name: 'a', command: 'x' },
        { name: 'b', command: 'y' },
      ],
    };
    const opts2 = {
      mcpServers: [
        { name: 'b', command: 'y' },
        { name: 'a', command: 'x' },
      ],
    };
    await pool.send(task, '1', undefined, opts1);
    await pool.send(task, '2', undefined, opts2);
    expect(created).toHaveLength(1);
  });
});
