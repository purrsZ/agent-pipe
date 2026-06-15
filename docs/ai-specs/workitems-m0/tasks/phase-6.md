# Phase 6: noop 端到端、PID 锁与装配

> 输入：S6-noop-verification.md、Phase 1~5 全部机制。
> 目标：实现 noop 类型、容器装配、kernel 三个触点与进程级验证，最终打穿 M0 全链路。
> 统一验证：每个 Task 完成后运行 `npm run typecheck && npm run lint && npm test`；T32/T33 需在本地真实进程环境执行。

## Task T26: noop WorkType 九成员

**AC**：AC-6.1  
**依赖**：T8、T10、T15、T24  
**文件**：
- Create: `src/worktypes/noop/index.ts`
- Test: `tests/workitems/noop-type.test.ts`

**RED**
- 测试 noop 注册后 id=`noop`，triggers 仅 api，topology=solo，permissions readonly，checkpoints 空，artifacts reportRequired=true。
- 测试 initialPhase 返回 `noop:idle`。
- 测试 onEvent 是纯函数：workitem_created → dispatch；run_completed → timer wait；timer_fired → terminal done；run_failed 根据 assignmentRetries 与 noopMaxRetries 重派或 failed。
- 测试 isDecisionStale 恒 false。

**GREEN**
- NoopParams 从 WorkItem.context 解析并给默认值。
- onEvent 不 import fs/git/AgentPool，不使用 await。

**完成判据**
- noop 类型只依赖 `src/workitems/types.ts`。

## Task T27: noop run handler

**AC**：AC-6.2、AC-6.3、AC-4.8/4.9 的 noop 注入点  
**依赖**：T16、T25、T26  
**文件**：
- Create: `src/worktypes/noop/run-handler.ts`
- Test: `tests/workitems/noop-handler.test.ts`

**RED**
- 测试 delayMs 控制执行时长，FakeClock 下可压缩。
- 测试不调用 AgentPool/Runner，不 spawn agent 进程。
- 测试 failAt=`before-run`、`during-run`、`before-report` 与 failCount 生效；超过 failCount 后成功。
- 测试 heartbeatMode=`silent` 不上报心跳，`normal` 周期心跳，`beat-no-finish` 持续心跳但不完成。
- 测试 simulateResumable=true 且 agent_session_id 存在时 canResume=true；否则 false。
- 测试 report 写入包含 eventsSince(batchFromSeq) 计数。

**GREEN**
- handler 注册 kind=`run`，recovery=`resume-or-redispatch`。
- run 开始写 agent_session_id=`noop:<assignmentId>` 与 brief artifact。
- 成功路径写非空 report，emit run_completed 交 EffectRuntime 收尾。

**完成判据**
- noop handler 能驱动 Phase 3~5 的批量、失败、心跳、墙钟与恢复测试。

## Task T28: WorkitemsContainer

**AC**：AC-6.10 容器侧 start/stop 语义  
**依赖**：T5、T8~T27  
**文件**：
- Create: `src/workitems/container.ts`
- Test: `tests/workitems/container.test.ts`

**RED**
- 测试 createWorkitemsContainer 组装 store/artifacts/registry/reducer/effects/watchdog/api。
- 测试 start 顺序：startupRecovery → executor/watchdog 启动。
- 测试 stop 顺序：watchdog.stop → effects.stopIntake → effects.abortInflight → store.close。
- 测试 running 效果 stop 后保持 running 留库，重新 start 走恢复路径。
- 测试 backupJob 返回可被 kernel backup extraJobs 调用的 BackupJob。

**GREEN**
- 容器接受可选 Clock，生产默认 SystemClock。
- registerNoop 不写在 workitems 层；container 只提供 registry/effects 注入点。

**完成判据**
- 测试装配与未来 index.ts 装配共用同一入口。

## Task T29: kernel config 路径声明

**AC**：AC-6.11  
**依赖**：T28  
**文件**：
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**RED**
- 测试默认 `workitemsDbPath` 为 `$DATA_DIR/workitems.sqlite`。
- 测试默认 `workitemsDir` 为 `$DATA_DIR/workitems`。
- 测试 `WORKITEMS_DB_PATH` 与 `WORKITEMS_DIR` 可覆盖。
- 测试 config.ts 对两项只做路径解析，不解析 workitems 调参。

**GREEN**
- 在现有 config 类型中新增两条路径。
- 不在 kernel config 引入 WorkItem/Assignment/Phase 等业务类型。

**完成判据**
- 架构测试仍绿，config.ts 仅作为路径豁免点。

## Task T30: index.ts 装配与 backup 接线

**AC**：AC-6.10、AC-1.14 装配面  
**依赖**：T28、T29、T4、T5、T26、T27  
**文件**：
- Modify: `src/index.ts`
- Modify: `src/backup.ts` call sites if needed
- Test: `tests/workitems/index-wiring.test.ts`

**RED**
- 测试启动装配调用 createWorkitemsContainer、registerNoop、container.start，且发生在 ensureSingleInstance 之后。
- 测试 releaseResources/crash guard 调用 container.stop。
- 测试 scheduleDailyBackup 接入 container.backupJob，extra job 失败不影响 kernel DB 备份。
- 测试 index.ts 只做接线，不基于 workitem status/phase 做业务判断。

**GREEN**
- 将应用启动主流程拆出可测试的 `createRuntime` 或等价 factory，保持 CLI 行为不变。
- index.ts import `src/workitems/container` 与 `src/worktypes/noop` 是架构豁免内唯一上层 import。

**完成判据**
- 现有 `npm run start` 入口仍可运行。
- kernel 其它模块不出现 workitems 业务词。

## Task T31: noop 进程内端到端

**AC**：AC-6.4、AC-6.5、AC-6.7、FLOW-6.1、FLOW-2.1、FLOW-5.1、FLOW-5.2  
**依赖**：T26~T30  
**文件**：
- Test: `tests/workitems/noop-e2e.test.ts`

**RED**
- 正常旅程：delayMs=100、timerWaitSec=1，最终 done；断言 seq 连续、effects done、wait resolved、status 与权威表一致、git log 提交数 ≥1。
- 持续失败：failCount=Infinity、noopMaxRetries=1，最终 failed；事件日志可审计 run_failed 与 replaces 链。
- 并发 ≥3：混合 delay/fail 参数，各自 seq 独立，A 失败不阻 B。
- FLOW-5.1：heartbeat silent → 重试 → 再 silent → human wait → 到期提醒 → 续期。
- FLOW-5.2：beat-no-finish 心跳正常但墙钟超限，触发 wallclock_exceeded 而非 heartbeat_silent。

**GREEN**
- 使用真实 SQLite + 真实 git 临时目录，FakeClock 驱动时间。
- 只通过 WorkitemsApi 创建与查询，不绕过容器写表。

**完成判据**
- 组合后端到端路径在单进程内全部闭合。

## Task T32: SIGKILL 崩溃恢复进程级测试

**AC**：AC-6.6、FLOW-6.2、FLOW-4.2 进程级复验  
**依赖**：T30、T31  
**文件**：
- Create: `tests/fixtures/workitems-app.ts`
- Test: `tests/workitems/noop-crash.test.ts`

**RED**
- 测试父进程 spawn fixture，轮询 workitems.sqlite 等 effect 进入 pending 窗口后 SIGKILL，重启后最终终态。
- 测试 running 窗口 SIGKILL：simulateResumable=true 续跑原 assignment；simulateResumable=false 作废重派。
- 断言重启后 seq 续写不回退、无双跑副作用、无无人推进中间态。
- 断言 DB 与 git 尾部不一致时 startup reconcile 提交，工作区干净。

**GREEN**
- fixture 用 `tsx` 运行；package.json 已有 devDependency `tsx`，无需新增依赖。
- 通过环境变量传 DATA_DIR、NOOP_PARAMS、启动模式；父测试使用真实 sqlite 轮询窗口。

**完成判据**
- 进程级测试不 mock DB/git/signals。
- SIGKILL 后子进程被 wait 清理，无残留。

## Task T33: PID 锁 takeover 与退出清理验证

**AC**：AC-6.8、AC-6.9、FLOW-6.3  
**依赖**：T32  
**文件**：
- Modify: `tests/lifecycle.test.ts`
- Test: `tests/workitems/pid-takeover.test.ts`

**RED**
- 复用/补充 removeOwnPidFile 回归：锁文件内容为新 pid 时旧实例清理返回 false，文件保留。
- 真实进程 A 持锁后 spawn B 竞争同一 DATA_DIR：A 收 SIGTERM 并 exit 0，B 持锁运行，锁文件内容等于 B.pid。
- 轮询断言任意时刻最多一个实例通过“ready marker + pid alive”判定为 active。
- 断言 B 退出时只删除自己的锁。

**GREEN**
- 不修改 `src/lifecycle.ts`，只按 ADR-2 的 takeover 语义核定测试。
- fixture 支持 ready marker 与 graceful SIGTERM。

**完成判据**
- PID 锁语义被进程级测试固定：takeover 可发生，但锁文件只属于当前存活实例。

