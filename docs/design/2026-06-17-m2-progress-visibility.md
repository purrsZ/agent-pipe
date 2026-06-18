# M2 进度可见性：probe 运行中流式反馈

日期：2026-06-17
状态：已落地（审核修正 P0/P1/P2 后实现，313 测试绿、`npm run check` 全通过）
上游：`docs/design/2026-06-17-m1b-wrapup.md` §7（下一步方向）；`docs/design/2026-06-16-m1b-wi6-outbound-report.md`（WI-6 出站报告）
前置：M1b 全部落地 + 手验暴露的 thread 锚定 / 心跳 / ws 三笔修复已 commit（300 测试绿）

---

## 0. 背景与目标

M1b 手验暴露：probe 单轮运行（Claude 从 spawn 到出报告的几十秒~几分钟）期间，飞书侧**没有任何中间反馈**——锚点卡停在 `looking`，体感「发出去 → 死寂 → 突然出报告」，多次被误以为卡死。M1b 刻意把「运行中流式反馈」划到边界外（wrapup §3），现在补上。

**目标**：probe（及未来任意 solo worktype）运行中，飞书 thread 下有一张**实时流式卡**，显示「调查中 · 计时 · 工具调用次数 · 当前动作 · 流式正文」；跑完这张卡原地 `updateCard` 成报告卡（或失败时成错误卡）。计时在长思考/长 Bash 静默期也持续走表，消灭「卡死」错觉。

**非目标**：卡片交互按钮（回调原语，仍属 M2 之后）；锚点卡形态变更；桥（bridge）行为变更。

---

## 1. 现状（可复用的地基）

| 件 | 锚点 | 复用方式 |
|---|---|---|
| `StreamingCard` 节流流式卡 | `src/feishu/stream-card.ts` | **直接复用**。已含：900ms leading+trailing 节流；5s 时钟心跳（静默期计时也走表，正解「思考期冻住」）；单飞 PATCH 防乱序；签名去重；`await stop()` 保证终态卡落最后。借鉴 ai-sentinel StreamUpdateController。接口 `onToolUse(name)/onText(fullText)/stop()` |
| 桥的流式用法范式 | `src/index.ts` `runOneTurn`（:257-326） | 参照：`处理中卡 replyCard → new StreamingCard → pool.send(callbacks) → streaming.stop() → updateCard(结果卡)`。一张卡走完一轮 |
| run-handler 的真 agent 流 | `src/worktypes/agent-run/run-handler.ts` | 现仅接 `onActivity`（WI-9 心跳）。`onText/onToolUse` 未接（M1b 边界）——本设计接上并转发 |
| WI-6 报告回贴 | run-handler `deps.onReport`（:106，成功路径）→ index `postReport`（:809）`replyCard(threadRoot, 报告卡)` | **并入**本设计的 `onRunEnd(success)`，报告卡改由流式卡原地收尾 |
| WI-7 出站状态桥 | index `postStatus` observer（:834）：失败错误卡 `replyCard` + 锚点卡 `updateCard` | **失败 replyCard 去掉**（流式卡自己收尾成错误卡）；**锚点失败态刷新保留** |
| thread 反查 | `store.getThreadRootByOwner(workitemId)`（WI-8 后 = 话题真根） | 流式卡 `replyCard(threadRoot)`，与 postReport 同源 |
| 卡片模板 | `src/feishu/card.ts` `buildStreamingCard / buildReportCard / buildErrorCard`（+本设计新增 `buildCancelledCard`） | 流式期 buildStreamingCard，终态 buildReportCard / buildErrorCard / buildCancelledCard |

---

## 2. 架构决策（方案 A：独立进度卡组件 + run-handler 中性回调）

run-handler 在 `worktypes/` 层，**不得 import feishu**（架构守门）。沿用 WI-6 `onReport` 的「回调注入」模式，但因进度卡逻辑（StreamingCard 生命周期 + per-run 卡 id 映射 + 三种终态）复杂度高于单点回调，独立成可单测组件：

- run-handler 暴露**中性** `RunProgressSink`（`onRunStart/onText/onToolUse/onRunEnd`，纯数据、零飞书类型）。
- 新建 `src/feishu/progress-cards.ts` 的 `ProgressCards` 实现该 sink，内聚管理 per-run 的 `StreamingCard` 与卡 id 映射。
- index 装配时注入：`createAgentRunHandler({ …, progress: progressCards })`。

**否决方案 B（index 内联闭包）**：会把 per-run StreamingCard 映射堆进已 800+ 行的 index 装配，分散难测。

**守门**：`run-handler.ts` 在 worktypes 层（可用 assignment 等词）。`src/feishu/` 在架构守门 `layerFor` 里归 **kernel 层**，故 `progress-cards.ts` 受两条约束：① kernel 不得 import worktypes/workitems → **不显式 `implements RunProgressSink`**，改用结构（鸭子）类型，由 kernel-exempt 的 index.ts 在装配处（`progress: progressCards`）做编译期校验；② 文件内（含注释）不得出现 `workitem`/`workitems`/`assignment`/`worktype`/`phase` 完整词 → 字段名避开 `workitems`（依赖收敛为 `threadLookup`，见 §3.3），`assignmentId`/`workitemId`/`getWorkItem` 因词边界安全。中性 sink 字段（assignmentId/workitemId/title/chatId/fullText/toolName/outcome）天然规避业务词守门。

---

## 3. 设计

### 3.1 RunProgressSink（run-handler 暴露的中性回调）

```ts
// src/worktypes/agent-run/run-handler.ts （或同层 types）
export interface RunProgressSink {
  // chatId：threadRoot 缺失时的发卡回落目标。由 run-handler 从 workitem.source 提取后随
  // onRunStart 携带，避免 feishu 层组件反向依赖 workitems（见 §2 守门）。
  onRunStart(info: { workitemId: string; assignmentId: string; title: string; chatId?: string }): void;
  onText(info: { assignmentId: string; fullText: string }): void;
  onToolUse(info: { assignmentId: string; toolName: string }): void;
  onRunEnd(info: {
    assignmentId: string;
    outcome: 'success' | 'failed' | 'aborted';
    report?: string; // outcome=success 时为 result.fullText（并入 WI-6 onReport）
    error?: string;  // outcome=failed 时为错误摘要
  }): void;
}
```

`AgentRunDeps` 把现有 `onReport?` 替换为 `progress?: RunProgressSink`（onReport 是 `onRunEnd(success)` 的特例，并入）。全部可选——不注入 progress 时 run-handler 行为与今日逐字节一致（**不关心出站的**测试夹具零改）。注意：现有注入了 `onReport` 的 WI-6 run-handler 单测因字段更名（onReport → progress）**编译即失败**，必须改成注入 `progress`（见 §5.2/§5.4），不在「零改」之列。

### 3.2 卡片生命周期（数据流）

```
run-handler.run(ctx):
  asg = ctx.assignment
  progress?.onRunStart({ workitemId: workitem.id, assignmentId: asg.id, title: workitem.title })
  callbacks = {
    onActivity: () => ctx.heartbeat(),                                   // WI-9 心跳（不变）
    onText:    (_id, full) => progress?.onText({ assignmentId: asg.id, fullText: full }),
    onToolUse: (_id, t)    => progress?.onToolUse({ assignmentId: asg.id, toolName: t.name }),
  }
  result = await pool.send(task, prompt, callbacks, options)
  if (ctx.signal.aborted) { progress?.onRunEnd({ assignmentId: asg.id, outcome: 'aborted' }); return }
  if (result.error)       { progress?.onRunEnd({ assignmentId: asg.id, outcome: 'failed', error: result.error }); throw … }
  ctx.writeArtifact(report.md, result.fullText)                          // 不变
  progress?.onRunEnd({ assignmentId: asg.id, outcome: 'success', report: result.fullText })

ProgressCards（feishu 层）：维护 Map<assignmentId, Entry>
  type Entry = { ready: Promise<void>; cardId: string | null; streaming: StreamingCard | null; title: string }

  onRunStart  → entry = { ready: <下方>, cardId: null, streaming: null, title }
                map.set(assignmentId, entry)                              // ★同步占位：先于任何 onText/onRunEnd 落 Map
                entry.ready = (async () => {                             // 发卡是异步的，但 Map 已就位
                  threadRoot = kernelStore.getThreadRootByOwner(workitemId)
                  cardId = threadRoot ? await sender.replyCard(threadRoot, buildStreamingCard(title,'claude',初始态))
                                      : await sender.sendCard(chatId, …)  // 同 postReport 的回落
                  if (cardId) { entry.cardId = cardId
                                entry.streaming = new StreamingCard(sender, cardId, title, 'claude') }
                })()                                                      // fire-and-forget，但句柄存进 entry.ready
  onText      → map.get(assignmentId)?.streaming?.onText(fullText)        // 发卡未就绪时 streaming=null；onText 是全量快照，后续帧自愈无损
  onToolUse   → map.get(assignmentId)?.streaming?.onToolUse(toolName)     // 同上；发卡窗口内的 toolUse 计数会少算（§4.2 已知边界）
  onRunEnd    → entry = map.get(assignmentId); if (!entry) return
                try {
                  await entry.ready                                       // ★P0：等发卡落地，消灭「run 结束早于发卡」竞态——终态卡绝不丢
                  if (entry.streaming) await entry.streaming.stop()       // 等净 in-flight PATCH
                  if (entry.cardId) {
                    const card = outcome==='success' ? buildReportCard(entry.title, report)
                               : outcome==='failed'  ? buildErrorCard(entry.title, error)
                               : buildCancelledCard(entry.title)          // grey「调查中断 · title」，与报告/失败卡同构
                    await sender.updateCard(entry.cardId, card)
                  }                                                       // cardId=null（发卡失败）：该轮无流式卡，仅靠锚点（§4.2）
                } finally { map.delete(assignmentId) }                    // ★放 finally：stop()/updateCard 异常也不泄漏 entry
```

`StreamingCard` 自身只负责「流式期间的节流刷新」；**终态卡由 `ProgressCards.onRunEnd` 在 `stop()` 后 `updateCard` 写入**——与桥 `runOneTurn`（stop 后 updateCard 结果卡）完全同构。

### 3.3 ProgressCards 组件依赖

```ts
new ProgressCards({
  sender: Pick<Sender, 'replyCard' | 'sendCard' | 'updateCard'>,
  threadLookup: Pick<Store, 'getThreadRootByOwner'>,   // 仅 thread 反查（kernel Store，同层 import）
  logger,                                              // 可选 { warn?, error? }
})
```

> 实现校正：原设计让 ProgressCards 注入 `workitems: { getWorkItem }` 取 source.chatId 回落 + title
> 兜底。但 `src/feishu/` 在架构守门里归 **kernel 层**（layerFor），受 ① kernel 不得 import
> worktypes/workitems、② 文件内（含注释）不得出现 `workitem`/`workitems`/`assignment`/`worktype`/`phase`
> 完整词 两条约束——字段名 `workitems` 正是完整词，会触发守门。故收敛：**title 与 chatId 都改由
> onRunStart 携带**（run-handler 在 worktypes 层从 workitem.source 提取 chatId），ProgressCards 只
> 留 sender + threadLookup（kernel Store，getThreadRootByOwner 用 Owner 中性命名）+ logger，彻底
> 甩掉 workitems 依赖。`assignmentId`/`workitemId`/`getWorkItem` 因词边界（`\bworkitem\b` 不匹配
> `workitemId`）安全。

异步 IO 全 fire-and-forget + try/catch（同 postReport/postStatus），任何飞书失败只 log、不影响 run。

### 3.4 与 WI-6 / WI-7 的协调（动已验证出站，明确写清）

| 出站 | 改动 | 理由 |
|---|---|---|
| WI-6 `onReport`/`postReport` | **移除**：报告卡不再独立 replyCard，改由流式卡 `onRunEnd(success)` 原地 updateCard 成 buildReportCard | 合并成一张卡（用户已选）；thread 不再每轮双卡 |
| WI-7 `postStatus` 失败 replyCard（错误卡） | **去掉** `reply` 分支的错误卡 replyCard | 流式卡 `onRunEnd(failed)` 已原地收尾成错误卡，避免重复 |
| WI-7 `postStatus` 锚点失败态 updateCard | **保留** | 锚点卡=工作项总状态，仍需刷成 failed（与流式卡分工） |
| `anchorAction` 纯函数 | `run_failed && terminal` 的 `reply` 改为 `false`（不再发错误卡，只 `update` 锚点） | 失败回贴归流式卡；锚点刷新归 observer |
| 锚点卡（蓝卡）本体 | **完全不变** | observer 照旧刷 looking/idle/failed |

> 协调后职责一刀切：**锚点卡 = 工作项总状态（observer 驱动）**；**流式卡 = 每轮 run 的过程 + 结论（ProgressCards 驱动）**。两者各有唯一负责人，不重叠不抢消息。

---

## 4. 边界

### 4.1 明确不做
- ❌ 卡片交互按钮 / 回调原语（M2 之后）
- ❌ 锚点卡形态变更（只协调失败态归属，卡面不动）
- ❌ 桥 `runOneTurn` 行为变更（它本就有流式，本设计只给 workitems 补齐）
- ❌ 为每个 phase_changed 单独发卡（流式卡按 run 生命周期，不按事件）

### 4.2 已知边界（接受）
- **多轮 = 多张流式卡**：每轮 run 一张（thread 下 replyCard 累积成对话历史），符合「无状态轮」模型。锚点卡仍是唯一总状态卡。
- **run 结束早于发卡（竞态，已治）**：onRunStart 异步发卡尚未落地时 run 已结束（如 `pool.send` 极快失败：二进制缺失 / cwd 非法 / 并发槽拒绝）。对策见 §3.2：onRunStart **同步** `map.set` 占位、发卡句柄存 `entry.ready`，onRunEnd **`await entry.ready`** 再收尾——终态卡绝不丢、不留「处理中」孤儿。副作用：发卡窗口（约 200~500ms）内到达的 onToolUse 因 streaming 尚未就绪而计数少算（onText 全量快照自愈无损）；run 通常几十秒、窗口内 toolUse 极少，接受。
- **同进程重派孤儿（可清理，先不做）**：recoverRun 在**不崩溃**时作废重派新 assignment（WI-9 canResume=false）→ 新 assignmentId → 新流式卡；旧 entry 仍在内存 Map。可在 onRunStart 时按 workitem 清理同源悬挂 entry（把旧卡 patch 成「已重试」），增量优化、先不做。
- **跨崩溃孤儿（M2 不修，如实记录）**：进程崩溃重启后内存 Map 全丢，旧流式卡的 cardId 无从寻回，onRunEnd 再不会作用于它——它**永久停在「处理中…」蓝卡，视觉上等同卡死**（恰是本设计要消灭的错觉，在崩溃边角复现）。崩溃恢复会重派新 assignment 产出新卡正常收尾，故 thread 里会并存一张孤儿「处理中」+ 一张正常完成卡。根治需持久化 cardId 让重启后能收尾，超出 M2 范围；M2 接受此边角、仅在此记录，**不掩盖为「无害」**。
- **拿不到 threadRoot**：回落 sendCard(chatId)（同 postReport）；updateCard 无回落（需原卡 id），onRunStart 发卡失败则该轮无流式卡、仅靠锚点（log 一条）。

---

## 5. 验收 / 测试

1. **ProgressCards 组件单测**（fake sender + fake store）：
   - onRunStart → replyCard 流式卡、记 cardId；threadRoot 缺失 → 回落 sendCard。
   - onText/onToolUse → 喂对应 StreamingCard（断言 updateCard 被节流调用）。
   - onRunEnd success → stop + updateCard(报告卡)；failed → 错误卡；aborted → `buildCancelledCard` 中断卡；entry 清除。
   - **run 结束早于发卡（P0 竞态）**：onRunStart 的 replyCard 用一个未决 promise 卡住 → 立即 onRunEnd(success) → 断言 onRunEnd 先 `await entry.ready`（发卡落地）再 updateCard 终态卡（终态卡不丢、不留「处理中」孤儿、entry 清除）。
   - 未知 assignmentId 的 onText/onRunEnd → 安全 no-op。
2. **run-handler 单测**：注入 fake progress，断言 onRunStart/onText/onToolUse/onRunEnd 序列与 outcome（success/failed/aborted 三分支）。
3. **probe-e2e 扩**：一轮 run 走「onRunStart → 流 → onRunEnd(success)」；锚点卡仍 observer 刷 idle、不再额外报告卡。
4. **WI-6/7 回归调整**：报告/失败不再 replyCard 新卡（index-wiring grep 改：`postReport` 移除、postStatus 失败分支去 reply）；`anchorAction` 失败分支 `reply:false` 单测更新。
5. `npm run check` 全绿；架构 + index-wiring 守门通过；既有 300 测试零退（除 4 处预期调整）。

---

## 6. 决策台账

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 进度形态 | 复用桥 StreamingCard 流式卡（计时/工具/当前动作/流式正文） | 体验与桥一致；节流/思考期心跳/限频/去重全有现成 |
| D2 | 流式卡 vs 报告卡 | 合并成一张（流式卡 onRunEnd 原地 updateCard 成报告/错误/中断卡） | thread 干净；贴合桥 processing→result |
| D3 | 架构 | 独立 `ProgressCards` 组件 + run-handler 中性 `RunProgressSink` | 可单测、不臃肿 index、边界干净（维护者授权「对研发友好就用」） |
| D4 | WI-6/7 协调 | 报告卡/失败卡归流式卡原地收尾；锚点失败态归 observer 保留 | 各有唯一负责人，不重叠 |
| D5 | 多轮 | 每轮一张流式卡 | 符合无状态轮；锚点卡是唯一总状态 |
| D6 | 节流参数 | 复用 StreamingCard 默认（900ms/5s 心跳） | 已在桥经生产验证，不另调 |

---

## 7. 改动点清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/worktypes/agent-run/run-handler.ts` | 新增 `RunProgressSink` 接口；`AgentRunDeps.onReport` → `progress?: RunProgressSink`；run() 加 onRunStart（含本地 `chatIdFromSource` 从 source 提取 chatId）、callbacks 转发 onText/onToolUse、三分支 onRunEnd（onActivity 心跳不变） |
| 2 | `src/feishu/progress-cards.ts`（新） | `ProgressCards`（鸭子实现 RunProgressSink），管 per-run StreamingCard 生命周期 + 终态卡；占位模式（onRunEnd await 发卡 ready） |
| 2b | `src/feishu/stream-card.ts` | 构造参数 `sender: Sender` 收窄为 `Pick<Sender,'updateCard'>`，让 ProgressCards 传依赖子集无需 cast |
| 3 | `src/index.ts` | 装配 ProgressCards 注入 run-handler（`progress` 替换 `onReport`）；移除 postReport（WI-6）+ 随之清理的 `buildReportCard`/`buildErrorCard` import 与 `chatIdFromSource`/`errorFromPayload` helper；postStatus 失败分支去 reply（保留锚点 update） |
| 4 | `src/feishu/card.ts` | 新增 `buildCancelledCard(title)`（grey「调查中断 · head」，与报告/失败卡同构、三态标题统一）；`anchorAction` 失败分支 `reply:false`（仅 update） |
| 5 | 测试 | progress-cards 单测；run-handler onRunEnd 三分支；probe-e2e 序列；index-wiring/anchorAction 回归调整 |

> 体量：~1 个 commit 量级（新 1 文件 + 改 4 处 + 测试），核心复杂度全在可单测的 ProgressCards。
