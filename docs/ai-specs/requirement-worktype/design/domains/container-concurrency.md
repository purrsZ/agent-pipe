# Domain: container-concurrency

> 层：workitems（容器层，守红线·不解释业务）。
> 本域是整个 requirement 改造**最凶险**的一块：多工人真并行的"在途数口径 + 拦截点 + abort 粒度 + 崩溃恢复粒度"全在这里。口径错就超放/漏放，恢复粒度错就只恢复第一个工人、其余静默吞掉。
> 硬底线：本域所有改造完成后 **probe/noop（solo 拓扑）行为逐字节不变**（CI 回归绿）。

## 领域职责（负责什么 / 不负责什么）

**负责**：
- 单飞门按 `role`/`topology` 分流（`reducer.ts:603-610`）——owner 单飞、worker 受上限、replacement 绕单飞门但不绕上限。
- "在途工人数"口径：按 DB `status='running'` 且 `role='worker'` 的 assignment 计数（reducer apply 内强一致），**不**用 effect 层 inflight Map（那是 post-commit 才更新的运行时态）。
- 批量 dispatch 逐个累加在途计数判入门（防同帧 N 个各读旧快照双双放行超放）。
- `releaseWakePending` 在 owner-workers 拓扑下按 role/排队信息补派对应 worker（不再单条 solo）。
- effect 层 `inflight` 键 `workitemId → assignmentId` 的连锁改造（6+ 处），实现 per-assignment 的并发执行与 per-assignment abort。
- 父子链 `parentAssignmentId` 的写入（owner assignment id 写进 worker `parent_id`）与基本消费。
- Owner 批量唤醒窗口 `(lastOwnerRunEffectSeq, currentOwnerRunEffectSeq]`——owner 运行期间到达的事件归入下一批，不漏不重。
- 多 worker + replacement 同时在途的崩溃恢复：`recoverRun`/`recoverRunning` 早退条件从 workitem 粒度降到 per-assignment 粒度。
- noop 夹具扩展（注入 owner-workers 拓扑 / 多 role dispatch / checkpoints / failAt+failCount）专打并发路径的回归锁定。

**不负责**：
- checkpoint gate 的 worktype 侧拦截逻辑（→ checkpoint-gate 域；本域只保证容器侧 `mergeTransitions`/`applyTransitionWrites` 不变量不被破坏）。
- worker run handler 的 prompt/write 档/worktree/自测硬门具体实现（→ worker-runtime 域；本域只提供 per-assignment inflight + abort + 恢复编排）。
- 合同结构 diff / isDecisionStale 纯函数实现（→ contract-engine 域）。
- 7 phase onEvent 的业务转移（→ requirement-statemachine 域）。
- 表结构/迁移/`countRunningWorkers` 查询 SQL 与索引、artifact 布局（→ data-model 域；本域**调用**这些查询，定义在 data-model）。
- 父子链的**级联 abort / 批次归属**高级消费语义（→ requirement-statemachine 域消费，本域只保证写入正确 + 提供反查砖）。

## 核心概念（本域特有）

- **单飞门（chokepoint）**：`insertDispatchOrWake`（`reducer.ts:588-643`）是"every dispatch path"的唯一收口。现状三段与拦截一律命中即 `wakePending:true`，**不读 role**。本域把它升级成 topology 感知的分流器。
- **在途工人数（DB 口径）**：`status='running' AND role='worker'` 的 assignment 计数。区别于 effect 层 `inflight` Map（运行时态、post-commit 才更新）。**这是本域最核心的口径裁决**：并发判定必须用 DB 口径（reducer apply 内强一致），否则同帧并发会读到旧值超放。
- **本批已放行数（in-memory accumulator）**：同一 owner transition 一次 dispatch N 个 worker 时，reducer 在内存里逐个累加已放行计数，判据 = `countRunningWorkers() + 本批已放行数 < maxWorkersPerItem`。
- **inflight 键 = assignmentId**：effect 层 `inflight` Map 的键从 workitemId 改 assignmentId（值 `{effectId, controller}`），是 per-assignment 并发 + per-assignment abort 的物理前提。
- **owner 单飞 ≠ inflight 键**：owner 的单飞**靠 reducer 单飞门按 role 分流**（owner run 在途即拦），**不靠** inflight 键。inflight 键改了之后 owner 单飞语义不依赖它。
- **Owner 批量唤醒窗口**：左开右闭半开区间 `(lastOwnerRunEffectSeq, currentOwnerRunEffectSeq]`，对齐 `eventsSince` 排他边界；owner 运行期间到达的事件锚到**下一次** owner run 起点 seq。
- **per-assignment 恢复粒度**：崩溃恢复时"列某 workitem 全部 running effect 并按 assignment 逐个恢复"，早退判定降到 assignmentId/effectId 粒度。
- **空态退化 solo**：`理解` phase worker 数 = 0、owner 单飞，owner-workers 分流退化为 solo 语义不报错（worker 计数查询遇空集返 0）。

## 数据契约（TypeScript 接口）

> 本域引用的新增符号签名一律在 internal-apis.md 登记，本文件不就地重写签名。

- `AssignmentSpec.parentAssignmentId?`（启用父子链，替换 `reducer.ts:616` 恒写 null）——见 internal-apis.md §2.1。
- `countRunningWorkers(workitemId): number`（DB 口径在途工人数查询）——定义归属 data-model，本域调用，见 internal-apis.md §2.2。
- 单飞门改造（topology 感知分流）——见 internal-apis.md §2.3。
- `releaseWakePending` 改造（按 role 补派）——见 internal-apis.md §2.4。
- Owner 批量唤醒窗口（半开区间组批）——见 internal-apis.md §2.5。
- effect `inflight` 键 `workitemId → assignmentId`（连锁 6+ 处）——见 internal-apis.md §3.1。
- per-assignment 崩溃恢复（早退条件降粒度）——见 internal-apis.md §3.2。
- per-assignment 并发恢复所需查询（"列某 workitem 全部 running effect 按 assignment 逐个恢复"）——定义归属 data-model，见 internal-apis.md（data-model 域登记的 `listInflightEffects` per-assignment 视图）。

复用现有资源（不重复定义）：
- [insertDispatchOrWake 单飞门](../codebase-findings.md#res-insertdispatchorwake)（唯一 dispatch 收口）。
- [isRunClass / hasInflightRunEffect / findInflightRunEffectForAssignment](../codebase-findings.md#res-isrunclass)（并发判据基石；`findInflightRunEffectForAssignment` 已是 per-assignment 粒度，per-assignment abort 直接复用）。
- [EffectRuntime.inflight + executeEffect + poke/drainOne](../codebase-findings.md#res-inflight)（真并行最大改造点）。
- [startupRecovery / recoverRun / recoverRunning](../codebase-findings.md#res-startuprecovery)（崩溃恢复编排）。
- [reducer 纯转移保证 + 关键不变量](../codebase-findings.md#res-reducer-purity)（tx 边界 / fresh nextSeq / terminal drop 同帧 dispatch）。
- [ReducerRuntimeDeps](../codebase-findings.md#res-reducerdeps)（`cfg` 注入 `maxWorkersPerItem`、`isRunClass` 注入）。
- [redispatchOrEscalate](../codebase-findings.md#res-redispatchorescalate)（replacement dispatch 路径，role 继承）。
- [noop 故障/心跳注入夹具](../codebase-findings.md#res-noop-fixture)（回归夹具扩展基石）。

## 涵盖的 AC（Sensor2 校验依据）

### R01 多工人真并行调度（10 条全覆盖）
- **R01.AC-1**：owner 派发多个 `role:'worker'` 的 dispatch THEN 为每个 worker 各创建 assignment 各起 run effect、**并发执行**（不被单飞门拦成 wakePending）。
- **R01.AC-2**：N 个 worker run 在途时各自维护独立 inflight（按 assignmentId）与独立 AbortController。
- **R01.AC-3**：owner run 单飞（同一时刻至多一个 owner run 在途）。
- **R01.AC-4（回补覆盖）**：判定 worker 并发上限按 **DB `status=running` 且 `role=worker` 的 assignment 计数**（reducer apply 内强一致，不用 inflight Map post-commit 运行时态），`< maxWorkersPerItem` 才放、否则转 wakePending。〔Gate3-C01〕
- **R01.AC-5**：取消/超时一个 worker 时只 abort 该 worker 的 run，不误伤同 workitem 其它在途 worker。
- **R01.AC-6**：replacement assignment 与多 worker 同时在途时纳入 worker 并发上限计数（replacement 绕单飞门但不绕上限）。
- **R01.AC-7（error/零回归）**：`topology()` 返回 `'solo'`（probe/noop）时保持原单飞行为逐字节不变（CI 回归绿）。
- **R01.AC-8（回补新增）**：同一 owner transition 一次 dispatch N 个 worker 时**逐个累加在途计数**判入门（不让每个各读同一份旧快照双双放行超放）。
- **R01.AC-9（回补新增）**：被 wakePending 排队的 worker 在 owner-workers 拓扑下释放时**按 role/排队信息补派对应 worker**，不再单条 `defaultDispatchSpec(role:solo)`。
- **R01.AC-10（回补新增·空态）**：`理解` phase（worker 数=0、owner 单飞）时 owner-workers 分流退化为 solo 语义不报错（worker 计数查询遇空集返 0）。〔Gate3-C04〕

### R02 Owner 协调与重建（父子链/批量唤醒窗口 3 条）
- **R02.AC-2**：owner 派发 worker 时把 owner 当前 assignment id 写入 worker assignment 的 `parent_id`（启用父子链）。
- **R02.AC-3（回补覆盖）**：owner 唤醒批量带入事件取 **`(lastOwnerRunEffectSeq, currentOwnerRunEffectSeq]` 半开区间**（左开右闭，对齐 eventsSince 排他边界），一次唤醒不漏不重。
- **R02.AC-7（回补新增）**：事件在 owner 本次 run **运行期间**到达时**归入下一批**（锚到下次 owner run 起点 seq），保证不漏不重；配 noop 夹具回归"owner 运行中 worker 完成"时序。〔Gate3-C02〕

> 注：R02 的 AC1/AC4/AC5/AC6（结构化快照权威 / journal 冲突 / journal 校验门 / journal 缺失判失败）归 requirement-statemachine 域，不在本域。

### R23 并发一致性 + noop 夹具回归（4 条全覆盖）
- **R23.AC-1**：N 个 worker 并发完成 → 各 enqueue `run_completed` → 串行 apply → 触发 Owner 唤醒 THEN 证明这批事件**不漏不重**（worker 在 Owner 运行期间完成的事件归入下一批）。
- **R23.AC-2**：replacement 与多 worker run 同时在途时在 `startupRecovery` 重建在途 effect、按 assignment 恢复 abort，覆盖这些组合。
- **R23.AC-3（edge）**：回归测试用扩展的 noop 夹具（注入 topology owner-workers / dispatch 多 role / checkpoints / failAt+failCount 编排失败序列）专打并发路径。
- **R23.AC-4（回补覆盖）**：`recoverRun/recoverRunning` 早退条件从 workitem 粒度改 **assignmentId/effectId 粒度**（否则同 workitem 多 worker 崩溃恢复只恢复第一个、其余静默吞掉）；noop 夹具专锁"同 workitem 多 worker **全部**恢复"断言。〔Gate5-C09〕

## 设计细节（按功能点分节）

### 5.1 单飞门按 role/topology 分流（R01.AC-1/3/4/6/7/8/10）

改造点：[insertDispatchOrWake](../codebase-findings.md#res-insertdispatchorwake) 的单飞门三段与（`reducer.ts:603-610`）。现状：`!spec.replacesAssignmentId && isRunClass('run') && hasInflightRunEffect(item.id)` 命中即 `wakePending:true` 并 return，**不读 role**。改造为 topology 感知（详见 internal-apis.md §2.3）：

- **topology()==='solo'（probe/noop）**：维持原三段与逐字节不变。这是零回归红线——**新逻辑必须包在 `topology==='owner-workers'` 分支里，solo 分支走原路径**，确保 CI 回归绿（R01.AC-7）。
- **topology()==='owner-workers' 且 `spec.role==='owner'`**：检"有 owner run 在途"才拦（owner 单飞，R01.AC-3）。在途 owner 判定 = 在途 run effect 中存在 `role='owner'` 的 assignment（可用 `findInflightRunEffectForAssignment` 反查思路 / DB 口径查 `status=running AND role=owner`）。owner 单飞**不靠 inflight 键**（inflight 键改 assignmentId 后 owner 不再天然单飞），靠这里 role 分流显式拦。
- **topology()==='owner-workers' 且 `spec.role==='worker'`**：判 `countRunningWorkers(item.id) + 本批已放行数 < maxWorkersPerItem` 才放，否则转 wakePending（R01.AC-4/AC-8）。
- **replacement（`replacesAssignmentId` 非空）**：现状整条短路绕门。改造后 replacement **仍绕单飞门**（破坏性返工要立即重派），但 **worker 角色的 replacement 必须纳入上限计数**（R01.AC-6）——即上限判定的"在途 worker 数"含 replacement，replacement 绕的是"单飞拦截"不是"上限计数"。

**在途数口径裁决（最凶险，R01.AC-4）**：必须用 `countRunningWorkers`（DB `status=running AND role=worker`，apply 内强一致），**禁用** effect 层 `inflight.size`（post-commit 才更新，并发同帧读旧值会超放）。判定细则见 design-detail.md §6"在途工人数口径"表（DB 口径 ✅ / inflight Map ❌）。

**批量累加（R01.AC-8）**：同一 owner transition 的 `dispatch: AssignmentSpec[]` 数组被 reducer 逐条过单飞门时，每放行一个 worker 就把内存累加器 +1，下一条用 `countRunningWorkers() + accumulator` 判。**绝不让每条各读同一份 `countRunningWorkers()` 快照**（那样 N 条都读到同一个低值会双双放行超放）。

**空态退化（R01.AC-10）**：`理解` phase 无 worker，`countRunningWorkers` 遇空集返 0，owner-workers 分流自然退化为"只 owner 单飞"的 solo 语义，不报错、不抛。这要求 `countRunningWorkers` 对空 workitem 返 0（data-model 域保证）。

⚠️ 红线：本域所有判定**禁出现 phase 比较**（`phase ==`/`switch(phase)`，CI 拦 workitems 层）；分流只读 `topology()` 返回值与 `spec.role`，不读 phase 名。

### 5.2 effect 层 inflight 键 workitemId→assignmentId（R01.AC-2/5）

改造点：[EffectRuntime.inflight](../codebase-findings.md#res-inflight)（`effects.ts:48` Map 定义 + 连锁 6+ 处）。详见 internal-apis.md §3.1。

键从 workitemId 改 assignmentId，值仍 `{effectId, controller}`。连锁改造点（漏一处即 worker 互相覆盖/恢复漏项）：
- `poke` 守卫（`effects.ts:66`）：现状 `inflight.has(workitemId)` 阻止第二个 effect → 改为按 assignmentId 判（允许同 workitem 多 assignment 并发）。
- `drainOne` 守卫（`:168,175`）：现状"有 running 就早退""只取一个 pending" → 改为允许并发拉起多个不同 assignment 的 pending effect（受 reducer 单飞门已分流过，effect 层不再二次卡上限）。
- `executeEffect` finally delete（`:229`）：`inflight.delete(workitemId)` → `delete(assignmentId)`。
- `findInflight` 反查（`:334`）：按 assignmentId 反查。
- `recoverRun`/`recoverRunning` 早退（`:78,94`）：见 §5.6。

**per-assignment abort（R01.AC-2/5）**：每 worker 独立 AbortController 存在 inflight[assignmentId].controller。取消/超时一个 worker 时只 `abort` 该 assignmentId 的 controller，不误伤同 workitem 其它在途 worker。复用 `findInflightRunEffectForAssignment`（已是 per-assignment 粒度）定位目标。

**owner 单飞保持（R01.AC-3）**：inflight 键改后 owner 不再靠"一 workitem 一 inflight"天然单飞——单飞改由 §5.1 reducer 单飞门 role 分流保证。这两处必须配套改，单独改 inflight 键不改单飞门会让 owner 也并发。

### 5.3 父子链 parentAssignmentId 写入消费（R02.AC-2）

改造点：[insertDispatchOrWake](../codebase-findings.md#res-insertdispatchorwake) 写 assignment 处（`reducer.ts:616` 现恒写 `parent_id=null`，是死列）。详见决策 D-19、internal-apis.md §2.1。

- `AssignmentSpec` 增 `parentAssignmentId?`（owner transition dispatch worker 时由 worktype 填入 owner 当前 assignment id）。
- `insertDispatchOrWake` 把 `spec.parentAssignmentId` 写入 assignment 的 `parent_id`（替换恒 null）。
- 提供基本反查砖（按 parent_id 列 owner 的子 worker），供 requirement-statemachine 域做批次归属 / 级联 abort 消费。本域只负责**写入正确 + 反查可用**，高级消费语义在 statemachine 域。

⚠️ schema 有列 ≠ 逻辑就绪（codebase-findings 历史踩坑："parent_id 是死列"）。要补完整写入 + 至少基本消费两端，不复活 v1"父子链免费拿"的乐观假设。

### 5.4 releaseWakePending 按 role 补派（R01.AC-9）

改造点：`releaseWakePending`（`reducer.ts:645-649`）。详见 internal-apis.md §2.4。

现状：清 `wakePending` 标志 + 补一个 `defaultDispatchSpec(role:'solo')`（`reducer.ts:847` 固定 solo）。这在 owner-workers 拓扑下会把排队的 worker 错派成 solo（role 错乱）。

改造：
- **topology()==='solo'**：维持原 `defaultDispatchSpec(role:'solo')` 不变（probe/noop 零回归）。
- **topology()==='owner-workers'**：按排队信息/role 补派对应 worker——即用排队时记录的 role/repo/parentAssignmentId 重建 worker dispatch spec，而不是补一个 solo run。

⚠️ codebase-findings 历史踩坑："wakePending 是布尔标志非事件批"——当前唤醒只跑一次 default solo run。owner-workers 下补派需带回排队 worker 的语义信息（role/repo），这部分排队信息来源由 statemachine 域 onEvent 在 dispatch 时携带、本域消费补派。

### 5.5 Owner 批量唤醒窗口（R02.AC-3/AC-7、R23.AC-1）

改造点：reducer owner 唤醒组批，复用 [store.lastRunEffectSeqBefore + eventsSince](../codebase-findings.md#res-checkdecision)（两块查询砖已就绪）。详见 internal-apis.md §2.5。

- 窗口 = **`(lastOwnerRunEffectSeq, currentOwnerRunEffectSeq]` 半开区间**（左开右闭，对齐 `eventsSince` 排他边界，R02.AC-3）。`lastOwnerRunEffectSeq` = 上次 owner run 起点（`lastRunEffectSeqBefore` 砖）；`currentOwnerRunEffectSeq` = 本次唤醒锚点。
- owner run **运行期间**到达的事件（如多个 worker 在 owner 跑的过程中先后完成）→ 锚到**下次** owner run 起点 seq，归入下一批（R02.AC-7、R23.AC-1）。即：本次 owner run 的窗口右界固定在 run 起点；run 期间的新事件落到右界之后，下次唤醒才带入。
- 不漏不重的保证：左开（不重复上次已带的）+ 右闭对齐排他边界（不漏本批应带的）+ 运行期事件锚下一批（owner 运行中 worker 完成不漏不重）。

⚠️ codebase-findings 漂移记录："wakePending 当前仅布尔标志，批量带事件尚是设计目标"——本域要**新建组批逻辑**（非"已实现"），有 `lastRunEffectSeqBefore`/`eventsSince` 两块砖可用。

⚠️ 边界写错就重复消费（同一 worker 报告验收两次）或漏带（永远看不到某端交付）。必须用专门时序夹具回归"owner 运行中 worker 完成"（见 §5.7）。

### 5.6 per-assignment 崩溃恢复（R23.AC-2/AC-4）

改造点：[recoverRun / recoverRunning](../codebase-findings.md#res-startuprecovery)（`effects.ts:92-123` / `:76-90`）的 `inflight.has(workitemId)` 早退（`:78,94`）。详见 internal-apis.md §3.2、决策 D-10 增补。

现状早退：`recoverRun/recoverRunning` 用 `inflight.has(workitemId)`（workitem 粒度）判是否已在途——在多并发恢复下**大概率漏恢复**：同 workitem 多 worker 崩溃恢复时，第一个 worker 恢复后 `inflight.has(workitemId)` 即真，其余 worker 被早退静默吞掉（R23.AC-4）。

改造：
- 早退条件从 `inflight.has(workitemId)` 改为**按本次要恢复的具体 effect 的 assignmentId/effectId 判**（per-assignment 粒度）。
- `startupRecovery` 编排改为"列某 workitem 全部 running effect，按 assignment 逐个恢复"（复用 data-model 域提供的 per-assignment 视图查询）。覆盖 replacement 与多 worker 同时在途的组合（R23.AC-2）。
- `recoverRun` 的 `canResume?resume:abort('recovery_redispatch')` 分支按 assignment 各自判（resume 能力依赖 worker-runtime 的 canResume 实现 + onSession 落库，本域只提供 per-assignment 编排）。

### 5.7 noop 夹具扩展（R23.AC-3，回归全部并发路径）

改造点：[noop 故障/心跳注入夹具](../codebase-findings.md#res-noop-fixture)（`noop/index.ts` + `noop/run-handler.ts`）。

扩 noop 注入能力（像 M0 打 outbox 那样锁定）：
- `topology:'owner-workers'`（开并行分流开关）。
- `dispatch` 多 role assignment（owner + N worker）。
- `checkpoints.requiredBefore` 可填（配合 checkpoint-gate 域回归，但本域用它验"checkpoint 不破坏并发恢复"）。
- 复用 `failAt`（before-run/during-run/before-report）+ `failCount`（前 N 次失败第 N+1 成功）精确编排失败序列。
- 复用 `heartbeatMode`（silent/normal/beat-no-finish）模拟卡死供 watchdog 回归。

夹具专打的回归断言（坑点全锁定）：
- 多 worker 并发 dispatch 不被单飞门拦成 wakePending（R01.AC-1）。
- 在途 worker 数按 DB 计数、批量累加不超放（R01.AC-4/AC-8）。
- per-assignment abort 不误伤其它 worker（R01.AC-5）。
- replacement 纳入上限计数（R01.AC-6）。
- **owner 运行中 worker 完成的批次归属**（R02.AC-7、R23.AC-1）——专门时序夹具。
- **同 workitem 多 worker 崩溃恢复全部恢复**（不只第一个，R23.AC-4）——这是 §5.6 改造的验证断言。
- solo（probe/noop solo）行为零回归（R01.AC-7）。

⚠️ 坑：probe/noop solo 行为必须零回归。noop 夹具扩展是**叠加新注入能力**，不能改动 solo 默认路径的行为（默认仍 solo）。

## 与其他领域的交互（调用方向）

- **data-model → 本域**：本域调用 `countRunningWorkers`（§2.2）、per-assignment 在途 effect 视图查询（并发恢复）、`maxWorkersPerItem` config（`ReducerRuntimeDeps.cfg`）、`AssignmentSpec.parentAssignmentId` 字段、新列 v3 迁移。这些定义归属 data-model，本域消费。
- **kernel-capabilities → 本域**：per-assignment abort 桥接到 `pool.abort(task.id)`（worker run handler 侧）；本域只产出 abort 信号（`PostCommitAction = abort_effect`），具体 abort 执行在 effect 层/kernel 层。
- **本域 → requirement-statemachine**：本域提供父子链反查砖、批量唤醒窗口的事件批，statemachine 域 onEvent 消费组批后的事件做 owner 心智重建；statemachine 域 dispatch worker 时填 `parentAssignmentId`/role/repo，本域写入与分流消费。
- **本域 → checkpoint-gate**：本域保证 `mergeTransitions`（只取 worktype phase）/ `applyTransitionWrites`（消费 phase）不变量不被本域改造破坏——checkpoint 拦截在 worktype 侧返 wait，本域容器层不碰 phase。
- **worker-runtime ← 本域**：worker run 的 per-assignment inflight + abort + 崩溃恢复编排由本域提供；worker-runtime 实现 run handler 的 canResume/resume，本域调度它。
- **contract-engine → 本域（间接）**：replacement dispatch（破坏性返工）经 [redispatchOrEscalate](../codebase-findings.md#res-redispatchorescalate) 产出，本域单飞门保证 replacement 绕门但纳上限计数。

## 相关决策

- **D-01**（只按仓拆 / 竖切不堵死）：本域并行改造**首要目标 = per-assignment 物理隔离 + abort 不误伤其它 worker**（正确性收益，并行度=2 也成立），墙钟收益次要。
- **D-10**（inflight 键 workitemId→assignmentId + 在途数 DB 计数 + 恢复早退降 per-assignment 粒度）：本域核心决策。"在途 worker 数"按 DB `status=running AND role=worker` 计数、同 transition 批量 dispatch 逐个累加、`releaseWakePending` 按 role 补派、`recoverRun/recoverRunning` 早退降 assignmentId/effectId 粒度。
- **D-19**（父子链 parent_id 启用写入 + 消费，非"免费拿"）：`AssignmentSpec` 增 `parentAssignmentId`，写入 assignment.parentId 替换恒 null，补读 parent_id 消费两端。
- **D-11**（修复/返工循环用独立计数，不复用 assignment.retries；replacement 继承返工计数）：本域 replacement 纳上限计数与此相关——replacement 锚"逻辑任务（repo+phase）"、继承前任返工计数（与继承 retries 分开两字段），防 stall 重派洗白返工次数。
- **D-26**（一次交付内部按依赖序推进）：本域属"地基改造"（reducer 并行 + checkpoint gate + noop 夹具回归），是开发序第①段，先 noop 夹具回归再接真 agent。

## 引用的内部 API

- internal-apis.md **§2.1** AssignmentSpec 扩展（parentAssignmentId）
- internal-apis.md **§2.2** `countRunningWorkers(workitemId): number`（DB 口径在途工人数）
- internal-apis.md **§2.3** 单飞门改造（topology 感知分流）
- internal-apis.md **§2.4** `releaseWakePending` 改造（按 role 补派）
- internal-apis.md **§2.5** Owner 批量唤醒窗口（半开区间组批）
- internal-apis.md **§3.1** inflight 键 workitemId→assignmentId（连锁 6+ 处）
- internal-apis.md **§3.2** per-assignment 崩溃恢复（早退条件降粒度）

> 跨域共享 utility（`repoOf` §1.1 / `contractStructuralDiff` §1.2 / `worktreePathFor` §1.3）本域**仅引用、不重新定义**：父子链/worker 计数按 role 分流但 worktree/repo 归属经 `repoOf`（worker-runtime 侧调用）；本域不直接调这三个 utility 的 fs 部分（reducer 纯同步）。

## 边界约束

### Must
- owner run 单飞（同一时刻至多一个 owner run 在途），靠 reducer 单飞门按 role 分流保证（**不**靠 inflight 键）。
- worker 受 `maxWorkersPerItem` 上限（默认 2，可由 env `WORKITEMS_MAX_WORKERS_PER_ITEM` 覆盖）。
- 在途 worker 数按 **DB `status=running` 且 `role=worker` 的 assignment 计数**（reducer apply 内强一致），不用 inflight Map post-commit 运行时态。
- 同一 transition 批量 dispatch N worker 时**逐个累加**已放行数判入门，不各读同一旧快照。
- abort 粒度 **per-assignment**（取消一个 worker 只 abort 该 assignmentId，不误伤其它）。
- replacement 绕单飞门但**纳入** worker 上限计数。
- 改造收敛在 `reducer.ts:603-610` 单飞门 + `effects.ts` inflight 键（不外溢）。
- 父子链 `parentAssignmentId` 写入 assignment.parent_id（替换恒 null）+ 补基本消费。
- 批量唤醒不漏不重，用 `(lastOwnerRunEffectSeq, currentOwnerRunEffectSeq]` 半开区间 + owner 运行期事件归下一批。
- `recoverRun/recoverRunning` 早退条件降 assignmentId/effectId 粒度；同 workitem 多 worker 崩溃恢复**全部**恢复。
- noop 夹具回归覆盖：批次完整性 + 两条非单飞路径（replacement/worker）崩溃恢复。
- reducer 全文无 await/async，IO 一律 post-commit；同一 apply 内追加 audit 事件各自 fresh nextSeq（禁 `event.seq+1`）；terminal 转移直接 drop 同帧 dispatch/waits/effects。

### Never
- 不按 `role` 之外的维度分流。
- 不在 reducer 里 await agent（IO 一律 post-commit）。
- 不破坏 probe/noop（solo）单飞语义——**solo 拓扑行为逐字节不变**（CI 回归绿）。
- 不用 inflight Map 计在途 worker 数（post-commit 时序会超放）。
- 不让每个 worker 各读同一份旧 `countRunningWorkers()` 快照（会双双放行超放）。
- 不在 owner-workers 拓扑下用 `defaultDispatchSpec(role:'solo')` 补派排队 worker（role 错乱）。
- 不在 reducer/workitems 层出现 **phase 比较**（`phase ==`/`switch(phase)`，CI 拦）。
- 不复活 v1"父子链免费拿"的乐观假设（需补完整写入 + 消费）。
- 不假设 replacement 与 worker 两条非单飞路径互不影响（必须夹具验证组合）。
- 不在 inflight 键改造时漏一处（poke/drainOne/finally/findInflight/recover 6+ 处全改，无一处残留 workitemId 键）。

## 可能的实现提示（可选）

- **改造顺序**：先扩 noop 夹具（`topology:owner-workers` + 多 role dispatch），写红的回归断言，再改单飞门 + inflight 键，最后改恢复早退——像 M0 打 outbox 那样"测试先行锁定"。
- **inflight 键改造一次性全改**：6+ 处连锁（poke:66 / drainOne:168,175 / executeEffect delete:229 / findInflight:334 / recoverRun·recoverRunning:78,94），用 grep `inflight.` 列全部引用点逐个核，避免漏一处导致 worker 互相覆盖。执行阶段自查清单 internal-apis.md §8 第 2 条已列此项。
- **owner 单飞与 inflight 键解耦验证**：改 inflight 键后专门加断言"owner 派两个 owner run 时第二个被单飞门拦成 wakePending"，确保单飞不依赖 inflight 键。
- **批量累加用局部变量**：在 reducer 处理 `dispatch: AssignmentSpec[]` 的循环内维护 `let releasedWorkers = 0`，每放行 worker 自增，判据 `countRunningWorkers(id) + releasedWorkers < max`。
- **半开区间边界**：`eventsSince(workitemId, basedOnSeq, currentSeq)` 已是排他左边界（`> basedOnSeq`），owner 窗口直接复用其语义，`lastOwnerRunEffectSeq` 作 basedOnSeq、`currentOwnerRunEffectSeq` 作 currentSeq。
- **per-assignment 恢复编排**：`startupRecovery` 第二步"在途 effect 按 kind 分流"改为先 list 全部 running effect、按 assignmentId 分组、逐个 `recoverRun`，每个早退判定只看自己的 effectId/assignmentId。
