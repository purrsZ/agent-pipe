# /req 全面改造方案：消息必达 · 活性自证 · 复杂度自适应

> 日期：2026-07-02 ｜ 状态：**已实施（2026-07-03，WS-0~WS-10 全绿，738 测试）** ｜ 读者：**执行本方案的 AI（claude-opus-4-8）**
> 本文档自包含：所有背景、证据（file:line）、设计决策、改动清单、测试要求都在文内。
> 执行时**不要重开已拍板的决策**（§2 决策台账），不确定处按台账倾向办；只有当代码现状与本文引用的
> file:line 明显对不上（说明中间有人改过代码）时，才停下来在报告里说明差异后按本文意图适配。

---

## 0. 执行须知（必读）

### 0.1 项目与构建

- 仓库：`/Users/zwh/agent-pipe`，TypeScript + Node（ESM，`.js` 后缀 import），SQLite（better-sqlite3），测试 vitest。
- 验证命令：`npm run check`（= typecheck + biome lint + vitest 全量）。**每个工作流（WS）完成后必须全绿再进下一个。**
- 现有测试约 593 个，分布在 `tests/`。新增功能一律带测试，风格对齐同目录既有测试（沙箱容器 + 手造事件 + 合成报告）。

### 0.2 架构分层红线（违反会被 lint/测试逮住，也绝不允许绕过）

1. **容器层（`src/workitems/`）零业务语义**：reducer/effects/watchdog/store 不 import worktypes、不解释 phase 字符串、不出现「需求/立项/对账/监工」等业务词。容器只做中性搬运（如 `enrichEventForType` 注入 `openWaitReasons`、`runningWorkers`），先例见 `src/workitems/reducer.ts:723-761`。
2. **worktype 纯核心（`src/worktypes/requirement/*.ts` 中非 handler 文件）纯同步**：无 async/await/fs/child_process。IO 放 effect handler（`reconcile.ts`/`gatekeeper.ts`/`integration.ts` 的 `create*Handler` 是先例）。
3. **feishu 层（`src/feishu/`）不 import worktypes**：卡片构建器只收渲染好的字符串。`src/index.ts` 是 kernel-exempt 桥层，可以 import worktype 纯核心（先例：`isIntakePhase`、`checkpointBoundaryOf`）。
4. **run 结论（run_completed/run_failed）只能由 `EffectRuntime.emitRunConclusion` 产生**（`src/workitems/effects.ts:318-325` 明确封死 ctx.emit 伪造），任何新逻辑不得绕过。
5. 新增 requirement 事件 kind 必须登记进 `src/worktypes/requirement/phases.ts` 的 `REQUIREMENT_EVENT_KINDS`，并同步更新 `tests/feishu/anchor-drift.test.ts` 的漂移断言。

### 0.3 执行顺序（依赖图）

```
WS-0 内核地基（stage 透传 + 新 enrich 字段）        ←— 一切的前置
 ├─ WS-1 活性不变式 + 补派 + wait resolve 加固
 ├─ WS-2 消息必达：owner steer 通道（本方案核心）
 │    ├─ WS-5 打回带意见 + 监工判大返工通道（依赖 WS-2 的 steer 与 WS-0 的 stage 路由）
 │    └─ WS-9 AskUserQuestion 接入 workitem run（答案经 WS-2 通道回灌）
 ├─ WS-6 复杂度自适应 lite 主线
 └─ WS-8 run_failed 先自动重试一次
WS-3 等待提醒外发 + 卡片持久化      （独立，可并行）
WS-4 入站持久 inbox + 断线补拉      （独立，可并行）
WS-7 交付清单 + 灯③ 证据厚化 + worktree GC（弱依赖 WS-0）
WS-10 杂项修缮                      （最后收尾）
```

建议按 WS-0 → WS-1 → WS-2 → WS-3 → WS-4 → WS-5 → WS-6 → WS-7 → WS-8 → WS-9 → WS-10 顺序串行执行，
每个 WS 一次独立提交（commit message 中文，格式对齐 git log 既有风格，如
`feat(requirement): 消息必达——owner steer 通道 (OVERHAUL WS-2)`）。

### 0.4 完成定义

- 全部 WS 落地，`npm run check` 全绿；
- `REQUIREMENT_EVENT_KINDS`、board 投影（`src/worktypes/requirement/board.ts`）、`web/src`（若字段形状变化）同步更新；
- 在本文档末尾追加「✅ 落地记要」小节（对齐 `PIVOT-设计外置-实现聚焦.md` 的记要格式），如实记录：实现了什么、
  哪些点与本文有出入及原因、留了什么 live 半（诚实标注，不美化）；
- 附录 B 的手验 runbook 更新为可直接照做的版本。

---

## 1. 诊断总表（为什么改：问题 → 代码根源 → 对应 WS）

| # | 问题（用户可感知） | 代码根源（证据） | WS |
|---|---|---|---|
| 1 | 多数相位下群消息是死信/延迟信，但系统统一回「已转交，稍候进展会更新」 | worker prompt 不接收 followups（`src/worktypes/requirement/worker.ts:20` 签名无此参数）；集成/交付相位无任何后续 run 消费 batch（`src/worktypes/requirement/index.ts:340-351` 除 /cancel 外只记录）；回执文案写死（`src/index.ts:1353`） | **WS-2** |
| 2 | 「事件×相位」漏一个分支就静默卡死，每个都要真机暴露一次（run_failed 卡死、declined 死状态、wait_resolved 误路由都是同类） | `requirementTransition` 手写 switch 返回 `{}` 即停摆，无容器级兜底；watchdog 只扫 wait 超时和 assignment 停滞（`src/workitems/watchdog.ts:52-132`），不检查「非终态却无路可走」 | **WS-1** |
| 3 | 超过 worker 并发上限的仓被静默丢弃（补派未实现） | `src/workitems/reducer.ts:624-637` 只打 warn；`releaseWakePending` 对 owner-workers 直接 return 不补派（`reducer.ts:763-774`） | **WS-1** |
| 4 | 系统在等人，但永远不催：病历/灯卡发出后没看到（或那次 API 恰好失败）就永远安静挂着 | `wait_reminder` 只翻 DB 字段 `remindedAt`（`reducer.ts:406-413`），无飞书出口；且只提醒一次、要等 24h TTL 到期；灯卡/病历卡 dedup 是内存 Set（`src/index.ts:1554`），卡片发送失败只有下一次事件才重试 | **WS-3** |
| 5 | 入站消息不持久：WS 断线/进程崩溃窗口内的消息永久丢失；去重和 botStartTime 过滤都是内存态 | dedup Set + `createTime < botStartTime` 过滤（`src/feishu/event-router.ts:88,117-123`）；全仓无离线补拉机制；`ReducerRuntime.queues` 内存队列（`reducer.ts:60`） | **WS-4** |
| 6 | 打回没有意见通道：人的判断内容一个字节都进不了下一轮工作；灯③打回=原样空转重跑 | 打回 reason 固定文案（`src/index.ts:1254`）；`redoPhase(integrate)` 只重跑静态 `integration_check`（`requirement/index.ts:336`）；灯卡文案却承诺「直接在群里回复要改什么，我据此重做」（`src/feishu/card.ts:578`）——空头支票 | **WS-5** |
| 7 | 监工判大后只有「放行」一个前进方向，红线出口漏气 | `onWaitResolved` 的 GATEKEEPER_BIG 分支只有 approved→assess（`requirement/index.ts:269-273`），无返工通道 | **WS-5** |
| 8 | 单仓小需求也要走满配流程（5 硬必填 + 对账 run + assess run + 2 次人工拍板），约束感的直接来源 | 必填清单不看仓数（`src/worktypes/requirement/intake.ts:39-91`）；`onReposSet` 一律派 owner 对账（`requirement/index.ts:211-214`） | **WS-6** |
| 9 | 灯③ 是纸门：no_contract/no_claims 优雅放行但卡上不说，人拍板没证据 | `src/worktypes/requirement/integration.ts:33-46`；灯③卡不带任何各仓改动证据 | **WS-7** |
| 10 | 交付断头：产物躺在 worktree 分支里，飞书里看不到分支名/diff/接手命令；worktree 永不清理 | `enterPhase(deliver)` 无任何动作（`requirement/index.ts:322-324`）；全仓无 worktree GC | **WS-7** |
| 11 | 任何 run 报错立刻惊动人（瞬时 API 错误也弹病历），加重「怕阻塞」体感 | `onRunFailed` 无差别 raise 病历（`requirement/index.ts:241-246`）；容器 retryBudget 只覆盖 stall/abort 路径 | **WS-8** |
| 12 | run 内 agent 不能问人（AskUserQuestion 在 workitem run 上未接线） | `src/worktypes/agent-run/run-handler.ts:208-222` callbacks 无 onAskUser；bridge task 路径已有完整实现可复用（`src/index.ts:481-489,1140-1214`） | **WS-9** |
| 13 | 解析 resolve 未知 reason 的 wait 会被误判成 checkpoint 拍板（如 integrate 相位 resolve 一条 retry_exhausted 病历 → 直接推进到交付） | `onWaitResolved` 默认分支按 `nextPhase+crossesCheckpoint` 推进（`requirement/index.ts:283-289`），而 `retry_exhausted`/`thrash` 是容器 raise 的 reason、无显式分支，且 `caseFileLabel` 不认识它们（无卡可见，只能从管控台 resolve——恰恰是误触路径） | **WS-1** |
| 14 | 立项 AI 抽取挂起时用户只看到「🤔 正在提取…」再无下文 | `aiExtractIntake` 的 `pool.send` 无超时（`src/index.ts:947-984`），该 run 不是 workitem effect、watchdog 管不到 | **WS-10** |
| 15 | 群里发 `/cancel` 永远得到「未知命令」——正常推进中想取消整单无路可走（病历卡的「取消整单」按钮只在病历恰好弹出时才存在） | 以 `/` 开头的消息先进 `commands.dispatch`（`src/index.ts:1296-1299`，早于 managed claim 路由），而 `commands.ts` 无 `/cancel` case → default「未知命令」；worktype 的 human_message `/cancel` 分支（`requirement/index.ts:341-347`）从飞书路径是**死代码** | **WS-10** |
| 16 | 即便 `/cancel` 可达，`cancel_confirm` wait 也无卡可点：surfaceCheckpoints 非 checkpoint 非病历一律跳过，注释说「cancel_confirm 走别的路径」——该路径并不存在 | `src/index.ts:1566-1569` | **WS-10** |
| 17 | 交付相位永远安静：没有灯④关单卡、没有催办，关单全靠人记得 `/done`；忘了就永久挂着（may-rest 豁免了活性看门，交付相位又无任何 open wait 可催） | `enterPhase(deliver)` 仅 rest（`requirement/index.ts:322-324`）+ D-D 将 deliver 声明 may-rest | **WS-7** |

---

## 2. 全局设计决策台账（已拍板，执行时不要重开）

### 已定决策

- **D-A「对话感」走 steer run，不走常驻会话**。曾考虑「每需求一个常驻可对话 owner 会话，群消息全部直通、状态机降级为护栏」——**否决**。理由：常驻会话状态不可恢复（崩溃即失忆），与事件溯源/幂等恢复的整个底座冲突；而「每条消息保证有一个消费它的 owner run」在批处理语义下能拿到 90% 的对话感，且完全落在现有 run/effect/事件模型内。**消息必达的定义：非终态需求单里的每条群消息，都必然被某个后续 run 的 followups 消费（intake 相位被收料消费）。**
- **D-B 消费窗口语义不改，改「保证有下一个 run」**。现有 batch 窗口（`effects.ts:289` 的 `lastRunEffectSeqBefore` → 本 effect seq）语义正确；死信的根源是「消息之后再无 run」。因此不引入「已消费水位」等新持久状态，而是：消息到达且 owner 空闲 → 立刻派 steer run；owner 忙 → 由容器注入的 `unconsumedHumanMessages` 计数在 owner run 收尾时补派 steer。窗口天然覆盖。
- **D-C run 结论携带 stage**。现状按「phase 猜 owner run 是什么」（implement 相位任何 owner run_completed 都推进到 integrate，`requirement/index.ts:124`）是隐患；改为 dispatch payload 的 `stage` 随 run 结论中性透传，worktype 按 `(role, stage)` 精确路由。stage 缺失时回落旧 phase 路由（兼容旧事件流与既有测试）。
- **D-D 活性不变式由 worktype 声明豁免，容器执行检查**。不变式：非终态 workitem 必须「有 running assignment ∨ 有 pending/running effect ∨ 有 open wait」。probe 全程休息、requirement 的立项/交付相位合法休息 → WorkType 新增 `liveness(item)` 声明 `'must-progress' | 'may-rest'`（容器调用 worktype 方法不算解释业务语义，先例 `topology()`）。违反不变式 → 容器发 `liveness_stalled` 事件，**由 worktype 决定怎么处理**（requirement：raise `stalled_no_path` 病历）；声明 must-progress 的 worktype 必须处理该事件。
- **D-E 打回意见 = 卡片 input + 注入 human_message**。飞书卡片支持 form/input（先例 `buildQuestionFormCard`，`card.ts:502-506`）。打回意见先 `injectHumanMessage` 再 resolve wait（保证 seq 在后续 run 的 batch 窗口内），由 steer/重跑 run 消费。**不**发明新的「意见」事件类型。
- **D-F 灯③打回 → 派 steer**，不再空转重跑 integration_check。steer 读打回意见决定返工哪些仓；无意见且无可行动方向 → steer 上报病历要求人补充（诚实，不假装重做）。
- **D-G 监工判大的返工链 = 重对账 → 差异定位 → 定向返工**。人点「已改图纸·返工」→ 派 owner reconcile（implement 相位内允许，靠 stage 路由）→ reconcile_passed(implement) → `gatekeeper_rework` effect 从最近一次 gatekeeper_big 的 raises 提取受影响仓 → emit `rework_requested` → 定向重派这些仓的 worker（带 rework note）。**设计（图纸）仍然只有人能改**——agent 只是重新对账人改过的图纸，红线不放松。
- **D-H lite 主线按「repos 数量」一刀切**：repos ≤ 1 → lite（必填收缩为 name/summary/repos；跳过 owner 对账与 assess；监工 gate 保留——它是确定性 effect，零成本）。≥ 2 仓 → 满配。不做更细的 AI 复杂度评估（不可测、易漂）。
- **D-I 交付不自动 MR**（沿用 D-14），但必须给全「最后一公里」信息：每仓分支名、diffstat、本地接手命令、push 命令。以 `deliver_manifest` effect 产物 + 群内卡片交付。
- **D-J worktree 清理走每日 GC 任务**（终态且 7 天以上 → `worktree remove --force`，分支保留），不在 terminal transition 里做（容器在 terminal 时丢弃 effects，`reducer.ts:292-307`，且删盘不该进事件流）。
- **D-K 入站可靠性 = 持久 inbox（防进程内丢）+ 重连后主动补拉（防 WS 断线丢）**。飞书 WS 不重放断线期间的事件，所以补拉必须走 `im.v1.message.list` 主动拉。补拉范围限 managed 认领的会话（立项群 + probe 话题所在群），不碰普通 bridge 会话（避免重启后乱回放旧消息）。
- **D-L run_failed 先自动重试一次再惊动人**；但错误信息含 `write-guard fail-closed` 的直接弹病历（安全护栏失效不能靠重试糊过去）。
- **D-M 回执诚实化**：非立项相位收到消息统一回「已收到，交给包工头处理，他的回应会以卡片形式出现在本群」——这句话在 WS-2 落地后为真。终态单元的回执保持现状（已诚实）。

### 明确不做（否决项，执行时不要顺手加）

- **不做**常驻对话 owner 会话（见 D-A）。
- **不做**自动创建 MR / 自动 push（平台差异大 + 出站发布类动作需要人手；只给命令）。
- **不做**飞书群自动解散/归档 API 调用（破坏性；只做改名标记 + 终态卡，见 WS-7，且为可选低优先）。
- **不做**运行中 run 的 stdin 中途注入（headless CLI 一轮一答是硬约束；对话感靠 steer run 的批语义）。
- **不做**乐观执行 / worktree 自动回滚（沿用 PIVOT §5 的裁决）。
- **不做**「AI 判料够不够」替代硬必填（lite 已把硬校验降到 3 项；AI 判定不可测，留作未来增强）。

---

## WS-0 内核地基：stage 透传 + 新 enrich 字段

**目标**：后续所有 WS 依赖的三件中性搬运能力。全部是容器层改动，必须保持零业务语义。

### 0.1 run 结论携带 stage

- `src/workitems/effects.ts` `emitRunConclusion`（349-371 行附近）：从 `effect.payload` 读 `stage`（若为 string）并平铺进结论 payload：`...(isObject(effect.payload) && typeof effect.payload.stage === 'string' ? { stage: effect.payload.stage } : {})`。容器只搬运字符串，与既有 role/repo 平铺完全同构（365-366 行是先例）。
- worktype 侧新增读取 helper（`src/worktypes/requirement/index.ts` 底部 helpers 区）：`stageOf(payload): string | undefined`。

### 0.2 enrich 注入 `runningOwners` 与 `unconsumedHumanMessages`

改 `src/workitems/reducer.ts` `enrichEventForType`（723-761）：对 **owner-workers 的每条事件**（现在已注入 `openWaitReasons` 的同一处）追加两个中性数字：

- `runningOwners = store.countRunningByRole(item.id, 'owner')`（方法已存在，`workitems/store.ts:498`）。注意：run 结论事件上该值读于 `closeRunConclusion` 之后（apply 流程 219-222 行先关结论再 enrich），所以 owner 自己的结论看到的是「其它 owner」数——与 `runningWorkers` 语义一致，注释里写明。
- `unconsumedHumanMessages`：`kind='human_message'` 且 `seq > lastRunEffectSeq` 的事件数。实现：
  1. `workitems/store.ts` 新增 `lastRunEffectSeq(workitemId: string, runKinds: string[]): number`——`SELECT COALESCE(MAX(seq), 0) FROM workitem_effects WHERE workitem_id = ? AND kind IN (...)`（参照 `lastRunEffectSeqBefore`，store.ts:645 的写法，动态占位符）。
  2. `workitems/store.ts` 新增 `countEventsAfter(workitemId: string, kind: string, afterSeq: number): number`。
  3. `ReducerRuntimeDeps` 新增 `runKinds: () => string[]`（与 `isRunClass` 同型的注入，`reducer.ts:43`）；`EffectRuntime` 新增 `runKinds(): string[]`（recovery === 'resume-or-redispatch' 的 handler kind 列表）；`src/workitems/container.ts` 接线：`runKinds: () => effects?.runKinds() ?? ['run']`。
  4. enrich 处组合：`const unconsumed = store.countEventsAfter(item.id, 'human_message', store.lastRunEffectSeq(item.id, this.deps.runKinds()))`。

- worktype 侧读取 helpers：`runningOwnersOf(payload)`、`unconsumedHumanMessagesOf(payload)`（照抄 `runningWorkersOf` 的防御式写法，`requirement/index.ts:410-413`）。

### 0.3 RunStrategy.composePrompt 增加 `effectPayload`

- `src/worktypes/agent-run/run-handler.ts`：`RunStrategy.composePrompt` 参数对象新增可选 `effectPayload?: unknown`；`runAgent` 传 `ctx.effect.payload`。worker/steer prompt 需要从 dispatch payload 读 `stage`/`note`（WS-2/WS-5 用）。probe 默认策略忽略之，零回归。

### 0.4 worktype 内 stage 常量与路由改造

- `src/worktypes/requirement/index.ts` 新增：`const STAGE = { reconcile: 'reconcile', assess: 'assess', steer: 'steer', implement: 'implement', fix: 'fix', rework: 'rework' } as const;`
- `ownerSpec(item, stage)` 已按 stage 传 payload（`requirement/index.ts:360-368`），无需改；`onRunCompleted` 的 owner 分支改为**优先按 stage 路由**：
  - `stage === STAGE.reconcile` →（不限相位）`{ effects: [{ kind: 'reconcile_check' }] }`；
  - `stage === STAGE.assess` && phase === implement → `enterPhase(item, PHASE.integrate, 'workers_done', ev)`；
  - `stage === STAGE.steer` → `{ effects: [{ kind: 'steer_apply', payload: { reportPath: reportPathOf(ev.payload) } }] }`（WS-2 定义该 effect）；
  - `stage` 缺失 → 保持现有 phase 路由（split→reconcile_check / implement→integrate），保证旧测试与历史事件回放不变。
- `src/worktypes/requirement/worker-handler.ts` `composePrompt` 与 `afterRun` 同步改为 stage 优先：`afterRun` 中「写 contract/reconcile.json + contract.json」的条件从 `workitem.phase === PHASE.split` 改为 `stage === 'reconcile' || workitem.phase === PHASE.split`；「写 impl-claims.json」条件从 `phase === implement` 改为 `stage === 'assess' || (stage 缺失 && phase === implement)`。stage 从 `effectPayload` 读。**这一步为 WS-5 的 implement 相位内重对账铺路。**

### 0.5 测试

- `tests/workitems/`：emitRunConclusion 透传 stage（有/无 stage 两例）；enrich 注入 runningOwners/unconsumedHumanMessages（含「消息在最后一个 run effect 之前 → 计 0」「之后 → 计 N」两例）；stage 缺失时 onRunCompleted 路由与旧行为逐字节一致（跑既有 requirement-type 套件即是回归网）。

---

## WS-1 活性自证：不变式看门 + 补派 + wait resolve 加固

**目标**：把「漏分支 = 静默卡死」整类 bug 从真机暴露变成系统自曝；补上超额 worker 补派；封死「未知 reason 的 wait 被误判成 checkpoint 拍板」。

### 1.1 WorkType.liveness 声明

- `src/workitems/types.ts` `WorkType` 新增可选方法：`liveness?(item: WorkItem): 'must-progress' | 'may-rest';` 缺省 ⇒ 恒 may-rest（probe/noop 零改动零回归）。
- `src/worktypes/requirement/index.ts` 实现：`liveness: (item) => item.phase === PHASE.intake || item.phase === PHASE.deliver ? 'may-rest' : 'must-progress'`。

### 1.2 watchdog 不变式扫描

改 `src/workitems/watchdog.ts`：

- `WatchdogDeps` 增加 `registry: WorkTypeRegistry`（container.ts 接线处已有 registry 实例）。
- `runTick()` 末尾追加扫描：对 `store.listNonTerminal()`（store.ts:412）中每个 `liveness === 'must-progress'` 的 item，判定违反 = 「无 running assignment（`listAssignments` 过滤 status==='running'）∧ 无 pending/running effect（`listInflightEffects`）∧ 无 open wait（`listOpenWaits`）」。**注意 wakePending 不算活路**（owner-workers 的 releaseWakePending 不补派，停在 wakePending 就是死状态；WS-1.4 修复后 parked 行本身会被算作活路，见下）。
- 防抖：watchdog 内存 `Map<workitemId, firstViolationAt>`；违反持续 ≥ `cfg.livenessGraceSec`（新配置，默认 30，`WORKITEMS_LIVENESS_GRACE_SEC`）才 `safeEnqueue(id, { kind: 'liveness_stalled', payload: {} })`；恢复正常则从 Map 删除。已有 open wait reason `stalled_no_path` 时不再 enqueue（从 listOpenWaits 判断，避免每 tick 重复弹）。
- watchdog 崩溃隔离沿用既有 try/safeEnqueue 模式（watchdog.ts:39-50,138-144）。

### 1.3 requirement 处理 liveness_stalled

- `requirementTransition` 新增 case `'liveness_stalled'`：`openWaitReasonsOf` 含 `'stalled_no_path'` → `{}`（幂等）；否则 raise 病历 `{ waits: [{ kind: 'human', reason: 'stalled_no_path', deadlineTtlSec: CHECKPOINT_WAIT_TTL_SEC }] }`。
- `onWaitResolved` 新增分支：`reason === 'stalled_no_path'` → approved ? `retryCurrentPhase(item)` : `reRaiseWait('stalled_no_path')`。
- `src/index.ts` `caseFileLabel` 增加 `'stalled_no_path': '流程卡死（系统自检出，无在途工作）'`。

### 1.4 补派（parked dispatch 持久化）

改 `src/workitems/reducer.ts` + `workitems/store.ts`：

- store 新表 `workitem_parked`（迁移按 `src/store.ts:118-138` 的 guarded-ALTER/CREATE 先例，用 `CREATE TABLE IF NOT EXISTS`）：`id INTEGER PRIMARY KEY, workitem_id TEXT NOT NULL, seq INTEGER NOT NULL, spec TEXT NOT NULL, created_at INTEGER NOT NULL`。方法：`insertParked(workitemId, seq, specJson)`、`listParked(workitemId)`（按 id 升序）、`deleteParked(id)`。
- `insertDispatchOrWake`（reducer.ts:609-670）：`shouldWakePending` 为真时，除置 wakePending 外，把完整 `spec` JSON 序列化落 `workitem_parked`（保留现有超限 warn 日志）。
- `releaseWakePending`（reducer.ts:763-774）owner-workers 分支：不再直接 return——先清 wakePending，然后 `for (const row of store.listParked(item.id))`：反序列化 spec → `deleteParked(row.id)` → 重走 `insertDispatchOrWake(item, seq, spec, now)`（仍超限会再次 park，强一致计数保证不超发；注意先 delete 再 insert 防重复）。solo 分支行为不变。
- terminal 清理：`finalizeTerminalState` 顺带清空该单的 parked 行（防僵尸复活）。
- 活性判定（1.2）把「有 parked 行」也算作活路吗？**不算**。parked 只有 run 结论才释放；若无任何 running/effect/wait，parked 永不释放 = 死状态，正该报警。但 releaseWakePending 修好后这种组合理论上不会出现，报警是兜底。

### 1.5 wait resolve 加固（修诊断 #13）

改 `requirement/index.ts` `onWaitResolved`（251-290）：

- 显式分支补全：`'retry_exhausted'` → approved ? `retryCurrentPhase(item)` : `reRaiseWait('retry_exhausted')`；`'thrash'` → approved ? `{}` : `reRaiseWait('thrash')`。
- 兜底分支收紧：只有 `resolvedWaitReason` 以 `'checkpoint:'` 开头（或 reason 为 undefined——纯单测手造事件的兼容口，保持现状）才走「nextPhase + crossesCheckpoint」推进；其它未知 reason 一律 `{}` 并依赖 1.2 的活性看门兜住（若真停摆会弹 stalled_no_path 病历）。
- `src/index.ts` `caseFileLabel` 增加 `'retry_exhausted': '重试用尽（stall/超时连续失败）'`、`'thrash': '决策震荡（连续被判过期）'`——这两类容器病历此前无飞书卡（PIVOT 文档也承认只能从管控台 resolve），补上后与其它病历同权。

### 1.6 测试

- `tests/workitems/liveness.test.ts`（新）：must-progress 单元制造死状态（手动清空 waits/assignments）→ 走时钟 ≥ grace → 收到 liveness_stalled → 病历 open；resolve approved → retryCurrentPhase 生效；may-rest 相位（intake/deliver）与 probe 不报警；有 open wait / running effect 不报警。
- `tests/workitems/parked-dispatch.test.ts`（新）：3 仓需求 + maxWorkersPerItem=2 → 2 running + 1 parked → 第 1 个 worker 完成 → parked 释放为第 3 个 assignment；terminal 清空 parked。
- `requirement-type.test.ts` 补：resolve 一条 retry_exhausted 病历（approved）在 integrate 相位**不**推进到 deliver。

---

## WS-2 消息必达：owner steer 通道（核心）

**目标**：非终态需求单的每条群消息都有真实消费路径——人可以随时插话（改方向、追问、给返工意见），
包工头（steer run）读到后回话并可触发结构化动作。落地后逐相位语义：

| 相位 | 群消息去向（改造后） |
|---|---|
| 立项 | 收料/AI 抽取（现状保留） |
| 拆解/并行实现/集成验证/交付 | owner 空闲 → 立刻派 steer run 消费；owner 忙 → 该 owner run 收尾时自动补派 steer。steer 的回应以流式卡贴回群 |

### 2.1 新文件 `src/worktypes/requirement/steering.ts`（纯核心 + effect handler，模式对齐 `reconcile.ts`）

**(a) `composeSteerPrompt(input)`**（纯函数）。输入：`{ title, phase, repos, intakeBrief?, followups, contractSummary?, gatekeeperLog?, integrationReport?, recentReports?, priorSteerReport? }`。prompt 要点（对齐 `composeOwnerPrompt` 的织入风格，`worker-handler.ts:194-265`）：

- 角色：「你是这个需求的包工头，负责在推进过程中**答复用户在群里说的话**并决定是否调整施工。你只读浏览，不改代码。」
- 输入织入顺序：需求标题 → 立项书 → 当前阶段（人话翻译：拆解=对账中/并行实现=各仓施工中/集成验证/交付待关单）→ 涉及仓库 → 跨仓契约摘要（interfaces 条数 + 逐条 signature）→ 各仓最近回执（复用 assess 的上界常量 MAX_ASSESS_REPORTS/MAX_ASSESS_REPORT_CHARS 截断策略）→ 监工日志 → 集成报告 → 上一轮 steer 结论 → **用户这批话（followups，标注最高优先级）**。
- 产出要求：①报告主体 = 面向用户的中文答复（会以卡片贴回群，直接跟用户说话，别写内部术语流水账）；②报告**最末尾**输出且仅输出一个 ```` ```steer ```` 块：

```
{ "action": "none | redo_reconcile | rework | raise_human",
  "repos": ["受影响仓绝对路径（仅 rework 填，必须取自涉及仓库清单）"],
  "note": "给工人的返工说明 / 或 raise_human 时要人裁决什么" }
```

- 选择规则写进 prompt：只是答疑/确认 → none；用户对跨仓契约或拆解结论提出修改 → redo_reconcile；用户要求改某仓的实现方向 → rework（repos 只填清单内的仓）；拿不准、或用户要求超出当前需求范围 → raise_human（疑则上报，与监工同姿态）。

**(b) `parseSteerDirective(report): SteerDirective`**（纯函数，永不抛）。`SteerDirective = { action: 'none'|'redo_reconcile'|'rework'|'raise_human', repos: string[], note: string }`。解析器复用 `gatekeeper.ts:136-146` 的 fenced-block 扫描模式（认 ```` ```steer ```` 与 ```` ```json ````），取最后一个有效块；坏 JSON/无块 → `{action:'none', repos:[], note:''}`。coerce 时 repos 过滤非字符串。

**(c) `steeringNotePath(repo): string`**（纯函数）：`steering/<sanitized>.md`，sanitize 规则照抄 `src/agents/worktree.ts:36-39`（worktypes 纯核心不能 import agents 层 → 复制该 4 行正则并加注释说明与 worktree.ts 保持一致）。

**(d) `createSteerApplyHandler(): EffectHandler`**：`kind: 'steer_apply'`，`recovery: 'rerun'`（幂等：重跑重读同一报告、重写同一产物、重 emit 同一事件——下游 worktype 分支需幂等消费，见 2.3）。`run(ctx)`：

1. `reportPath = ctx.effect.payload.reportPath`（string，缺失则直接 return——防御）。
2. `report = ctx.readArtifact(reportPath)`；空 → emit `steer_directive {action:'none'}` 并 return。
3. `d = parseSteerDirective(report)`。
4. `d.action === 'rework'`：对每个 `repo ∈ d.repos ∩ ctx.workitem.repos`（清单外的仓丢弃并写入日志行），把 note 追加写 `steering/<repo>.md`（读旧内容 + `\n\n## ${new Date(ctx.clock.now()).toISOString()}\n${note}` 追加，`writeArtifact` 全量覆写）。
5. emit `steer_directive { action, repos: 交集后, note }`（action 为 none 也 emit，审计留痕 + anchor 刷新）。

### 2.2 派发规则（`src/worktypes/requirement/index.ts`）

**(a) `onHumanMessage` 重写**（340-351）：`/cancel` 分支保留；其余：

```
if (item.phase === PHASE.intake) return {};            // 收料走 bridge，不经此
if (runningOwnersOf(ev.payload) > 0) return {};        // owner 忙 → 等它收尾补派（见 b）
return { dispatch: [ownerSpec(item, STAGE.steer)] };   // owner 空闲 → 立刻消费
```

deliver 相位同样适用（交付后问「分支在哪」也有人答）。注：worker 忙不忙无关——owner 槽独立（`reducer.ts:687-709` owner single-flight 只看 owner）。

**(b) owner run 收尾补派**：`onRunCompleted` 中 `role === 'owner'` 的每个 stage 分支算出基础 transition 后，若 `unconsumedHumanMessagesOf(ev.payload) > 0 && stage !== STAGE.steer`，在返回值上追加 `dispatch: [...(base.dispatch ?? []), ownerSpec(item, STAGE.steer)]`。steer 自己收尾不追加（它刚消费完；若期间又来了新消息，新消息到达时 owner 已空闲、走 (a)）。抽一个小 helper `withPendingSteer(item, ev, base)` 统一做这件事，owner 各分支包一层。

**(c) `run_failed` 的 steer run 特判**：steer run 失败不值得弹病历（它只是答话）。`onRunFailed` 开头加：`stageOf(ev.payload) === STAGE.steer → return {}`（消息仍在窗口内，下一个 owner run 会带上；WS-8 的重试也不用给 steer）。

### 2.3 `steer_directive` 事件消费（`requirementTransition` 新 case）

```
case 'steer_directive': return onSteerDirective(item, ev);
```

- `action === 'redo_reconcile'`：仅 `phase === PHASE.split || phase === PHASE.implement`；且 `runningOwnersOf === 0`（幂等 + 防挤兑）→ `{ dispatch: [ownerSpec(item, STAGE.reconcile)] }`；否则 `{}`。
- `action === 'rework'`：仅 implement/integrate；对 payload.repos 里仍在 `item.repos` 内、**且当前没有该仓 running worker** 的仓 → dispatch `{ role:'worker', repo, stage: STAGE.rework, payload:{ stage: STAGE.rework, repo, note } }`（ttl 取 `ttlsOf(item)`）。有 running worker 的仓跳过——note 已落 steering/<repo>.md，会注入它的后续轮次。「该仓有无 running worker」worktype 看不到 → 容器 enrich 再加一项：`runningWorkerRepos: string[]`（`store.listAssignments` 过滤 running+worker 取 repo，中性字符串数组；加进 WS-0 的 enrich 改动一并做）。
- `action === 'raise_human'`：raise 病历 `reason: 'steer_escalated'`（幂等守卫 openWaitReasons，同类先例 `onGatekeeperBig`）。`caseFileLabel` 加 `'steer_escalated': '包工头上报（需你裁决）'`；`caseFileDetail` 从最近一条 steer_directive 的 note 提详情。`onWaitResolved` 加分支：`'steer_escalated'` → approved ? `{}` : `reRaiseWait(...)`（人处理完就完了；若要继续推进，人再在群里说话即触发新 steer）。
- `action === 'none'` → `{}`。
- rework dispatch 的幂等：steer_apply 是 recovery:'rerun'，崩溃重跑会重 emit steer_directive → rework 分支会再派一遍。防重：dispatch 前检查 `runningWorkerRepos` 已含该仓 → 跳过（首跑派出的 worker 已 running，重跑天然跳过）。写明注释。

### 2.4 steer prompt 接线（`worker-handler.ts` `composePrompt`）

owner 分支按 stage（WS-0.4 已铺路）：`stage === STAGE.steer` →

```ts
return composeSteerPrompt({
  title, phase: workitem.phase, repos: workitem.repos,
  intakeBrief: readArtifact('intake/intake.md'),
  followups,                                  // 用户这批话——run-handler 已算好
  contractSummary: renderContractSummary(readContract(readArtifact)),   // 新小 helper：条数+signature 列表
  gatekeeperLog: readArtifact('contract/gatekeeper-log.md'),
  integrationReport: readArtifact('contract/integration-report.md'),
  recentReports: 复用 assess 的 priorReportPaths 截断逻辑（抽成共享 helper 避免复制）,
  priorSteerReport: priorReport,
});
```

steer 的 runOptions 与 owner 相同（readonly + readableDirs 全仓，`worker-handler.ts:97-103` 不用改——它按 role 分支）。

### 2.5 worker 消费 steering note

- `src/worktypes/requirement/worker.ts` `WorkerPromptInput` 加 `steeringNote?: string`；`composeWorkerPrompt` 在 reworkNote 之后织入：`# 用户中途给本仓的指示（最高优先级，按此调整）`。
- `worker-handler.ts` worker 分支：`steeringNote: assignment.repo ? readArtifact(steeringNotePath(assignment.repo)) : undefined`；rework/fix 轮的 `reworkNote` 从 `effectPayload.note` 读（dispatch payload 带的 note），替代现在仅 `replacesAssignmentId ? priorReport` 的单一来源（保留原逻辑作回落）。

### 2.6 回执诚实化（`src/index.ts:1349-1354`）

`injectHumanMessage` 后的回复改为：`'已收到，交给包工头处理；他的回应稍后会以卡片形式出现在本群。'`。终态回执（index.ts:1340）不变。

### 2.7 effect 注册与事件登记

- `src/index.ts` `createWorkitemsRuntime`：`workitems.effects.registerHandler(createSteerApplyHandler())`（与 gatekeeper/reconcile 同批，index.ts:1664-1674）。
- `phases.ts` `REQUIREMENT_EVENT_KINDS` 追加 `'steer_directive'`；anchor-drift 测试同步。

### 2.8 测试（`tests/workitems/requirement-steering.test.ts` 新建 + 既有套件补例）

- 纯核心：parseSteerDirective 四种 action + 坏 JSON + 无块 + 取最后块；composeSteerPrompt 织入完整性（followups 在场、契约摘要在场）。
- effect：steer_apply 写 steering note（含追加语义）+ emit steer_directive；repos 清单外的仓被过滤。
- 状态机：implement 相位 human_message 且 owner 空闲 → dispatch steer；owner 忙 → {}；owner（assess）收尾且 unconsumed>0 → transition 追加 steer dispatch；steer_directive rework → 只对无 running worker 的仓派 rework；steer run_failed → 不弹病历。
- e2e（对齐 `requirement-e2e.test.ts` 风格）：满配主线中途插一条 human_message → steer run 派发 → 合成 steer 报告（rework 指令）→ 对应仓 rework worker 派发 → fan-in → 监工 → assess 正常收敛。

---

## WS-3 等待提醒外发 + 卡片状态持久化

**目标**：系统在等人时会催；卡片发没发出去有持久记录，重启不重发不漏发。

### 3.1 提醒策略升级（容器层，中性）

- `src/workitems/config.ts` 新增：`waitRemindAfterSec`（默认 14400 = 4h，env `WORKITEMS_WAIT_REMIND_AFTER_SEC`）、`waitRemindRepeatSec`（默认 86400 = 24h，env `WORKITEMS_WAIT_REMIND_REPEAT_SEC`）。
- `src/workitems/watchdog.ts` human wait 分支（56-67）改为**不再只看 deadline**：`due = wait.remindedAt === null ? wait.createdAt + remindAfterSec*1000 : wait.remindedAt + remindRepeatSec*1000`；`now >= due` → enqueue `wait_reminder`。deadline 过期逻辑并入（到 deadline 也触发提醒，去掉原「只提醒一次」限制）。
- `src/workitems/reducer.ts` `applyWaitReminder`（406-413）：去掉 `remindedAt === null` 守卫，每次提醒都刷新 `remindedAt = now`（保留 resolved 守卫）。

### 3.2 wait 卡片消息 id 持久化

- `workitems/store.ts`：`workitem_waits` 表迁移加列 `card_msg_id TEXT`（guarded ALTER，PRAGMA table_info 先例）；`Wait` 类型加 `cardMsgId: string | null`；`updateWait` patch 支持它；行↔对象映射补齐（store.ts:156 附近）。
- `src/index.ts` `surfaceCheckpoints`（1558-1587）：内存 `cardedWaits` Set 删除，改为「`w.cardMsgId` 非空 → 跳过；发卡成功 → `workitems.store.updateWait(w.id, { cardMsgId: posted })`」。重启后不重发（DB 记得），发送失败下次事件/提醒重试（cardMsgId 仍空）。
- 顺带修：`handleCheckpointAction` resolve 后若该 wait 有 cardMsgId 且 ≠ 本次点击的卡（如从管控台 resolve），也可 patch 旧卡为「已处理」——**可选**，成本低就做，写不进就跳过并在落地记要注明。

### 3.3 提醒的飞书出口（`src/index.ts` `postStatus`）

`postStatus`（1594-1625）在锚点刷新后追加：`event.kind === 'wait_reminder'` 时——

1. 从 `event.payload.waitId` 取 wait（`workitems.store.getWait`）；已 resolve 则跳过。
2. 组催办文案：`⏰ 这单已等你 ${humanizeMs(now - wait.createdAt)}：${label}` —— label 用 `checkpointBoundaryOf(reason)` → `checkpointGateLabel`，否则 `caseFileLabel(reason)`，都取不到（如 cancel_confirm）→ 跳过不催。
3. `sender.reply(anchorMsgId, 文案)`（回在锚点卡下，群内可见）。
4. 若 `wait.cardMsgId` 为空 → 调 `surfaceCheckpoints` 重试补发卡（提醒事件成为卡片自愈的触发器）。

### 3.4 测试

- watchdog：4h 后首催、之后每 24h 重复催、resolve 后不催（走假时钟）。
- store：card_msg_id 迁移幂等（老库开两次不炸）；updateWait 写读。
- bridge 层若有 postStatus 测试先例（`tests/card.test.ts`/`tests/feishu/`）则补 wait_reminder 出口例；没有先例则以 caseFileLabel/humanize 纯函数测试兜底。

---

## WS-4 入站可靠性：持久 inbox + 断线补拉

**目标**：消息「递给系统」这半程不再有黑洞：进程内崩溃不丢（inbox），WS 断线不丢（重连补拉），重复投递不重放（DB 去重）。

### 4.1 持久 inbox（kernel store）

- `src/store.ts` 迁移新表：`CREATE TABLE IF NOT EXISTS inbox_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL, create_time INTEGER NOT NULL, payload TEXT NOT NULL, received_at INTEGER NOT NULL, processed_at INTEGER)`。方法：
  - `recordInbox(msg: {messageId, chatId, createTime, payloadJson}): boolean` —— `INSERT OR IGNORE`，`changes === 0` 返回 false（= 重复）；
  - `markInboxProcessed(messageId)`；`listInboxUnprocessed(limit)`；`latestInboxCreateTime(chatId): number`；
  - 清理：`purgeInboxBefore(ts)`（供每日备份任务顺带清 30 天前已处理行）。
- `src/index.ts` dispatcher 的 onMessage 回调外包一层（在 1275 行现回调顶端）：
  1. `store.recordInbox({..., payloadJson: JSON.stringify(msg)})` 为 false → return（权威去重；event-router 的内存 Set 保留作快路径）。
  2. 处理完（原回调正常返回）→ `store.markInboxProcessed(msg.messageId)`。抛错则不标记（重启补投）。
- 启动补投：`main()` 里 `wsClient.start` 成功后，`for (const row of store.listInboxUnprocessed(200))` 反序列化为 `IncomingMessage` 重走同一 onMessage（包一层 try/log，逐条隔离）。注意补投也要过 markProcessed。

### 4.2 断线补拉（对抗「飞书 WS 不重放离线事件」）

- `src/store.ts` `thread_claims` 迁移加列 `chat_id TEXT`（guarded ALTER）；`claimThread` 增参写入。两处调用同步：`runProbe`（index.ts:756 附近，传 `msg.chatId`）、`startIntakeGroup`（index.ts:868 附近，claimKey 即 chatId，也写入）。新方法 `listManagedClaimChatIds(): string[]`（DISTINCT chat_id，owner_kind='managed'，非空）。
- `src/feishu/sender.ts` 新方法 `listMessages(chatId: string, startTimeSec: number): Promise<Array<原始消息对象>>`——调 `client.im.message.list({ params: { container_id_type: 'chat', container_id: chatId, start_time: String(startTimeSec), sort_type: 'ByCreateTimeAsc', page_size: 50 } })`，翻页拉全（页数上限 10 防爆），失败返回 `[]` 只 log（与其它方法失败语义一致）。
- `src/feishu/event-router.ts`：把 `im.message.receive_v1` 回调里「原始 SDK 消息 → IncomingMessage」的解析段（117-190）抽成导出的纯函数 `parseIncomingMessage(data): IncomingMessage | null`，dispatcher 与补拉共用（避免两份解析漂移）。注意 message.list 返回的消息形状与推送事件略有差异（无 sender 包装层级差异等）——补拉侧写一个薄适配把 list item 拍成 receive_v1 的 data 形状再喂 parse，真机验证字段。
- `src/index.ts` 新函数 `backfillClaimedChats(reason: string)`：对 `listManagedClaimChatIds()` 每个 chat：`since = max(latestInboxCreateTime(chatId), Date.now() - 24h)`（无记录时只回看 24h，防首启动全量灌）→ `sender.listMessages(chatId, floor(since/1000) - 60)`（60s 重叠窗口，靠 inbox 去重防重放）→ 逐条适配 → 过 4.1 的同一入口（record→process→mark）。**跳过 bot 自己发的消息**（senderType/sender id 判断）。
- 触发点：①启动时（4.1 补投之后）；②WS 从 unhealthy 恢复 healthy 时——`src/feishu/ws-health.ts` `WsHealth` 加可选回调 `onRecovered?: () => void`（observe 里状态翻 true 时调用），index.ts 接 `() => void backfillClaimedChats('ws-recovered')`。
- `botStartTime` 过滤（event-router.ts:117-118）**保留**（推送路径防启动前历史消息乱入普通会话）；补拉路径不经过该过滤（它有自己的 since 水位），互不干扰。

### 4.3 测试

- store：inbox 去重/标记/水位/清理；thread_claims chat_id 迁移幂等。
- event-router：`parseIncomingMessage` 抽取后既有测试不回归（text/post/file/image 四型）。
- 补拉：伪 sender（内存消息数组）→ backfill 只投未见过的、跳过 bot 自己的、水位推进正确。

---

## WS-5 打回带意见 + 监工判大返工通道

**目标**：人的判断内容（为什么打回、怎么改）能进入下一轮工作；监工红线出口不再只有「放行」。

### 5.1 灯卡带意见输入框（`src/feishu/card.ts` `buildCheckpointCard`）

- 卡体改造：markdown 说明后加 `{ tag: 'form', name: 'ckpt_form', elements: [ input(name:'opinion', placeholder:'意见（可选）：打回原因 / 通过后想补充的方向', required:false), 通过按钮, 打回按钮 ] }`。两个按钮都放 form 内、`form_action_type: 'submit'`，各自 `behaviors[0].value` 沿用现有 `{kind:'ckpt', itemId, waitId, boundary, approved}`。样式参照 `buildQuestionFormCard`（card.ts:468-548）的 form/input/按钮写法。
- **真机风险注明**：一个 form 里两个 submit 按钮是否都能携带各自 value 需真机验证（runbook 项）；若飞书不支持，回落方案：「通过」保持 form 外的普通 callback 按钮，「打回」是 form 内唯一 submit（意见框只服务打回）——回落方案同样满足 D-E。
- `buildCaseFileCard` 同样加意见输入框（病历「已处理·继续」时人常想说「我改了什么」），按钮 value 不变。

### 5.2 意见回灌（`src/index.ts` `handleCheckpointAction`，1220-1269）

- 顶部读 `const opinion = typeof action.formValue?.opinion === 'string' ? action.formValue.opinion.trim() : ''`。
- **在 resolveWait 之前**：`opinion && workitems.api.injectHumanMessage(itemId, { text: `【${approved ? '拍板意见' : '打回意见'}】${opinion}` })`——先注入保证其 seq 小于 resolve 引发的后续 dispatch effect seq，落入下一轮 run 的 batch 窗口（D-E）。
- resolve 的 reason：`opinion || 原固定文案`（管控台/事件流里可见真实理由）。
- cancel 分支不注入。

### 5.3 灯③打回改走 steer（`requirement/index.ts` `redoPhase`，330-338）

`item.phase === PHASE.integrate` 分支：从 `{ effects: [{ kind: 'integration_check' }] }` 改为 `{ dispatch: [ownerSpec(item, STAGE.steer)] }`。steer 会读到 5.2 注入的打回意见（batch 窗口内），按 WS-2 的指令集决定 rework 哪些仓；无意见时 prompt 已规定 raise_human（「打回但未说明原因，请在群里补充」→ steer_escalated 病历）。intake 分支（重弹立项 gate）不变。

### 5.4 监工判大的返工通道

**(a) 病历卡三按钮**：`surfaceCheckpoints` 对 `reason === 'gatekeeper_big'` 的 wait 改用新卡 `buildGatekeeperBigCard`（`card.ts` 新增，结构照抄 `buildCaseFileCard`）：按钮「已改图纸 · 重对账并返工」（value `{... approved:true, action:'rework'}`）／「无需改 · 放行」（`{... approved:true, action:'proceed'}`）／「取消整单」（`{... cancel:true}`）+ 意见输入框。`handleCheckpointAction` 把 `value.action`（string）透传进 decision payload：`decision: { approved, payload: { reason, action: value.action } }`。

**(b) worktype 路由**（`onWaitResolved` GATEKEEPER_BIG 分支，269-273）：

```
approved && phase===implement && action==='rework'  → { dispatch: [ownerSpec(item, STAGE.reconcile)] }
approved && phase===implement（proceed / 无 action） → { dispatch: [ownerSpec(item, STAGE.assess)] }   // 现状
declined / 相位不对                                   → reRaiseWait(GATEKEEPER_BIG_REASON)              // 现状
```

action 从 `checkpointDecisionOf(ev).payload` 读（helper `decisionActionOf`）。

**(c) implement 相位内的重对账收敛链**（依赖 WS-0.4 的 stage 化 afterRun）：

- reconcile run（stage=reconcile）在 implement 相位收尾 → afterRun 已按 stage 重写 `contract/contract.json` + `reconcile.json` → `run_completed(stage=reconcile)` → `reconcile_check` effect（WS-0.4 已按 stage 路由，不看相位）。
- `reconcile_passed` 事件：现仅处理 split（`requestAdvance(split→implement)`，index.ts:72-80）。**新增 implement 分支**：`item.phase === PHASE.implement` → `{ effects: [{ kind: 'gatekeeper_rework' }] }`。
- `reconcile_conflict` 事件：`onReconcileConflict` 的相位守卫从 `!== PHASE.split` 放宽为 `phase !== split && phase !== implement → {}`（人改的图纸仍有冲突 → 再弹对账病历）；`onWaitResolved` 的 RECONCILE_CONFLICT 分支相应放宽：approved && (split || implement) → `ownerSpec(item, STAGE.reconcile)`。
- **新 effect `gatekeeper_rework`**（放 `gatekeeper.ts`，`recovery:'rerun'`）：`ctx.eventsSince(0)` 找最后一条 `gatekeeper_big` 的 payload.raises → 提取 `repos = 去重(raises[].repo 非空) ∩ ctx.workitem.repos`（空则回落 `ctx.workitem.repos` 全量，宁多勿漏）→ emit `rework_requested { repos, note: '监工判大后人已改图纸并重对账通过；请重读本仓设计目录与最新跨仓契约，按新图纸返工。' }`。
- worktype 新 case `'rework_requested'`：phase===implement → 对 payload.repos 中无 running worker 的仓 dispatch worker（stage=STAGE.rework，payload 带 note；幂等姿势同 WS-2.3 rework）。之后正常走 fan-in → gatekeeper_review → …循环收敛。
- 注册：`index.ts` registerHandler(`createGatekeeperReworkHandler()`)；`REQUIREMENT_EVENT_KINDS` 追加 `'rework_requested'`。

### 5.5 测试

- card：灯卡/病历卡含 input 与 form 结构（快照式断言 value 字段齐全）；GatekeeperBig 三按钮 value。
- bridge 纯函数层面：handleCheckpointAction 不好直接测的话，把「opinion → injectHumanMessage 先于 resolve」的顺序断言放进沙箱 e2e。
- 状态机：灯③ declined → dispatch steer（不再 integration_check）；gatekeeper_big resolve(action=rework) → owner reconcile → reconcile_passed(implement) → gatekeeper_rework → rework_requested → 定向 worker 派发；reconcile_conflict(implement) → 病历再弹。

---

## WS-6 复杂度自适应：lite 主线（单仓）

**目标**：让约束与需求复杂度成比例。repos ≤ 1 → lite：必填 3 项、跳过 owner 对账与 assess、一个 worker run 直达灯③。多仓（≥2）→ 满配不变。

### 6.1 必填自适应（`src/worktypes/requirement/intake.ts`）

- `IntakeRequirement` 增加 `'multi-conditional'`（多仓时必填、单仓时选填）；`INTAKE_CHECKLIST` 中 `prd`、`acceptance` 的 requirement 从 `'required'` 改为 `'multi-conditional'`。`name/summary/repos` 恒 required；`ui` 保持 `'conditional'`（勾 UI 才必填，与仓数无关）。
- `requiredDefs(state)`（167-171）：先算 `multiRepo = intakeReposOf(state).length >= 2`，过滤规则加 `d.requirement === 'multi-conditional' && multiRepo`。`requiredMissing`/`isGateReady`/`requiredProgress`/`nextRequiredToFill` 全部自动跟随（它们都基于 requiredDefs）。
- 边界语义（写进注释 + 测试）：repos 未填时 multiRepo=false → 清单先按 lite 显示；填了 2+ 仓 → prd/acceptance 变必填、ready 可能由 true 翻 false——此时若立项 gate wait 已 open，`buildIntakeCard`（index.ts:1085-1099）会因 `!view.ready` 隐藏「立项完成」按钮，补齐后按钮复现、复用同一 open wait。**已有机制天然兜住，不需要撤回 wait**，但要有测试钉死这条路径。
- `buildIntakeBrief` 不变（只输出有值项）。

### 6.2 lite 相位流转（`src/worktypes/requirement/index.ts`）

- 新 helper `isLite(item: WorkItem): boolean { return item.repos.length <= 1; }`（以 repos_set 提升后的 workitem.repos 为准——立项收的仓在 gate 通过 + intake_finalize 后才落上来，时机正确）。
- `onReposSet`（211-214）：`isLite(item)` → `{ phase: { to: PHASE.implement, reason: 'lite_single_repo' }, dispatch: workerDispatches(item, undefined) }`（split→implement 非 checkpoint 边界，直跳合法）；否则现状（派 owner reconcile）。
- 监工 gate 保留（fan-in 后 `gatekeeper_review` 照跑——确定性 effect，worker 的 gatekeeper 块上报语义在单仓下依旧有价值：interfaceId 恒空 → 判小 → `gatekeeper_passed`）。
- `gatekeeper_passed` case（84-85）：`isLite(item)` → `enterPhase(item, PHASE.integrate, 'lite_skip_assess', ev)`（跳过 assess——单仓无跨仓契约、impl-claims 无对象）；否则现状（dispatch assess）。
- integrate：`integration_check` 走 `no_contract` 放行（integration.ts:36-39 现状）→ 灯③ raise。WS-7 会把「no_contract=静态对账未生效」如实写上灯③卡。
- `retryCurrentPhase`（293-298）implement 分支已是 `workerDispatches`，lite 天然复用；split 分支加 lite 守卫：`isLite → workerDispatches`（防 stalled 自愈把 lite 单派回 owner 对账）。

### 6.3 收料引导文案

`src/index.ts` `promptNextIntake`/`handleIntakeMessage` 不需逻辑改动（它们跟随 requiredMissing）。唯一体验补丁：`fillIntakeDeterministic` 与 AI 抽取后的「还差」提示已动态正确。清单卡（`intake-card.ts`）渲染 required 标记也基于 view.items[].required——`buildIntakeView`（index.ts:183-206）里 required 的计算要跟随 6.1 的新枚举：`d.requirement === 'required' || (d.requirement === 'conditional' && state.uiRequired) || (d.requirement === 'multi-conditional' && multiRepo)`。**别漏这处**（它是 bridge 里复制的一份判定）；更好的做法：intake.ts 导出 `isDefRequired(def, state): boolean` 单一实现，bridge 与 requiredDefs 共用。

### 6.4 测试

- intake：单仓 → name/summary/repos 齐即 gateReady；填第 2 仓 → ready 翻 false、missing 含 PRD/验收；再补齐 → ready 复真。
- 状态机：lite e2e——repos_set(1 仓) → 直接 implement + 1 worker；worker 完成 → gatekeeper_review → passed → 直接 integrate（无 assess dispatch）→ no_contract 放行 → 灯③ wait open。多仓路径回归不变（跑既有 e2e）。
- 守卫：lite 单在 implement 相位 run_failed 病历 resolve(approved) → retryCurrentPhase 重派 worker 而非 owner。

---

## WS-7 灯③ 证据厚化 + 交付清单 + worktree GC

**目标**：灯③拍板有据；交付最后一公里给全（分支/差异/接手命令）；worktree 不再永久堆积。

### 7.1 新文件 `src/worktypes/requirement/deliver.ts` — `deliver_manifest` effect

`createDeliverManifestHandler(opts: { worktreesDir: string; baseRef?: string })`，`kind: 'deliver_manifest'`，`recovery: 'rerun'`（纯读 git + 写 artifact，幂等）。`run(ctx)`：

1. 从 `ctx.eventsSince(0)` 收集 run_completed 事件中 `role==='worker'` 且带 repo/assignmentId/reportPath 的记录，**每仓取最后一条**（多轮 fix/rework 后以最终为准）。
2. 每仓推导：分支名 = `branchFor(workitem, {id: assignmentId, repo})` ——把 `worker-handler.ts:173-176` 的 `branchFor` 移到一个两边共用的位置（建议移进 `deliver.ts` 导出、worker-handler import，或抽 `branch.ts`；保持纯函数）；worktree 路径 = `worktreePathFor(opts.worktreesDir, workitem.id, assignmentId, repo)`。
3. `src/agents/worktree.ts` 新增 `worktreeDiffStat(worktreePath: string, base: string): string`（`git diff --stat <base>...HEAD`，worktree 不存在/命令失败 → 返回 `'(worktree 已清理或不可读)'`，不抛）。**effect handler 允许调它**（先例：worker-handler prepareWorkspace 调 worktreeAdd）。
4. 写 `delivery/manifest.md`：

```
# 交付清单 · <title>
## <repo>
- 分支：req/xxx/yyy （已在主仓创建，worktree 删除后依然存在）
- 改动概览：<diffstat>
- 工人回执：<reportPath>（artifact 仓内路径）
- 本地接手：cd <repo> && git switch <branch>
- 推送开 MR：git push origin <branch> 后到代码平台发起 MR
```

5. emit `manifest_ready { repos: [{repo, branch}], summaryText: 全文 ≤ 3000 字截断 }`。

### 7.2 接线与触发

- 触发点：`requirementTransition` 的 `integration_check_passed` case（88-95）改为在 `requestAdvance(...)` 结果上追加 effect：灯③尚未 open 时返回 `{ ...raiseCheckpoint 结果, effects: [{ kind: 'deliver_manifest' }] }`；已 open（幂等重跑）不再追加。这样清单在人拍灯③**之前**就生成好。
- 注册：`index.ts` `registerHandler(createDeliverManifestHandler({ worktreesDir: path.join(deps.config.dataDir, 'worktrees') }))`（worktreesDir 与 `createRequirementRunStrategy` 的入参同源，index.ts:1640-1641——抽成一个 const 两处共用，别写两遍字符串）。
- 出口：`postStatus` 增加 `event.kind === 'manifest_ready'` → `sender.replyCard(anchorMsgId, buildReportCard(\`交付清单 · ${item.title}\`, summaryText))`。
- `REQUIREMENT_EVENT_KINDS` 追加 `'manifest_ready'`。

### 7.3 灯③ 卡厚化（诚实标注）

- `buildCheckpointCard`（card.ts:567）data 增加可选 `note?: string`，渲染为一段灰字。
- `surfaceCheckpoints`：boundary === PHASE.deliver（即灯③）时，从事件流取最后一条 `integration_check_passed` 的 payload.reason：`'no_contract'` → note = `'⚠️ 静态跨仓对账未生效（本单无跨仓契约）——请以下方交付清单与工人回执为准人工验收'`；`'no_claims'` → 相应文案；无 reason（真对账通过）→ note = `'✅ 静态跨仓对账通过（契约 N 条接口）'`。**注意 index.ts 是 kernel-exempt，可 import PHASE 判断 boundary**（先例：import checkpointBoundaryOf/lights）。

### 7.4 worktree GC（每日任务）

- 新文件 `src/worktypes/requirement/worktree-gc.ts`（或放 `src/backup.ts` 旁的独立模块）：`runWorktreeGc(deps: { store: WorkitemsStore; worktreesDir: string; logger; olderThanMs?: number })`——扫 `worktreesDir` 下一级目录（目录名即 workitemId）：对应 workitem **终态**（done/failed/cancelled）且 `updatedAt` 早于 `olderThanMs`（默认 7 天）→ 对其中每个 worktree 调 `worktreeRemove`（失败降级 `fs.rmSync(dir, {recursive, force})` 并 `git worktree prune`——worktreeRemove 需要主仓存活，主仓被删的极端情形直接 rm）→ 删空目录。**分支永远保留**（worktree.ts:51-54 语义）。workitem 不存在的孤目录（DB 重置过）→ 超过 30 天才删，log 警示。
- 接线：`src/backup.ts` 的 `scheduleDailyBackup` 已支持额外 jobs（index.ts:348 传了 `[workitems.backupJob()]`）——追加一个 `{ name: 'worktree-gc', run: () => runWorktreeGc(...) }`（对齐 BackupJob 接口形状，读 `src/backup.ts` 确认字段名后适配）。

### 7.5 交付群收尾（可选低优先，做不动就记入落地记要跳过）

- `sender.ts` 新方法 `updateGroupName(chatId, name)`（`im.chat.update`，失败只 log）。
- `runDone`（index.ts:766-796）在 requirement 单终态后：改群名前缀 `✅ ` + 原名，并 `sendText` 最终总结（含 manifest 提示）。

### 7.6 测试

- deliver.ts：合成事件流（两仓各两轮 worker）→ manifest 每仓取最后一轮；worktree 缺失 → 降级文案；manifest_ready payload 截断。
- 状态机：integration_check_passed → 灯③ wait + deliver_manifest effect 同批出现；幂等重跑不追加第二个 effect。
- GC：临时目录 + 假 store——终态 8 天前 → 删；非终态/未到期 → 留。

### 7.7 灯④ 显式化：awaiting_close wait + 关单卡（修诊断 #17）

「安静等人」也必须是一条 open wait——否则既不可点、也不可催、活性看门也看不见。

- `requirement/index.ts` `enterPhase` 的 deliver 分支（322-324）：从裸 `base` 改为
  `{ ...base, waits: [{ kind: 'human', reason: 'awaiting_close', deadlineTtlSec: 7 * 86_400 }] }`。
- `onWaitResolved` 新分支：`reason === 'awaiting_close'` → `decision.approved && item.phase === PHASE.deliver` →
  `{ terminal: 'done' }`（与 close_requested 等价出口）；否则 `reRaiseWait('awaiting_close')`（declined =「暂不关」，
  重弹保持可点可催；reRaise 产生新 waitId → card_msg_id 为空 → surfaceCheckpoints 自动重发新卡，与病历重弹同构）。
- 卡：`card.ts` 新增 `buildClosureCard(data: { title: string; note?: string }, routing: { itemId: string; waitId: string })`
  （orange；正文=「集成验证已过灯③，交付清单见上方卡片；确认各仓分支已合并/上线后点关单」+ note；按钮
  「✅ 确认关单 · 整单完成」`{kind:'ckpt', itemId, waitId, approved:true}` ／「暂不，保持打开」`{approved:false}`）。
  `surfaceCheckpoints` 对 `reason === 'awaiting_close'` 出此卡（在 boundary/caseLabel 判定之前加一个显式分支）。
  `handleCheckpointAction` 无需新分支（approved 布尔既有路径已透传）。
- `/done`（close_requested → terminal done）保留为等价出口；terminal 时 `finalizeTerminalState`（reducer.ts:348-367）
  自动清掉 awaiting_close，不需要额外处理。
- WS-3 催办自然覆盖（human wait 通用），但 WS-3.3 的 label 取值链要加 `awaiting_close → '交付待关单（灯④）'`，
  否则催办文案因取不到 label 被跳过。
- D-D 的 liveness 声明**不用改**（deliver 保持 may-rest；有 wait 时不变式本就满足，声明只是兜底豁免）。
- 测试：enterPhase(deliver) 带出 awaiting_close wait；approved resolve → terminal done；declined → 重弹新 wait；
  `/done` 路径仍可关单；terminal 后无 open wait 残留。

---

## WS-8 run_failed 先自动重试一次

**目标**：瞬时错误（API 超时、网络抖动）自愈，人只看到重复失败。

### 8.1 worktype 改动（`requirement/index.ts` `onRunFailed`，241-246）

```
const stage = stageOf(ev.payload);
if (stage === STAGE.steer) return {};                            // WS-2.2(c)
const err = errorTextOf(ev.payload);                              // payload.error，helper 防御式取
if (err.includes('write-guard fail-closed')) → 病历（现状路径）    // D-L：护栏失效不重试
const retries = numberField(ev.payload, 'assignmentRetries') ?? 0;
if (retries === 0) return retryFailedRun(item, ev);               // 首败自动重试
病历（现状路径，幂等守卫保留）
```

- `retryFailedRun(item, ev)`：按结论 payload 的 role/repo/stage 原样重派一次：worker → `{ role:'worker', repo, retries: 1, payload:{ stage: stage ?? 'implement', repo } }`；owner → `ownerSpec(item, stage ?? 按相位回落)` 加 `retries: 1`。TTL 取 `ttlsOf(item)`。`AssignmentSpec.retries` 字段已存在（types.ts:114），emitRunConclusion 已带 `assignmentRetries`（effects.ts:362）——重派后的 run 再失败时 retries=1 → 走病历。
- 注意与容器 stall 重试（`redispatchOrEscalate`，retryBudget=1）互不干扰：那条覆盖 stall/abort，这条覆盖 run_failed，计数同用 assignment.retries——worst case 一次 stall 重试 + 一次 fail 重试共 2 次，可接受；在注释中写明。

### 8.2 测试

`requirement-type.test.ts` 补：首败（retries=0）→ dispatch 重试且不弹病历；重试再败（retries=1）→ 弹病历；错误含 write-guard fail-closed → 直接病历；steer 失败 → 无动作。

---

## WS-9 AskUserQuestion 接入 workitem run（agent → 人的提问通道）

**目标**：owner/worker run 中途用 AskUserQuestion 提的问题，以按钮/表单卡出现在群里；人的回答经 WS-2 通道回灌下一轮。桥侧 bridge task 已有完整先例（index.ts:481-489 捕获、1140-1214 表单回灌），本 WS 把同套机制搬到 workitem run。

### 9.1 run-handler 接线（`src/worktypes/agent-run/run-handler.ts`）

- `RunProgressSink` 新增可选方法：`onAskUser?(info: { assignmentId: string; workitemId: string; title: string; questions: AskUserQuestionItem[] }): void`（类型从 `../../agents/types.js` import——run-handler 已 import 该模块，无新依赖边）。
- `runAgent` 的 callbacks（208-222）追加：`onAskUser: (_id, q) => deps.progress?.onAskUser?.({ assignmentId, workitemId: workitem.id, title: workitemTitle(workitem), questions: q.questions })`。
- 行为注记（写注释）：headless CLI 会自动关掉该 tool 并继续跑完本轮（agents/types.ts:20-25），所以 run 照常产报告收尾；问题卡是**并行**贴出的，答案走下一轮。

### 9.2 ProgressCards 实现（`src/feishu/progress-cards.ts`）

- `onAskUser(info)`：从 `runs.get(assignmentId)` 拿 locator（entry 需在 onRunStart 时把 loc 存进 RunEntry——加字段）；卡 = `buildQuestionFormCard` 的 workitem 变体（见 9.3）；`replyCard(anchorMsgId, card)`（thread 情形 `replyCardInThread`，与 postInitial 同分流）。fire-and-forget，失败只 log（组件既有纪律）。

### 9.3 卡与回调（`src/feishu/card.ts` + `src/index.ts`）

- `card.ts`：`export const AUQ_WORKITEM_ACTION_KIND = 'auq-wi'`；`buildQuestionFormCard` 加一个可选 routing 参数或新函数 `buildWorkitemQuestionCard(title, q, { workitemId })`——表单结构复用现有实现（把公共部分抽私有 helper），提交按钮 value 为 `{ kind: 'auq-wi', workitemId, total, headers }`。
- `index.ts` `handleCardAction`：新增 `value.kind === AUQ_WORKITEM_ACTION_KIND` 分支——答案组装逻辑与现有 auq 分支相同（把 1160-1191 的「formValue → lines/brief」抽成独立函数 `assembleAuqAnswers(value, formValue)` 两处共用）→ `workitems.api.injectHumanMessage(workitemId, { text: '这是对你上一轮提问的回答：\n' + lines })` → patch 卡为 `buildQuestionAnsweredCard`。注入即触发 WS-2 派 steer 或被下一轮 run 的 batch 消费——提问的那个 run 多半已结束，答案自然进下一轮（reconcile 重跑 / steer / rework），prompt 里的 priorReport 提供上下文连续性。

### 9.4 测试

- card：auq-wi value 形状。
- 集成：伪 progress sink 断言 onAskUser 被调、payload 齐全；answers 组装函数纯测（自定义优先、未作答占位——迁移现有逻辑时行为不变）。

---

## WS-10 杂项修缮（收尾清单）

1. **立项 AI 抽取超时**（诊断 #14，`src/index.ts` `aiExtractIntake`，947-984）：`pool.send` 外包 `Promise.race([send, timeout(90_000)])`；超时 → `pool.abort(taskId)` + 返回 null（自动落 `fillIntakeDeterministic` 回退）+ 群里发「AI 提取超时，改为逐项收料」。timeout 常量可 env（`INTAKE_EXTRACT_TIMEOUT_MS`）。
2. **病历卡详情带仓**（`src/index.ts` `caseFileDetail`，150-175）：`reconcile_conflict` 分支在 detail 后追加 `（涉及：repos.join('、')）`（payload.unresolved[].repos 已有数据）；`gatekeeper_big` 同理带 raise.repo。
3. **caseFileLabel 全覆盖断言**：新增单测枚举「所有会 raise 的 human wait reason」（checkpoint:* 之外：reconcile_conflict / gatekeeper_big / run_failed / integration_unresolved / retry_exhausted / thrash / stalled_no_path / steer_escalated / cancel_confirm）——除 cancel_confirm（有专属确认流）外都必须有 caseFileLabel 或 checkpoint 映射，防新病历再次成为「无卡可见」暗仓。
4. **打回文案与现实对齐**：card.ts:578 的「直接在群里回复要改什么，我据此重做」在 WS-2/5 后为真——保留；但把灯卡说明里的「也可点【打回】退回重做」改为「点【打回】并填写意见，我会按意见安排返工」。
5. **`buildIntakeView` 的 required 判定去重**：见 WS-6.3，抽 `isDefRequired` 单一实现。
6. **`anchorNoun`/board 投影跟新事件**：`board.ts` 的活动流/待办若按事件 kind 白名单渲染，把 steer_directive / rework_requested / manifest_ready / liveness_stalled 加入映射（读 board.ts 现状适配；web/src 若有 kind→文案表同步）。
7. **PIVOT 文档追记**：在 `PIVOT-设计外置-实现聚焦.md` 顶部落地记要区追加一行指向本文档（「体验与可靠性 OVERHAUL 已另立方案」），避免两份文档漂移。
8. **`/cancel` 命令接线**（修诊断 #15）：`src/bridge/commands.ts` 的 dispatch switch 加 case `'/cancel'` → 新构造器回调
   `onCancelUnit(msg)`（与 onRequirement 同型，kernel 中性）；`HELP_TEXT` 补一行「`/cancel` 在需求群里发起取消整单（需确认）」。
   `src/index.ts` 实现 onCancelUnit：按「threadRoot claim → 群 chatId claim」找 managed item（与普通消息的 managed 路由
   同源——把 index.ts:1321-1332 的查找段抽成小 helper `resolveManagedItem(msg)` 两处共用，防两份判定漂移）；找不到 →
   回复「本会话没有进行中的需求单」；找到且终态 → 复用现有「已结束，回复 /done 关闭」文案；否则 →
   `workitems.api.injectHumanMessage(item.id, { text: '/cancel' })`（worktype 现有分支 raise cancel_confirm，
   `requirement/index.ts:341-347` 从此不再是死代码）。
9. **cancel_confirm 确认卡**（修诊断 #16）：`card.ts` 新增 `buildCancelConfirmCard(title: string, routing: { itemId; waitId })`
   （red；正文=「确认取消整单？各仓在途工作将被中止，已产出的 worktree 分支保留」；按钮「⚠️ 确认取消」
   `{kind:'ckpt', itemId, waitId, approved:true}`（danger 样式）／「继续推进」`{approved:false}`）。`surfaceCheckpoints`
   对 `reason === 'cancel_confirm'` 出此卡（删掉「cancel_confirm 走别的路径」的过时注释）。resolve 路由**现状已正确**、
   不要动：approved → terminal cancelled；declined → `{}`——declined 返回空是安全的：cancel_confirm 是**叠加** wait，
   declined 后原有 waits/runs 原封不动；若原本就处于死状态，WS-1 活性看门兜底。WS-10.3 的全覆盖断言把 cancel_confirm
   从豁免名单移进「必须有卡」名单（它现在有专属卡了）。

---

## 附录 A：新增面清单（一览）

### 新事件 kind

| kind | 产地 | 消费 | 登记 REQUIREMENT_EVENT_KINDS |
|---|---|---|---|
| `liveness_stalled` | watchdog（容器） | requirementTransition → stalled_no_path 病历 | 否（容器事件，与 timer_fired 同类） |
| `steer_directive` | steer_apply effect | requirementTransition（redo_reconcile/rework/raise_human/none） | 是 |
| `rework_requested` | gatekeeper_rework effect | requirementTransition → 定向重派 worker | 是 |
| `manifest_ready` | deliver_manifest effect | postStatus → 群内交付清单卡 | 是 |

### 新 effect handler（全部 recovery:'rerun'，注册于 index.ts createWorkitemsRuntime）

`steer_apply`（steering.ts）· `gatekeeper_rework`（gatekeeper.ts）· `deliver_manifest`（deliver.ts）

### 新 wait reason（都要 caseFileLabel/专属卡 + onWaitResolved 分支 + declined 重弹）

`stalled_no_path` · `steer_escalated` · `awaiting_close`（专属关单卡，WS-7.7）
（另：`retry_exhausted`/`thrash` 补卡与分支；`cancel_confirm` 补专属确认卡（WS-10.9），它是唯一 declined→`{}` 不重弹的——叠加 wait，declined 即放弃取消）

### schema 迁移（全部 guarded，幂等）

- workitems db：`workitem_parked` 新表；`workitem_waits.card_msg_id` 列。
- kernel db：`inbox_messages` 新表；`thread_claims.chat_id` 列。

### 新配置

`WORKITEMS_LIVENESS_GRACE_SEC`(30) · `WORKITEMS_WAIT_REMIND_AFTER_SEC`(14400) · `WORKITEMS_WAIT_REMIND_REPEAT_SEC`(86400) · `INTAKE_EXTRACT_TIMEOUT_MS`(90000)

### stage 词表（dispatch payload.stage，随 run 结论透传）

`reconcile` · `assess` · `steer` · `implement` · `fix` · `rework`

---

## 附录 B：手验 runbook（真机，全部 WS 落地后）

前置：`npm start`，一个测试飞书群账号，两个本地 git 测试仓（可复用既有手验仓）。可选 env：
`WORKITEMS_WAIT_REMIND_AFTER_SEC=60`（第 6 项催办）、`INTAKE_EXTRACT_TIMEOUT_MS=5000`（验立项抽取超时回退）。

> **⚠️ 本 session 全靠单测/e2e 覆盖（738 测试绿），未跑真机。下列三点是代码层无法覆盖、务必真机确认的：**
> - **（第 3 项）飞书 form 里放 2~3 个 submit 按钮，点击是否各自回传自己的 `behaviors.value` + 同一份 `form_value.opinion`。**
>   若不行 → 启用方案 §5.1 回落（「通过」= form 外普通 callback、「打回」= form 内唯一 submit），灯卡/病历卡/监工三按钮卡同改。
> - **（第 7 项）`im.message.list` 返回 item 的真实字段**：`adaptListMessageToEventData` 假设 `msg_type`/`body.content`/
>   `sender.id`（字符串）/`sender.sender_type`/`mentions[].id`（字符串 open_id）/`create_time`（**毫秒**字符串）。逐字段核对，
>   尤其 create_time 单位；p2p 会话的 chat_type 走 `thread_claims.chat_type`（claimThread 已存），确认 p2p probe 补拉不被群门丢。
> - **（第 9 项）headless CLI 的 AskUserQuestion 行为**：确认 CLI 自动关该 tool 并跑完本轮（问题卡并行贴出、答案走下一轮）。

1. **lite 主线**：`/req` → 群名 → 只发 name/summary/一个仓 → 清单卡 ready（3 项）→ 点「立项完成」→ 直接见 worker 流式卡（无对账 run）→ 完成 → 灯③卡带「⚠️ 静态对账未生效」note + 交付清单卡（分支/diffstat/接手命令）→ 点通过 → 出灯④关单卡 → 点「确认关单」（或 `/done`）→ 单终态 done。
2. **消息必达**：满配双仓单，在「并行实现」工人跑动时于群里发「后端字段名改成 orderNo」→ 收到「已收到，交给包工头处理」→ steer 流式卡出现并回话 → 若给出 rework 指令，对应仓 rework worker 起跑。再在**交付**相位问「分支在哪」→ steer 卡回答（死信清零验证）。
3. **打回带意见**：灯③卡填意见「样式没按设计稿」点打回 → steer 起跑并引用该意见 → 定向 rework。真机确认 form 双 submit 按钮 value 是否各自到达（若不行，启用 WS-5.1 回落方案并记录）。
4. **监工返工**：诱导 worker 上报 interfaceId（PRD 里埋跨仓接口改动）→ 判大病历卡三按钮 → 点「已改图纸·重对账并返工」→ 观察 reconcile → rework 链。
5. **活性自证**：手动制造死状态（sqlite 里 resolve 掉唯一 wait 且无 run）→ ≤1 分钟收到「流程卡死」病历卡 → 点已处理 → 相位入口工作重跑。
6. **催办**：把 `WORKITEMS_WAIT_REMIND_AFTER_SEC=60` 起服务 → 挂一个灯③不点 → 1 分钟后群里收到 ⏰ 催办 + 若灯卡曾发失败会自动补发。
7. **断线补拉**：断网 30s（或 kill -STOP ws 进程模拟）期间往立项群发消息 → 恢复后消息被补拉进收料/steer；重启进程重复验证 inbox 补投。
8. **失败自愈**：临时把 claude binPath 指向不存在路径跑一轮 → 首败自动重试（日志可见 retries=1）→ 再败弹病历；恢复 binPath 后点「已处理·继续」恢复。
9. **AskUser**：给 worker 的 PRD 里埋「实现前先问用户 A 还是 B」→ 群里出现问题表单卡 → 提交答案 → 下一轮（steer/rework）prompt 引用答案。
10. **取消流**：任一推进中的单，群里发 `/cancel` → 出确认卡（不再是「未知命令」）→ 点「继续推进」→ 流程不受影响、原有卡/等待原封不动；再发 `/cancel` → 点「确认终止」→ 单终态 cancelled、锚点卡刷新、在途 run 被中止。
11. **委托模式（DELEGATE，睡前放权）**：`WORKITEMS_DELEGATION_DELAY_SEC=60` 起服务 → 推进中的需求群里发 `/delegate 5m` → 收到确认（含到期时刻 + 「监工判大与一切病历仍会等你」）→ 走到灯④关单卡（或双仓真对账通过的灯③）挂着不点 → 卡上带「⏱ 委托生效中」灰字 → 1 分钟后自动通过 + 群内「⏱ 已按你的委托自动通过」通知 + 事件流该 wait `resolved_by=delegation`、resolve_reason 带【委托】原文留痕 → **lite 单的灯③ 验证不自动过**（no_contract 被 guard 拦住，卡上也不出委托灰字，催办照常）→ `/delegate off` 后灯不再自动过（回「已撤销本单委托」）→ 超时长 `/delegate 48h` 被拒（上限 24h）。真机验证点：飞书通知回贴在锚点话题下、`/delegate` 在已认领需求群外回「本会话没有进行中的需求单」。

12. **立项智能收料 L0 快路径（INTAKE）**：先跑通任一需求让某仓进登记表（立项 gate 通过 → repos_set 回写；或历史单启动回填）→ 新开 `/req` 立项群 → 只说「就在 <该仓名> 里」→ 抽取命中登记表**秒填 repos**（过当场 git 校验）→ 清单卡对应项打勾。真机验证点：登记表快照确实进了抽取 prompt（命中即填、不派勘探）。
13. **立项勘探 L1 自动触发**：新群立项，说一个**登记表里没有**的仓名（如「就在 alaeatposapp 里」，本地该仓在 `INTAKE_SCOUT_ROOTS` 或已知仓父目录下）→ 群里出「🔍 没认出这个仓，我去本地找找」→ 勘探流式卡出现（readonly，搜索根内浏览）→ **唯一命中** → 报告收尾 → `scout_result` → 桥层当场校验通过 → 自动填 repos + 回写登记表 + ✅ 文案 → 清单卡打勾 → 正常走立项 gate。真机验证点：勘探 run 只读、只在搜索根内活动；每单自动派勘探 ≤ 2 次（连派两轮无果后不再自动派，需手动 `/scout`）。
14. **立项勘探 L1 歧义分叉**：本地放**两个同名仓**（如 `/a/alaeatposapp` 与 `/b/alaeatposapp`）→ 立项说该仓名 → 勘探出 `ambiguities` → 群里贴 **AUQ 选择卡**（带各候选证据：最近提交/远端）→ 点选一个 → 走既有 auq-wi 回灌 → **下一轮抽取命中所选绝对路径** → 填 repos。真机验证点：选择卡 workitemId routing 正确、点选后答案确实回到立项抽取（而非被 worktype human_message 吞掉）。
15. **立项勘探 手动 `/scout` + notFound**：立项群里发 `/scout <一个本地找不到的仓名>` → 回「🔍 收到，我去本地找找」→ 勘探 → `notFound` → 群里「没找到 xxx，请给绝对路径或 /scout 重试」。再验搜索根为空（不设 `INTAKE_SCOUT_ROOTS` 且登记表空）时 `/scout` 直接回「勘探不可用：没有可搜索的根目录」。
16. **立项仓内收料 L2（可选）**：满配单，勘探确定仓后仓里有 PRD/README → `scout_result.materials` → PRD/验收/背景**空字段**被填入带「【AI 从 <path> 提取，立项卡上请确认】」标记的草稿；已有值的字段**不被覆盖**；群里「📎 顺路从仓里找到候选材料」。真机验证点：gate 必填语义不变（L2 只递草稿，人在立项完成时确认）。

每项通过与否记录在本文档落地记要中，未通过项按「真机暴露」惯例开修。

---

> **执行完毕后**：更新本文件头部状态为「已实施」，追加「✅ 落地记要」（对齐 PIVOT 文档格式：改了什么 / 与方案出入 / 留下的 live 半 / 手验结果），并把 memory 交接需要的非显然结论写清。

---

## ✅ 落地记要（2026-07-03，WS-0~WS-10 全绿）

执行者：claude-opus-4-8（ultracode 模式，续跑 session）。WS-0/1/2 由前序 session 完成（HEAD=dddd98f）；本 session 从
dddd98f 起做 **WS-3~WS-10**，各 WS 一次独立提交、每次提交前 `npm run check` 全绿。高风险 WS（WS-4/WS-5）提交前做对抗式
代码审查。最终 **738 测试绿 / 92 文件**，typecheck + biome + vitest 全过，架构守卫（kernel 中性红线）通过。

### 各 WS 提交 hash（overhaul/req-v1 分支）

| WS | commit | 一句话 |
|---|---|---|
| WS-3 | `7a81b39` | 等待提醒外发（4h 首催/24h 复催）+ 卡片状态持久化（wait.card_msg_id） |
| WS-4 | `876ce45` | 入站可靠性：持久 inbox（kernel）+ 断线补拉（im.message.list）+ ws onRecovered |
| WS-5 | `c9abf9a` | 打回带意见（form+opinion）+ 监工判大三按钮返工链（gatekeeper_rework） |
| WS-6 | `662fce9` | 复杂度自适应 lite 主线（单仓跳过对账/assess，multi-conditional 必填） |
| WS-7 | `c35a6b5` | 灯③证据厚化 + 交付清单（deliver_manifest）+ worktree GC + 灯④关单 |
| WS-8 | `8f12647` | run_failed 先自动重试一次（retries 计数，write-guard fail-closed 除外） |
| WS-9 | `34dafe2` | AskUserQuestion 接入 workitem run（onAskUser → 问题卡 → 答案回灌） |
| WS-10 | `23e7c28` | 杂项：/cancel 接线 + 取消确认卡 + 立项抽取超时 + 病历带仓 + board 投影 |

### 新增面（对齐附录 A）

- **新事件 kind**：`steer_directive`（WS-2）/ `rework_requested`（WS-5）/ `manifest_ready`（WS-7），均登记进
  `REQUIREMENT_EVENT_KINDS`（共 13 项，anchor-drift 测试同步）；`liveness_stalled` 是容器事件不登记。
- **新 effect handler**（recovery:'rerun'）：`gatekeeper_rework`（gatekeeper.ts）/ `deliver_manifest`（deliver.ts，新文件）。
- **新 wait reason**（各有卡 + onWaitResolved 分支）：`awaiting_close`（灯④关单卡）；`cancel_confirm` 补专属确认卡。
- **新纯核心文件**：`steering.ts`（WS-2，前序）/ `deliver.ts` / `branch.ts`（抽 branchFor）/ `worktree-gc.ts`。
- **schema 迁移**（全 guarded/幂等）：workitems `workitem_waits.card_msg_id`（v5）；kernel `inbox_messages` 表 +
  `thread_claims.chat_id`/`chat_type`。
- **新配置**：`WORKITEMS_WAIT_REMIND_AFTER_SEC`(4h)/`_REPEAT_SEC`(24h)、`INTAKE_EXTRACT_TIMEOUT_MS`(90s)。

### 与方案的出入（如实记，已按方案意图适配）

1. **WS-6 lite 判定时机（重要）**：方案 §6.2 设想 `onReposSet` 用 `isLite(item.repos)`，但核对代码发现 `applyReposSet`
   只写 DB（`store.setRepos`）**不改内存 `item`**，故 `onReposSet` 里 `item.repos` 仍是提升前的旧值（空）→ `isLite` 恒真、
   且 `workerDispatches` 会按空 repos 派 0 个 worker。**改以事件 payload 的 repos 判 lite + 切 worker**（新 `reposSetOf` helper +
   `workerDispatches` 加 `reposOverride` 参）。其它 `isLite` 用处（gatekeeper_passed / retryCurrentPhase）item 已是新载入的、
   repos 已提升，用 `item.repos` 无碍。
2. **WS-4 onRecovered 落点**：方案 §4.2 写「`WsHealth` 加回调」，但 `WsHealth` 是 interface 不是 class，状态由 `createWsHealthLogger`
   工厂 + observe 闭包驱动。改为 `createWsHealthLogger(base, { onRecovered })` + `everHealthy` 守卫（首连不误触发）；且因该工厂
   在 index 早期（建 ws 时）就调用、而补拉依赖的 sender/store 晚装配，用**晚绑定挂载点**（index 里 `let onWsRecovered`）避时序坑。
3. **WS-4 补拉 chat_type（对抗审查 C7，important）**：`im.message.list` item 不带 chat_type，adapter 默认 'group' → p2p probe
   离线消息被 handleIncoming 群门丢弃。**修**：`thread_claims` 加 `chat_type` 列，claimThread 存、补拉时 `managedChatType` 读回、
   按真实类型 reshape。
4. **WS-9 命名避红线**：feishu 层（card.ts/progress-cards.ts）是 kernel 中性层，架构守卫禁 `\b(workitem|assignment|worktype|phase)\b`
   独立词。`buildWorkitemQuestionCard`/`workitemId`（驼峰无词界）本身安全，但注释里的独立词「workitem run」「worktype」被逮 →
   改「managed run」「需求侧」。WS-10 同样命中两次（commands.ts / card.ts 注释），已改。
5. **WS-7 §7.5（交付群改名/最终总结）未做**：方案标「可选低优先，做不动就跳过并记要」——跳过。`sender.updateGroupName` +
   `runDone` 改群名前缀未实现。
6. **入站 at-least-once 取舍未改**（WS-4 对抗审查 C2/C3/C11，均 minor，方案 inbox 设计的固有权衡）：`ingestMessage` 是
   record→handle→mark，handle 抛错则不 mark → 只靠**重启时的 replayInbox** 重试（非进程内周期重试）；崩溃窗口（handle 已写
   DB 副作用、mark 前被硬杀）重放非幂等 → managed 追问可能双注入、bridge 任务可能双派发。**为「必达」选 at-least-once 而非
   at-most-once（丢消息）**，是刻意取舍，未加死信队列/幂等去重（见 live 半）。
7. **WS-3 §3.2 可选项未做**：「管控台 resolve 后把旧卡 patch 成『已处理』」跳过——方案标为可选（成本低就做、
   写不进就跳过并注明），此前落地记要漏记，现补记为跳过（审查修复 D2）。
8. **WS-1 §1.4 超限日志降级 warn→info**：方案写「保留 warn」，实现改为 `logger.info` 并换了文案——补派逻辑
   成熟后，「超 worker 并发上限」从缺口告警变成正常补派流程的一部分（parked 行由后续补派吸收），降级为 info
   是有意为之（审查修复 D2）。

### 留下的 live 半（诚实标注，未美化）

- **入站 at-least-once**（上条）：无死信队列——确定性失败的「毒消息」会在每次重启被 replayInbox 重试一遍（`listInboxUnprocessed`
  已改游标循环 drain 全部、跨过失败行防死循环，但毒行永不清、inbox 单调增长，极端场景待观察）；崩溃窗口重放非幂等。**后续增强**
  可做：`injectHumanMessage` 按 feishuMsgId 幂等去重 + 未处理行重试计数→死信。
- **飞书 form 多 submit 按钮真机未验**（WS-5）：一个 form 里放 2~3 个 submit 按钮各带独立 `behaviors.value`——`buildQuestionFormCard`
  已证单 submit 可行（value + form_value 同回传），但多 submit 各自 value 是否都到达**需真机确认**（runbook 项 3）。不行则启用
  方案 §5.1 回落（通过=form 外 callback、打回=form 内唯一 submit）。
- **im.message.list 字段形状真机未验**（WS-4）：`adaptListMessageToEventData` 按「list item 用 msg_type/body.content/sender.id/
  mention.id（字符串）」拍成推送形状，是按 SDK 类型 + `getMessage` 既有解析推的，**真机需验**（尤其 create_time 单位 ms/s、
  p2p 会话 chat_type）。2000 条（40 页×50）/单次翻页上限已加告警（不静默截断）。
- **交付 diffstat 依赖 worktree 存活**：GC 删了 worktree 后 `deliver_manifest` 只能给占位串；清单在灯③ 前生成、GC 在终态 7 天后，
  时序上不冲突，但重跑（recovery:'rerun'）时若 worktree 已被并发清理会降级——可接受。

### 对抗式代码审查记录

- **WS-4**：用 workflow 编排 5 维度对抗审查（找→逐条证伪），12 confirmed / 4 refuted。修 C7（important，p2p 补拉）+ C1/C5/C8/
  C4-C12（minor）；C2/C3/C11（at-least-once）记为取舍。
- **WS-5**：审查 workflow 的 5 个 subagent **全部因账号 session limit 报错未跑成**（`confirmed:[]` 不等于通过，是没跑起来！）。
  改在主线亲自审：修「卡片双击双注意见」（加 wait-open 守卫）；其余高风险点（卡片 value 经 parseCardAction 不丢 / 路由零回归 /
  effect 幂等 / 链路 e2e）逐一核对通过。**教训：限流时看 failures/agents_done，别把 confirmed:[] 当通过。**

### 手验 runbook

见附录 B（已按实现更新为可照做版本）。本 session 未跑真机（需飞书凭据 + 测试群），全部靠 738 单测 + e2e 覆盖；真机项清单见
附录 B 各项的「真机验证点」标注。

至此 WS-0~WS-10 全部落地。

