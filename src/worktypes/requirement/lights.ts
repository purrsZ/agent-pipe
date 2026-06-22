import { PHASE } from './phases.js';

// Display helpers for the 4 检查点灯 (D-03). Pure (worktypes layer): no async/fs. The neutral
// feishu card builder can't interpret a phase string, so these map a checkpoint boundary
// (`checkpointBoundaryOf` output) to a human gate label + a compact 4-灯 rail, and index passes
// the rendered strings down to the kernel-neutral card.
//
//   灯①    理解 → 合同
//   灯②(快) 合同 → 详设
//   灯②(慢) 详设 → 拆解
//   灯③    集成验证 → 交付
const GATES: ReadonlyArray<{ boundary: string; light: string; from: string; to: string }> = [
  { boundary: PHASE.contract, light: '灯①', from: '理解', to: '合同' },
  { boundary: PHASE.design, light: '灯②(快)', from: '合同', to: '详设' },
  { boundary: PHASE.split, light: '灯②(慢)', from: '详设', to: '拆解' },
  { boundary: PHASE.deliver, light: '灯③', from: '集成验证', to: '交付' },
];

export function checkpointGateLabel(boundary: string): string {
  const g = GATES.find((x) => x.boundary === boundary);
  return g ? `${g.light} ${g.from}→${g.to}` : boundary;
}

// Compact rail: passed gates ✓, the active gate ●, future gates ○. An unknown boundary renders
// all-pending so the rail never throws on a stray value.
export function checkpointRail(boundary: string): string {
  const active = GATES.findIndex((g) => g.boundary === boundary);
  return GATES.map((g, i) => {
    const mark = active < 0 ? '○' : i < active ? '✓' : i === active ? '●' : '○';
    return `${mark}${g.light}`;
  }).join('  ');
}
