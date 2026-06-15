# v4 — workitems-m0 第二轮深度 Code Review（max 颗粒度）

> 日期：2026-06-13
> 方法：9 视角并行审查（逐行×2 / 不变量 / 跨文件 / 语言陷阱 / 并发生命周期 / 复用 / 简化 / 效率 / 实现深度），候选逐条对照源码裁决
> 范围：src/workitems/*（15 文件）、src/worktypes/noop/*、kernel 触点 diff、tests/*；含 v3 修复后的最新代码
> 基线：`npm run check` 37 files / 196 tests 全绿
> 说明：4 个视角由独立 agent 完成（32 候选），5 个逐行视角因额度中断、由本会话此前的人工逐行评审补位；与 v3 已记录且未修复的 P2/P3 项有交集的条目已标注

## 裁决后保留的发现（按严重度排序，≤15）

### 1.（高·契约陷阱→崩溃循环）同一 apply 内审计事件序号各自硬编码 seq+1，撞 UNIQUE 后整事务回滚且毒状态持久
- `src/workitems/reducer.ts:212`（phase_changed）、`:393` 附近（assignment_retry_exhausted）、thrash_escalated、resolveOriginTerminalWait 的 nextSeq
- 触发：未来任一工作类型对 assignment_stalled / effect_aborted 声明 phase 转移，且恰逢预算耗尽分支 → 两处同写 seq+1 → SQLITE_CONSTRAINT → stalled 处置整体回滚。**触发状态持久在 DB（running + 预算耗尽），watchdog 每 tick 复现 → 结合 #2 形成永久崩溃循环**。v3 S-6 的升级版：后果从"事件丢失"升级为"毒状态崩溃循环"。
- 建议：事务内统一事件序号分配器（apply 级递增游标），废除全部 seq+1 硬编码。

### 2.（高·已记录 P2-1 的升级）reducer apply 异常零隔离：单个坏 workitem 打死整个桥并无限复现
- `src/workitems/watchdog.ts:128`（tick 候选循环无 try/catch）、`src/workitems/effects.ts`（void drainOne 的 unhandledRejection 面）
- 任何 apply 异常（#1 撞键、onEvent 抛错、SQLITE_FULL、payload 校验失败）沿 setInterval 上抛 → uncaughtException → crash guard exit 1 → supervisor 重启 → startupRecovery + watchdog 从同一持久状态再次触发 → **无限崩溃循环，与 workitems 无关的飞书桥整体陪葬**；且 enqueue 队列残留事件随进程死亡丢失。
- 建议：watchdog tick 按 workitem 粒度 try/catch + 失败隔离（连续失败 N 次后 quarantine 该 workitem 并事件留痕）；poke/drainOne 边界捕获。

### 3.（高·已记录 S-4 的确证）watchdog 全局扫描不过滤终态项 + 终态分支只审计不消化 → 1Hz 无限事件追加
- `src/workitems/watchdog.ts:48`、`src/workitems/reducer.ts:144`（终态短路仅 appendEvent）
- 终态项残留 open wait / running assignment 时（可达路径见 #4），每 tick 重复 enqueue timer_fired/wait_reminder/assignment_stalled，终态分支只追加审计、不 resolve 不置 remindedAt → 同一事件 1Hz 无界写入 events 表，「单次提醒」与「终态冻结」双双失守。
- 建议：watchdog 扫描联结非终态过滤；或终态化时由容器统一 resolve open waits / supersede running assignments。

### 4.（高·新发现）Transition 不校验 terminal 与 dispatch/waits/effects 互斥；效果拾取链无终态过滤
- `src/workitems/reducer.ts:207-245`（applyTransitionWrites 先置 terminal 再照常插 dispatch/waits/effects）、`src/workitems/effects.ts:145`（drainOne 不读 item 状态）、recovery 全局拾取同样不滤
- 类型返回 `{terminal:'done', dispatch:[...]}` → 终态项落 pending run 效果 → postCommit poke 或重启恢复照常执行 → 已 done 的项继续跑 run、产新 assignment/事件/artifact 提交，并制造 #3 的残留。M0 noop 不返回此组合，但容器契约层无任何防线。
- 建议：applyTransitionWrites 对 terminal 与其余字段互斥校验（或 terminal 时丢弃并审计）；drainOne/recovery 拾取前校验 workitem 非终态。

### 5.（高·新发现）结论事件 payload 无 schema 校验，字段缺失行为发散，可达 wakePending 死锁
- `src/workitems/reducer.ts:743-755`（conclusionDetails 各字段缺省静默降级）、`src/workitems/effects.ts:274-292`（emit 侧手工拼装）
- basedOnSeq 缺省 0 → 全量历史做 stale 判定；effectId 缺失 → 跳过效果终态化 → run 效果永挂 running → hasInflightRunEffect 恒真 → 后续 dispatch 全转 wakePending 且 releaseWakePending 永远早退 → **workitem 死锁至下次重启**；assignmentId 缺失 → assignment 永驻 running → 接入 #3 的无限审计。来源：非 run 类 handler 的 ctx.emit（见 #6）或未来事件注入入口。
- 建议：enqueue 边界对 run_completed/run_failed 做结构校验，畸形直接拒绝 + 审计事件。

### 6.（高·新发现）非 run 类 handler 可伪造 run_completed，整体绕过 report.md 义务校验
- `src/workitems/effects.ts:249`（emit 守卫 `isRunClass(effect.kind) && isRunConclusion(kind)` 只拦 run 类自身）
- 类型经 Transition.effects 声明 rerun 类效果，其 handler `ctx.emit('run_completed', {...伪造 payload})` → 守卫放行 → closeRunConclusion 全信 payload：assignment 置 done、落一个从未写入的 reportPath——validateRunReport（义务代码化唯一执行点，AC-5.12/不变量 12）完全未运行。
- 建议：emit 一律屏蔽结论类 kind（结论只能由 EffectRuntime 收口发出），或在 reducer 侧校验结论的 effectId 必须是 run 类效果。

### 7.（中高·新发现）结论处置不校验 effectId/assignmentId 归属当前 workitem，可跨项改写状态
- `src/workitems/reducer.ts:549-573`（closeRunConclusion）、`:592-627`（structuralCheck）均按全局主键直查
- 向 A 入队的结论 payload 引用 B 的 effect/assignment（伪造或 bug）→ 在 A 的事务里把 B 的效果置 done、assignment 置 done，B 的 rollup 不重算、类型不知情 → B 的单飞记账错乱可致真双跑。
- 建议：getEffect/getAssignment 后校验 workitemId 匹配，不匹配按畸形 payload 作废。

### 8.（中·已记录 P2-2 的确证）stalled 事务提交与 postCommit abort 之间崩溃 → 恢复时 resume 已 superseded 的 assignment
- `src/workitems/effects.ts:96-104`（recoverRun 的 canResume 不查 assignment 状态）、`src/worktypes/noop/run-handler.ts:15`
- 窗口崩溃后旧 run 效果仍 running → 恢复时 canResume 只看 simulateResumable+session → superseded assignment 被续跑 → 结论以 assignment_superseded 判废并误计 discardStreak → 多余 wake 派发 + 可能误触 thrash 升级，同一次 stalled 被双重处置。
- 建议：recoverRun 先查 assignment.status，非 running 直接走 abort 作废。

### 9.（中·新发现）abort() 两段事务：aborted 置位先行 autocommit，与 effect_aborted apply 之间崩溃产生无审计、无重派的中间态
- `src/workitems/effects.ts:110-130`
- 窗口崩溃后：效果已 aborted（恢复不拾取）、事件日志无 effect_aborted、assignment 仍 running、无 replacement——唯一兜底是 watchdog 心跳超时（默认 60s），若类型声明了大超时参数则长时间悬挂。
- 建议：aborted 置位移入 effect_aborted 的 apply 事务（与 ADR-11 的结论终态化同构），abort() 只发信号+入队。

### 10.（中·新发现·结构陷阱）containerTransition 以负向守卫收尾，其后追加新分支必不可达
- `src/workitems/reducer.ts:291`（`if (event.kind !== 'effect_aborted') return {};` 使 effect_aborted 成为隐式兜底）
- 任何人按现有模式在该行之后加新容器事件分支（M1 checkpoint/artifact 事件是已规划增长点）→ 新分支静默不可达，编译不报错，只有端到端才能发现。
- 建议：改为 kind→handler 注册表或显式 switch + exhaustive default。

### 11.（中·新发现·深度）postCommit 是可选依赖，未接线的装配方 poke/abort 被静默丢弃
- `src/workitems/reducer.ts:41`（`postCommit?`）与 `:189`（`this.deps.postCommit?.()`）
- 18 处 ReducerRuntime 构造中 17 处（全部测试）未传 postCommit——测试靠手工 poke 补救，掩盖真实驱动链；未来不经 container 的装配方（脚本/REPL/新入口）落库的 run 效果永远 pending，stalled 的 abort_effect 丢失则旧 handler 跑满墙钟白耗一次运行。
- 建议：postCommit 改必选（测试传 no-op 即可），或 enqueue 返回 actions 强制调用方处置。

### 12.（中·性能）投影与 watchdog 的查询随数据增长线性退化
- `src/workitems/projection.ts:54`：recomputeRollup 每次 apply 全量 listEvents（含逐行 JSON.parse）只为算 `.some(seq>1)`——长寿 workitem 每 apply O(N)、生命周期 O(N²)
- `src/workitems/store.ts:445`：listRunningAssignments 按 status 过滤但索引前导列是 workitem_id，EXPLAIN 实测全表 SCAN + 临时 B-tree 排序，watchdog 每秒一次，assignments 表只增不删
- 建议：seq>1 改 `EXISTS ... LIMIT 1` 或由调用方传入；加偏索引 `(status) WHERE status='running'`。

### 13.（中·性能×正确性耦合）同步子进程阻塞事件循环：git 写提交、启动恢复、每日 tar 备份
- `src/workitems/artifacts.ts:38`（每写 2 个同步 git 子进程）、`src/workitems/recovery.ts:44`（启动串行 reconcile，阻塞在飞书连接之前）、`src/workitems/backup.ts:60`（tar -czf 同步压缩全部 artifact 仓）
- artifact 目录大时 tar 阻塞数秒~数十秒：飞书无响应、**watchdog 漏拍后对正常 run 误判 heartbeat_silent**，性能问题外溢为监督误杀。
- 建议：git/tar 改异步 spawn + 限流队列；reconcile 后台化；备份考虑 git bundle 增量。

### 14.（低中·资源）beats Map 无清理 + prepare 语句无缓存 + 散落 autocommit
- `src/workitems/effects.ts:53`（心跳条目终态后永久残留，重派链放大，无界增长）；`src/workitems/store.ts` 全部方法每次调用重新 prepare（better-sqlite3 无内建语句缓存，已核实）；setEffectStatus/updateWait 等事务外独立 autocommit 各自 fsync
- 建议：executeEffect finally 处 beats.delete；构造器内缓存 Statement；效果状态翻转尽量并入 reducer 事务。

### 15.（低·重复收敛）同形代码多份拷贝已开始漂移
- LoggerLike ×7 文件（backup.ts 变体已与其余 6 份签名分叉）；isObject ×4；assertPositiveFinite ×2（reducer/api）；isRunConclusion ×2（reducer/effects——新增结论 kind 时两处必然分叉）；workitems/backup.ts 的折叠/修剪/sidecar 逻辑与 kernel runBackup 重复（本分支已为 runBackup 加 naming 参数，可直接复用）；测试 harness/workType/waitFor/deferred 样板 ×17 文件
- 建议：类型与谓词收敛 types.ts；备份复用 runBackup(naming)；测试样板沉 tests/helpers/。

## 终扫补充（未进前 15，留档）

- `originalDeadlineTtlSec` 依赖「deadline_at = created_at + ttl」隐式不变式，M1+ 若给 assignment 加续期会静默放大重派 TTL——应持久化 TTL 列（reducer.ts:764 附近）
- assignment 终态化散落四处（closeRunConclusion / redispatchOrEscalate / closeDiscardedAssignment / effect_aborted 分支），endedAt/留痕一致性靠纪律；`cancelled` 在枚举/DDL 存在但全仓无写入方
- `safeRelPath` 未拒绝 `.git/` 前缀：writeArtifact 可写 `.git/hooks/*`，随后的 git commit 会执行 hook——M0 handler 是可信代码，M1b+ 若 artifact 路径受 agent 输出影响则成代码执行面（artifacts.ts:79）
- drainOne 的 missing-handler 路径直接置 aborted 不发 effect_aborted（与 recoverRunning 不一致），assignment 悬挂至 watchdog 收拾（effects.ts:151，v3 P2-3）
- AssignmentSpec.brief 文本被静默丢弃、briefPath 列与实际文件脱节（v3 P2-4）
- wait_resolved 后类型返回 {} 即成「无 wait 无 assignment 的非终态僵尸」，无活性兜底（v3 S-5）
- `api.injectEvent` 在 spec 中声明但未实现（v3 S-7）；noop 无 phase 流转（v3 S-8）

## 与 v3 的关系

v3 的 P1×5 已修复并经本轮复核未回归。本轮新增的高危项（#1 后果升级、#4、#5、#6、#7、#9、#10、#11）全部属于**契约/未来类型可达**层面——M0 noop 路径下均不可达，196 个测试全绿不受影响；但 M1 接入真实工作类型前应优先处置 #1~#7。
