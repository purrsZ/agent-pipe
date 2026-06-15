# v3 — workitems-m0 实现完成度核查 + 方案漏洞 + Code Review

> 日期：2026-06-12
> 范围：docs/design/2026-06-11-workitem-macro-design.md（总计划）、docs/ai-specs/workitems-m0/spec/*（细化方案）、src/workitems/*、src/worktypes/noop/*、kernel 触点（backup.ts/config.ts/index.ts）、tests/*
> 方法：总计划 §11 M0 清单逐项对照源码；spec S1~S6 设计节与实现逐文件交叉比对；全部 ~2900 行新源码逐行评审
> 基线：`npm run check` 37 文件 / 192 测试全绿（评审时实测）

---

## 一、实现完成度结论：M0 范围内全部实现 ✅

对照总计划 §11 M0 行 + 编排裁决 D-003~D-006，18 项交付全部落地：

| # | 设计要求 | 实现位置 | 状态 |
|---|---|---|---|
| 1 | 独立 workitems.sqlite 五表（WAL/FK/UNIQUE/append-only 触发器） | store.ts migration v1 | ✅ |
| 2 | 每 workitem 单 reducer（FIFO、seq 单调、纯转移+效果声明） | reducer.ts | ✅ |
| 3 | 效果 outbox 同事务 + 崩溃恢复分策略（rerun / resume-or-redispatch） | reducer.applyTransitionWrites + recovery.ts + effects.recoverRun/recoverRunning | ✅ |
| 4 | 单飞 + 批量带入（wake_pending + batchFromSeq，ADR-1/6） | reducer.insertDispatchOrWake + store.lastRunEffectSeqBefore | ✅ |
| 5 | 过期决策防错（结构检查 + isDecisionStale + 防颠簸 ≥2 升级） | reducer.checkDecision/handleDiscardedDecision | ✅ |
| 6 | rollup 投影（human > active > agent > timer，终态冻结，不钳制执行） | projection.ts | ✅ |
| 7 | 按 kind 到期动作（human 单次提醒+续期 / agent stalled / timer 即 resolve） | watchdog.tick + reducer.containerTransition | ✅（但见问题 P1-1） |
| 8 | watchdog 心跳/墙钟/deadline 三防线，预算默认 1，耗尽升级 human wait | watchdog.ts + reducer.handleStalledAssignment | ✅（但见问题 P1-2） |
| 9 | 每工作项独立 git 仓、一写一提交、reconcile | artifacts.ts | ✅ |
| 10 | noop 类型打穿全部路径 | worktypes/noop/* + ~25 个测试文件 | ✅（phase 面除外，见 P3-12） |
| 11 | PID 锁单实例验证（lifecycle.ts 只测不改，takeover 语义 ADR-2） | tests/workitems/pid-takeover.test.ts | ✅ |
| 12 | 备份扩展（workitems.sqlite + workitems-files tar 含 .git + 失败隔离） | src/workitems/backup.ts + kernel backup.ts extraJobs | ✅ |
| 13 | open ≤3 enforce（终态不占名额） | reducer.bootstrapApply + OpenLimitError | ✅ |
| 14 | WorkType 九成员接口 | types.ts | ✅ |
| 15 | 仅编程 API 入口 | api.ts（无 CLI/飞书命令） | ✅ |
| 16 | 架构守护（依赖单向 + kernel 业务词扫描，index/config 豁免） | tests/architecture.test.ts | ✅ |
| 17 | 收尾 report 非空校验（义务代码化） | effects.validateRunReport | ✅ |
| 18 | 启动恢复四步（锁 → 状态表 → outbox → artifact 对账） | index.ts ensureSingleInstance + recovery.ts | ✅ |

**明确延期项（有据可查，非遗漏）**：飞书提醒/锚点卡片（EX-6）、真 runner 心跳多路复用（M1b+）、knowledge/ 备份（M1b）、kernel 调度排队（M1a）、isDecisionStale 实战（M3，M0 仅接口 + noop 恒 false，D-004）。

---

## 二、细化方案（spec）漏洞

### S-1【高】S4 内部矛盾：effect_aborted 重派是否消耗重试预算
S4 §3（中止通道）写「assignment → superseded/failed + **按预算重派或升级**（S5 stalled 管道复用）」；S4 §4（恢复序列）伪代码却是无条件 `superseded + dispatch(replaces, retries+1)`，不查预算。实现跟了 §4（reducer.ts:291-316 containerTransition）。后果：non-resumable 的 run effect 遇进程反复崩溃 → 每次重启都作废重派，retries 无界增长，**永远不会升级 human wait**。规格需明确恢复重派是否计入预算；建议计入（与 stalled 管道一致）。

### S-2【高】S5 stalled 重派的「原参数」语义歧义
S5 §3 伪代码写 `dispatch:[{...原参数, replacesAssignmentId, retries+1}]`，未定义 deadline 取「原 TTL」还是「原绝对 deadline 的剩余」。实现取了剩余时间（见 P1-2），在 deadline_exceeded 场景下自毁。规格应明示：重派的 deadline 应重新计满（新 assignment 新约定），并补「失败摘要进 brief」的落点（实现完全丢弃了 brief，见 P3-13）。

### S-3【高】作废结论不关闭发起 assignment（spec 与实现同病）
S3 §2 伪代码的 discard 路径（decision_discarded → streak → 重唤醒 → return）从不触碰结论所属 assignment 的状态。对 reason ∈ {semantically_stale, wait_resolved, assignment_terminal(refs)}，发起 assignment 仍是 running 且永远无人收尾 → watchdog 约 60 秒后将其 stalled → **再次重派**，叠加 discard 路径自己的重唤醒派发，一次作废最多催生 3 个 assignment。M0 noop 不可达（无 refs、stale 恒 false），但这是容器契约级缺口，M3 isDecisionStale 实战前必须封堵。

### S-4【中】终态 workitem 与 open waits / running assignments 的交互未定义
Transition.terminal 只改 status；既有 open waits 与 running assignments 无任何清理。watchdog 全局扫描（listOpenWaits/listRunningAssignments 不过滤工作项状态），而 reducer 终态短路只追加审计事件、**不消费**（不置 remindedAt、不 resolve、不处置 stalled）。组合结果：终态项上一个过期 wait → watchdog 每 tick（默认 1s）enqueue 一次 → 审计事件表无限增长。noop 的事件序恰好规避（timer resolve 与 terminal 同事务），但规格应明确「终态化时容器自动 resolve open waits / supersede running assignments」或「watchdog 跳过终态项」。

### S-5【中】wait_resolved 之后的推进义务无契约
human wait（thrash/retry_exhausted）被 resolveWait 后，容器只置 resolved + 调 type.onEvent(wait_resolved)。类型若返回 {}（noop 即如此）→ workitem 落入「非终态、无 wait、无 assignment、无 effect」的静止态，**任何机制都不会再推进它**（watchdog 只盯 wait 和 running assignment）。「没有无人过问的等待」不变量没有覆盖「没有等待的非终态项」。需要：(a) WorkType 契约文档写明「类型必须在 wait_resolved 上决定后续动作」，或 (b) 容器对该静止态提供兜底（如自动 defaultDispatch 或升级提醒）。

### S-6【中】同一 apply 内多个审计事件的 seq 分配规则未定义
spec 在三处硬编码 `seq+1`（phase_changed、thrash_escalated、assignment_retry_exhausted），另有 wait_resolved(origin_terminal) 用 nextSeq。任何「同一 apply 双写」组合（如类型对 assignment_stalled 声明 phase 转移 + 容器同时写 retry_exhausted）会撞 UNIQUE(workitem_id, seq)，整事务回滚、事件丢失。M0 noop 不触发，但这是埋给 M3 的雷。规格应统一为「事务内连续 nextSeq 分配」。

### S-7【低】spec 声明了 `api.injectEvent` 但从未实现
overview 模块索引与 S2 接口段均含 injectEvent（「测试/未来触发器注入」），实现没有（grep src/tests 零命中，测试直接用 reducer.enqueue）。文档与代码漂移，二选一：补实现或从 spec 划掉。

### S-8【低】S6 设计的 noop phase 流转未落实
S6 设计 noop:idle → running → waiting → done/failed 四段 phase；实现 noop 的 phase 恒为 'noop:idle'。AC-2.11/2.12 靠 T15 桩类型覆盖，端到端层面 phase_changed 没有被 noop 打穿。

---

## 三、Code Review 发现（按严重度）

### P1（高 — 生产可达的行为缺陷）✅ 已全部修复（2026-06-12，见 execution-log [057]）

> 修复摘要：P1-1 watchdog 去掉 running 门禁（+watchdog.test 真实 tick 回归）；P1-2/P1-4 重派统一收敛
> `redispatchOrEscalate`（原 TTL 重计 + 预算检查，+stalled.test 三个回归）；P1-3 作废路径
> `closeDiscardedAssignment`（reducer-thrash/decisions 断言更新为修正后契约）。
> spec S3/S4/S5 对应位置已加〔已修正 · v3 评审〕标注。`npm run check` 37 files / 196 tests 全绿。

**P1-5（修复回归中追加发现，已修复，见 execution-log [058]）：重派 pending effect 无执行驱动**
- 恢复重派 / stalled 替换产出的 pending run effect 没有任何 poke 来源：executeEffect finally 的
  条件 poke（D-048）偏离了 S4 §2 伪代码的无条件 `finally{poke}`，recovery abort 路径更是无 finally。
  真实崩溃后替代任务永不执行 → watchdog ~1s 误判 heartbeat_silent → 预算耗尽 → 卡死 waiting(human)。
- **长期被测试基建缺陷掩盖**：noop-crash 经 tsx bin wrapper spawn，SIGKILL 只杀 wrapper，孤儿化的
  fixture 真进程（"幽灵进程"）继续驱动共享 DB 里的重派 effect，测试假绿；偶发失败即幽灵进程赛跑落败。
- 修复：reducer post-commit poke（落实 G-4.1/overview 第 7 步）+ finally 无条件 poke（D-066 推翻
  D-048）+ 测试改 `process.execPath --import tsx` 直接 spawn 真进程；noop-e2e 移除 D-062 手动 poke。

**P1-1 watchdog 漏发「origin 已终态的过期 agent wait」事件 → 悬空 wait 永不 resolve（ADR-8 生产不可达）**
- 位置：`src/workitems/watchdog.ts:69-80`
- 现象：agent wait 到期时实现要求 `assignment?.status === 'running'` 才产生 stalled 候选；origin 已正常完结（done/failed/superseded）时什么都不发。reducer 侧 ADR-8 的早退 resolve 分支（reducer.ts:421-451 resolveOriginTerminalWait）只能由 assignment_stalled 事件触发——事件不来，分支永不执行。
- 后果：agent wait 在 origin 先完结后过期 → 永久 open → rollup 卡 waiting(agent)，僵尸工作项。
- 佐证：S5 设计伪代码是**无条件** `stalledCandidates.add(...)`；tests/workitems/stalled.test.ts:169-198 通过**手工 enqueue** 事件绕过 watchdog 测过 reducer 分支，掩盖了 watchdog 侧断链。
- 建议：去掉 running 门禁（reducer 侧本就幂等），或 origin 非 running 时直接 enqueue 带 waitId 的 stalled 事件。

**P1-2 stalled 重派继承「剩余 deadline」→ deadline_exceeded 的重试必死**
- 位置：`src/workitems/reducer.ts:412`（`deadlineTtlSec: Math.max(1, Math.ceil((assignment.deadlineAt - now) / 1000))`）
- 现象：reason=deadline_exceeded 时剩余时间 ≤0，被 clamp 成 1 秒 → 替代 assignment 的 deadline 1 秒后必然再次 stalled → 预算瞬间烧光 → human wait。重试预算形同虚设。
- 对比：effect_aborted 重派路径用 `cfg.defaultDeadlineTtlSec`（reducer.ts:309），两条重派路径行为不一致。
- 建议：统一为重新计满（沿用 cfg.defaultDeadlineTtlSec 或持久化原 TTL）。

**P1-3 作废结论后发起 assignment 残留 running（同 S-3，实现层确认）**
- 位置：`src/workitems/reducer.ts:152-163`（discard 路径无 updateAssignment）
- M0 noop 不可达；但 reducer 作为容器核心，此缺口随 isDecisionStale 实战（M3）必然引爆。修复点：discard 路径中将发起 assignment（status='running' 且非 superseded 时）一并终态化（建议 failed 或 superseded + 事件留痕）。

**P1-4 effect_aborted 重派无预算检查（同 S-1，实现层确认）**
- 位置：`src/workitems/reducer.ts:291-316`
- 崩溃循环（canResume=false + 进程反复死）下 retries 无界增长、永不升级给人。建议复用 handleStalledAssignment 的预算分支。

### P2（中 — 边界/健壮性，建议 M1 前处理）

**P2-1 reducer apply 异常无隔离，单个坏事件可拖垮整个桥**
watchdog.tick / EffectRuntime emit 调 reducer.enqueue 均无 try/catch。apply 内任何异常（坏 payload 断言、SQLITE_BUSY、UNIQUE 撞 seq）会沿 setInterval 回调上抛 → uncaughtException → crash guard → **整进程退出重启**（kernel + 飞书桥陪葬）；且 enqueue 队列中未处理的事件被搁置到下一次同 workitem enqueue 才会续 drain。建议 tick/emit 侧按 workitem 粒度 try/catch + 错误事件留痕。

**P2-2 崩溃窗口下 recoverRun 会 resume 已 superseded 的 assignment**
stalled 重派的事务提交与 postCommit abort 之间崩溃 → DB 残留旧 running run effect + 新 pending run effect。重启后 recoverRun 对旧 effect 调 canResume（noop 只看 simulateResumable + agentSessionId，**不查 assignment 状态**）→ 可能续跑已被替代的 assignment，结论回流后被 structuralCheck 作废并误计 discardStreak。建议 recoverRun 先查 assignment.status，非 running 直接走 abort 作废。

**P2-3 drainOne 的 missing-handler 路径不发 effect_aborted（与 recoverRunning 不一致）**
`effects.ts:151-160` 直接 setEffectStatus('aborted') 不通知 reducer；`recoverRunning` 同场景走 `abort()`（有事件回流）。前者使关联 assignment 悬挂 running，直到 watchdog 心跳静默才被收拾（约 60s 延迟 + 一次冤枉重试）。建议统一走 abort()。

**P2-4 AssignmentSpec.brief 文本被静默丢弃**
`reducer.ts:483`：spec.brief 只被当作「是否记 briefPath」的布尔用，文本内容无任何落盘路径（容器不写、handler 不可见）。S5 设计还要求 stalled 重派携带「原 brief + 失败摘要」——实现里重派根本不传 brief。同时 noop handler 自己写了 brief.md 但行上 briefPath=null，路径列与实际文件脱节。

**P2-5 容器停机后在途 handler 的尾部写入可能撞已关闭的 DB**
stop() 同步执行 stopIntake → abortInflight → store.close，但 async handler 在 abort 信号后仍可能执行 `ctx.setAgentSessionId`（store 写）→ 抛 "database is not open"。executeEffect 的 catch 因 signal.aborted 直接 return，异常被吞——行为无害但有隐患；若未来 handler 在 abort 后还有 emit 之外的副作用，错误会静默消失。

### P3（低 — 记录在案，按需处理）

- **P3-1** `api.injectEvent` 未实现（spec 漂移，同 S-7）。
- **P3-2** noop 无 phase 转移（同 S-8）。
- **P3-3** workitemsDir 在首个工作项创建前不存在 → 每日备份 tar 报错日志噪音（`workitems/backup.ts:60`）。建议 job 内 mkdirSync 或容器装配时预建。
- **P3-4** `beatUntilAbort` 忽略 heartbeatIntervalMs：`waitOneTick` clamp 到 ≤10ms，实际每 ~10ms 心跳一次（`noop/run-handler.ts:89-94`）。测试语义不受影响，但参数名义与行为不符。
- **P3-5** spec/实现小偏差清单：effects.payload_json spec 要求 NOT NULL、实现可空；artifact commit message 格式与 spec 不同；idx_effects_inflight spec 为 partial index、实现为普通索引（含 status 列，功能等价）；noop resume 未按 spec 跳过 setAgentSessionId/brief 重写（多一次空提交）；registerNoop 签名（spec 注册 type+handler，实现拆两步在 index.ts 接线）；noopMaxRetries 默认值 spec=1、实现=0（D-057 已留痕）；container.backupJob 签名（backupsDir 在构造时给）。
- **P3-6** 防颠簸升级路径将 wakePending 置 false 丢弃在途唤醒诉求，人 resolve 后无人接续（与 S-5 同源）。
- **P3-7** `projection.recomputeRollup` 默认参数 `Date.now()` 绕开注入 Clock（现有调用方都显式传了 now，仅防御性问题）。
- **P3-8** kernel `index.ts` 中 workitems runtime 在 installCrashGuard 之前创建：两者之间若抛异常，watchdog interval 与 DB 句柄无 stop 兜底（进程随 main().catch 退出，实际无害）。

### 正面确认（评审中专门验证过、无问题）

- 同事务 outbox：assignment/wait/effect 行与事件、状态、rollup 确在单个 better-sqlite3 事务内（applyTransitionWrites 全部走 store，无 IO）。
- 单飞合并无竞态：poke→drainOne 到 inflight.set 全同步前缀，无双取窗口；replaces 重派绕过单飞是受控例外（D-054）且 postCommit abort 衔接正确。
- 创建路径 dedupe（先查后插 + SQLITE_CONSTRAINT 回查）、open 上限（事务内 count）在单实例同步模型下无 TOCTOU。
- 终态事件短路、effect_aborted 不计 streak、ADR-6 双窗口（开区间 vs (M,N]）、ADR-11 失败不提前置 aborted——实现与 ADR 逐条一致。
- 架构守护测试真实有效（kernel 反向依赖与业务词零违规，合成 fixture 证明可检出）。
- PID takeover、SIGKILL 双窗口恢复为真进程/真信号/真 DB 测试，无 mock。

---

## 四、处置建议

1. **提交前修**：P1-1、P1-2（各约 5-10 行改动 + 补 watchdog 驱动的集成测试，特别是用 watchdog.tick 而非手工 enqueue 复测 origin_terminal 场景）。
2. **提交前定夺**：P1-3、P1-4 属容器契约缺口，M0 noop 不可达——可选择随本批修复，或在 spec 中以 ADR-12/13 记录决策延后到 M1；但**不应无痕跨过**。
3. **M1 前**：P2-1（异常隔离）、P2-2（恢复时校验 assignment 状态）、S-4/S-5（终态清理与 wait_resolved 契约）。
4. **文档同步**：S-7/S-8/P3-5 的 spec-实现漂移，建议在 spec 对应节加「〔实现偏差核定〕」标注，避免 M1 接手者按旧 spec 施工。
