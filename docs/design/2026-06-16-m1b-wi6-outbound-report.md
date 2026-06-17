# M1b WI-6 补丁：出站回贴桥（report → 飞书）

日期：2026-06-16
状态：已落地（方案 1，279 测试绿，含 probe-e2e 多轮集成测；飞书端到端手验待做）
上游：`docs/design/2026-06-15-m1b-plan.md`（§0.1 ④「产出 report → 回飞书」、§5.1 验收 1）
前置：M1b WI-1~5 已落地（WI-1 已提交；WI-2/3/4/5 在工作区，268 测试绿）

---

## 0. 背景：M1b 计划的拆解缺口

WI-4/5 落地后核查 `/probe` 的端到端闭环，发现**「出站回贴」机制根本不存在**——三处证据：

1. `src/workitems/`、`src/worktypes/` 完全不引用飞书（仅 `api.ts` 有一个 `feishuMsgId` payload 字段名，非调用）。
2. `src/index.ts` 没有任何 workitems 事件订阅（无 `run_completed` 监听 / observer）。
3. `src/workitems/effects.ts` 的 `emit` / `emitRunConclusion` 是**容器内部**事件，没有对外订阅出口。

**后果**：即使 WI-1~5 全做完，用户 `/probe` 的真实表现是——建工作项 ✅ → 回锚点卡 ✅ → 真跑 Claude ✅ → `report.md` 写进 workitems git 仓 ✅ → **report 永远停在仓库里，飞书侧只看到一张不动的锚点卡** ❌。追问（WI-5）能进下一轮，产出同样回不来。

这是计划本身的拆解漏洞：§0.1 与验收 §5.1 都把「产出报告 → 回飞书」列为目标，但 WI-1~5 没有任何一个负责「出站回贴」。计划只设计了**入站**（创建 / 追问）与**内核运行**，漏了**出站**（结果回贴）。本文补 **WI-6**。

---

## 1. 决策：方案 1（run handler 回调）

| 方案 | 做法 | 取舍 |
|---|---|---|
| **方案 1（选定）** | 给 `createAgentRunHandler` 注入可选 `onReport(workitemId, report)` 回调；run handler 写完 `report.md` 后调用。`index.ts` 装配时传入闭包：反查锚点卡 msgId → `sender.replyCard` 回贴到 thread。 | 最小改动，不扩展 M0 容器表面；符合 run handler「通用 agent 运行器」定位（产出 report 后通知产出方，自己不依赖飞书类型）。先打通成功路径。 |
| 方案 2（否决） | 在 effects/容器层暴露结论事件订阅出口（`onConclusion` observer），`index.ts` 订阅 `run_completed`/`run_failed` → 回贴。 | 更通用（成功/失败都能回），但扩展了 M0 容器表面，与计划「最小扩展」立场（连 `readArtifact` 都刻意收着加）有张力。留待 M3 多 Worker 真有多订阅方时再做。 |

**否决方案 2 的核心理由**：容器表面扩展是单向门，一旦加了事件订阅出口就难收回；当前只有「回贴飞书」一个订阅方，用 run handler 回调足矣。

---

## 2. 设计

### 2.1 数据流（成功路径）

```
/probe <desc>  ──runProbe(index.ts)──►
  createWorkItem(source={kind:feishu, userId, chatId, messageId}, repos)
    └─ afterCreate → effects.poke(id)  [fire-and-forget，effects.ts:71]
         └─ (后台异步) probe.onEvent(workitem_created) → dispatch solo run
              └─ agent-run handler.run(ctx): 跑真 Claude → writeArtifact report.md
                   └─ deps.onReport({ workitemId, report })   ◄── 新增
  replyCard(锚点卡) → anchorMsgId
  claimThread(anchorMsgId, 'managed', item.id)

onReport 闭包(index.ts):
  threadRoot = store.getThreadRootByOwner(workitemId)   ◄── 新增反查
  threadRoot ? sender.replyCard(threadRoot, buildReportCard(...))   // 回贴到锚点卡 thread
             : sender.sendCard(source.chatId, buildReportCard(...)) // 回落到会话
```

### 2.2 时序：无生产竞态

`effects.poke` 是 **fire-and-forget**（`drainOne(...).catch()`，effects.ts:71），`createWorkItem` 同步返回后 run 在后台跑（真 Claude 数十秒）。`replyCard`（~百 ms）+ `claimThread`（同步）远早于 run 完成，故 `onReport` 触发时 claim 必已登记，`getThreadRootByOwner` 命中。

**回落兜底**：万一反查不到（极快返回的 fake pool / 异常竞态），用 `workitem.source.chatId` 走 `sendCard`，**绝不丢 report**。

### 2.3 改动点

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/store.ts` | 新增 `getThreadRootByOwner(ownerId): string \| undefined`——按 `owner_id` 反查 `thread_claims`（`owner_kind='managed'`，取最新一条）。kernel 中性词，合规。 |
| 2 | `src/worktypes/agent-run/run-handler.ts` | `AgentRunDeps` 加可选 `onReport?: (info: { workitemId: string; report: string }) => void`；`runAgent` 在成功写完 `report.md` 后调用。abort/失败路径**不**调（只成功路径，§3）。 |
| 3 | `src/feishu/card.ts` | 新增 `buildReportCard(title, report)`——绿色 header「调查报告 · {title}」+ markdown 正文（复用 `MAX_CARD_MARKDOWN` 截断）。kernel 层，避开 `workitem/assignment/worktype/phase` 词。 |
| 4 | `src/index.ts` | `createWorkitemsRuntime` deps 加 `sender`；装配 `createAgentRunHandler` 时传入 `onReport` 闭包 → `postReport(workitemId, report)`：反查 thread root（回落 chatId）→ 回贴。`main()` 调用处传 `sender`。 |

### 2.4 守门注意

- `store.ts` 反查 SQL 用中性词（`owner_id` / `thread_root_id` / `'managed'`），不触发 kernel 业务词守门。
- `card.ts` 的 `buildReportCard` 用中性命名（`title` / `report`），不出现禁词。
- `index.ts` 是 kernel-exempt，但 `postReport` 内**不要**出现 `workitems.*status/phase` 同行或 `status==`/`phase==`（`index-wiring.test.ts` 守门）——`postReport` 只读 `source`/`title`，天然避开。

---

## 3. 边界（明确不做）

- ❌ **失败回贴**（`run_failed` → 飞书错误卡）：M1b 只打通成功路径；失败有 probe 的 retry（maxRetries=1）+ watchdog 兜底，锚点卡暂不更新。失败回贴随方案 2（容器事件出口）一起到下一里程碑。
- ❌ 锚点卡随每轮 `phase` 实时刷新：M1b 回贴 report 卡即可，锚点卡仅在创建 / `/done` 时更新。
- ❌ report 流式回贴：一次性整篇回贴（截断）。

---

## 4. 验收

1. `/probe <desc>` → 锚点卡 → 真 Claude 跑完 → **report 回贴到锚点卡 thread**（飞书手验）。
2. 追问（thread 内发消息，WI-5）→ 下一轮跑完 → 新 report 同样回贴到 thread（飞书手验）。
3. `getThreadRootByOwner` 反查正确：建 managed claim 后能按 owner 反查到 thread root；回落 chatId 路径在反查 miss 时生效（单测）。
4. run handler 成功 → `onReport` 被调且 payload 含 report 全文；abort / 失败 → `onReport` **不**被调（单测，扩展 `agent-run-handler.test.ts`）。
5. `buildReportCard` 渲染 title + report，超长截断（单测，扩展 `card.test.ts`）。
6. `npm run check` 全绿；架构 + index-wiring 守门通过；M1b 既有 268 测试零退。

---

## 5. 后续 / 移交

- **失败回贴 + 锚点卡实时刷新**：随方案 2（容器结论事件订阅出口）一起做；届时可统一 `run_completed`/`run_failed` → 回贴 / 更新锚点卡。
- **回贴目标的健壮性**：当前回落 `source.chatId`；多 thread / 群聊场景的精确回贴在 M2 卡片交互原语时再收口。
