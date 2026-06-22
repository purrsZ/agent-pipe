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
    expect(source).toContain("store.claimThread(claimKey, 'managed'");
    expect(source).toContain('item.id, anchorMsgId)');
    // 群聊：用 reply_in_thread 把 probe 收进一个飞书话题（claim key = 话题 id）。
    expect(source).toContain('sender.replyCardInThread');
    expect(source).toContain('store.releaseThreadClaim(threadRoot)');
    expect(source).toContain('buildAnchorCard');
  });

  it('wires /req create + anchor claim through the requirement worktype (T1)', () => {
    const source = indexSource();

    expect(source).toContain('async function runRequirement');
    // /req creates a requirement-typed unit (the worktype registered in createWorkitemsRuntime).
    expect(source).toContain("type: 'requirement'");
    // same managed-claim + anchor-card path probe uses, keyed on the thread root.
    expect(source).toContain("store.claimThread(claimKey, 'managed'");
    expect(source).toContain('item.id, anchorMsgId)');
    // onRequirement closure is handed to the CommandHandler alongside onProbe/onDone.
    expect(source).toContain('void runRequirement(msg, opts)');
  });

  it('wires the HTML workbench server: adapter + 本人 token auth + lifecycle stop (T2)', () => {
    const source = indexSource();

    expect(source).toContain("from './workbench/server.js'");
    expect(source).toContain("from './workbench/auth.js'");
    expect(source).toContain("from './workitems/workbench-adapter.js'");
    expect(source).toContain('createWorkbenchAdapter');
    expect(source).toContain('createWorkbenchServer');
    // writes are 本人-only via the token auth helper.
    expect(source).toContain('createTokenAuth(config.workbench)');
    // gated by the enabled flag, bound to the configured host/port.
    expect(source).toContain('config.workbench.enabled');
    expect(source).toContain('workbenchServer.listen(config.workbench.port, config.workbench.host');
    // lifecycle: the server is handed to releaseResources so shutdown + crash guard close it.
    expect(source).toContain('workbenchServer,');
    expect(source).toContain('deps.workbenchServer?.close()');
  });

  it('wires the outbound progress bridge: a streaming card per run via ProgressCards (M2, merges WI-6)', () => {
    const source = indexSource();

    // M2: report回贴并入流式卡终态——不再有独立的 postReport closure / onReport 注入。
    expect(source).toContain("from './feishu/progress-cards.js'");
    expect(source).toContain('new ProgressCards');
    expect(source).toContain('progress: progressCards');
    expect(source).not.toContain('const postReport');
    expect(source).not.toContain('onReport:');
  });

  it('wires the post-commit status bridge: anchor refresh + terminal guard, failure card归流式卡 (WI-7 → M2)', () => {
    const source = indexSource();

    expect(source).toContain('postStatus');
    expect(source).toContain('onCommitted');
    expect(source).toContain('anchorAction');
    expect(source).toContain('updateCard');
    // M2: the observer no longer replies its own error card (failure card is the streaming
    // card's onRunEnd(failed) terminal patch), so index drops buildErrorCard entirely.
    expect(source).not.toContain('buildErrorCard');
    // WI-8: anchor refresh targets the anchor card's own id via getThreadAnchorByOwner,
    // not the thread root (which now keys routing / report replies).
    expect(source).toContain('getThreadAnchorByOwner');
    // dispatcher terminal guard + postStatus terminal check go through isTerminalStatus,
    // never `status===` (the latter is also caught by the wiring guard above).
    expect(source).toContain('isTerminalStatus');
  });
});
