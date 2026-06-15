# S2: 容器生命周期与状态投影

> Scope: 工作项外层生命周期（open→active⇄waiting→终态）、status rollup 投影、phase 不透明承诺、WorkType 接口与注册表、编程创建 API（含 dedupe 幂等与 open ≤3 enforce）
> AC: AC-2.1~2.13

---

## 需求（Step 1 产出）

### 概述

本组定义容器对所有工作类型的「最小公共语义」中与生死和展示相关的部分：工作项如何被创建（编程 API + 类型注册表 + 幂等键 + 并行上限）、外层生命周期如何流转与终结、status 如何作为 rollup 投影从权威状态（assignment/waits）聚合而来且不反向钳制执行、phase 作为不透明字符串的两条容器承诺。表结构细节归 G1，reducer 机制归 G3，效果执行归 G4，wait 到期动作归 G5，noop 实现归 G6。

### AC 列表

#### AC-2.1: 编程创建 API 创建工作项

**GIVEN** 类型注册表中已注册某 WorkType（如 noop）
**WHEN** 调用容器编程创建 API，提供 type、title、source（来源描述）
**THEN** 新工作项落库：status 初始为 open，phase 等于该类型 `initialPhase(item)` 的返回值，source 原样留存于溯源字段，并追加一条创建事件（kind 与 payload 可查）

#### AC-2.2: 未注册类型创建被拒

**GIVEN** 类型注册表中不存在 id 为 `'ghost'` 的 WorkType
**WHEN** 以 type='ghost' 调用创建 API
**THEN** 创建被拒绝并返回带类型未注册原因的错误，DB 中不产生任何工作项记录

#### AC-2.3: dedupe_key 幂等创建

**GIVEN** 已存在 (type='noop', dedupe_key='probe-0611') 的工作项
**WHEN** 再次以相同 type + dedupe_key 调用创建 API
**THEN** 不创建第二个工作项；查询该 (type, dedupe_key) 组合仅命中原工作项一条记录

#### AC-2.4: 无 dedupe_key 时不参与幂等

**GIVEN** 已存在一个未携带 dedupe_key 的 noop 工作项
**WHEN** 再次以相同 type + title、仍不携带 dedupe_key 创建
**THEN** 成功创建第二个独立工作项（两个不同 id 共存）

#### AC-2.5: open 工作项 ≤3 代码 enforce

**GIVEN** 已存在 3 个未达终态的工作项
**WHEN** 调用创建 API 创建第 4 个
**THEN** 创建被拒绝，返回包含「已达并行上限，请先收尾」语义的明确错误，DB 中不产生新记录

#### AC-2.6: 上限可配置且终态不计数

**GIVEN** 上限配置为 3，且已有 3 个工作项中的 1 个进入终态（done/failed/cancelled）
**WHEN** 再次调用创建 API
**THEN** 创建成功（终态项不占名额）；若将上限配置改为 4 重启后，4 个非终态共存时第 5 个才被拒绝

#### AC-2.7: 外层生命周期合法流转

**GIVEN** 一个 status=open 的工作项
**WHEN** 依次发生：首次推进 → 进入等待 → 等待消解 → 正常完结
**THEN** status 投影依次呈现 open → active → waiting → active → done，每次变化均可通过查询观测到

#### AC-2.8: rollup 投影固定优先级

**GIVEN** 同一工作项上同时存在：未消解的 human wait、运行中的 assignment、未消解的 agent wait、未消解的 timer wait
**WHEN** 计算 status 投影
**THEN** status 呈现 waiting(human)；依次消解 human wait、终结运行中 assignment、消解 agent wait 后，status 依次降级为 active → waiting(agent) → waiting(timer)

#### AC-2.9: 投影不反向钳制执行

**GIVEN** 工作项因 human wait 而 status=waiting(human)，同时另一个不受影响的 assignment 正在运行
**WHEN** 该 assignment 继续推进直至完成
**THEN** 容器不因 status 为 waiting 而暂停或拒绝该 assignment 的任何推进；期间 status 始终显示 waiting(human)

#### AC-2.10: 终态不可逆

**GIVEN** 工作项已处于 done（或 failed/cancelled）
**WHEN** 该工作项上再有任何事件到达或投影重算发生
**THEN** status 保持原终态不变，不回到 open/active/waiting（事件的具体处置机制归 G3，本 AC 仅断言投影终态稳定）

#### AC-2.11: phase 不假设单调——回退是普通转移

**GIVEN** 工作项 phase='b'
**WHEN** 类型的转移结果将 phase 改回 'a'（回退）
**THEN** 容器接受转移、无任何单调性校验或告警，并追加 `phase_changed {from:'b', to:'a', reason}` 事件，reason 来自转移声明

#### AC-2.12: phase 不解释——任意字符串原样存查

**GIVEN** 类型将 phase 设为任意非空字符串（如 `'阶段:7/验证'`）
**WHEN** 容器存储后再查询该工作项
**THEN** phase 原样返回、逐字节一致；容器层代码不存在依据 phase 取值的条件分支（静态可审查 + 任意值均不报错）

#### AC-2.13: WorkType 接口全签名与类型注册表

**GIVEN** 一个实现了 WorkType 全部九个成员（id、triggers、initialPhase、onEvent、isDecisionStale、topology、permissions、checkpoints、artifacts）的类型
**WHEN** 向注册表注册该类型，随后按 id 查找；再尝试以相同 id 重复注册
**THEN** 查找返回同一实现；缺少任一成员的实现无法通过 TypeScript 编译；重复注册同 id 被拒绝并报错

### Flow AC

#### FLOW-2.1: 工作项完整生命周期
- **路径**: 编程 API 创建 → 推进 active → 进入 waiting → 等待消解回 active → done
- **涉及 AC**: AC-2.1 -> AC-2.7 -> AC-2.8 -> AC-2.10
- **验证点**: 创建后 phase=initialPhase 且 status=open；每步转移后投影与权威状态一致；done 后投影冻结且事件序列完整记录全程
- **跨组**: Group 3（事件驱动转移）、Group 5（wait 消解）

#### FLOW-2.2: 幂等创建与上限计数协同
- **路径**: 带 dedupe_key 创建 → 同键重复创建（被幂等吸收） → 继续创建至上限 → 第 4 个被拒 → 收尾 1 个 → 再创建成功
- **涉及 AC**: AC-2.3 -> AC-2.5 -> AC-2.6
- **验证点**: 重复创建不占用并行名额（计数仍为 1）；上限拒绝不产生脏记录；终态释放名额立即生效
- **跨组**: 无

### Gaps

- [YELLOW] G-2.1: 「open 工作项 ≤3」的计数口径未明确——仅 status=open 还是全部非终态（open/active/waiting）？§9.1 语境是「并行工作项」，倾向按非终态计，需 Step 2 落定 — 口径不同会改变 AC-2.5/2.6 的判定边界
- [YELLOW] G-2.2: open 状态能否不经 active 直达终态（如创建后立即 cancel/失败）？§4.1 状态图未画该边 — 影响生命周期合法转移集合与取消语义
- [YELLOW] G-2.3: dedupe_key 冲突时 API 的返回语义未定——静默返回已存在工作项 vs 抛特定错误码。PRD 只承诺「防重复建项」 — 影响调用方（M4 触发器）的对接方式
- [YELLOW] G-2.4: 无运行中 assignment、无未消解 wait、又未达终态时的投影值未定义（仍是 open？还是 active？）——rollup 优先级表未覆盖「空活动」情形 — 影响 AC-2.7/2.8 的边界断言
- [WHITE] G-2.5: waiting 子类（human/agent/timer）在 status 字段的表示形态待选型 — 候选：status 单值 'waiting' + 子类查询时派生 / 复合字符串 'waiting:human' / status + 明细两字段
- [WHITE] G-2.6: 投影重算时机待选型 — 候选：每次状态转移事务内同步重算 / 查询时即时聚合；M0 单实例下两者皆可行，倾向事务内同步以便 status 列可直接索引查询

### PRD 校验（覆盖自查）

| PRD 锚点 | 要点 | 覆盖 AC |
|---|---|---|
| §4.1 外层状态机 + 五条公共语义 | 生命周期、rollup 优先级、不钳制执行 | AC-2.1, 2.7, 2.8, 2.9, 2.10 |
| §4.1 phase 两条承诺 | 不假设单调、不解释含义、phase_changed | AC-2.11, 2.12 |
| §4.5 WorkType 接口 | 九成员全签名、注册即接入 | AC-2.13, 2.2 |
| §4.7 触发器幂等 | UNIQUE(type, dedupe_key) 行为面 | AC-2.3, 2.4 |
| §9.1 并行上限 | ≤3 代码 enforce、可配置 | AC-2.5, 2.6 |
| §12 决策行（status 语义 / 状态机形态 / 并行上限 / 周期性工作） | 投影非权威、双层状态机、enforce、幂等建项 | AC-2.7~2.12, 2.5, 2.3 |

### UI 需求

不适用（has_ui=否，M0 无任何前端/卡片节点）。

---

## 设计（Step 2 追加）

### 对外接口

```ts
// src/workitems/types.ts —— WorkType 九成员全签名（§4.5 全量 → AC-2.13）
export interface WorkType {
  id: string;
  triggers: TriggerSpec;                                   // M0: { api: true }
  initialPhase(item: WorkItem): string;
  onEvent(item: WorkItem, ev: WorkItemEvent): Transition;  // 纯转移，禁 IO/await（→ S3）
  isDecisionStale(decision: Decision, eventsSince: WorkItemEvent[]): boolean;
  topology(item: WorkItem): 'solo' | 'owner-workers';
  permissions: PermissionProfile;                          // { mode: 'readonly' }，M0 无 enforce 面
  checkpoints: CheckpointPolicy;                           // M0: { requiredBefore: [] } 空策略
  artifacts: ArtifactSpec;                                 // { briefTemplate?, reportRequired: boolean }
}
export interface TriggerSpec { api: boolean }              // M1+ 再扩 command/webhook/cron
export interface PermissionProfile { mode: 'readonly' | 'write' }
export interface CheckpointPolicy { requiredBefore: string[] }
export interface ArtifactSpec { briefTemplate?: string; reportRequired: boolean }
export interface Decision {                                 // 结论决策载体（I-016 自 reducer.ts 归位类型层，免 types⇄reducer 文件环）
  refs?: { assignmentIds?: string[]; waitIds?: string[] };  // 结构检查输入（→ S3 AC-3.9/3.10）
  data?: unknown;                                           // 类型自用，容器不解释
}

// Transition —— onEvent 的唯一返回物（纯数据，时间一律相对值，绝对时刻由运行时以 Clock 换算）
export interface Transition {
  phase?: { to: string; reason: string };                  // → phase_changed 事件 (→ AC-2.11)
  terminal?: 'done' | 'failed' | 'cancelled';              // 仅类型可判终态
  dispatch?: AssignmentSpec[];                             // 事务内建 assignment 行 + run 效果（ADR-4）
  waits?: WaitSpec[];                                      // 事务内建 wait 行
  effects?: EffectDecl[];                                  // outbox 效果（事务外副作用）
}
export interface AssignmentSpec {
  role: 'owner'|'worker'|'solo'; repo?: string;
  deadlineTtlSec: number; wallclockCapSec: number;         // 必填正数（→ S5 AC-5.7）
  replacesAssignmentId?: string; retries?: number;
  brief?: string; payload?: unknown;
}
export interface WaitSpec {
  kind: 'human'|'agent'|'timer'; reason: string;
  deadlineTtlSec: number; originAssignmentId?: string;     // kind=agent 必填（→ G-5.3）
}
export interface EffectDecl { kind: string; payload?: unknown }

// 创建入参/出参（I-017 归位类型层：S2 api.createWorkItem 与 S3 reducer.bootstrapApply 共享，免 api⇄reducer 文件环）
export interface CreateInput {
  type: string; title: string; source: unknown;
  dedupeKey?: string; repos?: string[]; context?: unknown; // noop 参数走 context
}
export type CreateResult =
  | { created: true; item: WorkItem }
  | { created: false; item: WorkItem };                    // dedupe 命中静默返回既有项（→ G-2.3）

// src/workitems/registry.ts
export class WorkTypeRegistry {
  register(t: WorkType): void;          // 同 id 重复注册 throw（→ AC-2.13）
  get(id: string): WorkType | undefined;
}

// src/workitems/api.ts —— 容器编程门面（M0 唯一触发通道）
// CreateInput/CreateResult 定义于 types.ts（I-017 归位，见上方 types.ts 段）
export class WorkitemsApi {
  createWorkItem(input: CreateInput): CreateResult;        // 抛 TypeNotRegisteredError / OpenLimitError
  getWorkItem(id: string): WorkItem | undefined;
  listEvents(id: string): WorkItemEvent[];
  injectEvent(id: string, kind: string, payload?: unknown): void;  // 测试/未来触发器注入，经 reducer
  resolveWait(...)/renewWait(...)                          // 签名归 S5 设计节
}
```

### 内部结构

#### 1. 创建路径（→ AC-2.1, 2.2, 2.3, 2.4, 2.5, 2.6；FLOW-2.2）

```
createWorkItem(input):
  type = registry.get(input.type)            // 无 → TypeNotRegisteredError，不落库 (→ AC-2.2)
  reducer.bootstrapApply(draft):             // 单事务（崩溃无「有行无创建事件」窗口）：
    tx {
      if (input.dedupeKey && findByDedupe(...)) return { created:false, item }   // 先查后插
      if (countNonTerminal() >= cfg.maxOpen) throw OpenLimitError('已达并行上限，请先收尾')  // (→ AC-2.5/2.6)
      item = { id:'wi-'+uuid, status:'open', phase:type.initialPhase(draft), ... }
      insertWorkItem(item)                    // UNIQUE 兜底：并发竞态下捕获 SQLITE_CONSTRAINT 回查 (→ AC-2.3)
      seq=1 appendEvent('workitem_created', { source, title })                   // (→ AC-2.1)
      transition = type.onEvent(item, createdEvent)        // 类型决定初始动作（noop: dispatch）
      applyTransitionWrites(transition)        // 同事务（机制归 S3/S4）
      recomputeRollup(item)                    // (→ G-2.6)
    }
  post-commit: artifacts.initRepo(item.id)（git init 在事务外；崩溃由对账重建——G-4.4）
```

上限口径 = 全部非终态（→ G-2.1）；dedupe 命中不占名额（创建未发生）；终态项不计数（→ AC-2.6）。maxOpen 读 src/workitems/config.ts 的 `WORKITEMS_MAX_OPEN`（默认 3），改配置重启生效。

#### 2. rollup 投影（→ AC-2.7, 2.8, 2.9, 2.10；G-2.4/2.5/2.6）

```ts
// src/workitems/projection.ts —— 纯函数，单测主战场
export function computeRollup(input: {
  current: WorkItemStatus;                  // 终态直接原样返回（冻结，→ AC-2.10）
  openWaitKinds: WaitKind[];                // resolved_at IS NULL 的 waits
  hasRunningAssignment: boolean;
  hasEventsBeyondCreation: boolean;         // EXISTS(seq > 1)（→ G-2.4）
}): { status: WorkItemStatus; detail: WaitKind | null }
// 优先级：waiting(human) > active(有 running assignment) > waiting(agent) > waiting(timer)
//        > （空活动）hasEventsBeyondCreation ? active : open
```

重算入口 `recomputeRollup(item)` 在每次转移事务尾部同步执行（→ G-2.6），仅写 workitems.status/status_detail 两列。投影是派生值：任何执行决策（效果拾取、watchdog、onEvent 调度）都不读 status 列 ⇒ 结构上不可能反向钳制（→ AC-2.9）。终态由类型 Transition.terminal 显式进入，进入后 reducer 对后续事件只追加审计、不转移不重算（机制归 S3，→ AC-2.10）。

#### 3. phase 两条承诺（→ AC-2.11, 2.12）

phase 仅三处出现：创建时 `initialPhase()` 赋值、Transition.phase 整体替换 + 追加 `phase_changed {from,to,reason}` 事件（无单调性校验——回退即普通转移）、查询原样返回。容器代码无任何 `item.phase ===` 分支——「phase 只读写不比较」静态断言归属 S6 tests/architecture.test.ts 规则清单第 (5) 条（src/workitems/ 内 phase 标识符仅赋值/读取、不出现于比较/switch，→ AC-2.12 静态可审查面；规则定义见 S6 设计节内部结构 #5）。

#### 4. 生命周期合法转移集（→ AC-2.7；G-2.2）

权威状态变更只有两类：(a) 类型声明 terminal（任意非终态 → done/failed/cancelled，含 open 直达终态——G-2.2 允许）；(b) 其余全部经 rollup 派生（open/active/waiting 之间不存在「转移校验」，只有投影重算）。终态 → 任何状态：不存在路径（reducer 终态短路）。

### 依赖关系

依赖：S1 WorkitemsStore/ArtifactStore、S3 ReducerRuntime（bootstrapApply/injectEvent 经其入队）。被依赖：S6 noop 经 registry 注册、index.ts 经 WorkitemsApi 暴露能力；S5 watchdog 不读投影（只读 waits/assignments 权威表）。

### 数据契约

`WorkItem`（camelCase 域对象）、`Transition`、`Decision`、`CreateInput`/`CreateResult` 是容器公共契约，全部定义于 src/workitems/types.ts；worktypes 仅 import 该文件（依赖单向），api.ts/reducer.ts 亦各自单向 import types.ts——共享类型不在二者间互引（→ I-016/I-017）。错误类型：`TypeNotRegisteredError`、`OpenLimitError`（message 含「已达并行上限，请先收尾」语义，→ AC-2.5）。

### 测试策略

- 单元：computeRollup 全矩阵——四种活动共存的优先级降级序列（→ AC-2.8）、空活动两分支（→ G-2.4）、终态冻结（→ AC-2.10）；registry 重复注册拒绝（→ AC-2.13，缺成员由 tsc 编译期保证）。
- 集成：创建 happy path（status=open、phase=initialPhase、创建事件可查 → AC-2.1）；未注册类型拒绝且零落库（→ AC-2.2）；dedupe 幂等返回同 id（→ AC-2.3）/无键双建（→ AC-2.4）；上限拒绝→收尾→再建成功（FLOW-2.2，→ AC-2.5/2.6）；上限改配置生效——以 WORKITEMS_MAX_OPEN=4 重新装配容器，4 个非终态共存均创建成功、第 5 个才抛 OpenLimitError（→ AC-2.6 可配置分支）；open 直达 cancelled（→ G-2.2）；phase 任意字符串含 '阶段:7/验证' 逐字节回读 + 回退转移留 phase_changed（→ AC-2.11/2.12）。
- FLOW-2.1 全生命周期在 S6 端到端中以 noop 驱动覆盖，此处仅验投影面。

| 场景 | 类型 | 输入 | 期望 |
|---|---|---|---|
| 四类活动共存 | Happy | human+running+agent+timer | waiting(human)，依次消解降级 active→waiting(agent)→waiting(timer) |
| waiting 期间另一 assignment 推进 | Edge | human wait + running | 推进不被拒，status 恒 waiting(human) (→ AC-2.9) |
| 终态后注入事件 | Edge | done 后 injectEvent | status 不变，事件仅审计 (→ AC-2.10) |
| 第 4 个创建 | Error | 3 个非终态存在 | OpenLimitError，零脏记录 (→ AC-2.5) |
