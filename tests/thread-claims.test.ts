import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

let tmpDir: string;
let store: Store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-thread-claims-'));
  store = new Store(path.join(tmpDir, 'db.sqlite'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('thread claims registry (WI-D)', () => {
  it('claim / get / release roundtrip', () => {
    store.claimThread('root-1', 'managed', 'owner-123');
    const c = store.getThreadClaim('root-1');
    expect(c?.owner_kind).toBe('managed');
    expect(c?.owner_id).toBe('owner-123');
    store.releaseThreadClaim('root-1');
    expect(store.getThreadClaim('root-1')).toBeUndefined();
  });

  it('re-claim overwrites the previous owner (upsert)', () => {
    store.claimThread('root-2', 'bridge', 'task-a');
    store.claimThread('root-2', 'managed', 'owner-9');
    const c = store.getThreadClaim('root-2');
    expect(c?.owner_kind).toBe('managed');
    expect(c?.owner_id).toBe('owner-9');
  });

  it('unclaimed root returns undefined', () => {
    expect(store.getThreadClaim('never-claimed')).toBeUndefined();
  });

  it('release of an unclaimed root is a no-op (no throw)', () => {
    expect(() => store.releaseThreadClaim('nope')).not.toThrow();
  });

  it('getThreadRootByOwner reverse-looks-up the managed claim (M1b WI-6)', () => {
    store.claimThread('anchor-1', 'managed', 'wi-1');
    expect(store.getThreadRootByOwner('wi-1')).toBe('anchor-1');
    expect(store.getThreadRootByOwner('wi-missing')).toBeUndefined();
  });

  it('getThreadRootByOwner ignores bridge claims', () => {
    store.claimThread('root-b', 'bridge', 'task-x');
    expect(store.getThreadRootByOwner('task-x')).toBeUndefined();
  });
});
