# S4: 效果 outbox 与崩溃恢复

> Scope: 效果与状态转移同事务落库（transactional outbox）、效果生命周期与异步执行、崩溃恢复序列与按类型恢复策略、事件↔artifact 对账
> AC: AC-4.1~4.12
> 边界：不含 reducer 转移规则本身（S3）、表结构细节（S1）、wait 到期动作（S5）、PID 锁机制验证（S6，本组仅引用「单实例锁确认」作为恢复第一步）

---

## 需求（Step 1 产出）

### 概述

本组定义容器层的效果持久化与崩溃恢复语义：reducer 提交状态转移时，声明的效果以 `pending` 写入 `workitem_effects` 且与状态转移在**同一个 SQLite 事务**（任一失败全回滚）；容器运行时在 reducer 之外从 outbox 异步取效果执行，生命周期为 `pending → running → done | aborted`。进程崩溃后按固定序列恢复（单实例锁确认 → 状态表重建待办 → outbox 重建在途效果），并按效果类型分策略：幂等效果直接重跑；run 类效果（M0 无真 agent，由 noop「模拟运行效果」承载，resume 语义降级为 noop 的可恢复模拟）running 时先查可否 resume，不能则作废并经 replaces 链重派新 assignment，绝不盲目重跑。定位遵循「状态权威 + 事件审计」：事件不可重放，恢复不依赖事件回放；DB 与 git 尾部不一致时以状态表为准对 artifact 仓做校验提交。运行时另提供 running 效果的中止通道（AC-4.12，Step 1.5 补）：置 aborted + 中止事件，触发条件归 G5、中止后重派决策归 G3。

### AC 列表

#### AC-4.1: 效果与状态转移同事务落库

**GIVEN** 某 workitem 的 reducer 处理一个事件，产出「状态转移 + N 条效果声明」（N ≥ 1）
**WHEN** 容器运行时提交该转移
**THEN** 状态写入与 N 条效果记录（status=pending，携带 workitem_id、声明转移的 seq、kind、payload_json）在同一个 SQLite 事务内落库；事务提交后查询 `workitem_effects` 恰好可见这 N 条 pending 效果，且其 seq 与本次转移一致

#### AC-4.2: 同事务原子回滚

**GIVEN** reducer 产出「状态转移 + 效果声明」
**WHEN** 事务内任一写入失败（如效果写入被注入异常）
**THEN** 整个事务回滚：workitem 状态保持转移前的值，`workitem_effects` 中无本次新增记录，不存在「转移成功但效果丢失」或「效果落库但状态未变」的中间态

#### AC-4.3: 效果在 reducer 之外异步执行

**GIVEN** outbox 中存在已提交的 pending 效果（noop 效果配置为可控延时）
**WHEN** 容器运行时执行器拾取该效果开始执行
**THEN** 效果置 running（updated_at 更新）；执行发生在 reducer 之外——效果执行期间该 workitem 的 reducer 可继续接收并提交后续事件（reducer 调用栈中不存在对效果完成的等待）

#### AC-4.4: 效果终态化且终态不再被拾取

**GIVEN** 一条 running 的效果
**WHEN** 执行成功完成，或执行失败/被恢复流程作废
**THEN** 成功置 done，失败/作废置 aborted（失败是否先行重试见 G-4.5）；done 与 aborted 均为终态，之后（含进程重启后）不再被执行器拾取执行

#### AC-4.5: 崩溃恢复序列

**GIVEN** 容器进程在存在非终态 workitem、未完结 assignment/wait 及在途效果（pending/running）时被 SIGKILL
**WHEN** 进程重启执行恢复流程
**THEN** 恢复按固定顺序执行且每步留有日志可观测：(1) 单实例锁确认（机制由 S6 定义，本组仅要求其为第一步、失败即中止启动）；(2) 从 `workitems`（status ≠ 终态）+ `workitem_assignments`/`workitem_waits` 重建待办；(3) 从 `workitem_effects` 读取 pending/running 效果，按 AC-4.6~4.9 的策略处理

#### AC-4.6: 恢复后 pending 效果重新入队

**GIVEN** 崩溃时存在 status=pending 的效果（任意类型，尚未开始执行）
**WHEN** 恢复完成后执行器运行
**THEN** 这些效果按正常 outbox 路径被拾取执行（pending→running→done|aborted），不被丢弃、也不重复插入新效果行

#### AC-4.7: 幂等效果恢复——直接重跑

**GIVEN** 崩溃时一条幂等类效果处于 running（M0 由 noop 的幂等效果模拟）
**WHEN** 恢复流程处理该效果
**THEN** 直接重新执行同一条效果记录，成功后置 done；不创建新效果行（重复执行的副作用安全由幂等契约保证，见 G-4.2）

#### AC-4.8: run 类效果 running 且可 resume——续跑

**GIVEN** 一条 run 类效果（M0 = noop 模拟运行）崩溃时处于 running，且 noop 被注入为「会话可 resume」
**WHEN** 恢复流程处理该效果
**THEN** 容器先查询可否 resume（经 noop 的可注入判定点）；判定可续时在原 assignment 上续跑该模拟运行，不创建新 assignment、不从头重跑，效果最终置 done

#### AC-4.9: run 类效果不可 resume——作废并经 replaces 链重派

**GIVEN** 一条 run 类效果（M0 = noop 模拟运行）崩溃时处于 running，且 noop 被注入为「会话不可 resume」
**WHEN** 恢复流程处理该效果
**THEN** 原效果置 aborted 且不再被执行（无盲目重跑）；创建新 assignment 重派，其 `replaces_assignment_id` 指向原 assignment（沿 replaces 链可导航到源头）；原 assignment 不再处于活跃执行状态

#### AC-4.10: 事件↔artifact 对账校验提交

**GIVEN** 崩溃发生于「状态表已提交、对应 artifact git 提交未完成」的窗口（DB 与 git 尾部不一致）
**WHEN** 恢复流程执行对账步骤
**THEN** 以状态表为准对该 workitem 的 artifact 仓执行一次校验提交；对账后该 git 仓工作区干净（无未提交变更），对账动作留下可查的日志或审计事件

#### AC-4.11: 恢复不依赖事件回放（状态权威 + 事件审计）

**GIVEN** 一个经历过多次状态转移的 workitem，将其 `workitem_events` 记录人工清空以模拟事件不可用
**WHEN** 进程重启执行恢复
**THEN** 恢复结果（待办重建、在途效果处置）与事件日志完整时完全一致——恢复仅读取状态表与 `workitem_effects`，不读取/不重放 `workitem_events`

#### AC-4.12: running 效果的中止通道

**GIVEN** 一条 running 的运行类效果（M0 = noop 模拟运行）
**WHEN** 容器运行时收到对该效果的中止指令（来源如 watchdog 墙钟硬上限超限——触发条件归 G5，见 S5 AC-5.11）
**THEN** 该效果置 aborted 并产生对应的中止事件留痕；被中止的执行通道被实际停止，该效果不再产出结论回流事件；中止后是否经 replaces 链重派由 reducer 决策（判定归 G3），重派路径与 AC-4.9 的作废重派衔接

### Flow AC

#### FLOW-4.1: 效果正常流水线
- **路径**: reducer 提交转移（含效果声明）-> 同事务 pending 落库 -> 执行器拾取置 running -> 执行完成置 done
- **涉及 AC**: AC-4.1 -> AC-4.3 -> AC-4.4
- **验证点**: 事务提交后效果立即可见为 pending；执行期间 reducer 不被阻塞仍可处理新事件；终态 done 后不再被拾取
- **跨组**: Group 3（转移提交语义由 S3 定义）

#### FLOW-4.2: 崩溃恢复端到端
- **路径**: 在途效果窗口 SIGKILL -> 重启 -> 单实例锁确认 -> 状态表重建待办 -> outbox 分策略恢复（重跑/续跑/作废重派）-> artifact 对账提交
- **涉及 AC**: AC-4.5 -> AC-4.6/4.7/4.8/4.9 -> AC-4.10
- **验证点**: 恢复序列顺序可观测；不同注入条件下分别命中重跑/resume/replaces 重派三条策略且无双跑；对账后 git 仓干净
- **跨组**: Group 6（单实例锁机制）

### Gaps

- [WHITE] G-4.1: 效果执行器的并发度与取单顺序（全局单 worker 串行 / 每 workitem 串行 + 跨 item 并行；按 id 或 seq 排序）PRD 未细化 — 候选：每 workitem 串行、跨 workitem 并行，按 (workitem_id, seq, id) 排序；Step 2 决策（evaluation 已点名此补缺项）
- [YELLOW] G-4.2: 幂等效果「直接重跑」隐含 at-least-once 语义，幂等性由效果实现自证还是容器约束（如 effect id 去重）未明确 — 影响：M0 noop 副作用小可掩盖问题，需在 Step 2 写明幂等契约归属
- [YELLOW] G-4.3: 「可否 resume」判定在 M0 noop 下的模拟形态（如何注入可/不可 resume 两种结果、模拟会话标识存放于 agent_session_id 的约定）需与 noop 类型设计对齐 — 影响：AC-4.8/4.9 的可测性依赖该注入点
- [WHITE] G-4.4: 对账「校验提交」的具体形态（仅工作区脏才提交？提交 message 规范？workitem 仓尚未初始化时的处理）PRD 未细化 — 候选：git status 非净则以固定 message（含恢复时间戳）提交；Step 2 决策
- [YELLOW] G-4.5: 非崩溃场景下效果执行失败（运行时抛错）是直接 aborted 还是带重试预算后再 aborted，PRD §4.3 未述（§4.4 重试预算面向 assignment 监督而非效果）— 影响：决定 AC-4.4 失败分支的中间行为，Step 2 明确
- [YELLOW] G-4.6: 效果被作废（aborted）后是否产生回流事件通知 reducer、重派新 assignment 经直接写表还是经新事件/新效果通道，PRD 未细化 — 影响：AC-4.9 的实现路径与事件审计完整性，Step 2 明确

### PRD 校验

| PRD 锚点 | 要点 | 覆盖 AC |
|---|---|---|
| §4.3 规则 4 | 效果与转移同一 SQLite 事务 | AC-4.1, AC-4.2 |
| §4.3 规则 4 | 生命周期 pending→running→done\|aborted；运行时在 reducer 外取效果执行 | AC-4.3, AC-4.4 |
| §4.3 规则 4 | 恢复分策略：幂等直接重跑；run 类查 resume、不能则作废 + replaces 重派、不盲目重跑 | AC-4.6~4.9 |
| §10 | 重启恢复序列：锁确认 → 状态表重建待办 → outbox 重建在途效果 | AC-4.5 |
| §10 | 事件↔artifact 对账：以状态表为准做校验提交 | AC-4.10 |
| §10 / §12 | 状态权威 + 事件审计，非事件溯源，恢复不依赖事件回放 | AC-4.11 |
| §4.4 / 跨组检查③（Step 1.5 补） | 中止 running 运行的执行机制（墙钟超限「被掐」的容器侧通道，触发条件归 G5） | AC-4.12 |

> M0 降级说明：PRD 中「agent run 类效果查 agent_session_id 能否 resume」在 M0 无真 agent，由 noop 类型的可恢复模拟运行承载验证（envelope 既定口径，非 Gap）。

---

## 设计（Step 2 追加）

### 对外接口

```ts
// src/workitems/effects.ts
export interface EffectHandler {
  kind: string;
  recovery: 'rerun' | 'resume-or-redispatch';        // 注册即声明契约（→ G-4.2, G-3.3 运行类判定）
  run(ctx: EffectContext): Promise<void>;            // 抛错 = 执行失败
  canResume?(payload: unknown, assignment: Assignment | undefined): boolean;   // 仅 resume-or-redispatch
  resume?(ctx: EffectContext): Promise<void>;        // 续跑入口（→ AC-4.8）
}
export interface EffectContext {
  effect: Effect; workitem: WorkItem; assignment?: Assignment;
  signal: AbortSignal;                               // 中止通道（→ AC-4.12）
  clock: Clock; logger: Logger;
  heartbeat(): void;                                 // 活性上报（→ G-5.6，S5 消费）
  batchFromSeq: number;                              // 批量窗口起点 = 上一运行类效果的 based_on_seq，无则 0
                                                     // （构造 ctx 时经 store.lastRunEffectSeqBefore 查得 → S3 ADR-6）
  eventsSince(afterSeq: number): WorkItemEvent[];    // 半开区间 (afterSeq, effect.seq]——批量带入输入（→ S3 AC-3.7, ADR-6）
  setAgentSessionId(id: string): void;               // 小事务写 assignment 行（→ G-4.3）
  writeArtifact(relPath: string, content: string, message: string): void;  // 一写一提交
  emit(kind: string, payload: unknown): void;        // 结论事件回流（enqueue 到 reducer）
}
export class EffectRuntime {
  registerHandler(h: EffectHandler): void;           // 重复 kind 拒绝；容器不解释 kind（P4）
  isRunClass(kind: string): boolean;                 // recovery === 'resume-or-redispatch'
  poke(workitemId: string): void;                    // post-commit 通知：有新 pending（→ G-4.1）
  abort(effectId: number, reason: string): void;     // 中止通道（→ AC-4.12）
  lastBeat(assignmentId: string): number | undefined;
  stopIntake(): void; abortInflight(): void;         // 优雅关闭用（→ G-6.4）
}
// src/workitems/recovery.ts
export function startupRecovery(deps): void;         // 容器 start() 第一动作（锁由装配前置保证）
```

### 内部结构

#### 1. 同事务落库与原子性（→ AC-4.1, 4.2）

效果行的写入不在本模块——它发生在 S3 `applyTransitionWrites` 的转移事务内（`insertEffect(seq, kind, payload)`，seq=声明转移的 seq=based_on_seq，G-3.6）。better-sqlite3 的 `db.transaction()` 同步执行，任一写入抛错整体回滚 ⇒ 无中间态（→ AC-4.2）。本模块只在事务提交后经 postCommit `poke()` 被通知。

#### 2. 执行器（→ AC-4.3, 4.4；G-4.1）

```
inflight: Map<workitemId, {effectId, controller: AbortController}>   // 每 workitem 串行
poke(id): if (!inflight.has(id)) void drainOne(id)
async drainOne(id):
  e = store.listInflightEffects(id)[0]            // pending 按 (seq, id) 升序取单 (→ G-4.1)
  if (!e || e.status=='running') return           // running 槽位被占（恢复路径除外）
  setEffectStatus(e.id, 'running'); inflight.set(id, {...})
  try { await handler.run(ctx) }                  // reducer 之外、不持任何 reducer 队列 (→ AC-4.3)
  catch (err) {
    if (aborted) return                           // abort() 已处理终态
    if (isRunClass) emit('run_failed', {assignmentId, effectId, basedOnSeq: e.seq,
                                        assignmentRetries: assignment.retries, error})   // (→ S3 ADR-9)
      // 自报失败不提前置 aborted——效果保持 running，终态化统一在 run_failed 结论 apply 的转移事务内
      // 执行（与成功路径同构；提前置 aborted 会使结论被 ADR-7 前置检查作废 → ADR-11, G-4.5）
    else tx { setEffectStatus('aborted') }        // 幂等类失败无结论事件，小事务直接终态化，无效果级重试 (→ AC-4.4)
  }
  finally { inflight.delete(id); poke(id) }       // 串行推进下一条
```

run 类 handler 成功路径自行 `emit('run_completed', ...)`（实际发出点在 EffectRuntime 收尾钩子，见 S5 #5）；结论事件 payload 一律由执行器（reducer 外、持有 assignment 行）封装 `assignmentRetries = assignment.retries`——noop onEvent 纯函数仅读 payload 即可判定失败终态（→ S3 ADR-9）。效果终态化（run_completed→done、run_failed→aborted）发生在结论事件的 apply 事务内（S3 流程，与 assignment 收尾/转移同一事务，→ ADR-11），且终态化单向：S3 前置检查保证已 aborted（中止/恢复作废通道置位）的效果不被结论改写（→ S3 ADR-7）。幂等类（rerun）handler 无结论事件，run() 返回后小事务直接置 done。done/aborted 后 `listInflightEffects` 永不再返回 ⇒ 重启后也不会被拾取（→ AC-4.4）。

#### 3. 中止通道（→ AC-4.12）

```
abort(effectId, reason):
  inflight 命中 → controller.abort()             // handler 经 ctx.signal 停止执行通道
  tx { setEffectStatus('aborted') }
  reducer.enqueue(workitemId, {kind:'effect_aborted', payload:{effectId, assignmentId, basedOnSeq, reason}})
```

被中止的 handler 不再 emit 结论（signal 检查），唯一回流是 effect_aborted 事件。其 apply 由容器机制层处置：assignment → superseded/failed + 按预算重派或升级（S5 stalled 管道复用，→ AC-4.9 衔接；重派经 Transition.dispatch 走标准转移事务——G-4.6 单写入路径）。触发来源（墙钟超限等）归 S5。

#### 4. 崩溃恢复序列（→ AC-4.5~4.11；FLOW-4.2）

```
startupRecovery（container.start() 内，executor/watchdog 启动之前）:
  // (1) 单实例锁：kernel ensureSingleInstance 已在装配层先行（AC-4.5 第一步，语义见 S6 ADR-2）
  log('recovery: step 2 rebuild')
  items = store.listNonTerminal()                 // 状态表重建待办——不读事件表 (→ AC-4.11)
  for item: recomputeRollup(item)                 // 投影校正（崩溃窗口可能漏重算）
  log('recovery: step 3 outbox')
  for e of store.listInflightEffects():           // 不丢不重插：原行处置 (→ AC-4.6)
    h = handler(e.kind)
    if (e.status == 'pending'): 保持 pending，待 executor 启动后 poke 全量拾取
    else if (h.recovery == 'rerun'): 重新执行同一行（status 保持 running → run() → done）  // (→ AC-4.7)
    else:                                          // run 类 (→ AC-4.8/4.9)
      a = getAssignment(e.payload.assignmentId)
      if (h.canResume(e.payload, a)): void h.resume(ctx)     // 原 assignment 续跑，不建新行
      else: abort 路径复用——tx{ aborted } + enqueue effect_aborted
            // apply: a → superseded + Transition.dispatch 新 assignment(replaces=a.id, retries+1)
            // 〔已修正 · v3 评审〕apply 复用 stalled 管道的预算检查（与 §3「按预算重派或升级」对齐）：
            // 预算内 superseded+重派（deadline 按原 TTL 重新计满）；耗尽 failed + human wait 升级——
            // 否则崩溃循环下 retries 无界增长、永不升级给人（v3-code-review P1-4）
  log('recovery: step 4 reconcile')
  for item: r = artifacts.reconcile(item.id, 'startup')      // (→ AC-4.10, G-4.4)
            if (r != 'noop') reducer.enqueue(item.id, {kind:'artifact_reconciled', payload:{result:r}})
  启动 executor（poke 全部有 pending 的 item）+ watchdog
```

每步独立日志行（label: recovery.step2/3/4）满足「顺序可观测」。恢复全程不读 workitem_events（事件清空实验结果不变，→ AC-4.11）。canResume 判定（→ G-4.3）：noop handler 实现为 `payload.simulateResumable === true && assignment?.agent_session_id != null`——session 标识在首次 run 开始时经 ctx.setAgentSessionId(`noop:<assignmentId>`) 写入。

### 依赖关系

依赖：S1 store/artifacts、S3 reducer（emit/enqueue 回流）、Clock。被依赖：S3 经 isRunClass/postCommit-poke；S5 watchdog 经 abort/lastBeat；S6 noop handler 经 registerHandler 注入（装配点 index.ts，workitems 不 import worktypes）。

### 数据契约

Effect 行：`{ id, workitemId, seq, kind, payloadJson, status, createdAt, updatedAt }`。run 效果 payload：`{ assignmentId: string }`（其余参数从 workitem.context 读取——noop 的 delayMs/failAt 等）。结论事件 payload：`{ assignmentId, effectId, basedOnSeq, assignmentRetries, decision?, error? }`（assignmentRetries=assignment.retries，replaces 链深度，执行器查库携带 → S3 ADR-9）。`effect_aborted` payload：`{ effectId, assignmentId, basedOnSeq, reason }`。

### 测试策略

- 集成（真 DB，可编程桩 handler）：转移+N 效果同事务可见性（→ AC-4.1）；注入效果写失败断言全回滚（→ AC-4.2）；长延时 handler 执行中 reducer 继续 apply 新事件（→ AC-4.3）；done/aborted 后重启容器（同进程 close+start）不再拾取（→ AC-4.4）；恢复三策略各一用例：pending 重新入队零重插（行数不变 → AC-4.6）、running+rerun 直接重跑（→ AC-4.7）、running+run 类按注入双向走 resume/重派（replaces 链可导航、原 assignment superseded → AC-4.8/4.9）；DB-git 尾部不一致注入（写文件跳过 commit）→ 恢复后工作区净 + artifact_reconciled 事件（→ AC-4.10）；恢复顺序与日志可观测——以 log spy 捕获 logger 输出，断言 `recovery: step 2 rebuild` → `recovery: step 3 outbox` → `recovery: step 4 reconcile` 三个标签按此顺序各出现恰好一次（→ AC-4.5）；清空 events 表后恢复结果不变（→ AC-4.11）；abort 后无结论回流 + effect_aborted 事件 + 重派衔接（→ AC-4.12）。
- 进程级 SIGKILL 端到端归 S6（FLOW-6.2），本组用进程内 close/start 模拟覆盖逻辑分支，便宜且确定。

| 场景 | 类型 | 输入 | 期望 |
|---|---|---|---|
| 效果执行抛错 | Error | 桩 handler throw | run_failed 回流正常 apply（不被作废），效果于该 apply 事务内置 aborted；无效果级重试 (→ G-4.5, ADR-11) |
| 恢复时 handler 未注册 | Error | 未知 kind 在途 | 置 aborted + effect_aborted + error 日志（防呆，不崩溃） |
| pending 与 running 混存 | Edge | 同 item 两条 | running 先按策略处置，pending 保序拾取 |
