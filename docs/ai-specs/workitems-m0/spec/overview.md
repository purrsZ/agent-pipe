# workitems-m0 — 技术设计总览（Step 2）

> Track: DDD（领域模型即 PRD §4，本文「领域模型映射」节落定概念 → 代码映射）
> 设计权威：PRD §3/§4/§10/§12；本文 ADR 表逐条落定全部 38 个 Gap（22 YELLOW + 16 WHITE）。

## 模块索引

- [S1: 存储与数据基座](S1-storage-foundation.md) — workitems.sqlite 五表 DDL / artifact git 仓 / 备份扩展
- [S2: 容器生命周期与状态投影](S2-lifecycle-projection.md) — 创建 API / rollup 投影 / WorkType 注册表
- [S3: reducer 运行时与决策防错](S3-reducer-concurrency.md) — per-item FIFO / 纯转移 / 单飞合并 / 结构检查
- [S4: 效果 outbox 与崩溃恢复](S4-effects-outbox.md) — 同事务落库 / 执行器 / 恢复序列 / 对账
- [S5: 等待与活性监督](S5-waits-watchdog.md) — wait 到期动作 / watchdog / stalled 管道 / resolve 入口
- [S6: noop 类型与单实例全路径验证](S6-noop-verification.md) — noop 实现 / 端到端 / PID 锁 / 架构校验

### 新文件清单与目录结构

```
src/workitems/                  # 容器层（不 import worktypes）
  types.ts        # WorkItem/Assignment/Wait/Effect/WorkItemEvent/Transition/Decision/CreateInput/CreateResult/WorkType/Clock 全部域类型
  clock.ts        # SystemClock（Clock 的生产实现；测试用 FakeClock 在 tests/helpers）
  config.ts       # 容器调参（WORKITEMS_* 环境变量自管，kernel config 不解释语义）
  store.ts        # WorkitemsStore：独立 DB 打开/migration/五表读写/事务原语
  artifacts.ts    # ArtifactStore：每项 git 仓 init / 写文件+提交 / 对账 reconcile
  registry.ts     # WorkTypeRegistry（重复注册拒绝）
  projection.ts   # rollup 纯函数 + 事务内重算入口
  reducer.ts      # ReducerRuntime：per-item FIFO、结构检查、防颠簸、单飞合并、同事务提交
  effects.ts      # EffectRuntime：outbox 执行器、handler 注册表、心跳 ctx、中止通道
  watchdog.ts     # Watchdog：单周期轮询扫 waits 到期 + assignment 心跳/墙钟/死线
  recovery.ts     # startupRecovery：待办重建 → outbox 分策略 → artifact 对账
  api.ts          # 容器对外门面：createWorkItem / resolveWait / renewWait / 查询 / injectEvent
  backup.ts       # workitems 备份 job（DB 副本 + workitems/ tar 包），挂入 kernel 备份调度
  container.ts    # WorkitemsContainer：组装以上组件，start()/stop() 供 index.ts 一行接线
src/worktypes/noop/
  index.ts        # noop WorkType 实现（九成员）+ 参数解析
  run-handler.ts  # noop 模拟运行 effect handler（延时/失败注入/心跳/resume 模拟）
tests/workitems/  # 单测+集成测试（沿用 tests/**/*.test.ts 约定）
tests/fixtures/workitems-app.ts   # 进程级测试用最小装配入口（SIGKILL/双实例用）
tests/architecture.test.ts        # 依赖单向 + kernel 业务词汇扫描（G-6.2）
```

kernel 触点（仅三处，见变更影响矩阵）：`src/config.ts`（+2 路径）、`src/backup.ts`（前缀参数化 + extraJobs 通用钩子）、`src/index.ts`（装配接线）。

## 领域模型映射（PRD §4 概念 → TS 类型/文件）

| PRD 概念 | 锚点 | TS 类型 / 实现位置 |
|---|---|---|
| WorkItem 容器 / 外层状态机 | §4.1 | `WorkItem`（types.ts）；状态枚举 `open\|active\|waiting\|done\|failed\|cancelled` |
| status rollup 投影 | §4.1 | `computeRollup()` 纯函数（projection.ts），事务内重算写回 status/status_detail |
| phase 不透明承诺 | §4.1 | `WorkItem.phase: string`；`phase_changed` 事件由 ReducerRuntime 统一追加 |
| 五表 schema | §4.2 | store.ts migration v1（DDL 见 S1 设计节） |
| assignment（子任务，无第二个 task） | §4.2/§9.2 | `Assignment`（types.ts）+ workitem_assignments 表 |
| 显式等待对象 | §4.2/§4.4 | `Wait`（types.ts）+ workitem_waits 表；到期动作在 watchdog.ts |
| 效果 outbox | §4.2/§4.3 规则 4 | `Effect`（types.ts）+ workitem_effects 表 + effects.ts 执行器 |
| 事件日志（状态权威+事件审计） | §4.2 | `WorkItemEvent` + workitem_events（append-only trigger 兜底） |
| reducer 纯转移 / seq 单调 / 串行 | §4.3 规则 1 | reducer.ts `applyEvent()`：同步事务内分配 seq、调 onEvent |
| 运行是效果、单飞、批量带入 | §4.3 规则 2 | reducer.ts 单飞合并（wake_pending 列）+ run 效果 payload 的 based_on_seq + `eventsSince(batchFromSeq)`（窗口契约见 ADR-6） |
| based_on_seq / 结构检查 / isDecisionStale / 防颠簸 | §4.3 规则 3 | reducer.ts 结论事件前置检查；workitems.discard_streak 列 |
| 同事务 outbox | §4.3 规则 4 | reducer.ts `commitTransition()`：单 better-sqlite3 同步事务 |
| watchdog（心跳/墙钟/到期） | §4.4 | watchdog.ts `tick()`；心跳内存表在 effects.ts |
| 义务代码化（收尾 artifact 校验） | §4.4 | effects.ts run handler 收尾钩子：report 存在且非空 |
| WorkType 接口九成员 | §4.5 | `WorkType`（types.ts）+ registry.ts；noop 在 src/worktypes/noop |
| 恢复序列 / 对账 | §10 | recovery.ts；对账提交在 artifacts.ts `reconcile()` |
| 备份双库 | §10 | kernel backup.ts（泛化）+ workitems/backup.ts |
| 单实例前提（PID 锁） | §4.3 前提 | kernel index.ts `ensureSingleInstance` + lifecycle.ts `removeOwnPidFile`（只验不改） |
| 可注入时间 | （测试前提） | `Clock { now(): number }`（epoch ms，types.ts）；全部时间读取经注入 Clock |

## 组件交互图

```
                      ┌────────────────────────── api.ts（编程入口）──────────────────────────┐
                      │ createWorkItem / injectEvent / resolveWait / renewWait / 查询          │
                      └──────────────┬────────────────────────────────────────────────────────┘
                                     │ enqueue(event)（同步 drain，返回时已 apply）
            事件回流                  ▼
 effects.ts ────────────►  reducer.ts ReducerRuntime（每 workitem 一条 FIFO）
 watchdog.ts ───────────►    applyEvent（全同步，单 better-sqlite3 事务）:
 (到期/stalled 事件)          1. 终态项: 仅追加审计事件后返回（投影冻结）
                              2. 分配 seq = max(seq)+1
                              3. 结论事件: 结构检查(assignment/wait) → isDecisionStale
                                 失效 → decision_discarded + streak++（2 次 → thrash 升级 human wait）
                              4. 容器机制处置（stalled 预算/重派、effect_aborted、wait 生命周期）
                              5. 类型 onEvent（纯函数，无 IO）→ Transition 合并
                              6. 同事务写入: 事件行 + 状态 + assignment/wait 行 + 效果行(pending)
                                 + rollup 重算 + 单飞合并（在途 run → 置 wake_pending 不插第二条）
                              7. post-commit: poke 执行器 / 发送 AbortSignal（IO 永不进事务）
                                     │
                                     ▼ poke
                      effects.ts EffectRuntime（每 workitem 串行、跨 workitem 并行）
                        取单 (seq,id) 升序 → running → 调 handler（noop run = 进程内受控异步任务）
                        handler ctx: heartbeat() / eventsSince(batchFromSeq)（ADR-6）/ artifact 写提交
                        完成/失败 → 结论事件 enqueue 回 reducer（效果终态在结论 apply 事务内置位，ADR-11）
                        中止 → abort() 预置 aborted + effect_aborted 事件回流（非结论事件，ADR-7/AC-4.12）
                                     ▲
 watchdog.ts Watchdog（单周期轮询，Clock 注入）                     artifacts.ts ArtifactStore
   扫 open waits 到期: human 提醒 / agent→stalled / timer→fired      （git 仓 init/写提交/reconcile）
   扫 running assignments: 心跳静默/墙钟/死线 → assignment_stalled（同 tick 去重）

 启动序列（index.ts → container.start()）:
   kernel ensureSingleInstance（锁，装配前置）
   → recovery.ts: 待办重建（非终态项+open waits+running assignments，投影校正）
   → outbox 分策略（pending 入队 / running: rerun 或 resume-or-redispatch）
   → artifact 对账（脏区校验提交）
   → 启动 EffectRuntime + Watchdog
 关闭序列: 停 watchdog → 执行器停止取新单 → abort 在途 handler（效果保持 running 留给恢复）
   → store.close → removeOwnPidFile
```

## ADR 决策表（38 个 Gap 逐条落定）

### 头部 ADR（影响全局的 5 条，含方案对比）

**ADR-1（G-3.1）事件即时 apply + 唤醒效果合并**。方案 A「运行期间延迟 apply」：seq 分配推迟、与 AC-3.1/3.2 冲突且恢复时有未 apply 事件堆积；方案 B「即时 apply、唤醒合并」：事件到达即串行 apply 获得 seq，仅「再次唤醒运行」这个效果被合并（wake_pending 列持久化，当前运行结束后据 based_on_seq 批量带入）。**采 B**——1.5a 已论证唯一自洽，且崩溃窗口下 wake_pending 落库可恢复。

**ADR-2（G-6.1/G-6.6）PID 锁按 takeover 语义核定**。实勘 index.ts `ensureSingleInstance`：读旧 pid → SIGTERM 杀旧 → 写自己 pid，是 takeover 而非「后启拒绝」；设计文档 §4.3 要求的是「任意时刻最多一实例」而非特定获锁策略。**AC-6.8 断言形态核定为**：A 持锁运行 → B 启动 → A 收 SIGTERM 优雅退出（exit 0，符合 run-forever.sh「0=有意停止」契约，G-6.6 一并落定）→ B 持锁运行 → 全程锁文件内容始终等于存活实例 pid、任意时刻至多一实例。AC-6.9（6329d35 退出只删自己的锁）原样保留为回归。不改 kernel 锁代码。

**ADR-3（G-3.6）based_on_seq 与 effect.seq 同一载体**。效果在 apply seq=n 的事件的转移中声明 ⇒ 它所基于的状态恰是 seq=n 之后的状态，「由哪次转移声明」与「based_on_seq」语义重合。**workitem_effects.seq 单字段两用**；dispatch 时复制到 assignment.based_on_seq。否决双字段方案（永远相等的两列是漂移源）。

**ADR-4（声明式转移落库归属）assignment/wait 行在转移事务内创建，outbox 仅承载事务外副作用**。Transition 声明 `dispatch[]/waits[]`，运行时在同一事务内建 assignment/wait 行（它们是权威状态，必须与转移原子）并为每个 dispatch 写一条 kind='run' 效果；纯 DB 写不需要 outbox，文件/异步副作用（run、noop 幂等标记）才走 outbox。这使 AC-4.9「重派新 assignment」与 AC-5.9 的「声明派发」均收敛为「事件 → reducer → 转移事务建行 + run 效果」单写入路径。

**ADR-5（G-5.2/G-5.3/AC-4.12）三套超时统一收敛 stalled 管道**。分工：心跳静默=「不动了」、wallclock_cap_sec=「活着空转」、deadline_at=「逾期未完」；三者动作统一为 `assignment_stalled {reason}` 事件，apply 时容器机制层做幂等处置（assignment 非 running 即忽略 → 天然去重）：中止其 run 效果（post-commit AbortSignal + effect→aborted）、预算内 superseded+重派（replaces 链、retries+1）、耗尽 failed+human wait 升级。一条管道三个入口，无双重启可能。

### 全量 Gap 决策表

| Gap | 决策 | 理由 |
|---|---|---|
| G-1.1 | 时间戳 INTEGER epoch ms（对齐 kernel store 实际用 Date.now() 的习惯，Clock.now() 同单位）；实体表（workitems/assignments/waits）TEXT UUID 主键（crypto.randomUUID，零依赖），events/effects INTEGER AUTOINCREMENT；全部引用列声明 FK + foreign_keys=ON；status/kind/role 加 CHECK；索引与新增列（status_detail/wake_pending/discard_streak/reminded_at/started_at 等）见 S1 DDL | spec 候选写「TEXT ISO8601 对齐 kernel」但实勘 kernel store 用 INTEGER ms，按实勘纠偏；UUID 免自增 id 跨表歧义 |
| G-1.2 | M0 用系统 `tar -czf` 打包 workitems/ 整目录（含 .git）入 backups/，命名 `workitems-files-<ts>.tar.gz`，按前缀+扩展名修剪；远端推送留增量 | 零新依赖（darwin/linux 自带 tar）；与 sqlite 副本同目录同保留策略 |
| G-1.3 | 加 SQLite BEFORE UPDATE/DELETE trigger `RAISE(ABORT)` 于 workitem_events | store API 不暴露更新删除是底线，trigger 防未来旁路误用，成本一次 migration |
| G-1.4 | git init 后写 repo-local `user.name=agent-pipe / user.email=agent-pipe@local`；打初始空提交（HEAD 永存在，reconcile 不需特判无 HEAD）；不预建占位文件（文件按需写入即提交） | 服务器无全局 git 身份时 commit 必败；空仓 reconcile 特判是隐藏分支 |
| G-1.5 | backup.ts 前缀参数化：`backupFileName(prefix,now)`、`selectBackupsToPrune(names,{prefix,ext,keep})` 等带 prefix；kernel 传 'db'，workitems 传 'workitems'/'workitems-files'；修剪正则锚定前缀+扩展名，互不匹配即互不误删 | 通用能力改造（无业务词），双库副本同目录共存且各自滚动 |
| G-1.6 | 脏区约定：ArtifactStore 的每次写操作完成后工作区必须干净（write→add -A→commit 原子序列）；任何时刻发现工作区脏 = 崩溃窗口残留；提供幂等 `reconcile(id)`（脏则 add -A + 固定格式 message 提交，净则 no-op）作为 G4 对账抓手 | 「净工作区不变量」可被 git status 一条命令断言，对账实现退化为一个幂等函数 |
| G-1.7 | `assignments/<assignment_id>/brief.md` 与 `assignments/<assignment_id>/report.md`；brief_path/report_path 存仓内相对路径 | 与 §4.2 布局「任务卡+报告」一一对应；相对路径使整仓可搬迁 |
| G-2.1 | 上限计数口径 = 全部非终态（open/active/waiting） | §9.1 语境是「并行工作项」，waiting 中的项仍占人的心智带宽；AC-2.6「终态不占名额」反向锁定此口径 |
| G-2.2 | 允许 open 不经 active 直达终态（终态转移对任意非终态合法） | cancel/创建即失败必须可达；状态图未画的边按「投影是派生值」原则不人为禁止 |
| G-2.3 | dedupe 冲突静默返回已存在项：`{created:false, item}`；捕获 SQLITE_CONSTRAINT 后回查 | 调用方（M4 触发器）天然要幂等语义；错误码方案逼调用方写重复 catch |
| G-2.4 | 空活动且非终态投影规则：存在 seq>1 的已 apply 事件 → active，否则 open | 「创建后未动」与「运行间歇」可凭事件水位客观区分，无需新增状态 |
| G-2.5 | status 单值枚举 + status_detail 列（human/agent/timer/NULL）两字段 | 可索引、免字符串解析；'waiting:human' 复合串污染枚举 |
| G-2.6 | 每次转移事务内同步重算 rollup 写回 | M0 单实例同步事务零竞态；status 列直接可查可索引；查询时聚合把成本摊给每个读者 |
| G-3.1 | 见 ADR-1：即时 apply + 唤醒效果合并（wake_pending 列） | 1.5a 论证唯一自洽 |
| G-3.2 | 防颠簸计数 workitem 级，workitems.discard_streak 列持久化；结论成功 apply 清零；达 2 触发升级后同时清零（human resolve 后重新计数） | 决策链级计数在 M0 无链概念；列持久化使崩溃后不丢计数；升级后清零防止 human resolve 后立刻再升级 |
| G-3.3 | 单飞对象 = 每 workitem 至多一个执行中（pending/running）的运行类效果；运行类 = handler 注册时声明 recovery='resume-or-redispatch' 的 kind | M0 无 Owner/Worker 拓扑，按效果类别约束最通用；术语漂移⑤随之统一 |
| G-3.4 | per-item 显式 FIFO 队列 + 同步 drain（apply 全同步，Node 单线程下天然不交错；drain 中新入队事件继续被同一循环消费） | apply 是同步事务，Promise 链是多余的异步包装；显式队列可断言深度 |
| G-3.5 | `decision_discarded {effect_id, assignment_id?, wait_id?, based_on_seq, reason: 'assignment_superseded'\|'assignment_terminal'\|'wait_resolved'\|'semantically_stale'\|'effect_aborted'}`（'effect_aborted' 为 ADR-7 增补）；`thrash_escalated {streak, wait_id}` | 编号即候选名；payload 携带可审计的判废依据（assignment_id/wait_id 由 structuralCheck 返回的触发对象填充） |
| G-3.6 | 见 ADR-3：effect.seq 即 based_on_seq 单字段两用 | 语义重合，双列必漂移 |
| G-3.7 | eventsSince = 严格区间 (based_on_seq, 结论事件自身 seq)，两端开 | based_on_seq 当条已被决策看见过；结论事件自身尚未 apply 不属于「期间发生」 |
| G-4.1 | 每 workitem 串行、跨 workitem 并行；取单按 (seq, id) 升序；提交后 post-commit poke 驱动 + 启动恢复扫描兜底，不做周期轮询 | 与 reducer 串行模型同构；poke 零延迟零空转 |
| G-4.2 | 幂等性由效果 handler 自证：注册时声明 `recovery:'rerun'` 即承诺可重入；容器只保证 at-least-once + 终态不再拾取，不做执行去重 | 容器去重（exactly-once）在崩溃窗口是伪命题；契约显式写在注册点，审查有锚点 |
| G-4.3 | noop run payload 含 `simulateResumable:boolean`（建项参数注入）；run 开始时经 ctx 写 agent_session_id=`noop:<assignment_id>`；恢复判定 canResume = payload.simulateResumable && agent_session_id 非空 | 判定点（payload+session 字段）与真 agent 的 M1+ 形态同构，测试可双向注入 |
| G-4.4 | 对账 = 对每个非终态项调 ArtifactStore.reconcile：工作区脏才提交，message 固定 `reconcile(<id>): startup <ISO时间>`；仓缺失则重建（init+初始提交）；动作落 `artifact_reconciled` 审计事件 + 日志 | 幂等、可重复执行；message 含时间戳可审计 |
| G-4.5 | 效果无独立重试预算：执行失败 → `run_failed` 结论事件回流（效果保持 running，于该结论 apply 事务内终态化为 aborted → ADR-11），由 reducer 决策（容器 stalled 预算管活性失败，自报失败归类型 onEvent 决定重派或终态） | 效果级再加一层预算与 assignment 级预算两层纠缠；§4.4 预算面向 assignment 监督 |
| G-4.6 | 中止/恢复作废通道置 aborted 时产生 `effect_aborted` 事件回流，run 类自报失败产生 `run_failed` 结论事件（幂等类失败例外：小事务置 aborted、无回流事件，ADR-11）；重派不直接写表——reducer apply 该事件时经 Transition.dispatch 声明新 assignment（replaces 链）走标准转移事务 | 单写入路径（一切状态变更经 reducer 事务），事件审计缺口仅幂等类失败一处且已 ADR 留痕 |
| G-5.1 | 预算内重启：旧 assignment → `superseded`；预算耗尽：→ `failed`。status 枚举含 running/done/failed/superseded/cancelled | superseded=「被替代非终论」，failed=「最终失败」；AC-3.9 的「已 supersede」即 status='superseded'，与 §6.4 语境一致 |
| G-5.2 | 见 ADR-5：心跳=不动了 / 墙钟=活着空转 / deadline=逾期，动作统一 stalled 管道 | 三套语义三个入口一条处置路径，无组合爆炸 |
| G-5.3 | agent wait 复用 origin_assignment_id 作为关联 assignment（kind=agent 时必填，创建校验）；去重双保险：watchdog 同 tick 对同一 assignment 仅发一个 stalled（优先级 wallclock>heartbeat>deadline）+ apply 时 assignment 非 running 即忽略 | 不加第二个字段（M0 「溯源」与「目标」恰好同物）；apply 侧幂等使事件重复无害 |
| G-5.4 | 自动创建的 human wait deadline = now + `humanWaitTtlSec`（容器配置，默认 86400=24h）；适用 stalled 升级（AC-5.10）与防颠簸升级（AC-3.12） | 人不在环内只能给默认值；可配置 + 到期提醒 + 续期留痕兜底 |
| G-5.5 | 单一周期轮询 Watchdog：`tick()` 公开（测试以 FakeClock + 手动 tick 驱动），生产 setInterval(unref) 默认 1s 可配 | 每对象独立定时器不可注入测试且泄漏风险高；轮询量级（≤3 项）可忽略 |
| G-5.6 | 心跳内存表：EffectRuntime 持 Map<assignmentId, lastBeatMs>，run handler 经 ctx.heartbeat() 上报；不落库每跳；watchdog 读 lastBeat ?? started_at | 每跳落库是写放大；崩溃后心跳态无意义（running 效果走恢复策略，不走心跳判定） |
| G-6.1 | 见 ADR-2：takeover 语义，AC-6.8 断言改写 | 实勘 index.ts 为准 |
| G-6.2 | 自写 import 静态扫描挂 vitest（tests/architecture.test.ts）：解析 src/**/*.ts 的 import 语句断言三条规则 + kernel 源码业务标识符扫描（豁免 index.ts/config.ts）；已验证当前 kernel 无 workitem/assignment/phase 词汇（grep 实勘干净） | dependency-cruiser 引新依赖且规则表达力超出需求；正则级扫描对 ESM 静态 import 足够 |
| G-6.3 | 大 delayMs（如 30s）拉宽窗口 + 父测试进程轮询子进程的 workitems.sqlite（WAL 下跨进程可读）观察效果行进入目标状态（pending/running）后 SIGKILL | 文件信号同步要侵入生产代码；轮询 DB 零侵入且断言的就是真实状态 |
| G-6.4 | 优雅关闭对 running 效果：截断——AbortSignal 通知在途 handler、效果保持 running 留库、交下次启动恢复路径（与 SIGKILL 共用语义）；关闭序列：停 watchdog → 执行器停取新单 → abort 在途 → store.close | 「等待完成」使关闭时长无上界；与 SIGKILL 同一恢复语义则恢复路径只有一条 |
| G-6.5 | failAt 枚举 `'before-run'\|'during-run'\|'before-report'`（执行开始前抛错 / 延时中点抛错 / 跳过写 report 触发收尾校验失败）；failCount 判定基于 assignment.retries（replaces 链持久计数，崩溃不丢） | 点位全部在效果执行器路径内（reducer 纯函数不可注入）；before-report 专为 AC-5.12 提供失败注入 |
| G-6.6 | 见 ADR-2：takeover 被杀方 SIGTERM 优雅退出 exit 0（有意停止，supervisor 不拉起）；新实例正常持锁运行 | 与 lifecycle.ts 既有退出码契约一致，无新增约定 |

### 修正 ADR（Step 2.2 v2 / 2.2b 校验问题清零，续 ADR-6 起）

| ADR | 来源 | 决策 | 理由 |
|---|---|---|---|
| ADR-6 | I-011（v2-S3 #1）批量带入窗口矛盾 | 「状态基准」与「批量输入窗口」分离：run 效果的 based_on_seq=声明时 seq=N 仅作结构检查/isDecisionStale 基准；批量窗口起点 batchFromSeq=该 workitem 上一次运行类效果的 based_on_seq=M（首个 run 取 0），由 EffectRuntime 构造 ctx 时经 store.lastRunEffectSeqBefore() 从 workitem_effects 表查得（id 序最近一条运行类效果的 seq）；ctx.eventsSince(batchFromSeq) 返回半开区间 (M, N] | eventsSince(N) 恰好排除运行期间的完成事件——AC-3.7 按原契约不可达；窗口起点从库内查询导出而非 payload 携带：崩溃恢复/重跑后依旧成立、不引入冗余字段；(M, N] 含上界使唤醒输入确定（N 之后的事件归下一批） |
| ADR-7 | I-012（v2-S3 #2）结论改写 aborted | 效果终态化单向：setEffectStatus 置 done 仅允许 pending/running → done；已 aborted（S4 中止/恢复作废）的效果，其迟到结论经 structuralCheck 前置检查（effect.status=='aborted'）按过期决策路径作废——decision_discarded(reason='effect_aborted')，且不计 discard_streak、不重唤醒，效果保持 aborted。**边界（I-015 增补）**：aborted 的前置置位仅来自 S4 中止通道/恢复作废（「决策已被废」场景）；执行器自报失败不提前置 aborted——效果保持 running、run_failed 结论在 apply 事务内统一终态化（→ ADR-11），故失败结论不命中本检查 | aborted 由 stalled 管道置位且处置（重派/升级）已完成：改写为 done 违反「效果终态不再变」（AC-4.4），计 streak/重唤醒会与 stalled 重派双发；与 based_on_seq 结构检查同路径使契约只有一条作废通道 |
| ADR-8 | I-013（v2-S5 #1）agent wait 悬空 | agent wait 到期但 origin assignment 已非 running 时：stalled 处置早退分支内直接 resolve 该 wait（resolved_by='container', resolve_reason='origin_terminal'）+ 追加 wait_resolved 事件，再 return {} | 早退留悬空 wait 会使其永不 resolve、watchdog 每 tick（默认 1s）重复 enqueue stalled 刷屏；resolve 即退出到期扫描（AC-5.2 免疫），活性闭合且零新增状态；origin 已终态/被重派意味着该 wait 使命已尽，resolve 语义自洽 |
| ADR-9 | I-014（v2-S6 #1）noop 失败终态判定契约 | 结论事件（run_completed/run_failed）payload 增加 assignmentRetries 字段（=assignment.retries，即 replaces 链深度），由效果执行器 emit 时封装（执行器在 reducer 外、持有 assignment 行）；noop onEvent 纯函数仅读 ev.payload.assignmentRetries 判定是否达 noopMaxRetries | onEvent 是纯函数无法查库，AC-6.5 按原契约不可实现；retries 在执行器侧即手（ctx.assignment），零额外查询；G-6.5 已确立 retries 为链上持久计数，崩溃不丢 |
| ADR-10 | v2-S3 #3 defaultDispatch 参数来源 | 容器自发派发（唤醒/第 1 次作废重唤醒）的监督参数取容器配置默认值：cfg.defaultDeadlineTtlSec（默认 3600）/ cfg.defaultWallclockCapSec（默认 1800），并入 WorkitemsConfig（WORKITEMS_* 环境变量可调）；WorkType 经 Transition.dispatch 显式声明时覆盖 | 「复制上一 assignment 参数」在边界情形无行可抄且使参数来源出现两条路径；配置默认值路径唯一、可测、满足 AC-5.7 必填正数校验；S5 stalled 重派的「原参数」是显式复制被替代行，与本默认值机制并存不冲突 |
| ADR-11 | I-015（v2-arch #1）自报失败结论必被 ADR-7 前置检查作废 | S4 执行器 catch 自报失败时**不**提前置 aborted：run 类效果保持 running，仅 emit run_failed（payload 含 assignmentRetries 与失败原因 error）；效果终态化统一发生在结论事件 apply 的转移事务内——run_completed→done、run_failed→aborted 同构；aborted 的前置置位仅保留给 S4 中止通道（abort()）与恢复作废（ADR-7 检查语义不变，仍针对「决策已被废」场景）；幂等类（rerun）失败无结论事件，仍由执行器小事务直接置 aborted | 若 catch 先置 aborted，emit 的 run_failed 经同步 drain apply 时必命中 ADR-7 前置检查被作废——AC-6.5/G-4.5/ADR-9 的失败决策路径整体不可达（assignmentRetries 判定成死代码）；保持 running 与成功路径及交互图「效果终态在结论 apply 事务内置位」同构、改动最小；崩溃窗口下 running 效果自然落入既有恢复策略（resume/作废重派），无新增中间态 |

## 变更影响矩阵

| 模块 | 文件 | 变更类型 | 影响范围 | 风险 |
|---|---|---|---|---|
| kernel | src/config.ts | 修改 | +`workitemsDbPath`/`workitemsDir` 两条路径声明（默认落 DATA_DIR 下）；纯路径无语义（→ AC-6.11） | 低 |
| kernel | src/backup.ts | 修改 | 前缀参数化（既有导出签名加 prefix 参数，kernel 调用点传 'db'）+ scheduleDailyBackup 增 `extraJobs?: BackupJob[]` 通用钩子（每 job 独立 try/catch，失败互不连坐 → AC-1.14） | 中（动既有备份，回归 tests/backup.test.ts 必须全绿） |
| kernel | src/index.ts | 修改 | composition root 接线：createWorkitemsContainer + registerNoop + container.start()；releaseResources 增 container.stop()；scheduleDailyBackup 传入 workitems job（→ AC-6.10） | 低（仅装配，无业务分支） |
| workitems | src/workitems/*（14 文件） | 新增 | 容器层全部实现 | 中（新代码，测试覆盖兜底） |
| worktypes | src/worktypes/noop/*（2 文件） | 新增 | noop 类型 + run handler | 低 |
| tests | tests/workitems/*、tests/architecture.test.ts、tests/fixtures/workitems-app.ts | 新增 | 单测/集成/进程级测试 | 低 |
| 不改 | src/lifecycle.ts、src/store.ts、src/agents/*、src/feishu/*、src/bridge/* | 不变 | PID 锁与 kernel store 只测不改 | — |

## 测试策略总述

- **单元测试（vitest，tests/workitems/）**：纯函数直测——projection rollup（优先级矩阵 + 空活动边界）、备份命名/修剪选择（前缀分流矩阵）、结构检查判定、Transition 合并、noop onEvent（纯函数给定事件断言转移）。FakeClock（`{now, advance}`）注入全部时间相关逻辑。
- **集成测试（同 vitest，真实 better-sqlite3 临时文件 + 真实 git 仓于 os.tmpdir）**：store migration/约束/trigger、ArtifactStore 写提交与 reconcile、reducer 事务原子性（注入效果写失败断言回滚）、执行器全流水线、watchdog tick 驱动的 stalled/到期路径、恢复序列（同进程内关闭容器再 start 模拟）。better-sqlite3 同步 API 使这些测试无需 mock 即毫秒级。
- **进程级测试（vitest 内 spawn 子进程跑 tests/fixtures/workitems-app.ts，经 tsx）**：SIGKILL 崩溃恢复（G-6.3 轮询 DB 命中窗口）、PID 锁 takeover 与退出清理（FLOW-6.3）。子进程用环境变量注入 DATA_DIR 临时目录与 noop 参数。
- **架构测试**：tests/architecture.test.ts 静态扫描 import 与业务词汇（→ AC-6.12），`npm test` 一键执行即满足「本地与 CI 一键运行」。
- 测试金字塔预期：单测为主（reducer/projection/检查逻辑全部纯函数化设计正是为此），进程级仅 3-4 个用例（贵且慢，只验进程边界语义）。

## 需求反馈

- AC-6.8 原文「后启者拒绝启动」与实勘 takeover 语义不符，已按 ADR-2 核定断言形态（编排者已预授权此路径）；S6 设计节给出核定后断言，Step 4 出测试时以设计节为准。
- AC-6.5（持续失败 → failed）与 AC-5.10（预算耗尽 → human wait）并非矛盾：前者走「自报失败 → 类型决策终态」路径，后者走「活性失败 → 容器升级」路径，S4/S5/S6 设计节已分别落实两条路径的归属。
