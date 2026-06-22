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
| _本笔_ | **T2** 工作台 HTTP server 起停：index 接 createWorkbenchAdapter+createWorkbenchServer；新增 `src/workbench/auth.ts`（createTokenAuth 本人鉴权，Bearer/cookie 常量时比对）；config workbench 块（enabled/host/port/token/operator）；releaseResources 收尾关停；auth 单测+真服务端到端+config 测试 |

> 注：`docs/ai-specs/requirement-worktype/` 等设计文档仍未跟踪，按需 `git add docs/`。

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

### T3. 飞书灯卡（`src/feishu/card.ts`，kernel 中性）  ←（下一笔）
- 标题去"调查"化：`buildAnchorCard` 的 `调查 ·` 前缀参数化，或新建 requirement 专用构造器（4 灯 rail / 各端工人 / 决策台账，用 `stage/status` 中性字段）。
- 灯交互卡：button `value` 带 `{workitemId, checkpoint, decision}`（feishu 只塞不解释）。
- card.action 消费侧 adapter（workitems 层）：解释 value → 按 checkpoint 找 open wait → `resolveWait(waitId,{operator,reason,decision})`。kernel 分发侧 `card.action.trigger` 已就绪（S2，`parseCardAction`）。

### T4. owner 快照批量唤醒精化（多 worker 聚合）
- 当前骨架：单 worker 跑通；多 worker 的"全部完成→进集成验证"靠 owner 快照聚合（container-concurrency 批量唤醒窗口 `(lastOwnerRunEffectSeq, currentOwnerRunEffectSeq]` + releaseWakePending owner-workers 补派）。
- owner run handler 收尾时据快照判该批是否齐、是否再派/进 phase（worker-runtime 域）。

### T5. 设计/知识 agent run（S5 live 半）
- spec-design run effect handler（design-phase）：调起跑 spec-design 的 managed run，产物落 `contract/`+`design/`，收尾 emit `design_ready`；升格用 `design.ts` 的 `promoteToContract`。
- 冷启索引 run（knowledge）：readonly 考古 run 填 `map/conventions/runbook/pitfalls`，写 manifest（`generatedAtCommit`）；选择性注入接 `composeWorkerPrompt` 的 `knowledge` 参数。

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
