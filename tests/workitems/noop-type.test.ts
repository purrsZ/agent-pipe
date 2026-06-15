import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { noopWorkType, registerNoop } from '../../src/worktypes/noop/index.js';
import { makeWorkItem } from '../helpers/workitems.js';
import type { WorkItemEvent } from '../../src/workitems/types.js';

function event(kind: string, payload: unknown = {}): WorkItemEvent {
  return {
    id: 1,
    workitemId: 'wi-1',
    seq: 1,
    kind,
    payload,
    createdAt: 1000,
  };
}

describe('noop WorkType', () => {
  it('registers the fixed nine work type members', () => {
    const registry = new WorkTypeRegistry();
    registerNoop(registry);

    expect(registry.get('noop')).toBe(noopWorkType);
    expect(noopWorkType).toMatchObject({
      id: 'noop',
      triggers: { api: true },
      permissions: { mode: 'readonly' },
      checkpoints: { requiredBefore: [] },
      artifacts: { reportRequired: true },
    });
    expect(noopWorkType.topology(makeWorkItem('wi-1'))).toBe('solo');
    expect(noopWorkType.initialPhase(makeWorkItem('wi-1'))).toBe('noop:idle');
    expect(noopWorkType.isDecisionStale({}, [event('anything')])).toBe(false);
  });

  it('maps lifecycle events to pure noop transitions', () => {
    const item = makeWorkItem('wi-1', {
      context: { deadlineTtlSec: 7, wallclockCapSec: 5, timerWaitSec: 3, noopMaxRetries: 1 },
    });

    expect(noopWorkType.onEvent(item, event('workitem_created'))).toEqual({
      dispatch: [{ role: 'solo', deadlineTtlSec: 7, wallclockCapSec: 5 }],
    });
    expect(noopWorkType.onEvent(item, event('run_completed'))).toEqual({
      waits: [{ kind: 'timer', reason: 'noop_complete', deadlineTtlSec: 3 }],
    });
    expect(noopWorkType.onEvent(item, event('timer_fired'))).toEqual({ terminal: 'done' });
    expect(
      noopWorkType.onEvent(
        item,
        event('run_failed', { assignmentId: 'as-1', assignmentRetries: 0 }),
      ),
    ).toEqual({
      dispatch: [
        {
          role: 'solo',
          deadlineTtlSec: 7,
          wallclockCapSec: 5,
          replacesAssignmentId: 'as-1',
          retries: 1,
        },
      ],
    });
    expect(noopWorkType.onEvent(item, event('run_failed', { assignmentRetries: 1 }))).toEqual({
      terminal: 'failed',
    });
  });

  it('uses defaults when context params are missing or invalid', () => {
    const item = makeWorkItem('wi-1', { context: { deadlineTtlSec: -1, timerWaitSec: 0 } });

    expect(noopWorkType.onEvent(item, event('workitem_created'))).toEqual({
      dispatch: [{ role: 'solo', deadlineTtlSec: 60, wallclockCapSec: 30 }],
    });
    expect(noopWorkType.onEvent(item, event('run_completed'))).toEqual({
      waits: [{ kind: 'timer', reason: 'noop_complete', deadlineTtlSec: 1 }],
    });
  });

  it('does not import process runners or perform async side effects', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/worktypes/noop/index.ts'), 'utf8');

    expect(source).not.toMatch(/from ['"]node:fs|from ['"]node:child_process|AgentPool|Runner/);
    expect(source).not.toContain('async ');
    expect(source).not.toContain('await ');
  });
});
