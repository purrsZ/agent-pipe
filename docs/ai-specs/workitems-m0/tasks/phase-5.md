# Phase 5: 等待与活性监督

> 输入：S5-waits-watchdog.md、Phase 3 reducer、Phase 4 effects abort/heartbeat 能力。
> 目标：让 wait 到期、watchdog 活性监督、stalled 重试/升级、resolve/renew、收尾 artifact 校验全部闭合。
> 统一验证：每个 Task 完成后运行 `npm run typecheck && npm run lint && npm test`。

## Task T21: wait 与 assignment 创建校验

**AC**：AC-5.1、AC-5.7  
**依赖**：T12  
**文件**：
- Modify: `src/workitems/reducer.ts`
- Test: `tests/workitems/wait-assignment-validation.test.ts`

**RED**
- 测试 WaitSpec 非 human/agent/timer 拒绝，事务回滚。
- 测试缺 deadlineTtlSec、0、负数、非有限数拒绝。
- 测试 agent wait 缺 originAssignmentId 或 origin 不存在拒绝。
- 测试 AssignmentSpec 缺 deadlineTtlSec/wallclockCapSec 或非正数拒绝，assignment 与 run effect 均不存在。
- 测试远期 deadline 合法，后续到期仍可触发动作。

**GREEN**
- 在 applyTransitionWrites 内统一校验 WaitSpec/AssignmentSpec。
- deadline_at 由 Clock.now + ttl 计算，外部不能直接传绝对值。

**完成判据**
- “必带到期动作”和“监督参数必填”成为事务级不变量。

## Task T22: Watchdog tick、wait 到期与活性入口

**AC**：AC-5.2、AC-5.3、AC-5.5、AC-5.6、AC-5.8、AC-5.11、FLOW-5.3  
**依赖**：T16、T17、T21  
**文件**：
- Create: `src/workitems/watchdog.ts`
- Test: `tests/workitems/watchdog.test.ts`

**RED**
- FakeClock 推进到 human wait deadline，连续 3 次 tick 只产生 1 条 `wait_reminder`，不调用飞书。
- resolve 后再到期不产生任何事件。
- timer 到期产生 `timer_fired`，apply 后 wait resolved。
- agent wait 到期产生 `assignment_stalled(reason='agent_wait_expired')`。
- running assignment 心跳静默超过 cfg.heartbeatTimeoutSec 产生 `assignment_stalled(reason='heartbeat_silent')`。
- heartbeat 正常但 wallclock 超限产生 `assignment_stalled(reason='wallclock_exceeded')`，且无 heartbeat_silent。
- 同一 tick 多源超时只产生一条 stalled，优先级 wallclock > heartbeat > deadline。

**GREEN**
- `Watchdog.tick()` 只 enqueue 事件，不直接写 DB。
- `start()` 使用 unref interval，`stop()` 清理定时器。
- lastBeat 来自 EffectRuntime 内存 Map，缺省回退 assignment.started_at/created_at。

**完成判据**
- 所有时间测试用 FakeClock 手动驱动，无真实 sleep。

## Task T23: stalled 处置、重派链与升级 human wait

**AC**：AC-5.9、AC-5.10、AC-5.11 后半、FLOW-5.1/5.2 的处置面  
**依赖**：T17、T22  
**文件**：
- Modify: `src/workitems/reducer.ts`
- Test: `tests/workitems/stalled.test.ts`

**RED**
- 测试预算内 stalled：旧 assignment status=superseded，postCommit 调 effects.abort，新 assignment replaces 旧 assignment，retries+1。
- 测试预算耗尽：assignment status=failed，创建 human wait，origin 指向失败 assignment，追加 `assignment_retry_exhausted`。
- 测试重复 stalled 事件在 assignment 已非 running 时零动作。
- 测试 agent wait 到期但 origin 已 done：直接 resolve 该 wait，reason=`origin_terminal`，连续 tick 不刷屏。
- 测试 effect_aborted 迟到时不二次重派。

**GREEN**
- containerMechanics 在 run WorkType.onEvent 前处理 stalled/effect_aborted/wait 生命周期事件。
- 重派参数复制旧 assignment 的 deadline/cap/repo/role，并写入失败摘要 brief。

**完成判据**
- replaces 链可从新节点导航回原节点。
- Stalled 三入口共用一条处置路径。

## Task T24: resolveWait 与 renewWait API

**AC**：AC-5.4、AC-5.13  
**依赖**：T22、T23  
**文件**：
- Modify: `src/workitems/api.ts`
- Modify: `src/workitems/reducer.ts`
- Test: `tests/workitems/wait-api.test.ts`

**RED**
- 测试 human wait renew 后 renewed_count+1、deadline_at 更新、reminded_at 清空，到新 deadline 可再次提醒。
- 测试除 renewWait 外没有裸改 deadline_at 的生产调用点。
- 测试 resolve human/agent wait 后 resolved_at/resolved_by/resolve_reason 写入，追加 wait_resolved，rollup 与 watchdog 不再读取。
- 测试重复 resolve 返回 alreadyResolvedAt，不产生新事件。
- 测试 timer wait 主动 resolve 抛 `TimerNotResolvableError`。

**GREEN**
- `resolveWait`/`renewWait` 通过 reducer.enqueue 进入同步 apply。
- `wait_resolved` 与 `wait_renewed` 事件在 containerMechanics 层更新 wait 行。

**完成判据**
- human/agent wait 的主动消解入口与 S2/S3 的引用检查闭合。

## Task T25: 收尾 artifact 校验

**AC**：AC-5.12  
**依赖**：T16、T3  
**文件**：
- Modify: `src/workitems/effects.ts`
- Test: `tests/workitems/report-validation.test.ts`

**RED**
- 测试 run handler 写出非空 `assignments/<id>/report.md` 时 emit run_completed。
- 测试 report 缺失、空文件、只含空白时 emit run_failed(error='artifact_missing')，assignment 最终 failed 或进入类型失败路径。
- 测试 handler 不能绕过校验直接完成。

**GREEN**
- EffectRuntime 在 run handler 返回后、emit run_completed 前执行 report 校验。
- reportRequired 来自 WorkType.artifacts，M0 noop 为 true；不要求 report 的类型可跳过。

**完成判据**
- “义务代码化”在效果运行时强制执行，而非依赖 prompt。

