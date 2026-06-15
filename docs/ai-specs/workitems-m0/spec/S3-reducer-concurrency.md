# S3: reducer 运行时与决策防错

> Scope: 每 workitem 单线程 reducer 的串行/纯转移语义、Owner 单飞与事件批量带入、based_on_seq 结构检查与 isDecisionStale 钩子、防颠簸升级
> AC: AC-3.1~3.12
> 边界：效果的持久化/执行/崩溃恢复归 G4（同事务 outbox）；wait 对象与到期动作归 G5；表结构归 G1。本文涉及处仅引用。

---

## 需求（Step 1 产出）

### 概述

本组定义容器并发模型的运行时语义（PRD §4.3 规则 1/2/3，§12「并发模型」「过期决策判定」两行）：每个 workitem 一个单线程 reducer，事件按到达顺序逐个 apply、seq 单调分配；`onEvent` 是纯转移（状态转移 + 效果声明），效果由容器运行时在 reducer 之外执行（执行机制引用 G4）；运行（M0 为 noop 模拟运行）本身是效果，结论以新事件回流；同一 workitem 同时最多一个 Owner 运行（单飞），运行期间事件排队、下次唤醒批量带入；效果携带 based_on_seq，结论回流时容器做结构检查（不涉语义），语义判定走 `isDecisionStale` 钩子（M0 仅接口，noop 恒 false）；丢弃-重唤醒连续 2 次后升级 human wait（wait 对象归 G5，本组只定触发条件与事件）。

### AC 列表

#### AC-3.1: 同一 workitem 事件串行 apply

**GIVEN** 一个 noop 类型 workitem，多个来源并发向其注入事件 e1、e2、e3
**WHEN** 容器运行时处理这些事件
**THEN** reducer 对各事件的 apply 互不交错（前一个完成后才开始下一个），apply 顺序与到达顺序一致，事件日志记录顺序与 apply 顺序一致

#### AC-3.2: seq 单调分配

**GIVEN** 同一 workitem 已 apply 若干事件
**WHEN** 新事件被 apply
**THEN** 新事件获得的 seq 在该 workitem 维度严格单调递增且无重复

#### AC-3.3: 跨 workitem 互不阻塞

**GIVEN** workitem A 的 reducer 正在 apply 事件或其运行效果未完成
**WHEN** workitem B 收到新事件
**THEN** B 的事件被 B 自己的 reducer 立即 apply，不等待 A；A/B 的 seq 序列彼此独立

#### AC-3.4: onEvent 纯转移，效果不在 reducer 内执行

**GIVEN** noop 类型的 `onEvent` 对某事件返回「状态转移 + 效果声明」
**WHEN** reducer apply 该事件
**THEN** apply 同步完成，过程中不执行任何效果（不启动运行、无 await agent）；状态转移生效、效果声明完整移交容器运行时（落库与执行引用 G4）；apply 返回时刻可断言效果尚未开始执行

#### AC-3.5: 运行是效果、结论以事件回流

**GIVEN** 一次 noop 模拟运行作为效果在 reducer 之外执行
**WHEN** 运行完成（成功或注入失败）
**THEN** 结论不直接修改 workitem 状态，而是封装为新事件进入该 workitem 事件队列，经 reducer apply（获得新 seq）后才发生状态转移

#### AC-3.6: Owner 单飞

**GIVEN** 某 workitem 的一次 Owner（noop 模拟）运行正在进行
**WHEN** 新事件 apply 后产生再次唤醒 Owner 的诉求
**THEN** 不并行启动第二个运行——任意时刻该 workitem 执行中的 Owner 运行数 ≤ 1；唤醒诉求合并，待当前运行结束后处理

#### AC-3.7: 排队事件批量带入

**GIVEN** Owner 运行期间先后到达 3 个完成类事件（各自已按 AC-3.1/3.2 即时 apply）
**WHEN** 当前运行结束、触发下一次唤醒
**THEN** 仅启动一次新的 Owner 运行，其输入包含自上次运行 based_on_seq 以来的全部 3 个事件，而非唤醒 3 次

#### AC-3.8: 效果携带 based_on_seq

**GIVEN** reducer 在 apply seq=n 的事件时声明效果
**WHEN** 效果被移交容器运行时
**THEN** 效果携带 based_on_seq=n（字段载体与 G1 对齐，见 G-3.6）；该值随结论回流可读取，作为结构检查与 isDecisionStale 的基准

#### AC-3.9: 结构检查——引用 assignment 已 supersede/终态则作废

**GIVEN** 运行结论回流，其决策引用的 assignment 在 based_on_seq 之后已被 supersede 或进入终态
**WHEN** 容器在 apply 结论前执行结构检查（不涉语义）
**THEN** 该决策作废：其声明的状态转移不发生，记录作废事件（kind/payload 见 G-3.5）；该 assignment 既有产物（报告、分支等 artifact）不删除、不回滚

#### AC-3.10: 结构检查——引用 wait 已 resolve 则作废

**GIVEN** 运行结论回流，其决策引用的 wait 在 based_on_seq 之后已被 resolve
**WHEN** 容器执行结构检查
**THEN** 同 AC-3.9 作废处理（wait 生命周期归 G5，本组仅消费其 resolved 状态）

#### AC-3.11: isDecisionStale 调用时机与 noop 退化实现

**GIVEN** 运行结论回流且结构检查通过
**WHEN** 容器继续处理该结论
**THEN** 调用该类型的 `isDecisionStale(decision, eventsSince)`，eventsSince 为 based_on_seq 之后该 workitem 的事件（边界见 G-3.7）；接口签名按 §4.5 全量定义；M0 noop 实现恒返回 false，结论正常 apply——seq 前进本身不导致作废

#### AC-3.12: 防颠簸——连续 2 次丢弃后升级人工

**GIVEN** 同一 workitem 的运行结论被作废并触发重唤醒，且「丢弃-重唤醒」已连续发生 2 次
**WHEN** 第 2 次作废落定
**THEN** 不再自动重唤醒重试；产生升级事件并触发创建 kind=human 的 wait（wait 对象与到期动作归 G5，本组只定义触发条件与事件）；任一结论成功 apply 后连续计数清零

### Flow AC

#### FLOW-3.1: 单飞-排队-批量唤醒-回流闭环
- **路径**: 创建 noop workitem → 事件触发 Owner 运行（效果经 G4 执行）→ 运行期间注入 3 个完成事件 → 各事件即时串行 apply → 运行结束 → 一次唤醒批量带入 → 新结论事件回流 apply
- **涉及 AC**: AC-3.1 -> AC-3.2 -> AC-3.5 -> AC-3.6 -> AC-3.7
- **验证点**: 运行期间 Owner 运行数恒 ≤1；3 个事件 seq 连续递增且先于唤醒落日志；下一次运行输入含全部 3 个事件；回流结论以新 seq 事件形式落库后状态才变化
- **跨组**: Group 4（效果落库与执行）

#### FLOW-3.2: 过期决策作废-防颠簸升级
- **路径**: 声明效果（based_on_seq=n）→ 运行期间引用的 assignment 被 supersede → 结论回流被结构检查作废（第 1 次）→ 自动重唤醒 → 结论再次被作废（第 2 次）→ 防颠簸触发 → 升级事件 + human wait 创建
- **涉及 AC**: AC-3.8 -> AC-3.9 -> AC-3.12
- **验证点**: 两次作废各留作废事件且 artifact 不丢；第 2 次作废后无第 3 次自动唤醒；升级事件与 human wait 创建可观测
- **跨组**: Group 4（效果执行）、Group 5（human wait 对象）

### Gaps

| 级别 | 编号 | 描述 | 影响 / 处理 |
|---|---|---|---|
| YELLOW | G-3.1 | 「运行期间事件排队」与规则 1「按到达顺序逐个 apply」的精确关系：本组按「事件即时 apply、唤醒效果合并」解读（AC-3.7 据此编写）；若 Step 2 改为「延迟 apply」，seq 分配时点与 AC-3.2/3.7 需重审 | Step 2 设计时确认解读 |
| YELLOW | G-3.2 | 防颠簸计数作用域（workitem 级还是决策链级）与清零条件 PRD 未定义；AC-3.12 暂按「workitem 级连续计数、成功 apply 清零」 | Step 2 确认，影响误升级概率 |
| YELLOW | G-3.3 | M0 无真实 Owner/Worker 拓扑（EX-8），「单飞」约束对象是所有运行类效果还是仅 owner 角色运行；建议 M0 noop 实现为「每 workitem 至多一个执行中的运行类效果」 | Step 2 定，影响 noop 并发测试形态 |
| YELLOW | G-3.7 | eventsSince 边界未定义：是否含 based_on_seq 当条、是否含回流结论事件自身 | Step 2 定，影响 isDecisionStale 入参契约 |
| WHITE | G-3.4 | per-workitem 串行队列的进程内实现形态（Promise 链 / 显式 FIFO + 忙标志）；evaluation 已点名为领域模型映射补缺项 | Step 2 选型 |
| WHITE | G-3.5 | 作废/升级事件的 kind 命名与 payload 结构（候选 decision_discarded / thrash_escalated）PRD 未给 | Step 2 定义事件契约 |
| WHITE | G-3.6 | effect 的 based_on_seq 字段载体：§4.2 workitem_effects 仅有 seq（「由哪次转移声明」），与规则 3「效果携带 based_on_seq」是否同一字段 | 与 G1 表结构对齐，候选复用 seq 语义 |

### PRD 覆盖校验

| PRD 条款 | 覆盖 |
|---|---|
| §4.3 前提：单实例（PID 锁） | 非本组所有权——kernel 验证点，由 lifecycle 测试组覆盖 |
| §4.3 规则 1：纯转移、单线程、seq 单调 | AC-3.1~3.4 |
| §4.3 规则 2：运行是效果、单飞、批量带入 | AC-3.5~3.7（§1.4 心智模型连续的机制面） |
| §4.3 规则 3：based_on_seq、结构检查、isDecisionStale、防颠簸、产物不丢 | AC-3.8~3.12 |
| §4.3 规则 4：同事务 outbox | 非本组——G4 独占 |
| §12「并发模型」「过期决策判定」决策行 | AC-3.6/3.7、AC-3.8~3.12 |

### UI 需求

无（has_ui=否，M0 无任何飞书交互）。

---

## 设计（Step 2 追加）

### 对外接口

```ts
// src/workitems/reducer.ts
export class ReducerRuntime {
  constructor(deps: {
    store: WorkitemsStore; registry: WorkTypeRegistry; clock: Clock; logger: Logger;
    cfg: WorkitemsConfig;                    // defaultDispatch 监督参数默认值等（→ ADR-10）
    isRunClass(kind: string): boolean;       // 由 EffectRuntime handler 注册表提供（→ G-3.3）
    postCommit(actions: PostCommitAction[]): void;  // poke 执行器 / 发 AbortSignal——IO 永不进事务
  });
  enqueue(workitemId: string, ev: PendingEvent): void;   // 入队并同步 drain，返回时已 apply
  bootstrapApply(input: CreateInput): CreateResult;      // 创建专用（S2 设计节伪代码；两类型定义于 types.ts → I-017）
}
export interface PendingEvent { kind: string; payload?: unknown }
// 结论类事件 payload 约定（run_completed / run_failed），由效果执行器（reducer 外、可查库）emit 时封装：
//   { assignmentId, effectId, basedOnSeq, assignmentRetries, decision?: Decision, error? }
//   assignmentRetries = 该 assignment 的 retries（replaces 链深度）——noop onEvent 纯函数判定失败终态仅读此字段（→ ADR-9）
// Decision 定义于 src/workitems/types.ts（共享域类型，I-016 归位，见 S2 设计节 types.ts 段）：
// types.ts 不回头 import reducer.ts；reducer.ts/api.ts/worktypes 均单向 import types.ts——无文件级环
```

### 内部结构

#### 1. per-item FIFO + 同步 drain（→ AC-3.1, 3.2, 3.3；G-3.4）

```
queues: Map<workitemId, PendingEvent[]>; draining: Set<workitemId>
enqueue(id, ev):
  queues.get(id).push(ev)
  if (draining.has(id)) return            // 正在 drain 的循环会消费到它
  draining.add(id)
  try { while (ev = queues.shift(id)) applyEvent(id, ev) }   // 全同步，逐个 apply
  finally { draining.delete(id) }
```

applyEvent 是同步函数（better-sqlite3 同步事务），Node 单线程下两个 apply 不可能交错——FIFO + drain 给的是「顺序与到达一致」与可断言的队列深度（→ AC-3.1）。各 workitem 独立队列、独立 seq 序列，A 的 drain 不持有任何全局锁（→ AC-3.3）。seq 在事务内 `MAX(seq)+1` 分配，UNIQUE(workitem_id, seq) 兜底（→ AC-3.2）。

#### 2. applyEvent 主流程（单事务，伪代码）

```
applyEvent(id, ev):
  item = store.getWorkItem(id)
  if (item.status ∈ 终态): tx { appendEvent(nextSeq, ev.kind, ev.payload) }; return   // 仅审计 (→ AC-2.10)
  tx {
    seq = store.nextSeq(id)
    // —— 结论类事件前置检查（kind ∈ {run_completed, run_failed}）——
    if (isConclusion(ev)):
      verdict = structuralCheck(ev.payload)            // (→ AC-3.9/3.10)
      if (verdict.ok && type.isDecisionStale(           // (→ AC-3.11)
            ev.payload.decision ?? {},
            store.eventsSince(id, ev.payload.basedOnSeq, seq)))   // 开区间 (based_on_seq, seq) (→ G-3.7)
        verdict = { ok:false, reason:'semantically_stale' }
      if (!verdict.ok):
        appendEvent(seq, 'decision_discarded',         // 判废依据可审计 (→ G-3.5)
          {reason: verdict.reason, assignmentId: verdict.assignmentId, waitId: verdict.waitId,
           effectId, basedOnSeq})
        if (effect.status ∈ {pending, running}):       // 终态化单向：只允许 pending|running → done|aborted
          setEffectStatus(effectId, 'done')            // 决定作废，效果已执行完；已 aborted 保持不变 (→ ADR-7)
        if (verdict.reason == 'effect_aborted'):       // 中止来源的处置已由 stalled 管道完成（重派/升级）
          recomputeRollup; return                      // 不计 streak、不重唤醒——杜绝双派，不复活效果 (→ ADR-7)
        streak = item.discard_streak + 1               // (→ G-3.2)
        if (streak >= 2):
          appendEvent(seq+1, 'thrash_escalated', {streak, waitId})
          insertWait(kind='human', reason='thrash', deadline=now+humanWaitTtl)       // (→ AC-3.12, G-5.4)
          update(discard_streak=0)                     // 升级即清零，human resolve 后重新计数
        else: update(discard_streak=streak); markWakePending(item)  // 自动重唤醒（第 1 次）
        // 〔已修正 · v3 评审〕作废同时将结论的发起 assignment（仍 running 且 reason != effect_aborted 时）
        // 置 superseded + ended_at——否则其残留 running 会在 ~heartbeatTimeout 后被 watchdog 二次 stalled
        // 重派，与本路径的重唤醒叠加产生冗余 assignment（v3-code-review P1-3）
        recomputeRollup; return                        // 转移不发生，artifact 不动 (→ AC-3.9 产物不删)
    appendEvent(seq, ev.kind, ev.payload)
    containerT = containerMechanics(item, ev, seq)     // stalled 预算/重派、effect_aborted、wait 生命周期（归 S4/S5）
    typeT      = type.onEvent(item, eventRow)          // 纯函数：无 IO、无 await、无 clock (→ AC-3.4)
    t = merge(containerT, typeT)   // 效果/dispatch/waits 取并集；phase/terminal 仅类型可声明
    if (t.phase): appendEvent(seq+1, 'phase_changed', {from,to,reason}); update(phase)
    if (isConclusion(ev)): setEffectStatus(effectId, ev.kind=='run_failed' ? 'aborted' : 'done')
                           closeAssignment(ev); update(discard_streak=0)
                           // 效果终态化统一在本 apply 事务：成功→done、自报失败→aborted（同构，→ ADR-11）
                           // 此处效果必为 running——已 aborted（中止/恢复作废通道）的结论在前置检查即被作废，永不达此分支 (→ ADR-7)
    applyTransitionWrites(t, seq):                     // 同一事务（→ S4 AC-4.1）
      for d of t.dispatch: insertAssignment(based_on_seq=seq, deadline=now+ttl…); insertRunEffect(seq, d)
      for w of t.waits:    insertWait(deadline=now+ttl…)
      for e of t.effects:  insertEffect(seq, e.kind, e.payload)      // (→ AC-3.8: 效果携带 based_on_seq=seq)
      单飞合并（见 3）
    if (t.terminal): update(status=t.terminal)
    recomputeRollup(item)
  }
  postCommit(actions)    // poke 执行器 / AbortSignal（→ AC-3.4: apply 返回时效果未开始执行）
```

onEvent 在事务内被调用但它是纯函数（仅计算 Transition），事务内没有任何 await/IO——「同步事务内禁止 async」由签名（非 async）+ 架构测试双重保证。

#### 3. 单飞与批量唤醒（→ AC-3.5, 3.6, 3.7；G-3.1/3.3）

```
insertRunEffect(seq, d)（applyTransitionWrites 内）:
  if (EXISTS inflight effect WHERE workitem_id=id AND isRunClass(kind)):   // 单飞检查 (→ AC-3.6)
    update(wake_pending = 1)        // 唤醒诉求合并，不插第二条 run 效果
  else: insertAssignment(...); insertEffect(kind='run', seq, {assignmentId, ...})
markWakePending 同上。
结论 apply 尾部（closeAssignment 之后）:
  if (item.wake_pending == 1 && !t.terminal):
    update(wake_pending = 0)
    insertRunEffect(seq, defaultDispatch(item))   // 一次唤醒；based_on_seq = 当前 seq
```

批量带入的机制（→ ADR-6）：**状态基准**与**批量输入窗口**分离——新 run 效果的 based_on_seq=当前 seq=N，只作结构检查 / isDecisionStale 的状态基准；批量窗口起点 `batchFromSeq` = 该 workitem 上一次运行类效果的 based_on_seq=M（首个 run 取 0）。存取路径：EffectRuntime 构造 EffectContext 时经 `store.lastRunEffectSeqBefore(workitemId, 当前 effectId, runKinds)` 从 workitem_effects 表查「id 小于当前效果的最近一条运行类效果」的 seq（无则 0），挂为 `ctx.batchFromSeq`；run handler 经 `ctx.eventsSince(ctx.batchFromSeq)` 读取半开区间 **(M, N]** ——3 个完成事件（seq 均落在 (M, N] 内）全部在内（→ AC-3.7）。「批量」不是攒事件，而是唤醒输入按 seq 区间取；事件本身早已各自即时 apply（→ G-3.1 即时 apply 解读，seq 分配时点 = apply 时点，AC-3.2/3.7 无需重审）。wake_pending 落库 ⇒ 崩溃后恢复路径可见未兑现的唤醒；batchFromSeq 由库内查询导出（不依赖内存/payload）⇒ 崩溃恢复重跑后窗口依旧成立。

`defaultDispatch(item)` 的监督参数来源（→ ADR-10）：`{ role:'solo', deadlineTtlSec: cfg.defaultDeadlineTtlSec, wallclockCapSec: cfg.defaultWallclockCapSec }`——取容器配置默认值（并入 WorkitemsConfig，见 S5 设计节配置段）；WorkType 需要不同监督参数时在 Transition.dispatch 显式声明即覆盖（defaultDispatch 仅服务唤醒/第 1 次作废重唤醒这类容器自发派发，满足 AC-5.7 必填正数校验）。

#### 4. 结构检查（→ AC-3.9, 3.10；纯容器机制，不涉语义）

```
structuralCheck({assignmentId, effectId, decision}):     // 返回 {ok, reason?, assignmentId?, waitId?}（→ G-3.5）
  if (store.getEffect(effectId).status == 'aborted')     // 效果已被中止/作废（仅 S4 abort()/恢复作废通道置位；
    return {ok:false, reason:'effect_aborted', assignmentId}   // 自报失败不置 aborted → ADR-11）：迟到结论按过期决策路径作废 (→ ADR-7)
  for aid of [assignmentId, ...decision.refs.assignmentIds]:
    a = store.getAssignment(aid)                         // S1 单行读取接口
    if (a.status == 'superseded') return {ok:false, reason:'assignment_superseded', assignmentId: aid}
    if (a.status ∈ {'done','failed','cancelled'} && aid != assignmentId)
      return {ok:false, reason:'assignment_terminal', assignmentId: aid}
  for wid of decision.refs.waitIds:
    if (store.getWait(wid).resolved_at != null) return {ok:false, reason:'wait_resolved', waitId: wid}
  return {ok:true}
```

注：事件自身的 assignmentId 处于 running 是常态（它正是来收尾的），只查「已被 supersede」；refs 引用的其他对象按终态/已 resolve 判废；触发判废的具体对象 id（assignmentId/waitId）随 verdict 并入 decision_discarded payload（→ G-3.5 可审计判废依据）。效果终态化全局只允许 pending/running → done|aborted，置位仅两处：结论事件 apply 事务（成功→done、自报失败→aborted，→ ADR-11）与 S4 中止/恢复作废通道（aborted）——结论回流发现效果已 aborted 时作废结论、不复活效果（该 aborted 必来自中止/恢复作废，置位与后续重派归 S4/S5 stalled 管道，→ ADR-7）。isDecisionStale 仅在结构检查通过后调用，noop 恒 false ⇒ seq 前进本身不导致作废（→ AC-3.11）。

### 依赖关系

依赖：S1 store、S2 registry/projection、Clock、WorkitemsConfig（src/workitems/config.ts，→ ADR-10）；经构造注入 isRunClass 与 postCommit（避免 reducer→effects 的环）。被依赖：S4 EffectRuntime / S5 Watchdog / S2 api 全部经 enqueue 回流事件。

### 数据契约

容器机制事件 kind 清单（payload 见各设计节）：`workitem_created / phase_changed / run_completed / run_failed / effect_aborted / assignment_stalled / assignment_retry_exhausted / decision_discarded / thrash_escalated / wait_reminder / wait_renewed / wait_resolved / timer_fired / artifact_reconciled`。Decision 结构定义于 src/workitems/types.ts（→ S2 设计节，I-016 归位）。两个事件窗口不混用：isDecisionStale 的 eventsSince = 开区间 (based_on_seq, 当前事件 seq)（→ G-3.7）；run handler 的批量输入窗口 = 半开区间 (batchFromSeq, 本效果 based_on_seq]（→ ADR-6）。`decision_discarded` payload：`{reason, assignmentId?, waitId?, effectId, basedOnSeq}`，reason ∈ `'assignment_superseded'|'assignment_terminal'|'wait_resolved'|'semantically_stale'|'effect_aborted'`（→ G-3.5 + ADR-7 增补）。

### 测试策略

- 单元：structuralCheck 四分支判定矩阵；merge 规则（terminal/phase 仅类型，效果并集）。
- 集成（真 DB + noop 桩类型）：并发注入 e1/e2/e3 断言 apply 顺序=到达顺序、seq 连续（→ AC-3.1/3.2）；A 长延时运行中 B 事件即时 apply（→ AC-3.3）；onEvent 返回 dispatch 后 apply 返回时刻效果行 pending 且 handler 未被调用（→ AC-3.4）；运行期间注入 3 事件→运行结束仅 1 次新运行且输入含 3 事件——断言依据为 batchFromSeq 窗口 (M, N]，3 个事件 seq 全部落入（FLOW-3.1，→ AC-3.5/3.6/3.7, ADR-6）；supersede 注入→结论作废→自动重唤醒→再作废→thrash 升级 human wait + 第 3 次唤醒不发生 + artifact 文件仍在（FLOW-3.2，→ AC-3.8/3.9/3.12）；成功 apply 后 streak 清零（→ G-3.2）。
- Mock 边界：本组测试以「桩 WorkType」（可编程 onEvent/isDecisionStale 返回值）替代 noop，隔离 S6 实现。

| 场景 | 类型 | 输入 | 期望 |
|---|---|---|---|
| isDecisionStale 返回 true | Edge | 桩类型恒 true | decision_discarded(semantically_stale)，转移不发生 |
| 结论引用已 resolve wait | Edge | refs.waitIds=[已 resolve] | 作废，reason='wait_resolved' (→ AC-3.10) |
| 终态项收事件 | Edge | done 后 enqueue | 仅审计行，无 onEvent 调用 |
| 第 1 次作废 | Happy | supersede 后回流 | 自动重唤醒发生（wake_pending 路径），streak=1 |
| 结论回流时效果已 aborted | Edge | abort 后 handler 仍 emit 结论 | decision_discarded(effect_aborted)，效果保持 aborted、streak 不变、无重唤醒 (→ ADR-7) |
