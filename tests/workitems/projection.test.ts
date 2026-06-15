import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeRollup, recomputeRollup } from '../../src/workitems/projection.js';
import { SystemClock } from '../../src/workitems/clock.js';
import { WorkitemsStore } from '../../src/workitems/store.js';
import { makeAssignment, makeWait, makeWorkItem } from '../helpers/workitems.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-projection-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('computeRollup', () => {
  it('freezes terminal status regardless of waits or running assignments', () => {
    expect(
      computeRollup({
        current: 'done',
        openWaitKinds: ['human'],
        hasRunningAssignment: true,
        hasEventsBeyondCreation: true,
      }),
    ).toEqual({ status: 'done', detail: null });
  });

  it('applies waiting and active priority rules', () => {
    expect(
      computeRollup({
        current: 'open',
        openWaitKinds: ['timer', 'agent', 'human'],
        hasRunningAssignment: true,
        hasEventsBeyondCreation: true,
      }),
    ).toEqual({ status: 'waiting', detail: 'human' });
    expect(
      computeRollup({
        current: 'open',
        openWaitKinds: ['agent', 'timer'],
        hasRunningAssignment: true,
        hasEventsBeyondCreation: true,
      }),
    ).toEqual({ status: 'active', detail: null });
    expect(
      computeRollup({
        current: 'open',
        openWaitKinds: ['agent', 'timer'],
        hasRunningAssignment: false,
        hasEventsBeyondCreation: true,
      }),
    ).toEqual({ status: 'waiting', detail: 'agent' });
    expect(
      computeRollup({
        current: 'open',
        openWaitKinds: ['timer'],
        hasRunningAssignment: false,
        hasEventsBeyondCreation: true,
      }),
    ).toEqual({ status: 'waiting', detail: 'timer' });
  });

  it('distinguishes never-started from empty-active items', () => {
    expect(
      computeRollup({
        current: 'open',
        openWaitKinds: [],
        hasRunningAssignment: false,
        hasEventsBeyondCreation: false,
      }),
    ).toEqual({ status: 'open', detail: null });
    expect(
      computeRollup({
        current: 'open',
        openWaitKinds: [],
        hasRunningAssignment: false,
        hasEventsBeyondCreation: true,
      }),
    ).toEqual({ status: 'active', detail: null });
  });
});

describe('recomputeRollup', () => {
  it('reads authoritative rows and stores the projected status', () => {
    const store = new WorkitemsStore(path.join(tmpDir, 'workitems.sqlite'), new SystemClock());
    store.insertWorkItem(makeWorkItem('wi-1'));
    store.insertAssignment(makeAssignment('as-1', 'wi-1'));
    store.insertWait(makeWait('wt-human', 'wi-1', { kind: 'human' }));
    store.insertWait(makeWait('wt-agent', 'wi-1', { kind: 'agent', originAssignmentId: 'as-1' }));
    store.appendEvent('wi-1', 1, 'workitem_created');
    store.appendEvent('wi-1', 2, 'assignment_created');

    expect(recomputeRollup(store, 'wi-1', 2000)).toEqual({ status: 'waiting', detail: 'human' });
    expect(store.getWorkItem('wi-1')!.status).toBe('waiting');
    expect(store.getWorkItem('wi-1')!.statusDetail).toBe('human');
    expect(store.getWorkItem('wi-1')!.updatedAt).toBe(2000);
    store.close();
  });
});
