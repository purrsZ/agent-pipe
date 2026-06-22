import { describe, expect, it } from 'vitest';
import { SystemClock } from '../../src/workitems/clock.js';
import { loadWorkitemsConfig } from '../../src/workitems/config.js';
import type { WorkItem, WorkItemEvent, WorkType } from '../../src/workitems/types.js';

function makeWorkItem(): WorkItem {
  return {
    id: 'wi-test',
    type: 'test',
    title: 'Test item',
    status: 'open',
    statusDetail: null,
    phase: 'initial',
    source: { kind: 'test' },
    dedupeKey: null,
    repos: [],
    context: null,
    wakePending: false,
    discardStreak: 0,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

describe('WorkType contract', () => {
  it('requires all nine WorkType members at compile time', () => {
    const complete: WorkType = {
      id: 'complete',
      triggers: { api: true },
      initialPhase: () => 'initial',
      onEvent: () => ({}),
      isDecisionStale: () => false,
      topology: () => 'solo',
      permissions: { mode: 'readonly' },
      checkpoints: { requiredBefore: [] },
      artifacts: { reportRequired: true },
    };

    // @ts-expect-error checkpoints is required by the WorkType contract.
    const missingCheckpoints: WorkType = {
      id: 'missing-checkpoints',
      triggers: { api: true },
      initialPhase: () => 'initial',
      onEvent: () => ({}),
      isDecisionStale: () => false,
      topology: () => 'solo',
      permissions: { mode: 'readonly' },
      artifacts: { reportRequired: true },
    };

    const ev: WorkItemEvent = {
      id: 1,
      workitemId: 'wi-test',
      seq: 1,
      kind: 'created',
      payload: null,
      createdAt: 1000,
    };

    expect(complete.initialPhase(makeWorkItem())).toBe('initial');
    expect(complete.onEvent(makeWorkItem(), ev)).toEqual({});
    expect(missingCheckpoints.id).toBe('missing-checkpoints');
  });
});

describe('workitems config', () => {
  it('loads safe defaults for M0 container tuning', () => {
    const cfg = loadWorkitemsConfig({});

    expect(cfg.maxOpen).toBe(3);
    expect(cfg.defaultDeadlineTtlSec).toBe(3600);
    expect(cfg.defaultWallclockCapSec).toBe(1800);
    expect(cfg.humanWaitTtlSec).toBe(86400);
    expect(cfg.watchdogIntervalMs).toBe(1000);
    expect(cfg.heartbeatTimeoutSec).toBe(60);
    expect(cfg.retryBudget).toBe(1);
    expect(cfg.maxWorkersPerItem).toBe(2);
  });

  it('overrides maxWorkersPerItem from env', () => {
    expect(loadWorkitemsConfig({ WORKITEMS_MAX_WORKERS_PER_ITEM: '4' }).maxWorkersPerItem).toBe(4);
    expect(() => loadWorkitemsConfig({ WORKITEMS_MAX_WORKERS_PER_ITEM: '0' })).toThrow(
      /WORKITEMS_MAX_WORKERS_PER_ITEM/,
    );
  });

  it('rejects non-positive numeric tuning values', () => {
    expect(() => loadWorkitemsConfig({ WORKITEMS_MAX_OPEN: '0' })).toThrow(/WORKITEMS_MAX_OPEN/);
    expect(() => loadWorkitemsConfig({ WORKITEMS_DEFAULT_DEADLINE_TTL_SEC: '-1' })).toThrow(
      /WORKITEMS_DEFAULT_DEADLINE_TTL_SEC/,
    );
    expect(() => loadWorkitemsConfig({ WORKITEMS_RETRY_BUDGET: '-1' })).toThrow(
      /WORKITEMS_RETRY_BUDGET/,
    );
  });

  it('provides an epoch-millisecond system clock', () => {
    const before = Date.now();
    const now = new SystemClock().now();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
