import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

function indexSource(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8');
}

describe('index workitems wiring', () => {
  it('exposes testable runtime helpers and wires probe + agent-run through the container', () => {
    const source = indexSource();

    expect(source).toContain('export function createWorkitemsRuntime');
    expect(source).toContain("from './workitems/container.js'");
    expect(source).toContain("from './worktypes/probe/index.js'");
    expect(source).toContain("from './worktypes/agent-run/run-handler.js'");
    expect(source).toContain('createWorkitemsContainer');
    expect(source).toContain('registerProbe');
    expect(source).toContain('createAgentRunHandler');
    expect(source).toContain('workitems.start()');
  });

  it('creates workitems only after the single-instance lock is acquired', () => {
    const source = indexSource();
    const lockIndex = source.indexOf('ensureSingleInstance(pidPath, logger)');
    const workitemsIndex = source.indexOf('createWorkitemsRuntime');

    expect(lockIndex).toBeGreaterThan(-1);
    expect(workitemsIndex).toBeGreaterThan(lockIndex);
  });

  it('stops the workitems container during releaseResources and crash guard cleanup', () => {
    const source = indexSource();

    expect(source).toContain('workitems.stop()');
    expect(source).toContain('installCrashGuard(logger, releaseResources)');
  });

  it('connects workitems backup as an extra job without moving kernel DB backup behavior', () => {
    const source = indexSource();

    expect(source).toContain('scheduleDailyBackup(');
    expect(source).toContain('workitems.backupJob()');
  });

  it('keeps index as wiring without interpreting workitem status or phase', () => {
    const source = indexSource();

    expect(source).not.toMatch(/workitems?\.[^\n]*(status|phase)|\b(status|phase)\b\s*={2,3}/);
  });

  it('wires /probe create + anchor claim and /done close + claim release (WI-4/WI-5)', () => {
    const source = indexSource();

    expect(source).toContain('async function runProbe');
    expect(source).toContain('async function runDone');
    expect(source).toContain('workitems.api.createWorkItem');
    expect(source).toContain('workitems.api.injectClose');
    expect(source).toContain('workitems.api.injectHumanMessage');
    // WI-8: claim keys on the thread root (rootId ?? messageId), NOT the anchor card id —
    // the anchor card id rides as the 4th arg for later updateCard (anchor refresh / close).
    expect(source).toContain("store.claimThread(msg.rootId ?? msg.messageId, 'managed'");
    expect(source).toContain('item.id, anchorMsgId)');
    expect(source).toContain('store.releaseThreadClaim(threadRoot)');
    expect(source).toContain('buildAnchorCard');
  });

  it('wires the outbound report bridge back to the IM thread (WI-6)', () => {
    const source = indexSource();

    expect(source).toContain('const postReport');
    expect(source).toContain('onReport: postReport');
    expect(source).toContain('getThreadRootByOwner');
    expect(source).toContain('buildReportCard');
  });

  it('wires the post-commit status bridge: failure card + anchor refresh + terminal guard (WI-7)', () => {
    const source = indexSource();

    expect(source).toContain('postStatus');
    expect(source).toContain('onCommitted');
    expect(source).toContain('anchorAction');
    expect(source).toContain('buildErrorCard');
    expect(source).toContain('updateCard');
    // WI-8: anchor refresh targets the anchor card's own id via getThreadAnchorByOwner,
    // not the thread root (which now keys routing / report replies).
    expect(source).toContain('getThreadAnchorByOwner');
    // dispatcher terminal guard + postStatus terminal check go through isTerminalStatus,
    // never `status===` (the latter is also caught by the wiring guard above).
    expect(source).toContain('isTerminalStatus');
  });
});
