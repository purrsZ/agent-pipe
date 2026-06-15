# Phase 4: 效果 outbox 与崩溃恢复

> 输入：S4-effects-outbox.md、Phase 3 的同事务 outbox 写入。
> 目标：实现 EffectRuntime、abort 通道、startupRecovery 与恢复分策略，并用集成测试闭合 G3/G4 Flow。
> 统一验证：每个 Task 完成后运行 `npm run typecheck && npm run lint && npm test`。

## Task T16: EffectRuntime 执行器与结论事件回流

**AC**：AC-3.5、AC-3.7 批量窗口执行面、AC-4.3~4.4、FLOW-4.1  
**依赖**：T12、T13  
**文件**：
- Create: `src/workitems/effects.ts`
- Modify: `src/workitems/reducer.ts`
- Test: `tests/workitems/effects-runtime.test.ts`

**RED**
- 测试 pending effect 被 poke 后置 running，handler 在 reducer 外异步执行。
- 测试 handler 成功后 emit run_completed，效果在结论 apply 事务内置 done。
- 测试 handler throw 时 emit run_failed，效果在结论 apply 事务内置 aborted。
- 测试幂等类 handler throw 无结论事件，小事务置 aborted。
- 测试同 workitem 串行、跨 workitem 并行。
- 测试 ctx.batchFromSeq 与 ctx.eventsSince 返回 `(上一 run seq, 当前 run seq]`。

**GREEN**
- `EffectHandler` 注册表支持 `recovery='rerun'|'resume-or-redispatch'`。
- `EffectContext` 提供 heartbeat、eventsSince、setAgentSessionId、writeArtifact、emit。
- `EffectRuntime.poke` 按 `(seq,id)` 拾取 pending；done/aborted 不再拾取。

**完成判据**
- AC-3.5 的“结论以事件回流”在真实执行器中可观测。

## Task T17: running 效果中止通道

**AC**：AC-4.12、AC-5.11 的执行机制前置  
**依赖**：T16  
**文件**：
- Modify: `src/workitems/effects.ts`
- Modify: `src/workitems/reducer.ts`
- Test: `tests/workitems/effects-abort.test.ts`

**RED**
- 测试 `abort(effectId,'wallclock_exceeded')` 触发 AbortSignal，效果置 aborted。
- 测试追加 `effect_aborted` 事件，payload 含 effectId/assignmentId/basedOnSeq/reason。
- 测试被 abort 的 handler 不再 emit run_completed/run_failed。
- 测试迟到结论到达时被 T13 的 `effect_aborted` 结构检查作废。

**GREEN**
- inflight Map 保存 AbortController。
- abort 未命中 inflight 但 DB 行 running 时也可置 aborted 并回流事件，用于恢复作废复用。

**完成判据**
- S5 stalled 管道可以只调用 effects.abort，不直接碰执行器内部状态。

## Task T18: startupRecovery 基础序列、pending 与 rerun 策略

**AC**：AC-4.5~4.7、AC-4.11  
**依赖**：T16  
**文件**：
- Create: `src/workitems/recovery.ts`
- Test: `tests/workitems/recovery-basic.test.ts`

**RED**
- 测试恢复日志顺序：`recovery: step 2 rebuild` → `step 3 outbox` → `step 4 reconcile`。
- 测试 pending effect 恢复后不重插行，启动执行器后按原行执行。
- 测试 running 幂等类 effect 恢复后直接重跑同一行并置 done。
- 测试清空 `workitem_events` 后恢复结果与事件完整时一致。

**GREEN**
- `startupRecovery` 只读状态表与 effects 表，不读 events 表。
- 恢复执行器/watchdog 启动前运行。
- 投影校正在恢复 step 2 执行。

**完成判据**
- 恢复基础不依赖 noop；使用测试桩 handler 即可。

## Task T19: resume-or-redispatch 与 artifact 对账

**AC**：AC-4.8~4.10  
**依赖**：T17、T18、T3  
**文件**：
- Modify: `src/workitems/recovery.ts`
- Modify: `src/workitems/artifacts.ts` if needed
- Test: `tests/workitems/recovery-run.test.ts`

**RED**
- 测试 running run effect 且 canResume=true 时调用 handler.resume，原 assignment 续跑，无新 assignment。
- 测试 canResume=false 时原 effect aborted，原 assignment superseded，经 reducer 标准 dispatch 创建新 assignment，replaces 指向原 assignment。
- 测试 artifact 工作区脏时恢复对账提交，工作区变干净，追加 `artifact_reconciled` 事件。
- 测试仓缺失时 reconcile 重建仓并留审计事件。

**GREEN**
- run 类恢复分支复用 EffectRuntime abort/effect_aborted 路径，不直接插新 assignment。
- reconcile 对每个非终态 workitem 幂等执行。

**完成判据**
- 恢复策略覆盖 rerun/resume/redispatch 三路。

## Task T20: G3/G4 流程集成

**AC**：FLOW-3.1、FLOW-3.2、FLOW-4.1、FLOW-4.2 的进程内面  
**依赖**：T16~T19  
**文件**：
- Test: `tests/workitems/reducer-effects-flow.test.ts`

**RED**
- FLOW-3.1：运行期间注入 3 个事件，事件即时 apply，下一次 run 只启动一次且输入含 3 个事件。
- FLOW-3.2：两次过期决策作废后升级 human wait，artifact 不删除。
- FLOW-4.1：pending → running → done 全流水线，执行期间 reducer 继续处理新事件。
- FLOW-4.2 进程内：close/start 模拟恢复，覆盖 pending、rerun、resume、redispatch、reconcile。

**GREEN**
- 只补测试 glue；若发现接口缝隙，优先在前置模块做最小签名修正。

**完成判据**
- Phase 4 完成后，容器已能执行效果并从进程内崩溃窗口恢复。

