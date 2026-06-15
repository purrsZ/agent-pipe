import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanArchitecture } from './helpers/architecture.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-architecture-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('architecture guard', () => {
  it('keeps the real source tree within workitems dependency boundaries', () => {
    expect(scanArchitecture(path.join(process.cwd(), 'src'))).toEqual([]);
  });

  it('detects import direction, kernel vocabulary, and phase interpretation violations', () => {
    write(
      'kernel.ts',
      `
        import { WorkitemsStore } from './workitems/store.js';
        const assignment = 'leaked';
      `,
    );
    write(
      'workitems/reducer.ts',
      `
        import { noopType } from '../worktypes/noop/index.js';
        export function comparePhase(item: { phase: string }) {
          return item.phase === 'done';
        }
      `,
    );
    write('worktypes/noop/index.ts', `export const noopType = {};`);
    write('workitems/store.ts', `export class WorkitemsStore {}`);

    expect(scanArchitecture(tmpDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'kernel.ts',
          rule: 'kernel-imports-upper-layer',
        }),
        expect.objectContaining({
          file: 'kernel.ts',
          rule: 'kernel-business-vocabulary',
        }),
        expect.objectContaining({
          file: 'workitems/reducer.ts',
          rule: 'workitems-imports-worktypes',
        }),
        expect.objectContaining({
          file: 'workitems/reducer.ts',
          rule: 'phase-interpreted-by-container',
        }),
      ]),
    );
  });
});
