// requirement worktype — phase vocabulary (worktypes layer; business words allowed, but
// this file stays pure: no async/await/fs/child_process). Phase names carry a `requirement:`
// prefix (like probe's `probe:looking`); they are opaque strings to the container.
//
// PIVOT（设计外置·实现聚焦）：设计（理解/合同/详设）已摘出 agent-pipe——由人在 Claude Code 用
// /spec-design 独立完成、产出各仓设计目录。agent-pipe 收缩为「拿着设计文档做实现 + 自测」的施工+
// 质检引擎。七相位四灯 → 五相位「两灯一 gate」：
//   立项 →[立项 gate]→ 拆解(owner 跨仓对账) → 并行实现 → 集成验证 →[灯③ 验收]→ 交付 →[灯④ 上线 close]

export const PHASE = {
  // 立项（intake）= 生命周期最前面一段：建专属群 → 引导者收齐前置料（含各仓设计目录）→ 立项 gate 放行。
  intake: 'requirement:立项',
  // 拆解（split）= 新主线第一个 owner 动作：读各仓设计的「外部方契约」节，拼凑 + 对账成需求层级的跨仓
  // 契约（全咬合 → 按仓分发施工；冲突/悬空 → raise 人）。砍掉的灯② 合同以这份对账契约的轻量形式长回来。
  split: 'requirement:拆解',
  implement: 'requirement:并行实现',
  integrate: 'requirement:集成验证',
  deliver: 'requirement:交付',
} as const;

export type RequirementPhase = (typeof PHASE)[keyof typeof PHASE];

// Fixed sequence (PIVOT §3). nextPhase walks it: 立项 →[立项 gate]→ 拆解 → 并行实现 → 集成验证 →[灯③]→ 交付.
export const PHASE_SEQUENCE: RequirementPhase[] = [
  PHASE.intake,
  PHASE.split,
  PHASE.implement,
  PHASE.integrate,
  PHASE.deliver,
];

export function nextPhase(current: string): RequirementPhase | undefined {
  const i = PHASE_SEQUENCE.indexOf(current as RequirementPhase);
  if (i < 0 || i >= PHASE_SEQUENCE.length - 1) return undefined;
  return PHASE_SEQUENCE[i + 1];
}

// 判断是否处于「立项」收料阶段。包成函数，让 index/bridge(kernel-exempt) 据它分流群内消息（收料 vs
// 普通追问）/ 出站卡（清单卡 vs 锚点卡），而不必在那些文件里写 `phase === …`（会被 wiring/红线扫到）。
export function isIntakePhase(phase: string): boolean {
  return phase === PHASE.intake;
}

// The phase boundaries that require a human checkpoint before being crossed (PIVOT「两灯一 gate」):
//   立项 gate 立项→拆解（料齐 + 各仓设计就位 + 确认开干，复用 checkpoint 机制但语义≠审设计）·
//   灯③ 集成验证→交付（验收）.
// (灯④ 交付→submit 是 NOT here — 它是 close_requested 驱动的 two-stage rest-in-non-terminal，§交付.)
export const CHECKPOINT_REQUIRED_BEFORE: string[] = [
  PHASE.split, // 立项 gate（立项→拆解）
  PHASE.deliver, // 灯③（集成验证→交付）
];

// internal-apis §7 — authoritative new event-kind list. The container does not interpret
// these; only requirementTransition switches on them. This array is the single source of
// truth for the anchorAction drift assertion (R24.AC-7 / data-model §8).
//
// PIVOT：砍合同变更引擎（contract_frozen/_patched/_change_*）与 spec-design 产物事件（design_ready）；
// owner 跨仓对账新增 reconcile_passed / reconcile_conflict（与 integration_check_* 同构：effect 产判定、
// worktype 据以推进或 raise 人）。
export const REQUIREMENT_EVENT_KINDS = [
  'checkpoint_reached',
  'checkpoint_decision',
  'worker_report',
  'integration_check_passed',
  'integration_check_failed',
  'reconcile_passed', // owner 跨仓对账：全咬合 → 拆解→并行实现
  'reconcile_conflict', // owner 跨仓对账：发现冲突/悬空 → raise 人（病历）
  'gatekeeper_passed', // 监工科层（C）：无跨仓外溢上报（含判小放行）→ owner assess
  'gatekeeper_big', // 监工科层（C）：跨仓外溢/疑则判大 → raise 人（病历）
  'intake_field_set', // 立项收料：每填一项一条（fold 出立项清单状态，gateReady 时 raise 立项 gate）
  'steer_directive', // WS-2 消息必达：steer_apply 解析包工头报告后 emit 的结构化指令（redo_reconcile/rework/raise_human/none）
] as const;

export type RequirementEventKind = (typeof REQUIREMENT_EVENT_KINDS)[number];
