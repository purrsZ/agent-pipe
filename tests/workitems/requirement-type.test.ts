import { describe, expect, it } from 'vitest';
import type { WorkItemEvent } from '../../src/workitems/types.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';
import { registerRequirement, requirementWorkType } from '../../src/worktypes/requirement/index.js';
import { WorkTypeRegistry } from '../../src/workitems/registry.js';
import { makeWorkItem } from '../helpers/workitems.js';

function ev(kind: string, payload: unknown = {}): WorkItemEvent {
  return { id: 1, workitemId: 'wi-1', seq: 1, kind, payload, createdAt: 1000 };
}

const t = requirementWorkType;

describe('requirement WorkType definition', () => {
  it('is an owner-workers write type with the 4-light requiredBefore boundaries', () => {
    expect(t.id).toBe('requirement');
    expect(t.topology(makeWorkItem('wi-1'))).toBe('owner-workers');
    expect(t.permissions).toEqual({ mode: 'write' });
    expect(t.initialPhase(makeWorkItem('wi-1'))).toBe(PHASE.understand);
    expect(t.checkpoints.requiredBefore).toEqual([
      PHASE.contract,
      PHASE.design,
      PHASE.split,
      PHASE.deliver,
    ]);
    expect(t.artifacts.reportRequired).toBe(true);
  });

  it('registers into a registry', () => {
    const reg = new WorkTypeRegistry();
    registerRequirement(reg);
    expect(reg.get('requirement')).toBe(t);
  });
});

describe('requirement lifecycle transitions', () => {
  it('creation enters 理解 and dispatches an owner', () => {
    const out = t.onEvent(makeWorkItem('wi-1'), ev('workitem_created'));
    expect(out.phase).toEqual({ to: PHASE.understand, reason: 'created' });
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner' });
  });

  it('灯① — owner done in 理解 raises a checkpoint wait, NOT a phase change', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.understand });
    const out = t.onEvent(item, ev('run_completed', { role: 'owner' }));
    expect(out.phase).toBeUndefined();
    expect(out.waits?.[0]).toMatchObject({ kind: 'human', reason: `checkpoint:${PHASE.contract}` });
  });

  it('灯① approved advances 理解 → 合同 and dispatches design owner', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.understand });
    const out = t.onEvent(item, ev('wait_resolved', { decision: { approved: true } }));
    expect(out.phase).toEqual({ to: PHASE.contract, reason: 'checkpoint_approved' });
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner' });
  });

  it('灯① rejected stays in 理解 and re-dispatches the owner', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.understand });
    const out = t.onEvent(item, ev('wait_resolved', { decision: { approved: false } }));
    expect(out.phase).toBeUndefined();
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner' });
  });

  it('split owner done enters 并行实现 and fans out one worker per repo, parented to the owner', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.split, repos: ['repo-a', 'repo-b'] });
    const out = t.onEvent(item, ev('run_completed', { role: 'owner', assignmentId: 'as-owner' }));
    expect(out.phase).toEqual({ to: PHASE.implement, reason: 'split_done' });
    expect(out.dispatch).toHaveLength(2);
    for (const d of out.dispatch ?? []) {
      expect(d).toMatchObject({ role: 'worker', parentAssignmentId: 'as-owner' });
    }
    expect(out.dispatch?.map((d) => d.repo).sort()).toEqual(['repo-a', 'repo-b']);
  });

  it('last worker (runningWorkers===0) wakes an owner to assess; owner done advances to 集成验证', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['repo-a'] });
    // single repo / last worker: the container injects runningWorkers:0 (absent ⇒ 0 too).
    const onWorker = t.onEvent(item, ev('run_completed', { role: 'worker', runningWorkers: 0 }));
    expect(onWorker.phase).toBeUndefined();
    expect(onWorker.dispatch?.[0]).toMatchObject({ role: 'owner' });

    const onOwner = t.onEvent(item, ev('run_completed', { role: 'owner' }));
    expect(onOwner.phase).toEqual({ to: PHASE.integrate, reason: 'workers_done' });
  });

  it('T4: a non-last worker (runningWorkers>0) rests — no owner assess until the batch is in', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['repo-a', 'repo-b'] });
    // a sibling worker is still running → do nothing, wait for it.
    const early = t.onEvent(item, ev('run_completed', { role: 'worker', runningWorkers: 1 }));
    expect(early).toEqual({});
    // the last worker (no siblings left) wakes the owner exactly once.
    const last = t.onEvent(item, ev('run_completed', { role: 'worker', runningWorkers: 0 }));
    expect(last.dispatch?.[0]).toMatchObject({ role: 'owner' });
  });

  it('T4: a worker conclusion with no runningWorkers field is treated as the last (back-compat)', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement, repos: ['repo-a'] });
    const out = t.onEvent(item, ev('run_completed', { role: 'worker' }));
    expect(out.dispatch?.[0]).toMatchObject({ role: 'owner' });
  });

  it('T4: in 集成验证 a fix worker re-checks integration only once the whole fix batch is in', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate });
    expect(t.onEvent(item, ev('run_completed', { role: 'worker', runningWorkers: 1 }))).toEqual({});
    expect(
      t.onEvent(item, ev('run_completed', { role: 'worker', runningWorkers: 0 })).effects?.[0],
    ).toMatchObject({ kind: 'integration_check' });
  });

  it('灯③ — integration_check_passed in 集成验证 raises the delivery checkpoint', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate });
    const out = t.onEvent(item, ev('integration_check_passed'));
    expect(out.phase).toBeUndefined();
    expect(out.waits?.[0]).toMatchObject({ reason: `checkpoint:${PHASE.deliver}` });
  });

  it('灯③ approved advances 集成验证 → 交付 and rests (no auto MR work)', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.integrate });
    const out = t.onEvent(item, ev('wait_resolved', { decision: { approved: true } }));
    expect(out.phase).toEqual({ to: PHASE.deliver, reason: 'checkpoint_approved' });
    expect(out.dispatch).toBeUndefined();
  });

  it('灯④ — close in 交付 terminates done; elsewhere close is inert', () => {
    expect(
      t.onEvent(makeWorkItem('wi-1', { phase: PHASE.deliver }), ev('close_requested')),
    ).toEqual({ terminal: 'done' });
    expect(
      t.onEvent(makeWorkItem('wi-1', { phase: PHASE.understand }), ev('close_requested')),
    ).toEqual({});
  });

  it('/cancel raises a confirm wait; a cancel decision then terminates cancelled', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.implement });
    const confirm = t.onEvent(item, ev('human_message', { text: '/cancel' }));
    expect(confirm.waits?.[0]).toMatchObject({ reason: 'cancel_confirm' });

    const cancelled = t.onEvent(
      item,
      ev('wait_resolved', { decision: { approved: true, payload: { action: 'cancel' } } }),
    );
    expect(cancelled).toEqual({ terminal: 'cancelled' });
  });

  it('a plain wait_resolved (no decision) does not advance phase (救场 resolve)', () => {
    const item = makeWorkItem('wi-1', { phase: PHASE.understand });
    expect(t.onEvent(item, ev('wait_resolved', { reason: 'rescued' }))).toEqual({});
  });

  it('isDecisionStale is never-stale in the skeleton (Stage 4 contract diff)', () => {
    expect(t.isDecisionStale({ data: {} }, [])).toBe(false);
  });
});
