import { describe, expect, it } from 'vitest';
import { runOptionsFingerprint } from '../../src/agents/types.js';

describe('runOptionsFingerprint (D-21: writableDirs in the fingerprint)', () => {
  it('collapses the default/full path to empty (zero regression)', () => {
    expect(runOptionsFingerprint(undefined)).toBe('');
    expect(runOptionsFingerprint({})).toBe('');
    expect(runOptionsFingerprint({ permission: { mode: 'full' } })).toBe('');
  });

  it('a write profile with a changed dir set yields a changed fingerprint', () => {
    const a = runOptionsFingerprint({ permission: { mode: 'write' }, writableDirs: ['/wt/x'] });
    const b = runOptionsFingerprint({ permission: { mode: 'write' }, writableDirs: ['/wt/y'] });
    expect(a).not.toBe('');
    expect(a).not.toBe(b); // changing the worktree forces a runner rebuild (no stale --add-dir)
  });

  it('is order-insensitive over writableDirs', () => {
    const a = runOptionsFingerprint({ permission: { mode: 'write' }, writableDirs: ['/a', '/b'] });
    const b = runOptionsFingerprint({ permission: { mode: 'write' }, writableDirs: ['/b', '/a'] });
    expect(a).toBe(b);
  });

  it('readonly still fingerprints distinctly from full', () => {
    expect(runOptionsFingerprint({ permission: { mode: 'readonly' } })).not.toBe('');
  });
});
