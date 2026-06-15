# S5: 等待与活性监督

> Scope: 显式等待对象的按 kind 到期动作、human/agent wait 主动 resolve 入口、watchdog 活性监督（心跳 + 墙钟硬上限）、stalled 重试与升级、收尾义务的代码化校验
> AC: AC-5.1~5.13

---

## 需求（Step 1 产出）

### 概述

本组承载容器不变量「没有无人过问的等待」：任何 wait 必带到期动作，且到期必产生事件（PRD §4.4）。到期动作按 kind 内建——human 提醒 + 显式续期（M0 无飞书，提醒降级为日志 + 事件留痕，提醒卡片是 M1b）、agent 走 stalled 流程、timer 触发即 resolve。watchdog 对运行中 assignment 做活性监督：心跳静默超时与墙钟硬上限是两条独立防线，触发后按重试预算（默认 1）重启（replaces_assignment_id 链）或升级为 human wait（origin_assignment_id 溯源）。assignment 收尾时由代码校验必备 artifact（M0 以 noop 的 report 文件承载）。human/agent wait 另提供主动 resolve 编程入口（AC-5.13，Step 1.5 补）：resolve 留 operator 与 reason 痕，幂等拒绝重复 resolve；timer 不开放（其 resolve 即触发）。M0 心跳源由 noop 模拟运行提供（真 runner 流式心跳多路复用推迟 M1b+）。本组不定义表结构（G1）、事件进入 reducer 的机制（G3，仅表述「产生事件回流」）与效果执行机制（G4）；语义监督（「跑偏」）归工作类型验收点，不在本组（PRD §12 监督归属）。

### AC 列表

### AC-5.1: wait 创建必带到期动作（防 2099 反模式）

**GIVEN** 容器运行中
**WHEN** 通过容器 API 创建 wait
**THEN** 仅当 kind ∈ {human, agent, timer} 且 deadline_at 为有效时间戳时创建成功；到期动作由 kind 内建绑定，API 不提供任何「禁用/跳过到期动作」的选项；非法 kind 或缺 deadline_at 的创建被拒绝且不落库（§3.3：不变量是「必带到期动作」，日期只是触发器，2099 式远期日期到期时同样触发动作并留痕）

### AC-5.2: 到期必产生事件，resolve 后免疫

**GIVEN** 一个未 resolve 的 wait 已到达 deadline_at
**WHEN** watchdog 执行到期检查（测试以注入时钟推进）
**THEN** 必产生与 kind 对应的事件回流，不存在静默过期路径；已 resolve（resolved_at 非空）的 wait 到期不触发任何动作或事件

### AC-5.3: human wait 到期 → 提醒降级为日志 + 事件（M0）

**GIVEN** kind=human 的 open wait 到期
**WHEN** watchdog 触发到期动作
**THEN** 输出提醒日志并产生提醒事件回流留痕；不调用任何飞书能力；同一到期对同一 wait 仅提醒一次（§4.4「置顶一次」语义），后续检查周期不重复提醒

### AC-5.4: human wait 显式续期留痕

**GIVEN** 一个 kind=human 的未 resolve wait（已到期或未到期）
**WHEN** 通过容器 API 显式续期并给出新 deadline_at
**THEN** renewed_count 加 1，产生续期事件回流留痕，新 deadline 下到期监督重新生效（可再次提醒）；除续期 API 外不存在修改 deadline_at 的入口——续期是有记录的决定，不是默默延长

### AC-5.5: agent wait 到期 → stalled 流程

**GIVEN** kind=agent 的 open wait 到期，其等待的 assignment 尚未终态
**WHEN** watchdog 触发到期动作
**THEN** 产生 assignment_stalled 事件回流，进入与心跳超时一致的重试/升级路径（AC-5.9 / AC-5.10）

### AC-5.6: timer wait 到期 → 触发即 resolve

**GIVEN** kind=timer 的 open wait 到期
**WHEN** watchdog 触发到期动作
**THEN** 该 wait 被标记 resolved（resolved_at 置值）并产生触发事件回流——触发就是它存在的目的

### AC-5.7: assignment 派发必带监督参数

**GIVEN** 派发（创建）assignment
**WHEN** 创建参数缺少 deadline_at 或 wallclock_cap_sec，或二者取值非正
**THEN** 创建被拒绝并报错、不落库；两者齐备时创建成功并随 assignment 持久化

### AC-5.8: 心跳静默超时 → assignment_stalled

**GIVEN** 一个 running assignment，心跳由 M0 noop 模拟运行提供
**WHEN** 心跳静默时长超过阈值（测试以注入时钟压缩）
**THEN** 产生 assignment_stalled 事件回流，payload 含 assignment id 与停滞原因

### AC-5.9: 预算内重启 — replaces 链

**GIVEN** assignment_stalled 且该 assignment 重试预算（默认 1 次）未耗尽
**WHEN** 容器处理 stalled
**THEN** 旧 assignment 进入终态并保留记录（assignment 树 append-only，不复活旧节点，§6.2）；声明派发一个新 assignment（派发的执行机制属 G4），其 replaces_assignment_id 指向旧 assignment，重试消耗沿链可查

### AC-5.10: 预算耗尽 → 升级 human wait（可溯源）

**GIVEN** assignment_stalled 且重试预算已耗尽
**WHEN** 容器处理 stalled
**THEN** 该 assignment 标记失败；创建 kind=human 的 wait，其 origin_assignment_id 指向该失败 assignment；产生升级事件回流；M0 通知降级为日志 + 事件留痕（无飞书）

### AC-5.11: 墙钟硬上限 — 活着也会被掐

**GIVEN** 一个 running assignment 持续产生正常心跳（活着但空转）
**WHEN** 运行墙钟时长超过 wallclock_cap_sec
**THEN** 该 assignment 的运行被触发中止（中止的执行机制属 G4）并产生标明墙钟超限的事件回流；随后进入与 stalled 相同的重试/升级路径（AC-5.9 / AC-5.10）

### AC-5.12: 义务代码化 — 收尾 artifact 校验

**GIVEN** 一个 assignment 进入收尾（M0 由 noop 完成模拟运行）
**WHEN** 容器执行收尾校验
**THEN** 必备 artifact 文件（M0 为该 assignment 的 report 文件）存在且非空 → 正常完成；文件缺失或为空 → 该 assignment 判失败并产生失败事件回流——义务由代码 enforce，不靠 prompt 自觉（§4.4）

### AC-5.13: human/agent wait 主动 resolve 入口

**GIVEN** 一个未 resolve 的 kind=human 或 kind=agent 的 wait
**WHEN** 调用容器 resolve API（携带 operator 与 reason）
**THEN** 该 wait 标记 resolved（resolved_at 置值）并产生 wait_resolved 事件回流；resolve 后该 wait 不再参与 rollup 投影（G2）与到期扫描；对已 resolve 的 wait 重复调用 resolve 被幂等拒绝——返回其已 resolve 状态、不产生新事件。kind=timer 的 wait 不开放主动 resolve——其 resolve 即到期触发（AC-5.6 已锁定）

### Flow AC

### FLOW-5.1: 卡死升级全链路（心跳 → 重试 → 升级 → 续期）

- **路径**: noop 心跳静默 → stalled 事件 → 预算内重启（新 assignment）→ 再次静默 → 预算耗尽 → human wait（溯源）→ wait 到期日志+事件 → 显式续期
- **涉及 AC**: AC-5.8 -> AC-5.9 -> AC-5.8 -> AC-5.10 -> AC-5.3 -> AC-5.4
- **验证点**: replaces_assignment_id 链可从新节点导航回原节点；human wait 的 origin_assignment_id 指向最终失败节点；续期后 renewed_count=1；事件序列完整记录全过程
- **跨组**: Group 3（事件回流 reducer）、Group 4（重启派发为效果）、Group 6（noop 驱动）

### FLOW-5.2: 空转防线（墙钟独立于心跳）

- **路径**: noop 持续心跳但不完成 → 墙钟超限被掐 → 事件回流 → 重试/升级路径
- **涉及 AC**: AC-5.11 -> AC-5.9 / AC-5.10
- **验证点**: 全程心跳正常、AC-5.8 不触发——证明墙钟是独立于心跳的第二道防线
- **跨组**: Group 4（中止运行为效果）、Group 6（noop 空转模式）

### FLOW-5.3: timer 等待生命周期

- **路径**: 创建 timer wait（必带到期动作）→ 时钟推进至到期 → resolve + 事件回流
- **涉及 AC**: AC-5.1 -> AC-5.2 -> AC-5.6
- **验证点**: resolved_at 置值后 watchdog 不再触碰该 wait
- **跨组**: Group 3（事件回流）

### Gaps

- [YELLOW] G-5.1: stalled 重启时旧 assignment 的终态取值未明示（failed 还是 superseded？§6.2 只说「旧节点保留终态」，superseded 出现在 §6.4 契约变更语境）— 影响 rollup 投影输入与 replaces 链查询语义，Step 2 设计时定
- [YELLOW] G-5.2: assignment 的 deadline_at 自身的到期动作 PRD 未单列（§4.4 对心跳与墙钟有明确动作，对 assignment deadline 没有）；deadline_at / 心跳静默阈值 / wallclock_cap_sec 三者分工需 Step 2 澄清，避免三套超时混淆
- [YELLOW] G-5.3: agent wait 与目标 assignment 的关联方式未明确（schema 仅有溯源用 origin_assignment_id，无目标字段）；且同一 assignment 的多个超时源（心跳静默 / 墙钟超限 / agent wait 到期）并发触发时的去重语义未定义——可能重复 stalled 事件与双重重启
- [YELLOW] G-5.4: 重试耗尽时容器自动创建的 human wait 的 deadline_at 取值无依据（人不在环内无法即时给值）— 建议 Step 2 以可配置默认时长解决
- [WHITE] G-5.5: watchdog 实现形态待选型：单一周期轮询扫描 waits/assignments（候选，便于注入时钟测试）vs 每对象独立定时器
- [WHITE] G-5.6: 心跳上报接口形态待定：noop（及未来 runner）如何向容器上报活性——候选：容器侧记录 assignment 级最近心跳时间，由运行通道更新（接口需与 G4 协调）

### PRD 校验

> 正式一致性校验在 Step 1.5 由独立校验 Agent 执行；下表为编写时的覆盖自查。

| PRD 锚点 | 要点 | 覆盖 |
|---|---|---|
| §4.4 不变量 | wait 必带到期动作且到期必产生事件 | AC-5.1, AC-5.2 |
| §4.4 按 kind 动作 | human 提醒+显式续期 / agent stalled / timer resolve | AC-5.3~5.6 |
| §4.4 监督参数 | assignment 必带 deadline_at 与 wallclock_cap_sec；墙钟兜底空转 | AC-5.7, AC-5.11 |
| §4.4/§6.2 stalled 路径 | 心跳超时 → stalled → 预算重启（replaces 链）→ 耗尽升级 human wait | AC-5.8~5.10, FLOW-5.1 |
| §4.4 义务代码化 | 收尾校验必备 artifact 存在且非空 | AC-5.12 |
| §3.3 反模式 | 约束是「必带到期动作」而非「必带日期」 | AC-5.1, AC-5.4 |
| §12 等待到期/监督归属 | 续期有记录；容器管活性、类型管语义（本组只做活性） | AC-5.4, 概述边界声明 |
| 跨组检查②（Step 1.5 补） | human/agent wait 主动 resolve 编程入口——消解 S2 AC-2.7/2.8、S3 AC-3.10 的悬空引用 | AC-5.13 |

---

## 设计（Step 2 追加）

### 对外接口

```ts
// src/workitems/watchdog.ts
export class Watchdog {
  constructor(deps: {
    store: WorkitemsStore; reducer: ReducerRuntime; effects: EffectRuntime;
    clock: Clock; logger: Logger; cfg: WorkitemsConfig;
  });
  tick(): void;                       // 公开：测试以 FakeClock.advance + 手动 tick 驱动（→ G-5.5）
  start(): void; stop(): void;        // setInterval(cfg.watchdogIntervalMs, unref)
}
// src/workitems/api.ts（wait 操作面）
resolveWait(waitId: string, p: { operator: string; reason: string }):
  { resolved: true } | { resolved: false; alreadyResolvedAt: number }    // (→ AC-5.13)
renewWait(waitId: string, p: { operator: string; deadlineTtlSec: number }): void   // 仅 kind=human (→ AC-5.4)
// wait/assignment 创建无独立 API——一律经 Transition.waits / Transition.dispatch 声明（S2 契约）
```

容器配置（src/workitems/config.ts，环境变量 WORKITEMS_*）：`watchdogIntervalMs`（默认 1000）、`heartbeatTimeoutSec`（默认 60）、`humanWaitTtlSec`（默认 86400，→ G-5.4）、`retryBudget`（默认 1）、`maxOpen`（默认 3）、`defaultDeadlineTtlSec`（默认 3600）、`defaultWallclockCapSec`（默认 1800）——后两项是容器自发派发（S3 defaultDispatch 唤醒/重唤醒）的监督参数默认值，WorkType 经 Transition.dispatch 显式声明即覆盖（→ S3 ADR-10，满足 AC-5.7 必填正数）。

### 内部结构

#### 1. wait 创建校验（→ AC-5.1；运行时在转移事务内执行 WaitSpec）

```
applyWaitSpec(w, seq):   // S3 applyTransitionWrites 内
  assert w.kind ∈ {human, agent, timer}            // 非法 kind 拒绝（事务回滚，不落库）
  assert w.deadlineTtlSec > 0 有限数                 // 缺/非法 deadline 拒绝
  if (w.kind == 'agent') assert w.originAssignmentId 存在且行存在   // (→ G-5.3 必填)
  insertWait({ deadline_at: clock.now() + ttl*1000, ... })
```

到期动作由 kind 内建于 watchdog（下节），WaitSpec 无任何禁用开关——「必带到期动作」是结构事实而非参数（→ AC-5.1）。2099 式远期 ttl 合法：到期同样触发动作留痕。assignment 创建校验同理：deadlineTtlSec/wallclockCapSec 缺失或非正 → 事务回滚（→ AC-5.7）。

#### 2. watchdog tick（→ AC-5.2, 5.3, 5.5, 5.6, 5.8, 5.11；G-5.2/5.3/5.5）

```
tick():
  now = clock.now()
  // —— waits：仅扫 resolved_at IS NULL（resolve 后免疫 → AC-5.2）——
  for w of store.listOpenWaits() where w.deadline_at <= now:
    switch w.kind:
      human: if (w.reminded_at == null)            // 同到期仅一次 (→ AC-5.3)
               logger.warn(...); enqueue('wait_reminder', {waitId})
             // apply: 置 reminded_at=now（事件留痕 + 不调飞书）
      agent: stalledCandidates.add(w.origin_assignment_id, reason='agent_wait_expired', waitId)  // (→ AC-5.5)
      timer: enqueue('timer_fired', {waitId})      // apply: resolved_at=now + 投影重算 (→ AC-5.6)
  // —— assignments：三道防线收敛 stalled 管道（ADR-5 → G-5.2）——
  for a of store.listRunningAssignments():
    beat = effects.lastBeat(a.id) ?? a.started_at ?? a.created_at
    if (now - a.started_at >= a.wallclock_cap_sec*1000): cand(a, 'wallclock_exceeded')   // (→ AC-5.11)
    else if (now - beat >= cfg.heartbeatTimeoutSec*1000): cand(a, 'heartbeat_silent')    // (→ AC-5.8)
    else if (now >= a.deadline_at): cand(a, 'deadline_exceeded')
  for (a, reason) of stalledCandidates:            // 同 tick 同 assignment 仅一条（优先级即上序 → G-5.3）
    enqueue(a.workitem_id, 'assignment_stalled', {assignmentId: a.id, reason, waitId?})
```

enqueue 即同步 drain（S3）：本 tick 产生的事件在 tick 返回前已 apply ⇒ 下一 tick 看到的是已处置状态，无跨 tick 重复触发。agent wait 到期而 origin assignment 已非 running（先正常完结/已被重派）的路径同样闭合：stalled 处置（下节）在早退分支即把该 wait 直接 resolve（resolve_reason='origin_terminal'）⇒ 该 wait 退出到期扫描，绝不每 tick 重复 stalled、不留悬空 wait（→ ADR-8）。

#### 3. stalled 处置（容器机制层，apply 事务内 → AC-5.9, 5.10；G-5.1）

```
containerMechanics(ev = assignment_stalled):
  a = getAssignment(ev.assignmentId)               // S1 单行读取接口
  if (a.status != 'running'):                      // 幂等去重：迟到/重复 stalled 无害 (→ G-5.3)
    if (ev.reason == 'agent_wait_expired'):        // 不留悬空 wait——早退路径也必须消解来源 (→ ADR-8)
      updateWait(ev.waitId, resolved_at=now, resolved_by='container', resolve_reason='origin_terminal')
      追加事件 'wait_resolved' {waitId, operator:'container', reason:'origin_terminal'}
    return {}
  postCommit: effects.abort(runEffectOf(a), ev.reason)        // 中止执行通道（机制归 S4 AC-4.12）
  if (a.retries < cfg.retryBudget):                // 预算内 (→ AC-5.9)
    update(a, status='superseded', ended_at=now)   // 旧节点终态保留，append-only (→ G-5.1)
    return { dispatch: [{...原参数, replacesAssignmentId: a.id, retries: a.retries+1,
                          brief: 原brief + 失败摘要}] }        // 新 assignment 经转移事务建行
    // 〔已修正 · v3 评审〕「原参数」中 deadline 的语义核定为：原 TTL（deadline_at - created_at）
    // 自 now 重新计满，而非继承剩余时间——否则 deadline_exceeded 的重派只剩 ~1s 必死，
    // 重试预算形同虚设（v3-code-review P1-2）
  else:                                            // 预算耗尽 (→ AC-5.10)
    update(a, status='failed', ended_at=now)
    追加事件 'assignment_retry_exhausted' {assignmentId}
    return { waits: [{kind:'human', reason:'retry_exhausted', deadlineTtlSec: cfg.humanWaitTtlSec,
                       originAssignmentId: a.id}] }            // origin 溯源；M0 通知=日志+事件
  // agent_wait_expired 来源时：附带 resolve 该 agent wait（其使命已尽）
```

effect_aborted 事件随后到达时 assignment 已非 running → 容器机制层忽略（不二次重派）。墙钟路径全程心跳正常也会被掐——第一防线（heartbeat）不触发即证独立性（→ AC-5.11，FLOW-5.2）。

#### 4. resolve / renew 入口（→ AC-5.4, 5.13）

```
resolveWait(id, {operator, reason}):
  w = getWait(id)
  if (w.kind == 'timer') throw TimerNotResolvableError        // AC-5.6 已锁
  if (w.resolved_at != null) return {resolved:false, alreadyResolvedAt}   // 幂等拒绝，无新事件
  enqueue(w.workitem_id, 'wait_resolved', {waitId, operator, reason})     // 同步 drain
  // apply: resolved_at/resolved_by/resolve_reason 置值 + 投影重算 → 退出 rollup 与到期扫描
renewWait(id, {operator, deadlineTtlSec}):
  assert kind == 'human' && resolved_at == null
  enqueue('wait_renewed', {waitId, operator, newDeadlineAt: now+ttl})
  // apply: deadline_at 更新 + renewed_count+1 + reminded_at=NULL（监督重新生效，可再提醒 → AC-5.4）
  // 除此入口外无任何 deadline_at 写路径（S1 updateWait patch 已收窄为 wait 生命周期字段、
  // deadlineAt 注明仅本路径可写——接口形状与「续期是唯一改期入口」承诺对齐，→ I-018）
```

#### 5. 收尾 artifact 校验（→ AC-5.12；执行点在 S4 run handler 收尾钩子）

run handler 成功返回前，EffectRuntime 校验 `assignments/<id>/report.md` 存在且非空（ArtifactStore.readFile）：通过 → emit run_completed（apply: assignment done + report_path 落库）；缺失/空 → emit run_failed {error:'artifact_missing'}（apply: assignment failed + 失败事件留痕）。义务由容器代码 enforce，handler 无法绕过（校验在 emit 之间，不在 handler 自觉）。

### 依赖关系

依赖：S1 store、S3 reducer（事件回流唯一通道——watchdog 自身零 DB 写）、S4 effects（abort/lastBeat）、Clock/config。被依赖：S6 noop 经心跳/失败注入驱动本组全部路径。

### 数据契约

事件 payload：`wait_reminder {waitId}`、`timer_fired {waitId}`、`wait_renewed {waitId, operator, newDeadlineAt}`、`wait_resolved {waitId, operator, reason}`（容器自动 resolve 时 operator='container'，如 origin_terminal / agent wait 使命已尽路径，→ ADR-8）、`assignment_stalled {assignmentId, reason: 'heartbeat_silent'|'wallclock_exceeded'|'deadline_exceeded'|'agent_wait_expired', waitId?}`、`assignment_retry_exhausted {assignmentId}`。心跳接口 = EffectContext.heartbeat()（内存 Map，→ G-5.6）。

### 测试策略

- 全部以 FakeClock + 手动 tick 驱动（零真实定时器）；noop 参数注入心跳模式（normal/silent/beat-no-finish）。
- 集成：非法 kind/缺 deadline 创建拒绝且零落库（→ AC-5.1）；到期必有事件、resolve 后推进时钟再 tick 零动作（→ AC-5.2）；human 到期单次提醒（连续 3 tick 仅 1 条 wait_reminder）+ 续期后可再提醒（→ AC-5.3/5.4）；timer 到期 resolve（FLOW-5.3，→ AC-5.6）；心跳静默 → stalled payload 含 id 与原因（→ AC-5.8）；agent wait 到期入口——FakeClock 推进至 deadline + tick → assignment_stalled(reason='agent_wait_expired') → 预算内 replaces 重派，且该 agent wait 已 resolve（→ AC-5.5）；agent wait 到期但 origin 已非 running → 该 wait 直接 resolved(resolve_reason='origin_terminal') + wait_resolved 事件，连续多次 tick 不再产生任何 stalled/事件（→ ADR-8）；dispatch 缺 deadlineTtlSec/wallclockCapSec 或取值 0/负 → 整事务回滚，assignment 行与 run 效果行均不存在（→ AC-5.7）；FLOW-5.1 全链路（stalled→superseded+replaces→再 stalled→failed+human wait（origin 溯源）→到期提醒→续期 renewed_count=1）；FLOW-5.2 心跳正常仅墙钟触发（断言无 heartbeat_silent 事件）；同 tick 三超时源并发仅一条 stalled（→ G-5.3）；resolveWait 幂等拒绝 + timer 不开放（→ AC-5.13）；report 缺失/空 → assignment failed（→ AC-5.12）。

| 场景 | 类型 | 输入 | 期望 |
|---|---|---|---|
| stalled 事件重复 apply | Edge | 手工 enqueue 两次 | 第二次零动作（assignment 已 superseded） |
| agent wait 缺 origin | Error | WaitSpec 无 originAssignmentId | 事务回滚拒绝 (→ G-5.3) |
| 预算耗尽链 | Happy | retryBudget=1 连续两次 stalled | 链：A superseded→B failed→human wait.origin=B |
| agent wait 到期但 origin 已终态 | Edge | origin done 后推进时钟 + 连续 tick | 该 wait resolved(origin_terminal) + 一条 wait_resolved，无重复 stalled 刷屏 (→ ADR-8) |
| dispatch 监督参数非正 | Error | wallclockCapSec=0 | 事务回滚，assignment 与效果行均不存在 (→ AC-5.7) |
| 远期 deadline | Edge | ttl=10 年 + 时钟推进 | 到期照样提醒留痕（2099 不豁免 → AC-5.1） |
