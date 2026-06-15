# Phase 3: reducer 运行时与决策防错

> 输入：S3-reducer-concurrency.md、S2 设计中的创建骨架、S4 的同事务 outbox 约束。
> 目标：让所有事件经每 workitem FIFO 串行 apply，落完整 Transition 写入、单飞合并、结构检查与防颠簸。
> 统一验证：每个 Task 完成后运行 `npm run typecheck && npm run lint && npm test`。

## Task T11: ReducerRuntime FIFO、seq 与终态短路

**AC**：AC-3.1~3.4、AC-2.10 运行时面  
**依赖**：T8~T10  
**文件**：
- Modify: `src/workitems/reducer.ts`
- Test: `tests/workitems/reducer-fifo.test.ts`

**RED**
- 测试同一 workitem 并发 enqueue e1/e2/e3，apply 顺序与到达顺序一致，seq 连续。
- 测试跨 workitem A 长 apply 不阻塞 B 的 enqueue。
- 测试终态 item 收到事件只追加审计事件，不改 status/phase。
- 测试 onEvent 返回效果声明时 apply 同步完成，handler 未启动。

**GREEN**
- 实现 `queues: Map<workitemId, PendingEvent[]>` 与 `draining` 集合。
- `applyEvent` 事务内分配 `nextSeq`、appendEvent、调用 WorkType.onEvent、recomputeRollup。
- postCommit 机制先以回调数组保留，执行器 poke 在 Phase 4 接入。

**完成判据**
- reducer 不含 `await`。
- 单项 FIFO 与跨项独立都由测试直接断言。

## Task T12: applyTransitionWrites、同事务 outbox 与单飞合并

**AC**：AC-3.6~3.8、AC-4.1~4.2  
**依赖**：T11  
**文件**：
- Modify: `src/workitems/reducer.ts`
- Modify: `src/workitems/store.ts`
- Test: `tests/workitems/reducer-transition.test.ts`

**RED**
- 测试 Transition.dispatch 同事务创建 assignment 与 run effect，effect.seq 等于声明事件 seq。
- 测试 Transition.waits/effects 写入失败时，event/status/assignment/effect 全部回滚。
- 测试同一 workitem 已有 pending/running run 类效果时，再次 dispatch 不插第二条 run effect，而是置 `wake_pending=1`。
- 测试结论 apply 后 `wake_pending=1` 只启动一次新 run。
- 测试 `lastRunEffectSeqBefore` 返回上一条运行类效果 seq，首条返回 0。

**GREEN**
- `applyTransitionWrites` 统一处理 dispatch/waits/effects/phase/terminal。
- run 类判定通过注入 `isRunClass(kind)`。
- defaultDispatch 使用 cfg.defaultDeadlineTtlSec/defaultWallclockCapSec。

**完成判据**
- AC-4.1/4.2 的代码归属在 Phase 3 完成，Phase 4 不重复实现写入路径。

## Task T13: 结论结构检查与 isDecisionStale 契约

**AC**：AC-3.9~3.11  
**依赖**：T12  
**文件**：
- Modify: `src/workitems/reducer.ts`
- Test: `tests/workitems/reducer-decisions.test.ts`

**RED**
- 测试 run_completed 引用 superseded assignment 被作废，追加 `decision_discarded`，artifact 不删除。
- 测试引用 resolved wait 被作废。
- 测试 effect 已 aborted 时迟到结论 reason=`effect_aborted`，不改写 effect status。
- 测试结构检查通过后才调用 `isDecisionStale`，eventsSince 使用 `(basedOnSeq, seq)` 开区间。
- 测试 noop 式 `isDecisionStale=false` 时 seq 前进不导致作废。

**GREEN**
- 实现 `structuralCheck`，payload 包含 effectId/assignmentId/wait refs/basedOnSeq。
- 作废路径只追加审计事件与 streak 处理，不应用 WorkType Transition。
- run_completed/run_failed 的 effect 终态化统一在结论 apply 事务内。

**完成判据**
- Decision 类型仍在 `types.ts`，reducer 不导出共享域类型给 worktypes。

## Task T14: 防颠簸升级 human wait

**AC**：AC-3.12、FLOW-3.2 的 reducer 部分  
**依赖**：T13  
**文件**：
- Modify: `src/workitems/reducer.ts`
- Test: `tests/workitems/reducer-thrash.test.ts`

**RED**
- 测试第 1 次作废后 `discard_streak=1` 且自动重唤醒。
- 测试第 2 次连续作废后追加 `thrash_escalated`、创建 human wait、清零 streak、不产生第 3 次自动唤醒。
- 测试任一结论成功 apply 后 streak 清零。
- 测试 reason=`effect_aborted` 不计 streak、不重唤醒。

**GREEN**
- workitem 级 `discard_streak` 持久化。
- human wait deadline 使用 cfg.humanWaitTtlSec。
- 升级事件与 wait 创建在同一事务内。

**完成判据**
- 防颠簸升级能被 S5 的 wait 到期逻辑继续接管。

## Task T15: 生命周期、phase 与投影集成

**AC**：AC-2.7、AC-2.9、AC-2.11、AC-2.12、FLOW-2.1 的非 noop 面  
**依赖**：T11~T14、T9  
**文件**：
- Test: `tests/workitems/lifecycle-projection.test.ts`
- Modify: `src/workitems/reducer.ts` as needed

**RED**
- 用桩 WorkType 驱动 open → active → waiting → active → done。
- 测试 human wait 下仍有另一个 assignment 完成，status 继续 waiting(human)，执行不被钳制。
- 测试 phase 从 `b` 回退到 `a` 被接受并追加 `phase_changed`。
- 测试任意非 ASCII phase 字符串逐字节回读。

**GREEN**
- 将 phase_changed 追加与 phase 更新纳入 applyTransitionWrites。
- 确保投影重算只看权威 wait/assignment/effect 表。

**完成判据**
- Group 2 的生命周期承诺在 reducer 集成面闭合。

