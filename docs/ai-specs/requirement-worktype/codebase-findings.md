# 代码考古发现 — requirement worktype

> 本次考古范围：requirement worktype 一次性落地所触碰的全部子系统（容器 reducer/effects/types/store、worktypes 范本、agents kernel 权限/runner/pool、feishu 卡片/路由、index 接线、架构红线）。
> 本文件是考古发现的 **SSOT**，`design/` 通过链接引用不复制。
> **核验方式**：8 个并行考古员逐条核验《实现总纲》的 41 条 file:line 断言 —— **0 条 refuted，5 条仅行号/措辞漂移（实质全部成立）**。总纲快照与当前代码近零漂移，可信度高。行号基于 2026-06-18 核验快照。

---

## Part A: Human Summary

### 涉及模块（要动的）
- `src/workitems/reducer.ts`（945 行）— 并发与转移核心。**单飞门**（:603-610）是多工人并行改造的唯一收口；checkpoint gate、父子链、批量唤醒都改这里及其邻域。
- `src/workitems/effects.ts` — effect 执行/inflight/abort。`inflight: Map<workitemId,单条>`（:48）是真并行**最大障碍**，要改成按 assignmentId。
- `src/workitems/types.ts` — `WorkType` 接口（:140-150）、`CheckpointPolicy`（:92）、workitems 层 `PermissionProfile{readonly|write}`（:88）、`AssignmentSpec`（:109）。
- `src/workitems/{store,config,artifacts,projection,api}.ts` — 五表 schema、config（缺 `maxWorkersPerItem`）、每工作项 git 仓、投影、inject 门面。
- `src/worktypes/probe/index.ts` + `agent-run/run-handler.ts` — **requirement 的直接照搬范本**；run-handler:147 硬编码 readonly 是写权限改造点。
- `src/agents/types.ts`（PermissionProfile `full|readonly`，:98）、`claude/runner.ts`（buildClaudeArgs :36）、`pool.ts`（Semaphore 调度，无优先级）。
- `src/feishu/{event-router,card}.ts` — event-router 只处理 `im.message.receive_v1`（:15）；卡片回调原语从 0 到 1；卡片标题硬编码"调查"需去化。
- `src/index.ts`（顶层，921 行）— `createWorkitemsRuntime`（:807）装配总入口；`runProbe`（:498）触发范本；`postStatus`（:841）锚点刷新。
- **新建**：`src/worktypes/requirement/`、`src/knowledge/`、HTTP 工作台模块。

### 主要复用点（一两句，细节看 Part B）
- 复用 [probeWorkType + probeTransition](#res-probeworktype) 整套 worktype 范本（7-phase onEvent 照此放大）。
- 复用 [createAgentRunHandler / runAgent](#res-createagentrunhandler) run handler 骨架（换 prompt + 权限 + cwd）。
- 复用 [insertDispatchOrWake 单飞门](#res-insertdispatchorwake) 作并发分流唯一改点；[isRunClass/hasInflightRunEffect](#res-isrunclass) 作并发判据。
- 复用 [checkDecision/structuralCheck/eventsSince](#res-checkdecision) 作 isDecisionStale 接入点（容器侧已就绪，worktype 只填纯函数）。
- 复用 [ArtifactStore](#res-artifactstore)（写即 commit，契约"冻结"免费拿 git 史）。
- 复用 [ProgressCards/RunProgressSink](#res-progresscards)（每 worker 一张流式卡，按 assignmentId 天然分流）。
- 复用 [claimThread / managed 影子 task](#res-claimthread)（一需求一话题 + run channel 隔离，零额外路由）。
- 复用 [resolveWait/injectHumanMessage 注入门面](#res-workitemsapi)（checkpoint 拍板扩展此处，不新增并行入口）。

### 关键集成点
- `reducer.ts:603-610` — 单飞门拆成 role/topology 感知；`reducer.ts:616` — parent_id 启用写入+消费。
- `effects.ts:48,66,168,175,229,334` — inflight 键 workitemId→assignmentId 的连锁改造（6+ 处）。
- `run-handler.ts:147` — 硬编码 readonly 改由 worktype.permissions 驱动；`pickCwd`（:214）改为 worktree 路径。
- `agents/types.ts:99` 加 `write` 档 + `writableDirs`；`claude/runner.ts:57-61` 加 write 分支；`runOptionsFingerprint`（:119）纳入目录。
- `feishu/event-router.ts:15` 加 `card.action` 事件键（走 ws，不起 HTTP）；卡片构造器去"调查"化。
- `architecture.ts:109-114` — **新增 `knowledge/` 层分支**（否则 src/knowledge/ 落 kernel 触发禁词）。

### 历史踩坑 / 注意事项
- **inflight Map 键 = workitemId**：effects.ts 内 6+ 处依赖"一 workitem 一 inflight"，改键漏一处即 worker 互相覆盖/恢复漏项。
- **parent_id 是死列**：schema 有列（self-ref FK），但 reducer 恒写 null、从不读 —— 建父子链要补完整两端，非"免费拿"。
- **两层 PermissionProfile 同名不同义**：agents `full|readonly` vs workitems `readonly|write`；映射**绝不能** workitems-write → agents-full（full=无限制 `--dangerously-skip-permissions`，会丢目录限定）。
- **`--add-dir` 放宽不收紧**：不能限定写入目录；真限定靠 **PreToolUse hook**，但 hook/settings 基建当前**不存在**，要新建。
- **canResume:()=>false 不能照搬**：probe readonly 幂等可 redispatch；worker write 已改盘（非幂等），redispatch 重跑污染 worktree。
- **wakePending 是布尔标志非事件批**：当前唤醒只跑一次 default solo run，"批量带入自上次 run 全部事件"尚是设计目标（有 `lastRunEffectSeqBefore`/`eventsSince` 两块查询砖）。
- **retryBudget 全局共用（默认1）**：集成验证/契约返工的修复循环若复用 `assignment.retries` 会与 stall 重试串味，应独立计数。
- **worktype 必须纯同步**：`worktypes/*/index.ts` 禁 async/await/fs/child_process（CI 强制）。
- **kernel 禁词**：`workitem|workitems|assignment|worktype|phase`（/i）；`requirement`/`WorkItemEvent` 安全，`WorkItem`/`Phase` 不安全。

### 不在范围（容易误改但本次不动）
- `src/bridge/commands.ts` 的桥任务命令（`/list /stop /rm`）— 只新增 `/req`，不动桥命令命名空间。
- 桥四层 fallback 路由（index.ts:679-711）— 复用其 managed 隔离，不改逻辑。
- `StreamingCard` 节流参数、M2 流式卡生命周期 — 直接复用，不调。
- Codex runner — 未接入，write 档不走 Codex。

---

## Part B: AI Details

> 给执行 skill 消费。精确签名/路径/使用场景。`design/` 用锚点链接引用本节，不 copy。

### 容器 reducer / 并发核心（src/workitems/reducer.ts）

<a id="res-insertdispatchorwake"></a>
#### `insertDispatchOrWake`（单飞门所在 / 唯一 dispatch 收口）
- **位置**：`src/workitems/reducer.ts:588-643`（单飞门 :603-610）
- **签名**：`private insertDispatchOrWake(item: WorkItem, seq: number, spec: AssignmentSpec, now: number): void`
- **现状**：单飞门三段与 `!spec.replacesAssignmentId && this.isRunClass('run') && this.hasInflightRunEffect(item.id)` → 命中只 `updateWorkItem({wakePending:true})` 并 return，**不读 role**。replacement（`replacesAssignmentId` 非空）整条短路绕门。`defaultDispatchSpec` 固定 `role:'solo'`（:847）。注释自称"single chokepoint for every dispatch path"。
- **本次使用场景**：R01 多工人并行的唯一改点 —— `topology()==='owner-workers'` 时按 `spec.role` 分流：owner run 检 owner 在途才拦；worker run 检在途 worker 数 < `WORKITEMS_MAX_WORKERS_PER_ITEM` 才放，超转 wakePending。需新增按 `assignment.role` 过滤在途 effect 的查询。

<a id="res-isrunclass"></a>
#### `isRunClass` / `hasInflightRunEffect` / `findInflightRunEffectForAssignment`
- **位置**：`reducer.ts:841-843` / `:825-829` / `:831-839`
- **签名**：`isRunClass(kind):boolean = deps.isRunClass?.(kind) ?? kind==='run'`；`hasInflightRunEffect(workitemId):boolean = listInflightEffects().some(isRunClass)`；`findInflightRunEffectForAssignment(workitemId, assignmentId): Effect|undefined`（按 `payload.assignmentId` 精确匹配）
- **本次使用场景**：并发判据基石。`findInflightRunEffectForAssignment` 已是 per-assignment 粒度 —— R01 的 per-assignment abort 直接复用。需新增 `countInflightWorkerRuns`（list + 按 `assignment.role==='worker'` 过滤）作上限判据。

<a id="res-redispatchorescalate"></a>
#### `redispatchOrEscalate`（返工/重试核心）
- **位置**：`reducer.ts:519-559`
- **签名**：`private redispatchOrEscalate(assignment, now, reason): Transition`
- **现状**：`assignment.retries >= cfg.retryBudget`（默认1）→ 置 `failed` + audit + 建 `{kind:'human', reason:'retry_exhausted', deadlineTtlSec:humanWaitTtlSec, originAssignmentId}` wait；否则置 `superseded` 并 dispatch `{role:assignment.role, replacesAssignmentId, retries+1}`。
- **本次使用场景**：worker 失败重试复用此 stall 路径（R18）。⚠️ requirement 的"集成验证修复 2 轮""接口改 2-3 次举手"**不要复用 `assignment.retries`**（那是 stall 预算），另起独立计数（R11/R14）。

<a id="res-checkdecision"></a>
#### `checkDecision` / `structuralCheck` / `eventsSince`（决策新鲜度机制）
- **位置**：`reducer.ts:746-801` / store `eventsSince` `src/workitems/store.ts:623-635`、`lastRunEffectSeqBefore` `store.ts:593-604`
- **签名**：`checkDecision(workitemId, payload, type, currentSeq): DecisionCheck`；先 `structuralCheck`（检 effect aborted / assignment superseded·terminal / wait resolved），再 `eventsSince(workitemId, basedOnSeq, currentSeq)` 调 `type.isDecisionStale(decision, eventsSince)`，true → `reason:'semantically_stale'`
- **本次使用场景**：R10 真实现 isDecisionStale 的接入点**已就绪，无需改 reducer** —— worktype 只在纯函数里对 eventsSince 做契约结构 diff。`lastRunEffectSeqBefore`+`eventsSince` 是 R02 Owner"批量带入自上次 run 以来事件"的查询砖。

<a id="res-containertransition"></a>
#### `containerTransition` / `mergeTransitions`（容器事件分发 + 合并）
- **位置**：`reducer.ts:370-397`（switch）/ `:886-894`（merge）
- **现状**：`containerTransition` switch 处理 `wait_reminder/timer_fired/wait_resolved/wait_renewed/assignment_stalled/effect_aborted`，default `{}`。`mergeTransitions`：**phase/terminal 只取 worktype 侧，dispatch/waits/effects 是 container+type 拼接**。
- **本次使用场景**：R03 checkpoint gate 的新容器事件在此 switch 加 case。⚠️ **关键约束**：容器侧无法直接覆写 `transition.phase`（merge 只取 worktype 的 phase）—— checkpoint 拦 phase 越界必须在 **`applyTransitionWrites` 消费 phase 前拦**（:265-276）或改走 wait 机制，不能靠容器事件改 phase。

<a id="res-reducer-purity"></a>
#### reducer 纯转移保证 + 关键不变量
- **位置**：tx 边界 `reducer.ts:162-232`；post-commit IO `:236-246`；`store.tx` `store.ts:230-232`（`this.db.transaction(fn)()` 同步）
- **不变量（细化必守）**：① reducer 全文无 await/async，IO 一律 post-commit（`PostCommitAction` = abort_effect|poke，:33-35）；② 同一 apply 内追加 audit 事件**必须各自 fresh nextSeq**（`appendAudit` :254），禁 `event.seq+1`，否则撞 `UNIQUE(workitem_id,seq)` 把 apply 回滚成 poison；③ `terminal` 转移直接 drop 同帧 dispatch/waits/effects（:277-308，audit `terminal_work_dropped`）—— owner 收尾同帧不能再派 worker。

<a id="res-reducerdeps"></a>
#### `ReducerRuntimeDeps`（依赖注入）
- **位置**：`reducer.ts:37-57`，装配于 `container.ts:51-68`
- **签名**：`{ store, registry, clock, cfg, logger?, isRunClass?, postCommit, onCommitted? }`
- **本次使用场景**：`cfg`（WorkitemsConfig）是新增 `maxWorkersPerItem` 等可配置项的注入入口；`isRunClass` 注入点（container.ts:57 = effects.isRunClass）让 worker run 的 effect kind 也归 run 类。

### 容器 effects / 恢复 / 监督

<a id="res-inflight"></a>
#### `EffectRuntime.inflight` + `executeEffect` + `poke`/`drainOne`（真并行最大改造点）
- **位置**：`effects.ts:48`（Map）/ `:41-44`（InflightEffect）/ `:196-240`（executeEffect）/ `:65-74`（poke）/ `:167-194`（drainOne）
- **现状**：`inflight = Map<string/*workitemId*/, {effectId, controller:AbortController}>`，每 workitem **至多一个** inflight。poke 守卫 `inflight.has(workitemId)`（:66）阻止第二个 effect；drainOne `:175` "有 running 就早退"、`:177` 只取一个 pending；executeEffect finally `inflight.delete(workitemId)`（:229）。
- **本次使用场景**：R01 真并行核心改造 —— 键 `workitemId→assignmentId`（或值改数组），连带改 6+ 处：poke:66 / drainOne:168,175 / executeEffect delete:229 / findInflight:334 / recoverRun·recoverRunning `inflight.has`:78,94。owner 单飞靠 reducer 单飞门分流（不靠 inflight 键）。

<a id="res-effecthandler"></a>
#### `EffectHandler` / `EffectContext`（effect 实现契约）
- **位置**：`effects.ts:8-14`（EffectHandler）/ `:16-30`（EffectContext，构造 `contextFor` :242-293）
- **签名**：`EffectHandler = { kind:string; recovery:'rerun'|'resume-or-redispatch'; run(ctx):Promise<void>; canResume?(payload,assignment,workitem):boolean; resume?(ctx):Promise<void> }`；`EffectContext` 含 `signal:AbortSignal、heartbeat()、emit(kind,payload)、writeArtifact/readArtifact、setAgentSessionId、batchFromSeq、eventsSince`
- **本次使用场景**：R12 worker run handler / R14 集成验证 / R03 checkpoint handler 照此实现。worker run = `recovery:'resume-or-redispatch'` + 实现 canResume（查 session + worktree 脏否，R09/R12）；集成验证若幂等用 `'rerun'`。⚠️ `emit` 拦截 `isRunConclusion`（:283-291）—— worker **不能** `ctx.emit('run_completed')` 伪造完成，只能 run() 正常返回 + 报告门通过。`isRunClass(kind) = recovery==='resume-or-redispatch'`（:61-63）。

<a id="res-validaterunreport"></a>
#### `validateRunReport`（reportRequired 报告门）
- **位置**：`effects.ts:295-312`（reportRequired 判定 :301）
- **现状**：`if (type?.artifacts.reportRequired !== true) return {ok:true}`；缺/空 report.md → `{ok:false}` → run_failed。
- **本次使用场景**：R12"绿了才能交活" —— worker 交活前跑绿契约测试+本端单测，可在此门旁**新增"测试结果门"**（不绿判 run_failed），reportRequired 是现成范式。

<a id="res-startuprecovery"></a>
#### `startupRecovery` / `recoverRun` / `recoverRunning`（崩溃恢复）
- **位置**：`recovery.ts:18-65`；`effects.ts:92-123`（recoverRun）/ `:76-90`（recoverRunning）
- **现状**：四步（rollup 重算 / 在途 effect 按 kind 分流 / artifact reconcile / pending poke）。recoverRun：assignment 仍 running 时 `canResume?resume:abort('recovery_redispatch')`，非 running 直接 abort（避免重复处理已结 stall）。
- **本次使用场景**：R24 多 worker + replacement 同时在途的崩溃恢复复用此编排。⚠️ `recoverRun/recoverRunning` 的 `inflight.has(workitemId)` 早退（:78,94）在多并发恢复下**大概率漏恢复** —— 是必须夹具验证并很可能要改的点（随 inflight 键改造连带）。

<a id="res-watchdog"></a>
#### `Watchdog`（活性监督，1Hz sweep）+ b794939 心跳改造
- **位置**：`watchdog.ts:34-157`（三类停滞探测 :94-131）；心跳源 `run-handler.ts:138`（onActivity）
- **现状**：扫 running assignment 判 `wallclock_exceeded`（prio4）> `heartbeat_silent`（prio3，`now-beat>=heartbeatTimeoutSec*1000`）> `deadline_exceeded`（prio2）+ open wait `agent_wait_expired`（prio1）→ `assignment_stalled`。`beats` Map（effects.ts:49）键 = **assignmentId**。b794939：心跳源从 onText/onToolUse 改挂 `onActivity`（每行 stdout），heartbeatTimeoutSec 现义="stdout 完全静默 N 秒=真 wedge"，与任务时长解耦。
- **本次使用场景**：R18/R24 worker 监督**免费拿** —— beats 键 assignmentId，多 worker 心跳天然隔离，watchdog 不改。前提：worker run handler 照 `run-handler.ts:138` 挂 onActivity（否则长思考误判 stalled）。

<a id="res-errors"></a>
#### `OpenLimitError` 等错误类型
- **位置**：`errors.ts:1-21`
- **现状**：`OpenLimitError(limit)` 含中文 `已达并行上限，请先收尾（maxOpen=${limit}）`（errors.ts 属 workitems 层、不受 kernel 无业务词约束，是少数允许中文用户文案处）。
- **本次使用场景**：worker 并发上限超限提示可照此新建（注意避 phase 等词以防误伤）。

### 容器 types / store / api / config / artifacts

<a id="res-worktype-interface"></a>
#### `WorkType` 接口 + `Transition` / `AssignmentSpec` / `Decision`
- **位置**：`types.ts:140-150`（WorkType）/ `:132-138`（Transition）/ `:109-118`（AssignmentSpec）/ `:101-107`（Decision）/ `:127-130`（EffectDecl）/ `:75-82`（WorkItemEvent）/ `:88-90`（PermissionProfile readonly|write）/ `:92-94`（CheckpointPolicy）
- **签名**：
  - `WorkType { id; triggers; initialPhase(item):string; onEvent(item,ev):Transition; isDecisionStale(decision,eventsSince):boolean; topology(item):'solo'|'owner-workers'; permissions:PermissionProfile; checkpoints:CheckpointPolicy; artifacts:ArtifactSpec }`
  - `Transition { phase?:{to,reason}; terminal?:'done'|'failed'|'cancelled'; dispatch?:AssignmentSpec[]; waits?:WaitSpec[]; effects?:EffectDecl[] }`
  - `AssignmentSpec { role:'owner'|'worker'|'solo'; repo?; deadlineTtlSec; wallclockCapSec; replacesAssignmentId?; retries?; brief?; payload? }`（**无 basedOnSeq** —— reducer 写入 :625）
  - `Decision { refs?:{assignmentIds?;waitIds?}; data?:unknown }`
  - `CheckpointPolicy { requiredBefore: string[] }`
- **本次使用场景**：R08 requirement WorkType 定义照此。`Transition` 一个声明式结构表达 7-phase/4 灯 wait/worker 并行 dispatch/新 effect kind。contract diff 判据塞进 `decision.data`。新事件 kind 直接写 `kind` 字段（DB 无 CHECK，容器不解释）。⚠️ worktype index.ts 必须纯同步（禁 async/fs/child_process）。

<a id="res-five-tables"></a>
#### 五表 schema（src/workitems/store.ts）
- **位置**：`store.ts:238-332`（migrate v1）/ `:338-343`（v2 索引）
- **现状**：`workitems(id,type,title,status,status_detail,phase,source_json,dedupe_key,repos_json,context_json,wake_pending,discard_streak,...)` UNIQUE(type,dedupe_key)；`workitem_assignments(...,parent_id[self-ref FK],role[CHECK owner/worker/solo],agent_session_id,replaces_assignment_id,deadline_at,wallclock_cap_sec,retries,based_on_seq,brief_path,report_path,...)`；`workitem_waits(...,kind,origin_assignment_id,reason,deadline_at,renewed_count,reminded_at,resolved_at,resolved_by,resolve_reason,...)`；`workitem_effects(id AUTOINCREMENT,workitem_id,seq,kind,payload_json,status,...)`；`workitem_events(...UNIQUE(workitem_id,seq)+append-only 触发器 no_update/no_delete)`
- **本次使用场景**：R25 增量。新增列（permissions repos / parent_id 索引）走 `user_version<3` 新迁移段（`store.ts:334` 模式）。事件不可改不可删 —— checkpoint/contract 决策记录天然有审计性。⚠️ `parent_id` 列在但 reducer 恒写 null、从不读。

<a id="res-workitemsapi"></a>
#### `WorkitemsApi`（单一注入门面）
- **位置**：`src/workitems/api.ts:20-104`
- **签名**：`createWorkItem(input):CreateResult`；`resolveWait(waitId, {operator,reason}):ResolveWaitResult`（timer 抛 TimerNotResolvableError，已 resolved 返 alreadyResolvedAt，否则 enqueue `wait_resolved`）；`injectHumanMessage(workitemId, {text,feishuMsgId?})`（enqueue `human_message`）；`injectClose(workitemId)`（enqueue `close_requested`）；`renewWait(waitId, {operator,deadlineTtlSec})`；`listEvents(id):WorkItemEvent[]`
- **本次使用场景**：R03/R22 所有外部写路径（卡片回调/页面按钮）→ inject 门面 → reducer.enqueue。⚠️ checkpoint 拍板**扩展 resolveWait** input 加 `decision?`（不新增并行 inject 方法）；当前 input 仅 `{operator,reason}`，无 decision 字段。

<a id="res-artifactstore"></a>
#### `ArtifactStore`（每工作项 git 仓，写即 commit）
- **位置**：`src/workitems/artifacts.ts:8-94`
- **签名**：`writeFile(workitemId,relPath,content,message):void`[写即 commit]；`readFile(workitemId,relPath):string|undefined`；`isClean(workitemId):boolean`；`reconcile(workitemId,label):'noop'|'committed'|'recreated'`；`initRepo(workitemId)`；`repoPath(workitemId):string`
- **现状**：每 workitemId 一个独立 git 仓（`$DATA_DIR/workitems/<id>/`），`git init -b main`，writeFile 写完即 `git add -A && git commit --allow-empty`。有路径穿越防护（拒绝绝对路径/`../`）。**不硬编码布局** —— `brief.md/journal.md/decisions.md/contract/design/` 是 worktype 约定的目标布局。
- **本次使用场景**：R08/R09 契约/报告/journal 经 writeFile 落地，契约"冻结"免费拿 git 史。⚠️ `isClean` 只判 git 工作区是否干净，**无内容/schema 校验** —— owner journal 写回校验（R11）要在 worktype 层另建。`--allow-empty` 即内容未变也产空 commit，契约 diff 按内容判而非 commit 数。

<a id="res-projection"></a>
#### `computeRollup`（状态投影）
- **位置**：`src/workitems/projection.ts:18-37` / `:39-62`
- **现状**：优先级 `terminal > human wait > running assignment > agent wait > timer wait > 有事件→active/open`。
- **本次使用场景**：R03/R23 —— 4 灯 human wait 一旦 open，即便有 worker 在跑，status 也显示 `waiting/human`（盖住 active）。焦点卡（工作台）据 open human waits 查"该你了"。多 worker 不改投影（`hasRunningAssignment` 是布尔，任一 running 即 active）。

<a id="res-config"></a>
#### `WorkitemsConfig`（缺 maxWorkersPerItem）
- **位置**：`src/workitems/config.ts`（maxOpen 默认3 :14，env WORKITEMS_MAX_OPEN :36；retryBudget默认1 :18）
- **现状字段**：`maxOpen / retryBudget / humanWaitTtlSec / defaultDeadlineTtlSec / defaultWallclockCapSec`。`maxWorkersPerItem` / `WORKITEMS_MAX_WORKERS_PER_ITEM` **全仓零命中**，要新增。
- **本次使用场景**：R01/R25 新增 `maxWorkersPerItem`（默认2）+ env，在 DEFAULTS + loadWorkitemsConfig 各加一项。

### worktypes 范本（probe / agent-run / noop）

<a id="res-probeworktype"></a>
#### `probeWorkType` / `probeTransition` / `registerProbe`（worktype 范本）
- **位置**：`src/worktypes/probe/index.ts:12-71`（registerProbe）
- **现状**：`probeWorkType = {id, triggers:{api:true}, initialPhase('probe:looking'), onEvent, isDecisionStale:()=>false, topology:()=>'solo', permissions:{mode:'readonly'}, checkpoints:{requiredBefore:[]}, artifacts:{reportRequired:true}}`。`probeTransition`：`workitem_created→dispatch soloRun`、`run_completed→probe:idle`（非终态，留追问可达）、`human_message→probe:looking 再 dispatch`、`run_failed→retry 或 probe:failed(terminal)`、`close_requested→probe:done(terminal:'done')`。
- **本次使用场景**：R08 直接照搬模板 —— 定义 `requirementWorkType`（id:'requirement'、7-phase onEvent、topology 返 'owner-workers'、permissions write、真 isDecisionStale），写 `registerRequirement(registry)`。idle→close 两段式（停非终态等外部信号再收尾）可借鉴给"交付→沉淀→终态"。

<a id="res-createagentrunhandler"></a>
#### `createAgentRunHandler` / `runAgent` / `composeProbePrompt` / `pickCwd`
- **位置**：`src/worktypes/agent-run/run-handler.ts:70-82`（工厂）/ `:84-179`（runAgent）/ `:193-212`（composeProbePrompt）/ `:214-217`（pickCwd）/ 硬编码 readonly `:147`
- **签名**：`createAgentRunHandler(deps:{pool,kernelStore,defaultCwd,logger?,progress?}): EffectHandler`；`runAgent(ctx,deps)` 七步：①组自包含 prompt+写 brief.md ②upsertTask 定 cwd（:105）③onRunStart 发流式卡 ④心跳/进度回调桥（onActivity :138）⑤构造 options（:147 硬编码 `{permission:{mode:'readonly'}}`）⑥abort 桥（ctx.signal→pool.abort(task.id) :150）+`pool.send(task,prompt,callbacks,options)`（:153）⑦写 report.md+onRunEnd；`composeProbePrompt(title, priorReport, followups):string`（第一句硬编码"只读、不要修改任何文件" :199-200）；`pickCwd(workitem,fallback) = workitem.repos[0] ?? fallback`
- **本次使用场景**：R12 worker run handler 照工厂改写三处：① composeProbePrompt→composeWorkerPrompt（任务卡+冻结合同+repo 知识，**去掉"只读不改"系统句**）；② :147 硬编码 readonly→由 worktype.permissions+repos 映射 write 档；③ pickCwd(repos[0])→该 assignment 的 worktree 路径。结构（kind/recovery/canResume/run/resume）整体复用。⚠️ `canResume:()=>false`（:73-77）**不能照搬**（worker write 非幂等）。⚠️ run-handler 禁 `AgentPool|Runner|spawn|child_process`（副作用走 EffectContext 注入）。

<a id="res-upserttask"></a>
#### `Store.upsertTask` + owner_kind 隔离（managed 影子 task）
- **位置**：`src/store.ts:292-303`（Task 接口 :13-27，cwd:19，owner_kind:'bridge'|'managed' :11）
- **签名**：`upsertTask(t: Omit<Task,'created_at'|'last_active_at'>): Task`；`ON CONFLICT(id)` 只刷新 cwd 与 last_active_at（agent_session_id 等保留旧值）
- **本次使用场景**：R12 worker run 的 cwd 唯一落点 —— 每 worker 一个 `id=managed:${assignment.id}`、owner_kind:'managed' 的影子 task，cwd=worktree 路径。owner_kind:'managed' 让其对桥侧查询（routing/list/rm）不可见，requirement 影子 task 都走 managed，零额外隔离。⚠️ artifact 仓（writeArtifact 写处）≠ worktree（cwd），两套路径分开。

<a id="res-noop-fixture"></a>
#### noop 故障/心跳注入夹具
- **位置**：`src/worktypes/noop/index.ts:3-17,74-88` + `noop/run-handler.ts:22-94`
- **现状**：`NoopFailAt='before-run'|'during-run'|'before-report'`、`NoopHeartbeatMode='silent'|'normal'|'beat-no-finish'`、`failCount`（前 N 次失败第 N+1 成功，用 `(ctx.assignment?.retries??0)<failCount`）、`simulateResumable`。
- **本次使用场景**：R24 回归基石 —— 扩 noop 注入（加 `topology:'owner-workers'`、`dispatch role:owner/worker 多 assignment`、`checkpoints.requiredBefore` 可填），像 M0 打 outbox 那样回归锁定多 worker 并发、checkpoint gate、两条非单飞路径崩溃恢复，再接真 agent。failAt+failCount 精确编排第 N 次失败、heartbeatMode 模拟卡死/静默供 watchdog 回归。

### agents kernel（权限 / runner / pool）

<a id="res-runoptions"></a>
#### `RunOptions` / `PermissionProfile`(agents) / `McpServerSpec` / `runOptionsFingerprint`
- **位置**：`src/agents/types.ts:109-112`（RunOptions）/ `:98-100`（PermissionProfile `full|readonly`，注释 `'write' lands in M2`）/ `:102-107`（McpServerSpec）/ `:119-126`（fingerprint）
- **签名**：`RunOptions { permission?:{mode:'full'|'readonly'}; mcpServers?:McpServerSpec[] }`（**无 cwd** —— cwd 是 Task 字段 store.ts:19）；`fingerprint = permission.mode + mcpServers(按 name 排序)`，`full && 0 servers → ''`（零回归）
- **本次使用场景**：R04 写权限档 —— agents `PermissionProfile.mode` 加 `'write'`，RunOptions 加 `writableDirs?:string[]`（agents 层只认路径不认"repo"，守 kernel 中性），**fingerprint 必须纳入 writableDirs**（否则换 repo 不重建 runner —— 隐藏缺口）。

<a id="res-buildclaudeargs"></a>
#### `buildClaudeArgs`（Claude 启动参数）
- **位置**：`src/agents/claude/runner.ts:36-65`；`READONLY_DENIED_TOOLS='Write Edit MultiEdit NotebookEdit'` :34
- **现状**：固定段 `-p --input-format stream-json --output-format stream-json --verbose --model --effort`（:43-54）；权限分支 `readonly→--disallowedTools READONLY_DENIED_TOOLS`（:57-58）/ `full(else)→--dangerously-skip-permissions`（:60）**互斥**；尾段 `--mcp-config --strict-mcp-config`（:62）/ `--resume`（:63）
- **本次使用场景**：R04 加第三分支 `write`：**不带** `--dangerously-skip-permissions`（那=无限制丢目录限定）+ `--add-dir <repos>` + 写工具白名单/settings/PreToolUse hook。⚠️ `--add-dir` 放宽不收紧（不限定写入）；MultiEdit 已合并进 Edit（deny 留着无害，白名单时收敛为 `Write Edit NotebookEdit`）。

<a id="res-pool"></a>
#### `AgentPool` + `Semaphore`（调度，无优先级）
- **位置**：`src/agents/pool.ts`：Semaphore `:22-56`、send `:109-167`、evictLRU `:196-216`、observability `activeRuns/queuedRuns` `:101-107`
- **现状**：**有排队**（WI-C 引入 Semaphore，cap=`min(maxConcurrent??maxHot, maxHot)`，FIFO，"忙时超 cap"已过时）；`send()` 先 `tryAcquire` 满则 `onQueued`+`await acquire`，acquire 在 createRunner 之前（防 thrash）；evictLRU 挑 lastActivity 最小 idle hot runner，**无优先级/owner 维度**；fingerprint 变 → dispose+重建（:120-134）。
- **本次使用场景**：R07 Owner 预留槽 —— Semaphore 单一无差别池 FIFO → worker 占满则 owner 排队尾（优先级反转确凿）。改点：① Semaphore 加预留槽/优先级队列；② send 新增 `priority`/`role` 入参（task.owner_kind 区分不了 owner-vs-worker，都是 managed）；③ evictLRU 可选保护 owner。⚠️ 总纲§14⑤"不用改 pool"指写权限档；§19 Owner 预留槽是另一条、确实改 pool。

### feishu kernel（卡片 / 事件路由 / 流式）

<a id="res-eventrouter"></a>
#### `createDispatcher`（事件路由，缺卡片回调）
- **位置**：`src/feishu/event-router.ts:7`（createDispatcher）/ `:15-16`（register 唯一键 `im.message.receive_v1`）；ws 接线 `index.ts:774`
- **现状**：`EventDispatcher.register` 只注册 `im.message.receive_v1`，无卡片 action 回调。卡片 body 全 markdown/hr，**无 value/button**。飞书纯 ws（无 HTTP 端点）。
- **本次使用场景**：R06 卡片回调原语 —— 在 register 加 `card.action.trigger`（之类）事件键（**走 ws，不起 HTTP**）。kernel/feishu 只分发 raw card action（value 当不透明 payload 透传），**不解释 workitemId/checkpoint**（守红线），上层 workitems adapter 解释。需先定义卡片 value schema + button 构造器（0 到 1）。

<a id="res-cards"></a>
#### 卡片构造器（buildAnchorCard 等）+ anchorAction
- **位置**：`card.ts:59`（buildAnchorCard，AnchorCardData{id,title,stage,status,closed?}）/ `:101`(buildReportCard) / `:127`(buildErrorCard) / `:152`(buildCancelledCard) / `:179`(anchorAction)
- **现状**：锚点卡只有进度/状态字段（markdown 文本）。标题硬编码"调查 · / 调查报告 · / 调查失败 · / 调查中断 ·"（:78-81 等）。`anchorAction(kind, isTerminal):{reply,update}` 是**纯映射函数**（非卡片构造器，名字误导）。
- **本次使用场景**：R23 requirement 锚点卡复用 buildAnchorCard 但**标题前缀需参数化/新增专用构造器**（否则显示"调查"误导）。新事件 kind（design_ready/checkpoint_*）须在 `anchorAction` 加映射决定是否刷锚点（否则静默）。守 kernel 中性命名（stage/status，避业务词 + status===）。

<a id="res-progresscards"></a>
#### `ProgressCards` / `RunProgressSink` / `StreamingCard` / `Sender`
- **位置**：`progress-cards.ts:49`（ProgressCards）/ run-handler.ts:14-44（RunProgressSink）/ `stream-card.ts:24`（StreamingCard）/ `sender.ts:50`（Sender，replyCardInThread :110、updateCard :133）
- **签名**：`RunProgressSink { onRunStart({workitemId,assignmentId,title,chatId?,threadId?,anchorMsgId?}); onText({assignmentId,fullText}); onToolUse({assignmentId,toolName}); onRunEnd({assignmentId,outcome:'success'|'failed'|'aborted',report?,error?}) }`；ProgressCards 鸭子实现（不 import worktypes，守 kernel 边界），onRunEnd 三态原地 updateCard 收尾；StreamingCard 节流（900ms + 5s 时钟心跳 + 单 in-flight PATCH + sig 去重）
- **本次使用场景**：R12/R23 每 worker 一张流式卡 —— sink 按 assignmentId 天然分流，N worker=N 卡，**接口无需改**。onRunStart 的 title 多 worker 下带 role/repo 区分（"后端 worker · repo-x"）。onText 是全量快照（非增量）。所有飞书 IO fire-and-forget + try/catch，失败不拖垮 run。

### index 接线 / 桥共存（src/index.ts 顶层）

<a id="res-createworkitemsruntime"></a>
#### `createWorkitemsRuntime`（装配总入口）+ runProbe + postStatus
- **位置**：`index.ts:807-883`（createWorkitemsRuntime）/ `:871`(registerProbe) / `:872`(effects.registerHandler) / `:498-564`(runProbe) / `:566`(runDone) / `:820,826,841`(postStatus 晚绑定 thunk)
- **现状**：装配顺序 `createContainer(onCommitted thunk)→ProgressCards→postStatus 赋值→registerProbe→registerHandler→start()`。postStatus 晚绑定（循环依赖，:820 空 thunk，:841 赋真实，用 `anchorAction`+`isTerminalStatus` 分发，避 `status===`）。
- **本次使用场景**：R08 注册 —— `registerProbe` 后追加 `registerRequirement(workitems.registry)`（effects.registerHandler 是通用 agent-run，requirement 多角色 run 复用同一 handler，可能需为 worker/集成验证注册额外 handler kind）。R23 仿 runProbe 写 runRequirement 闭包（发锚点占位卡→createWorkItem→claimThread→补全卡）。⚠️ index.ts 受 index-wiring grep 守门（禁 `workitems.status`/`status===`，用 `item.status`+`isTerminalStatus`）。

<a id="res-claimthread"></a>
#### `Store.claimThread` 等（话题认领 + 反查）+ 入站路由
- **位置**：`store.ts:208-229`（claimThread/getThreadClaim/releaseThreadClaim）/ `:233-251`（getThreadRootByOwner/getThreadAnchorByOwner）；入站追问路由 `index.ts:643-677`
- **签名**：`claimThread(rootId, ownerKind:'bridge'|'managed', ownerId, anchorMsgId?)`；`getThreadRootByOwner(ownerId):string|undefined`；`getThreadAnchorByOwner(ownerId):string|undefined`
- **本次使用场景**：R23 一需求一话题复用 `claimThread(claimKey,'managed',item.id,anchorMsgId)`；入站追问路由（:643-677）已通用（对任意 managed-claimed workitem `injectHumanMessage`），requirement **零改动复用**；若要区分"追问 vs 决策答复"，在路由前加 worktype-aware 分支。postStatus 出站用 getThreadAnchorByOwner 刷锚点。

<a id="res-commandhandler"></a>
#### `CommandHandler`（命令分发，kernel 范本）+ BackupJob
- **位置**：`src/bridge/commands.ts:45`（class）/ onProbe :56 / onDone :57 / dispatch /probe :124→handleProbe :313；BackupJob `backup.ts:26-29`，scheduleDailyBackup :147-184，注入 `index.ts:162`
- **现状**：CommandHandler 构造器注入回调，命令层零业务词、"只搬运不解释"（解析参数调回调，create/claim 在 index.ts）。
- **本次使用场景**：R23 仿 /probe 加 `/req`（dispatch switch case + 构造器 onRequirement 回调 + index 注入 runRequirement）。R25 若引入新持久化（knowledge 库）挂 BackupJob 纳入日备份。

### 架构红线（CI 强制，requirement 不能踩）

<a id="res-redlines"></a>
#### 红线词表 / layerFor / 守门正则（tests/helpers/architecture.ts）
- **位置**：`tests/helpers/architecture.ts`：禁词 :17、phase 检测 :18-19、import :16、layerFor :109-114；`tests/workitems/index-wiring.test.ts:49`
- **逐字规则**：
  - **kernel 禁业务词**（/i）：`/\b(workitem|workitems|assignment|worktype|phase)\b/i` —— `WorkItem`/`Assignment`/`WorkType`/`Phase` 全禁；**`requirement` 安全（不在表）**；`WorkItemEvent` 安全（无词边界）；`status`/`claim`/`probe`/`noop` 安全。
  - **phase 解释**（仅 workitems 层）：`/\bphase\b\s*(?:={2,3}|!={1,2})|.../`（phase==/===/!=）+ `/switch\s*\([^)]*\bphase\b[^)]*\)/`。
  - **layerFor**（按相对 src 根 POSIX 路径顺序判）：`workitems/`→workitems；`worktypes/`→worktypes；`==='index.ts'`→kernel-exempt；`==='config.ts'`→kernel-exempt；**其它全 kernel**。豁免是**精确等值**（仅 src 根 index.ts/config.ts；`workitems/config.ts` 不豁免）。
  - **index-wiring**（src/index.ts）：`/workitems?\.[^\n]*(status|phase)|\b(status|phase)\b\s*={2,3}/` 禁；`item.status` 合法；必须含 `createWorkitemsRuntime/registerProbe/createAgentRunHandler/workitems.api.*/store.claimThread/ProgressCards`。
  - **worktype 纯度**（noop-type.test.ts:83-87）：worktype index.ts 禁 `node:fs`/`node:child_process`/`AgentPool`/`Runner`/`async `/`await `。
  - **effect handler 隔离**（noop-handler.test.ts:103）：禁 `AgentPool|Runner|spawn|execFile|child_process`。
  - **wait 续期**（wait-api.test.ts:154-155）：禁直接 `updateWait(...deadlineAt)`，走 `renewWaitDeadline`。
- **本次使用场景（硬边界）**：requirement 所有业务逻辑（phase 状态机、WorkItem/Assignment 类型自由用）放 `src/worktypes/requirement/`（worktypes 层不查禁词，但禁 async/fs/进程）。kernel 侧（feishu 卡片回调、index 接线）只搬运不解释，判定下沉 `isTerminalStatus`/`anchorAction` 纯函数。
- ⚠️ **knowledge 层前置改动**：`layerFor` 无 `knowledge/` 分支 → `src/knowledge/` 会判 kernel → 触发禁词检测。若 knowledge 代码含业务词（大概率），**必须先在 `architecture.ts:109-114` 加 `knowledge/` 分支**（R17 前置）。

---

## 漂移与修正记录（5 处，实质全部成立）

| 总纲断言 | 实际 | 影响 |
|---|---|---|
| checkpoints 注释 reducer.ts:368 "M1 checkpoint planned" | 实为 "M1 checkpoint/artifact events are planned"，语境是 switch exhaustive default | 方向一致，引文以实际为准 |
| wakePending"批量带入自上次 run 全部事件" | 当前仅布尔标志，唤醒只跑一次 default run；批量带事件尚是设计目标（有 lastRunEffectSeqBefore/eventsSince 查询砖） | R02 要新建组批逻辑，非"已实现" |
| 心跳改造 b794939 在 effects/watchdog | 实在 agents/runner + run-handler:138（onActivity）；watchdog 仍墙钟阈值，只是 beat 喂入语义变 | watchdog 不为 requirement 改，但 worker 须挂 onActivity |
| composeProbePrompt 在 run-handler:84 | :84 是 runAgent 声明；composeProbePrompt 调用 :98、定义 :193 | "照 :84 模式"指 runAgent 整套，非 prompt 拼接行 |
| 桥四层 fallback 在 index.ts:392-425 | 实在 :679-711（392-425 现是 runDiagMcp） | 逻辑未变、仅位置漂移 |
| pool"忙时无排队可超 cap" | 已过时：WI-C 引入 Semaphore，有 FIFO 排队、不超 cap | R07 Owner 预留槽改的是 Semaphore 优先级，非"加排队" |

> 注：最后一条不在原 41 断言内，是 agents-kernel 考古补充发现，一并记录。
