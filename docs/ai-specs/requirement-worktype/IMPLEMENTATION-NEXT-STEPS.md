# requirement worktype 实现 — 续作任务计划

> 状态快照（本轮收尾）：按 D-26 开发序，**Stages 1–6 的可实现+可单测核心已落地并提交**。
> 分支 `codex/workitems-m0`，`npm run typecheck` 干净，`vitest` 422 全绿，架构红线（solo 零回归 /
> kernel 中性 / worktype 纯同步）守住。

## 已完成（提交清单）

| commit | 内容 |
|---|---|
| `2fa62ff` | S1 地基：单飞门 role 分流 / inflight 键 per-assignment / 崩溃恢复全量 / 父子链 / countRunningWorkers / v3 迁移 / resolveWait 带 decision |
| `4b459bc` | S2 kernel：write 档+writableDirs+fingerprint+buildClaudeArgs write 分支+write-guard / worktree 生命周期 / onSession / card.action / Owner 预留槽 |
| `bb9cbe9` | S3 worktype 骨架：7-phase + 4 灯关卡（拦截 worktype 侧）+ /cancel + 灯④ |
| `d0dff47` | S4 contract-engine 全量 + worker 纯 helper |
| `671e3da` | S4 worker 写档/worktree 运行策略 + run-handler 可注入 strategyFor |
| `919c666` | S4 集成验证 integration_check effect + 修复循环（round 独立计数 D-11） |
| `56450f2` | S5 知识层（保鲜/选择性注入/git store）+ architecture.ts knowledge 分层 |
| `64aa2c7` | S5 design-phase 升格 + 按端切片 |
| `36ac8a0` | S6 工作台读视图 SSR / HTTP server / 本人鉴权 / adapter |
| `fe1f7ef` | S6 anchorAction 不漂移断言（R24.AC-7） |
| `7f2c868` | index 接线：strategyFor（write worker）+ integration_check handler 注册 |
| `1844761` | **T1** `/req` 触发闭包 + 命令接线（仿 runProbe）：commands onRequirement/handleRequirement（重复 --repo 多端）+ index runRequirement；commands-req 测试 + index-wiring 断言 |
| `7dc62d2` | **T2** 工作台 HTTP server 起停：index 接 createWorkbenchAdapter+createWorkbenchServer；新增 `src/workbench/auth.ts`（createTokenAuth 本人鉴权，Bearer/cookie 常量时比对）；config workbench 块（enabled/host/port/token/operator）；releaseResources 收尾关停；auth 单测+真服务端到端+config 测试 |
| `9048d82` | **T3** 需求灯卡：buildAnchorCard noun 去"调查"化 + buildCheckpointCard/AnsweredCard（通过/打回 callback）；`lights.ts`(灯标签/4灯rail)；index surfaceCheckpoints 推灯卡 + handleCheckpointAction 走 workbenchAdapter.actions.resolve 单写路径；lights/card/wiring 测试 |
| `5bf194c` | **T4** owner 多 worker 聚合：reducer enrichEventForType 注入中性 runningWorkers → worktype "最后一个 worker 才唤醒 owner / owner 完成进 integrate"；over-cap warn surface；worktype 单测 + e2e 慢仓 hold + 三仓告警。⚠️ 补派/批量窗口(R01.AC-9)推迟 |
| _本笔_ | **T5(部分)** 知识选择性注入接线：`knowledge/compose.ts` composeRepoKnowledge + 运行策略 knowledgeFor + index 真 KnowledgeStore 接线；compose/策略/wiring 测试。spec-design run + 冷启索引 run 留 live(Stage 7) |

> 注：`docs/ai-specs/requirement-worktype/` 等设计文档仍未跟踪，按需 `git add docs/`。
> ⚠️ `src/feishu/event-router.ts` 有用户并行的 AskUserQuestion 调试改动（TEMP debug + messageId 取 context），未纳入 T1–T3 提交，留用户处理。

## 续作任务（建议顺序）

### ~~T1. `/req` 触发闭包 + 命令接线~~ ✅ 已完成（`1844761`）
- `runRequirement`（index.ts，kernel-exempt）仿 runProbe：先发锚点占位卡建话题 → `createWorkItem({type:'requirement', repos, ...})` → `claimThread(claimKey,'managed',item.id,anchorMsgId)` → 补全卡。
- `handleRequirement`（commands.ts）：`/req [--repo <path> ...] <需求>`，收集重复 `--repo`（多端）；无 repo 时 index 回退默认 cwd。kernel 中性（解析委托，创建在 index）。
- 出站定位 chatId/threadId/anchorMsgId 写进 `source`（run-handler 的 `locatorFromSource` 消费）。
- ⚠️ 锚点卡暂复用 `buildAnchorCard`，header 仍"调查"字样 → T3 一并去化。

### ~~T2. 工作台 HTTP server 起停接入~~ ✅ 已完成（本笔）
- `src/index.ts`：`createWorkbenchAdapter({ store, artifacts, api })` → `createWorkbenchServer({ data, actions, auth, logger })`，`WORKBENCH_ENABLED` 门控；ws 就绪后 `listen(host, port)`，挂 `'error'` 防 EADDRINUSE 拖垮全局。
- `auth`：新增中性 `src/workbench/auth.ts` `createTokenAuth`——写要本人 token（`Authorization: Bearer` 或浏览器 `wb_token` cookie），常量时间比对；**空 token = 看板只读**。读始终开放（server 仅 POST 调 auth）。
- `config.workbench`：enabled/host(默认 127.0.0.1)/port(默认 7080)/token/operator(默认首个 admin)。`.env.example` 已补。
- 生命周期：server 交给 `createReleaseResources` 先关（停收请求）再拆 store/pool；shutdown + crashGuard 共用。
- ⚠️ 浏览器写需先有 `wb_token` cookie（server 不发 cookie，无 /auth 路由）——真机由内网穿透代理注入或手动设 cookie；Stage 7 走查。

### ~~T3. 飞书灯卡~~ ✅ 已完成（`9048d82`）
- 去"调查"化：`buildAnchorCard` 加 `noun` 参数（默认"调查"）；index `anchorNoun(item.type)` 在 runRequirement/runDone/postStatus 三处按类型传"需求"。
- 灯交互卡：`buildCheckpointCard`（橙卡，通过/打回 callback，value `{kind:'ckpt', itemId, waitId, boundary, approved}`）+ `buildCheckpointAnsweredCard`（已通过/已打回/已处理）。灯标签/4 灯 rail 在 `lights.ts`（worktypes 纯）渲染后传入中性卡。
- 推送：index `postStatus.surfaceCheckpoints` 每个 committed 事件后查 `listOpenWaits` 找新 human checkpoint wait（reducer 先持久化 wait 再 onCommitted，无死锁），推灯卡回贴锚点；in-memory dedup（重启可能重发）。
- 消费：`handleCardAction` 按 `value.kind` 分流 → `handleCheckpointAction` → `workbenchAdapter.actions.resolve`（与看板同一 resolveWait 单写路径，card 带精确 waitId 免查找）→ 终态 patch。`workbenchAdapter` 已提出 enabled-IIFE，板关停仍可消费。
- ⚠️ 灯卡终态 patch 需 `action.messageId`（用户并行的 event-router 修复让 WS 卡片回调能取到 messageId；缺它则跳过 patch，resolve 仍生效）。

### ~~T4. owner 快照批量唤醒（多 worker 聚合）~~ ✅ 已完成（owner fan-in；补派/批量窗口部分推迟）
- 实现路径（避开纯 worktype 不能数 worker 的约束）：reducer `enrichEventForType` 在 apply 内（强一致、closeRunConclusion 之后）把中性 `runningWorkers`（DB status=running∧role=worker）注入给 **onEvent 看的事件副本**——提交/观察事件不变，solo 零回归。
- worktype gate：`PHASE.implement` worker 完成仅当 `runningWorkers===0`（最后一个）才唤醒 owner assess，其余静默等；owner 完成即进 `集成验证`。`PHASE.integrate` 同理——fix 批全部完成才重核 integration_check。`runningWorkersOf` 缺省 0（单 worker / 纯单测向后兼容）。
- 测试：worktype 单测（runningWorkers>0 静默 / ===0 唤醒 / 缺省兼容 / integrate 批门）+ e2e（慢 repo-b 卡住 `并行实现` 不提前推进 → 双 worker 齐了才进 灯③；三仓 over-cap 告警）。460 测试绿。
- ⚠️ **仍开口（R01.AC-9 / R02.AC-3/7）**：>`maxWorkersPerItem`(默认 2) 的仓会被 wakePending **丢弃不补派**——reducer 已加显式 warn surface，workaround：`WORKITEMS_MAX_WORKERS_PER_ITEM ≥ 单需求最大仓数`。完整"批量唤醒窗口 + releaseWakePending 按 role 补派"是 container-concurrency 域剩余的高风险改造（需 wakePending 布尔→spec 队列的 data-model 改），单列后续。

### T5. 设计/知识 agent run（S5 live 半）— 部分完成（选择性注入 ✅；两条 agent run 留 live）
- ✅ **选择性注入接线**（可测核心）：新增 `src/knowledge/compose.ts` `composeRepoKnowledge`（读 4 档 → `assess` 保鲜 → `selectInjection` 预算选择 → `renderInjection`，never-indexed 返 undefined、stale 仍注入但打标）；运行策略加 `knowledgeFor?` 注入函数（worktypes 不 import knowledge 层，由 index 注入真 store）；worker `composePrompt` 仅 worker 取本仓知识喂 `composeWorkerPrompt.knowledge`；index 用真 `KnowledgeStore`+`loadFreshnessPolicy`+`KNOWLEDGE_BUDGET_CHARS` 接线。compose 单测 + 策略注入单测 + wiring 断言。467 测试绿。
- ⏳ **冷启索引 run（knowledge）— 留 live（Stage 7）**：readonly 考古 agent run 填 `map/conventions/runbook/pitfalls` + 写 manifest（`generatedAtCommit`=`currentHeadOf`）。store/保鲜/注入已就绪，缺的是「触发（命令 or 按需）+ agent 真跑 + 输出解析落 4 档」——agent 输出解析是 live、沙箱测不了。
- ⏳ **spec-design run effect（design-phase）— 留 live（Stage 7）**：design 阶段 owner run 跑 spec-design 产 `contract/`+`design/`、emit `design_ready`（事件已被 onEvent 处理）；升格用 `design.ts` 的 `promoteToContract`（已就绪）。缺的是「run 编排 + agent spec-design 输出 → InternalApiEntry[] 解析 → 写 contract.json」——同样是 live 解析。

## Stage 7 — 端到端 + live 手验清单（沙箱测不了，需真机）
- [ ] write 档真 Claude run：fail-closed 探针实测 PreToolUse hook 生效（不过则拒绝 write 档启动）；DEFER-1 Bash 路径残余如实记录。
- [ ] worktree 真切分支 + worker 写代码 + 自测门（两类不绿分流）。
- [ ] 各端 impl 读码对账（integration_check 的 live 扩展，当前对 `contract/impl-claims.json` 静态对账）。
- [ ] 飞书灯卡真机：4 灯按钮 → card.action → resolveWait；3s toast。
- [ ] 浏览器工作台走查（多 agent 对抗式 UX 走查，D-13）。
- [ ] 真双端需求端到端：1 Owner + 后端 + 前端 worker 照合同并行 → 拼起来（项目核心命题）。

## 接线点速查
- run-handler 可注入：`createAgentRunHandler({ ..., strategyFor })`，`RunStrategy` 接口在 `src/worktypes/agent-run/run-handler.ts`。
- worker 写档策略：`createRequirementRunStrategy({ worktreesDir, baseRef? })`（`requirement/worker-handler.ts`）。
- 集成对账：`createIntegrationCheckHandler()`（`requirement/integration.ts`），事件 `integration_check_passed/failed`。
- 工作台：`createWorkbenchServer` / `createWorkbenchAdapter`（`src/workbench/` + `src/workitems/workbench-adapter.ts`）。
- 事件 kind 权威清单：`REQUIREMENT_EVENT_KINDS`（`requirement/phases.ts`），anchorAction 不漂移由 `tests/feishu/anchor-drift.test.ts` 守。
