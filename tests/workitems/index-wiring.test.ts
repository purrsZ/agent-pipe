import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

function indexSource(): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8');
}

describe('index workitems wiring', () => {
  it('exposes testable runtime helpers and wires noop through the container', () => {
    const source = indexSource();

    expect(source).toContain('export function createWorkitemsRuntime');
    expect(source).toContain("from './workitems/container.js'");
    expect(source).toContain("from './worktypes/noop/index.js'");
    expect(source).toContain("from './worktypes/noop/run-handler.js'");
    expect(source).toContain('createWorkitemsContainer');
    expect(source).toContain('registerNoop');
    expect(source).toContain('createNoopRunHandler');
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
});
