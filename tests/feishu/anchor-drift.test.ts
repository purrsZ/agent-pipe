import { describe, expect, it } from 'vitest';
import { anchorAction } from '../../src/feishu/card.js';
import { REQUIREMENT_EVENT_KINDS } from '../../src/worktypes/requirement/phases.js';

// R24.AC-7 / R19.AC-5 drift guard: every requirement event kind (the authoritative list in
// phases.ts) MUST get an explicit anchor-refresh decision from anchorAction — never silently
// dropped. The current anchorAction refreshes (update:true) on any non-terminal kind, so each
// requirement event refreshes the需求 anchor card. This test fails if anchorAction is ever
// changed to stop refreshing on a requirement kind, OR a new kind is added to the list that
// anchorAction no longer covers.

describe('anchorAction ⇄ REQUIREMENT_EVENT_KINDS (no drift)', () => {
  it('every requirement event kind refreshes the anchor (explicit decision, not silent)', () => {
    for (const kind of REQUIREMENT_EVENT_KINDS) {
      const decision = anchorAction(kind, false);
      // a defined refresh decision exists for the kind …
      expect(typeof decision.update).toBe('boolean');
      // … and requirement progress events refresh the anchor card.
      expect(decision.update).toBe(true);
    }
  });

  it('the authoritative list is non-empty and matches the PIVOT count (8 + 监工 gatekeeper_passed/_big = 10)', () => {
    expect(REQUIREMENT_EVENT_KINDS.length).toBe(10);
  });
});
