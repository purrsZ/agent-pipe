import type { Accent } from './types.js';

// 配色与领域常量 —— 逐字搬自原型 renderVals()，保证视觉一致。
export const C = {
  green: '#3fb950',
  amber: '#e3a008',
  red: '#f0533f',
  blue: '#5b9dff',
  violet: '#a371f7',
  dim: '#3f4654',
  muted: '#7d8694',
} as const;

const accentMap: Record<Accent, string> = {
  cyan: '#56c2e6',
  blue: '#5b9dff',
  violet: '#a371f7',
};

export function accentColor(accent: Accent): string {
  return accentMap[accent] ?? accentMap.cyan;
}

// PIVOT《设计外置·实现聚焦》：设计已摘出 agent-pipe → 5 阶段 +「两灯一 gate」，与需求 worktype 对齐。
export const STAGES = ['立项', '拆解', '并行实现', '集成验证', '交付'] as const;
export const LIGHTS = [
  { n: 'gate', label: '立项' },
  { n: '③', label: '验收' },
  { n: '④', label: '上线' },
] as const;

// 给 6 位 hex 颜色追加 2 位 alpha（如 '#3fb950' + '33'）。
export function hex(c: string, a: string): string {
  return c + a;
}
