# workitems-m0 — 任务总览（Step 3）

> 交接说明：Step 3 总览初稿来自前序 Claude 模型；`phase-1.md`~`phase-6.md` 详细任务文件及后续维护自 execution-log `[022] 模型交接标记` 起由 Codex / GPT-5 接手。
> 输入：spec/ 全部 8 文件（_index + overview + S1~S6，38 Gap 已落定 + ADR-1~11）
> 口径：76 条点状 AC + 13 条 Flow AC 全覆盖（核对表见文末）；TDD 硬约束（每 Task RED→GREEN→验证）；不写业务代码、本目录只产出任务清单。
> has_ui=否：全部 Task 均为非视觉行为，一律以单元/集成/进程级测试验证，不再逐条标注 [non-visual]。
> 验证命令（每 Task 统一）：`npm run typecheck && npm run lint && npm test`

## Phase 索引

- [Phase 1: 存储与数据基座](phase-1.md) — AC-1.1~1.14、FLOW-1.1、AC-6.12（架构守护测试提前落地）、AC-2.13（签名面）
- [Phase 2: 生命周期、投影与创建路径](phase-2.md) — AC-2.1~2.6、AC-2.8、AC-2.10（纯函数面）、AC-2.13（注册表面）、FLOW-2.2
- [Phase 3: reducer 运行时与决策防错](phase-3.md) — AC-3.1~3.4、AC-3.6、AC-3.8~3.12、AC-4.1~4.2、AC-2.7/2.9/2.11/2.12（集成面）
- [Phase 4: 效果 outbox 与崩溃恢复](phase-4.md) — AC-3.5、AC-3.7、AC-4.3~4.12、FLOW-3.1/3.2/4.1/4.2
- [Phase 5: 等待与活性监督](phase-5.md) — AC-5.1~5.13、FLOW-5.3
- [Phase 6: noop 端到端、PID 锁与装配](phase-6.md) — AC-6.1~6.11、FLOW-6.1~6.3、FLOW-2.1、FLOW-5.1/5.2、FLOW-4.2（进程级复验）

## 依赖关系

- Phase 1 无依赖（基础层：types/store/artifacts/backup + 架构守护测试）
- Phase 2 依赖 Phase 1（registry/projection/创建路径读写 WorkitemsStore，类型契约来自 types.ts）
- Phase 3 依赖 Phase 2（applyEvent 调 registry/computeRollup；bootstrapApply 骨架在 Phase 2 建立，本 Phase 完整化）
- Phase 4 依赖 Phase 3（执行器消费 reducer 写入的 outbox 行、结论事件经 enqueue 回流）
- Phase 5 依赖 Phase 3（创建校验/stalled 处置在 reducer 转移事务内）+ Phase 4 的 T16/T17（lastBeat/heartbeat 与 abort 中止通道）；其余 Task 可与 Phase 4 并行推进
- Phase 6 依赖 Phase 4 + Phase 5（noop 打穿全部机制组合；kernel 触点接线最后做）

Phase 内 Task 依赖已在各 phase 文件逐条显式标注（同文件增量实现的 Task 串行，其余可并行）。

## 统计

- 总 Phase 数: 6
- 总 Task 数: 33（T1~T33，全局连续编号）
- 预计涉及文件数: ≈34（src/workitems/ 14 + src/worktypes/noop/ 2 + kernel 触点 3 + tests/ ≈15）
- kernel 触点 Task（单独成 Task，标注「触碰 kernel，改动最小化」）：T4（src/backup.ts）、T29（src/config.ts）、T30（src/index.ts）
- 进程级测试 Task（需 tests/fixtures/workitems-app.ts 最小装配）：T32（SIGKILL）、T33（PID 锁 takeover）

## Phase 一览（目标与完成判据）

| Phase | 名称 | 目标 | 依赖 | AC 范围 | 完成判据 |
|---|---|---|---|---|---|
| 1 | 存储与数据基座 | workitems.sqlite 五表 + ArtifactStore git 仓 + 备份扩展 + 架构守护测试上线 | 无 | AC-1.1~1.14, FLOW-1.1, AC-6.12 | 全量验证命令绿；tests/backup.test.ts 既有用例回归全绿；FLOW-1.1 四面互查通过；architecture.test.ts 即刻生效 |
| 2 | 生命周期、投影与创建路径 | registry/computeRollup 纯函数/createWorkItem 创建事务 | P1 | AC-2.1~2.6, 2.8, 2.10, 2.13, FLOW-2.2 | 创建路径 6 AC + FLOW-2.2 集成通过；rollup 矩阵单测全绿 |
| 3 | reducer 运行时与决策防错 | per-item FIFO/applyEvent 主流程/单飞合并/结构检查/防颠簸 | P2 | AC-3.1~3.4, 3.6, 3.8~3.12, 4.1~4.2, 2.7/2.9/2.11/2.12 | 串行与 seq 断言、同事务原子回滚、作废与升级路径、phase 两承诺集成全部通过 |
| 4 | 效果 outbox 与崩溃恢复 | EffectRuntime 执行器/中止通道/startupRecovery 三策略/对账 | P3 | AC-3.5, 3.7, 4.3~4.12, FLOW-3.1/3.2/4.1/4.2 | 三策略恢复（进程内 close+start）零双跑零丢失；四条 FLOW 集成通过 |
| 5 | 等待与活性监督 | wait/assignment 创建校验/watchdog tick/stalled 管道/resolve 入口/收尾校验 | P3 + P4(T16,T17) | AC-5.1~5.13, FLOW-5.3 | FakeClock+手动 tick 驱动全部到期/升级路径；resolve 幂等；FLOW-5.3 通过 |
| 6 | noop 端到端、PID 锁与装配 | noop 类型 + container 装配 + kernel 触点 + 进程级验证 | P4 + P5 | AC-6.1~6.11, FLOW-6.1~6.3, FLOW-2.1, FLOW-5.1/5.2 | 五面交叉一致到 done/failed；SIGKILL 双窗口恢复；takeover 全程单实例；AC 覆盖核对表闭合 |

## AC → Task 覆盖核对表

### G1 存储与数据基座（S1）

| AC | Task | 备注 |
|---|---|---|
| AC-1.1 | T2 | 独立 DB + WAL + FK + 五表 |
| AC-1.2 | T2 | PRAGMA user_version migration |
| AC-1.3 | T2 | workitems 主表 schema |
| AC-1.4 | T2 | UNIQUE(type, dedupe_key) |
| AC-1.5 | T2 | assignments 表 + replaces 链 |
| AC-1.6 | T2 | waits 表 + origin FK |
| AC-1.7 | T2 | effects 表 |
| AC-1.8 | T2 | events append-only + UNIQUE(workitem_id, seq) |
| AC-1.9 | T3 | 每项独立 git 仓 |
| AC-1.10 | T3 | 一写一提交 |
| AC-1.11 | T3 | 正文不入库（dep T2） |
| AC-1.12 | T5 | T4 提供命名分流支撑（G-1.5） |
| AC-1.13 | T5 | tar 含 .git |
| AC-1.14 | T4, T5 | extraJobs 隔离 + 双向不连坐 |
| FLOW-1.1 | T7 | 存储全链路集成测试 |

### G2 容器生命周期与状态投影（S2）

| AC | Task | 备注 |
|---|---|---|
| AC-2.1 | T10 | 创建事务 + 创建事件 |
| AC-2.2 | T10 | TypeNotRegisteredError 零落库 |
| AC-2.3 | T10 | dedupe 静默幂等（G-2.3） |
| AC-2.4 | T10 | NULL 键双建 |
| AC-2.5 | T10 | OpenLimitError |
| AC-2.6 | T10 | 非终态口径 + WORKITEMS_MAX_OPEN 重装配 |
| AC-2.7 | T15 | 生命周期流转集成（桩类型驱动） |
| AC-2.8 | T9 | 纯函数优先级矩阵（T15 集成复验） |
| AC-2.9 | T15 | 投影不钳制执行 |
| AC-2.10 | T9, T11 | 纯函数冻结 + reducer 终态短路 |
| AC-2.11 | T15 | phase 回退 + phase_changed |
| AC-2.12 | T15 | 逐字节回读；静态面归 T6 规则(5) |
| AC-2.13 | T1, T8 | 接口签名（tsc）+ 注册表重复拒绝 |
| FLOW-2.1 | T31 | S2 测试策略明示由 S6 noop 端到端覆盖 |
| FLOW-2.2 | T10 | 幂等×上限协同 |

### G3 reducer 运行时与决策防错（S3）

| AC | Task | 备注 |
|---|---|---|
| AC-3.1 | T11 | FIFO + 同步 drain |
| AC-3.2 | T11 | 事务内 MAX(seq)+1 |
| AC-3.3 | T11 | 跨 item 独立 |
| AC-3.4 | T11 | 纯转移 + postCommit 时序 |
| AC-3.5 | T16 | 结论以事件回流（执行器 emit） |
| AC-3.6 | T12 | 单飞合并 wake_pending |
| AC-3.7 | T12, T16, T20 | 落库面 / batchFromSeq 窗口（ADR-6）/ FLOW-3.1 终验 |
| AC-3.8 | T12 | effect.seq 即 based_on_seq（ADR-3） |
| AC-3.9 | T13 | structuralCheck assignment 分支 |
| AC-3.10 | T13 | structuralCheck wait 分支 |
| AC-3.11 | T13 | isDecisionStale 时机 + 开区间（G-3.7） |
| AC-3.12 | T14 | 防颠簸 streak→human wait |
| FLOW-3.1 | T20 | 单飞-排队-批量唤醒-回流闭环 |
| FLOW-3.2 | T20 | 作废-防颠簸升级链 |

### G4 效果 outbox 与崩溃恢复（S4）

| AC | Task | 备注 |
|---|---|---|
| AC-4.1 | T12 | 效果写入在 applyTransitionWrites 事务内（S4 设计节明示归 S3 代码） |
| AC-4.2 | T12 | 注入失败全回滚 |
| AC-4.3 | T16 | running 置位 + reducer 不阻塞 |
| AC-4.4 | T16 | 终态不再拾取（ADR-11 终态化路径） |
| AC-4.5 | T18 | 恢复序列三步日志顺序 |
| AC-4.6 | T18 | pending 重新入队零重插 |
| AC-4.7 | T18 | rerun 直接重跑 |
| AC-4.8 | T19 | canResume 续跑 |
| AC-4.9 | T19 | 作废 + replaces 重派 |
| AC-4.10 | T19 | artifact 对账 + artifact_reconciled |
| AC-4.11 | T18 | 清空 events 后恢复不变 |
| AC-4.12 | T17 | abort 通道 + effect_aborted |
| FLOW-4.1 | T20 | pending→running→done 流水线 |
| FLOW-4.2 | T20, T32 | 进程内 close+start / 进程级 SIGKILL 复验 |

### G5 等待与活性监督（S5）

| AC | Task | 备注 |
|---|---|---|
| AC-5.1 | T21 | WaitSpec 校验，无禁用开关 |
| AC-5.2 | T22 | 到期必有事件 + resolve 免疫 |
| AC-5.3 | T22 | human 单次提醒（reminded_at） |
| AC-5.4 | T24 | renewWait 唯一改期入口 |
| AC-5.5 | T23 | agent_wait_expired 入 stalled 管道 |
| AC-5.6 | T22 | timer_fired 即 resolve |
| AC-5.7 | T21 | 监督参数必填正数，事务回滚 |
| AC-5.8 | T22 | 心跳静默 → assignment_stalled |
| AC-5.9 | T23 | 预算内 superseded + replaces 链 |
| AC-5.10 | T23 | 耗尽 failed + human wait（origin 溯源） |
| AC-5.11 | T22, T23 | 墙钟触发面 / stalled 处置面（中止机制为 T17） |
| AC-5.12 | T25 | 收尾 report 校验钩子 |
| AC-5.13 | T24 | resolve 幂等拒绝 + timer 不开放 |
| FLOW-5.1 | T31 | 跨组标注 noop 驱动（G6），归端到端 Task |
| FLOW-5.2 | T31 | 同上（墙钟独立防线） |
| FLOW-5.3 | T22 | timer 生命周期（桩类型即可驱动） |

### G6 noop 类型与单实例全路径验证（S6）

| AC | Task | 备注 |
|---|---|---|
| AC-6.1 | T26 | noop 九成员 |
| AC-6.2 | T27 | 可控延时 + 零 AgentPool |
| AC-6.3 | T27 | failAt/failCount 注入（G-6.5） |
| AC-6.4 | T31 | 五面交叉一致到 done |
| AC-6.5 | T31 | 持续失败到 failed 可审计（ADR-9 路径） |
| AC-6.6 | T32 | SIGKILL 双窗口恢复 |
| AC-6.7 | T31 | 并发 ≥3 互不串扰 |
| AC-6.8 | T33 | takeover 断言形态（ADR-2 核定） |
| AC-6.9 | T33 | removeOwnPidFile 回归（6329d35） |
| AC-6.10 | T28, T30 | 容器侧 start/stop 语义 / kernel 接线 |
| AC-6.11 | T29 | config 路径声明零语义 |
| AC-6.12 | T6 | 架构守护测试（Phase 1 提前落地） |
| FLOW-6.1 | T31 | noop 正常全生命周期 |
| FLOW-6.2 | T32 | 崩溃恢复旅程（含对账断言） |
| FLOW-6.3 | T33 | 双实例竞争与退出清理 |

**核对结论**：76 条点状 AC 与 13 条 Flow AC 全部映射到至少一个 Task，无遗漏；Flow AC 全部落在集成/进程级测试 Task（T7/T10/T20/T22/T31/T32/T33）。

## 设计反馈（拆分中发现的问题与裁决）

1. **（裁决）S2 创建路径与 S3 reducer 的文件级耦合**：`createWorkItem` 经 `reducer.bootstrapApply` 落库（S2 设计节伪代码），而 `applyTransitionWrites` 的完整语义（校验/单飞合并）属 S3/S5。拆分为：T10 先落「行直插」最小骨架，T12（完整化+单飞）、T21（校验）增量补齐——同文件 Task 串行并显式标依赖，非设计缺口。
2. **（裁决）FLOW-5.1/5.2 验证时点后移**：两条 Flow 的 spec 跨组标注均含「G6（noop 驱动）」，故全链路用例归 Phase 6 T31（noop 心跳模式驱动）；Phase 5 内以可编程桩 handler 覆盖各点状 AC（含「预算耗尽链」场景），不留验证真空。
3. **（裁决）AC-3.7 跨 Task 验证**：wake_pending 落库面在 T12、batchFromSeq 窗口（ADR-6）在 T16、端到端断言在 T20（FLOW-3.1）——单 Task 无法独立闭环此 AC，已在核对表三处标注。
4. **（裁决）AC-4.1/4.2 的归属**：S4 设计节明示「效果行写入发生在 S3 applyTransitionWrites 事务内」，故两 AC 的实现与测试归 Phase 3 T12，Phase 4 不重复造任务。
5. **（待执行期确认）fixture 运行时依赖**：spec/overview.md 测试策略写明进程级测试「spawn 子进程跑 tests/fixtures/workitems-app.ts，经 tsx」——本步骤未核查 package.json（超出输入范围），T32 落地时需确认 tsx 在 devDependencies；若无则改为 vitest 内 tsc 预编译或复用项目既有子进程运行方式，不引新依赖需在该 Task 内裁决。
6. **设计缺口**：除上述第 5 条待确认项外未发现——38 Gap 与 ADR-1~11 已将拆分所需的全部接缝（字段载体、事件契约、恢复策略、超时分工、锁语义）落定，各 Task 均能从 spec 直接导出测试断言。
