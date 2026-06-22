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

> 注：`docs/ai-specs/requirement-worktype/` 等设计文档仍未跟踪，按需 `git add docs/`。

## 续作任务（建议顺序）

### T1. `/req` 触发闭包 + 命令接线（接 S3 骨架的入口）
- `src/index.ts`：仿 `runProbe`（`index.ts` 内 runProbe 范式）写 `runRequirement`：发锚点占位卡 → `createWorkItem({type:'requirement', repos, ...})` → `claimThread(claimKey,'managed',item.id,anchorMsgId)` → 补全卡。
- `src/bridge/commands.ts`：仿 `onProbe`/`handleProbe` 加 `/req`（dispatch case + 构造器回调），index 注入 `onRequirement`。
- 出站定位（chatId/threadId/anchorMsgId）写进 `source`（run-handler 的 `locatorFromSource` 已消费）。

### T2. 工作台 HTTP server 起停接入
- `src/index.ts`：仿 BackupJob 注入处，`createWorkbenchServer({ data, actions, auth, logger })`，其中 `data/actions` 来自 `createWorkbenchAdapter({ store, artifacts, api })`（已实现，`src/workitems/workbench-adapter.ts`）。
- `auth`：单用户本人校验（参考 ai-sentinel owner 校验）；绑定地址/端口可配（R17.AC-6 内网穿透在外）。
- 起停挂常驻进程生命周期 + `createReleaseResources`。

### T3. 飞书灯卡（`src/feishu/card.ts`，kernel 中性）
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
