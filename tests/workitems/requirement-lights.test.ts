import { describe, expect, it } from 'vitest';
import { checkpointGateLabel, checkpointRail } from '../../src/worktypes/requirement/lights.js';
import { PHASE } from '../../src/worktypes/requirement/phases.js';

// PIVOT「两灯一 gate」：立项 gate（立项→拆解）+ 灯③（集成验证→交付）。理解/合同/详设的灯①② 已随设计外置砍掉。
describe('checkpointGateLabel (灯标签)', () => {
  it('maps each checkpoint boundary to its 灯 + 边界文案', () => {
    expect(checkpointGateLabel(PHASE.split)).toBe('立项 立项→拆解');
    expect(checkpointGateLabel(PHASE.deliver)).toBe('灯③ 集成验证→交付');
  });

  it('echoes an unknown boundary instead of throwing', () => {
    expect(checkpointGateLabel('requirement:理解')).toBe('requirement:理解');
  });
});

describe('checkpointRail (两灯一 gate rail)', () => {
  it('marks passed ✓ / active ● / future ○ relative to the boundary', () => {
    // 立项 gate active: nothing passed yet
    expect(checkpointRail(PHASE.split)).toBe('●立项  ○灯③');
    // 灯③ active: 立项 gate passed
    expect(checkpointRail(PHASE.deliver)).toBe('✓立项  ●灯③');
  });

  it('renders all-pending for an unknown boundary (never throws)', () => {
    expect(checkpointRail('requirement:理解')).toBe('○立项  ○灯③');
  });
});
