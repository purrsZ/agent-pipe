import { PHASE } from './phases.js';

// Display helpers for the「两灯一 gate」(PIVOT《设计外置·实现聚焦》). Pure (worktypes layer): no async/fs.
// The neutral feishu card builder can't interpret a phase string, so these map a checkpoint boundary
// (`checkpointBoundaryOf` output) to a human gate label + a compact rail, and index passes the
// rendered strings down to the kernel-neutral card.
//
//   立项 gate  立项 → 拆解（料齐 + 各仓设计就位，确认开干）
//   灯③       集成验证 → 交付（验收）
// (灯④ 交付→上线 是 close_requested 驱动的 rest-in-non-terminal，不是 checkpoint 边界，故不在此。)
const GATES: ReadonlyArray<{ boundary: string; light: string; from: string; to: string }> = [
  { boundary: PHASE.split, light: '立项', from: '立项', to: '拆解' },
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
