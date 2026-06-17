import { describe, expect, it } from 'vitest';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import type { WorkItemEvent } from '../../src/workitems/types.js';
import { probeWorkType, registerProbe } from '../../src/worktypes/probe/index.js';
import { makeWorkItem } from '../helpers/workitems.js';

function event(kind: string, payload: unknown = {}): WorkItemEvent {
  return { id: 1, workitemId: 'wi-1', seq: 1, kind, payload, createdAt: 1000 };
}

describe('probe WorkType', () => {
  it('registers the nine work type members as a solo readonly type', () => {
    const registry = new WorkTypeRegistry();
    registerProbe(registry);

    expect(registry.get('probe')).toBe(probeWorkType);
    expect(probeWorkType).toMatchObject({
      id: 'probe',
      triggers: { api: true },
      permissions: { mode: 'readonly' },
      checkpoints: { requiredBefore: [] },
      artifacts: { reportRequired: true },
    });
    expect(probeWorkType.topology(makeWorkItem('wi-1'))).toBe('solo');
    expect(probeWorkType.initialPhase(makeWorkItem('wi-1'))).toBe('probe:looking');
  });

  it('dispatches a solo run on creation', () => {
    const item = makeWorkItem('wi-1', {
      context: { deadlineTtlSec: 100, wallclockCapSec: 50 },
    });
    expect(probeWorkType.onEvent(item, event('workitem_created'))).toEqual({
      phase: { to: 'probe:looking', reason: 'created' },
      dispatch: [{ role: 'solo', deadlineTtlSec: 100, wallclockCapSec: 50 }],
    });
  });

  it('rests IDLE (non-terminal) on run_completed — never terminal (S1 fix)', () => {
    const item = makeWorkItem('wi-1');
    const t = probeWorkType.onEvent(item, event('run_completed', { reportPath: 'x' }));
    expect(t).toEqual({ phase: { to: 'probe:idle', reason: 'run_completed' } });
    expect(t.terminal).toBeUndefined();
    expect(t.dispatch).toBeUndefined();
    expect(t.waits).toBeUndefined();
  });

  it('dispatches a fresh round on a human_message follow-up', () => {
    const item = makeWorkItem('wi-1', { context: { deadlineTtlSec: 100, wallclockCapSec: 50 } });
    expect(probeWorkType.onEvent(item, event('human_message', { text: '再看看 X' }))).toEqual({
      phase: { to: 'probe:looking', reason: 'follow_up' },
      dispatch: [{ role: 'solo', deadlineTtlSec: 100, wallclockCapSec: 50 }],
    });
  });

  it('retries within budget then fails', () => {
    const item = makeWorkItem('wi-1', {
      context: { deadlineTtlSec: 100, wallclockCapSec: 50, maxRetries: 1 },
    });
    expect(
      probeWorkType.onEvent(
        item,
        event('run_failed', { assignmentId: 'as-1', assignmentRetries: 0 }),
      ),
    ).toEqual({
      phase: { to: 'probe:looking', reason: 'retry' },
      dispatch: [
        {
          role: 'solo',
          deadlineTtlSec: 100,
          wallclockCapSec: 50,
          replacesAssignmentId: 'as-1',
          retries: 1,
        },
      ],
    });
    expect(probeWorkType.onEvent(item, event('run_failed', { assignmentRetries: 1 }))).toEqual({
      phase: { to: 'probe:failed', reason: 'run_failed' },
      terminal: 'failed',
    });
  });

  it('terminates done only on an explicit close_requested', () => {
    const item = makeWorkItem('wi-1');
    expect(probeWorkType.onEvent(item, event('close_requested'))).toEqual({
      phase: { to: 'probe:done', reason: 'closed' },
      terminal: 'done',
    });
  });

  it('uses container-matching defaults when context is missing', () => {
    const item = makeWorkItem('wi-1');
    expect(probeWorkType.onEvent(item, event('workitem_created'))).toEqual({
      phase: { to: 'probe:looking', reason: 'created' },
      dispatch: [{ role: 'solo', deadlineTtlSec: 3600, wallclockCapSec: 1800 }],
    });
  });
});
