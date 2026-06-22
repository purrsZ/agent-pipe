import { describe, expect, it } from 'vitest';
import { PHASE } from '../../src/worktypes/requirement/phases.js';
import { checkpointGateLabel, checkpointRail } from '../../src/worktypes/requirement/lights.js';

describe('checkpointGateLabel (T3 灯标签)', () => {
  it('maps each checkpoint boundary to its 灯 + 边界文案', () => {
    expect(checkpointGateLabel(PHASE.contract)).toBe('灯① 理解→合同');
    expect(checkpointGateLabel(PHASE.design)).toBe('灯②(快) 合同→详设');
    expect(checkpointGateLabel(PHASE.split)).toBe('灯②(慢) 详设→拆解');
    expect(checkpointGateLabel(PHASE.deliver)).toBe('灯③ 集成验证→交付');
  });

  it('echoes an unknown boundary instead of throwing', () => {
    expect(checkpointGateLabel('requirement:理解')).toBe('requirement:理解');
  });
});

describe('checkpointRail (T3 4 灯 rail)', () => {
  it('marks passed ✓ / active ● / future ○ relative to the boundary', () => {
    // 灯① active: nothing passed yet
    expect(checkpointRail(PHASE.contract)).toBe('●灯①  ○灯②(快)  ○灯②(慢)  ○灯③');
    // 灯②慢 active: ①②快 passed, ③ future
    expect(checkpointRail(PHASE.split)).toBe('✓灯①  ✓灯②(快)  ●灯②(慢)  ○灯③');
    // 灯③ active: first three passed
    expect(checkpointRail(PHASE.deliver)).toBe('✓灯①  ✓灯②(快)  ✓灯②(慢)  ●灯③');
  });

  it('renders all-pending for an unknown boundary (never throws)', () => {
    expect(checkpointRail('requirement:理解')).toBe('○灯①  ○灯②(快)  ○灯②(慢)  ○灯③');
  });
});
