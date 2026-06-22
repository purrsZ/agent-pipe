# 需求理解 Q&A — requirement worktype

> 本设计把「实现 requirement 需求开发 worktype（一次到位）」当作一个需求，用 spec-design 方法论产出完整设计。
> 「PRD」= 《实现总纲》`docs/design/2026-06-18-requirement-implementation-overview.md` + 《宏观设计》`docs/design/2026-06-11-workitem-macro-design.md` + 交互原型 `docs/design/prototype-req-flow.html`。
> ⚠️ **特殊说明**：本轮维护者不在场，授权「悬而未决处先按推荐决策走，回来再审」。故下面每个疑问的「回答」是**我替你拍的推荐裁决**，全部汇总进 `决策待审.md` 等你审核；标 🔶 的是影响面较大、最该你复核的。

---

## 轨道
**Full** —— 多模块、多架构级决策、强跨层。

判定依据：
- 预估 Requirement 数：约 24 个（容器 3 + kernel 4 + worktype 核心 ~9 + 知识/交互/异常/数据 ~8）
- 预估 AC 数：≈ 110+
- 跨模块：是（worktypes / workitems 容器 / kernel agents / feishu / 新增 knowledge 层 / 新增 HTTP 工作台）
- 架构级决策：是（reducer 并发模型改造、写权限模型、checkpoint gate 机制、卡片回调原语）

---

## PRD 来源
- 主纲：`docs/design/2026-06-18-requirement-implementation-overview.md`（v1.1，已吸收一轮项目主审查）
- 底层 WHY：`docs/design/2026-06-11-workitem-macro-design.md`（v4 定稿）
- UI 蓝本：`docs/design/prototype-req-flow.html`（「需求批阅台」）
- 方法论：`~/.claude/skills/spec-design/`

## PRD 核心摘要
让 agent-pipe 长出「一个人 + 这套系统 = 一个全栈工程师 + 半个 PM」的能力：一个跨多端多服务的完整需求，人只在 **4 个决策灯**（对齐需求 / 审设计 / 验收 / 提交）出场，其余由系统自治推进。技术上 = **probe 范本放大** + **容器补三件**（多工人并行 / checkpoint gate / isDecisionStale）+ **kernel 补三件**（写权限 / worktree / 卡片回调）+ **全新两层**（对接合同+集成验证 / 知识层 / HTML 工作台）。底座（M0 容器 + M1a kernel 能力 + probe/noop worktype + M2 流式卡）已落地，本次在其上一次性长出 requirement worktype。

---

## 关键疑问清单

### Q1 ✅🔶 拆解维度 × 分支策略：本次只做「按仓拆」？
- **背景**：宏观设计开放问题①/总纲§23①把「按仓拆 vs 按功能竖切」列为必须一起定。竖切要 worktree 隔离 + 串行合并，工作量翻倍。
- **我的理解**：总纲已定调「一仓一 worker、仓内不再拆」。
- **回答（推荐）**：**本次只实现「按代码仓库拆」**，一仓一 worker；同仓多 worker（竖切）不做，但 `AssignmentSpec`/worktree 接口上不堵死（worktree add 已能按 path 隔离，未来放开只需补串行合并）。"对得上"靠对接合同，"踩不到一起"靠各占一仓。
- **理由**：物理隔离（各占一仓）是并行最省心的一致性保证；竖切的串行合并是另一个量级，违背"一次到位但不贪"。

### Q2 ✅🔶 灯②「快慢两拍」如何落到 phase / gate？
- **背景**：总纲§4/§6.2 把「设计契约」拆成 `合同`+`详设` 两 phase，灯②含两个 gate（快审接口合同=并行发令枪 / 慢审各端详设）。但 `checkpoints.requiredBefore: string[]` 一个 phase 边界只能挂一个 gate。
- **我的理解**：倾向"拆 phase"。
- **回答（推荐）**：**拆 phase**——7 phase 序列定为 `理解 → 合同 → 详设 → 拆解 → 并行实现 → 集成验证 → 交付/沉淀`，灯①挂在 `理解→合同` 边界、灯②-快拍挂 `合同→详设`、灯②-慢拍挂 `详设→拆解`、灯③挂 `集成验证→交付`。checkpoint 机制按 phase 边界拦（见 D-）。
- **理由**：复用现成的 `requiredBefore: string[]` 语义（phase 名列表），不引入"独立 checkpoint id"新概念；phase 边界天然对应"该停下来给人看"的节点。

### Q3 ✅ checkpoint gate 的容器机制怎么落（单轨 vs 双轨）？
- **背景**：总纲§6.2 主张"单轨事件模型"——checkpoint 就是 human wait 的一种用法，不另起 `checkpoint_decision` 双轨；拍板 = 扩展 `resolveWait` 携带 `{approved, reason}`。
- **回答（推荐）**：**单轨**。容器在 phase 越界到 `requiredBefore` 边界前自动插一个 `human` wait 拦截；拍板复用 `resolveWait`，input 扩展 `{operator, reason, decision?: {approved, payload?}}`；wait_resolved 事件携带 decision，worktype onEvent 据此推进/回退 phase。不新增并行 inject 方法。
- **理由**：守"单一注入口"（宏观设计反模式）；避免"wait resolved 但 phase 没动 / decision 绕过 wait"的不一致。

### Q4 ✅🔶 Claude 写权限档强度：拦不住 Bash 写盘怎么办？
- **背景**：总纲§14/§23③、宏观§5.2。Claude readonly 现靠 `--disallowedTools 'Write Edit MultiEdit NotebookEdit'`（工具级，拦不住 `Bash` 里的 `>`/`curl`）。写档要"限定写入目录"，Claude 无原生参数。
- **我的理解**：纵深防御——不指望单一参数兜死。
- **回答（推荐）**：**纵深三层**：① `--add-dir <worktree>` 把可写范围声明给 Claude（软约束，引导）；② **PreToolUse hook** 校验 Bash/Write/Edit 的目标路径在 worktree 内、否则 deny（硬约束）；③ worker 跑在专属 git worktree（cwd），凭证不进 prompt、适配器配置路径进 deny。具体 hook 形态在 R04 详设给出可验证方案（不 punt）。
- **理由**：工具级拦截对 Bash 无效是真问题；hook 是 Claude 现有机制里唯一能做"路径级硬拦"的点。详见 D-/R04。

### Q5 ✅ isDecisionStale 真实现：怎么判 stale 不脆弱、不下沉 LLM？
- **背景**：总纲§6.3/§23②。纯函数易退化成脆弱规则；reducer 里不能调 LLM。
- **回答（推荐）**：以**契约结构化比对**为主——`isDecisionStale(decision, eventsSince)` 判：decision 基于的 contract 版本号是否变、或 eventsSince 是否含触及同一 repo 集合的 `contract_change_applied`。与 §8 的契约变更判定**共用同一套 contract 结构 diff**（一石二鸟）。不在纯函数里调 LLM；若未来确需语义判断，下沉为异步 effect。
- **理由**：契约是结构化的（字段/提供方/调用方），diff 可机械化；共用 diff 避免两处各写脆弱规则。

### Q6 ✅ 集成验证形态：契约测试框架 + 静态对账怎么做？
- **背景**：总纲§10/§23④、宏观§13⑥。倾向先做静态符合性 + 契约测试，真实联调列可选增量。
- **回答（推荐）**：代码层两件——① **各端契约测试结果汇总**（契约测试**由独立角色/从冻结合同机械生成**，实现 worker 不许碰，见 R13）；② **跨端静态对账**：以"读各端实现 vs 合同逐条核"的 AI effect（`integration_check` kind）产出差异报告。契约测试框架**不锁定具体框架**，按各 repo `runbook` 的既有测试命令跑（worker 用该 repo 的测试栈写）。真实联调（拉各端分支起服务）= 人上、非每需求标配。
- **理由**：静态 + 契约覆盖大部分跨端错配，成本低；联调工作量差一个数量级，按需。

### Q7 ✅ Owner 重建税：每次唤醒从结构化状态冷重建，大需求下成本/判断衰减？
- **背景**：总纲§5/§23⑤。Owner 状态以结构化为权威、journal 为辅；每次唤醒从机械生成的"现状快照"重建。
- **回答（推荐）**：**结构化快照为权威输入**（events/assignments/contract/open waits 机械生成），journal 降为人类可读叙事补充、非真相源；冲突 → 结构化优先。重建税**第 7 步端到端时埋点观测**（记每次 owner run 的 token/输入规模），不预先优化。
- **理由**：与 P3"状态在服务侧"一致；先有数据再谈优化，避免过早抽象。

### Q8 ✅ 知识层冷启质量 / 保鲜阈值？
- **背景**：总纲§15/§23⑥、宏观§7。
- **回答（推荐）**：每 repo 一次性索引任务生成初版（与 spec-design"代码考古"产物对接复用）；`_system/` 人+agent 访谈式整理。保鲜：知识文件锚定生成时 commit hash，消费时检查 HEAD 偏离超阈值标 stale 触发重建。**阈值先给经验默认（如偏离 > 200 commits 或 > 30 天标 stale），可配置**，第 7 步实测校准。知识**选择性注入**（按 assignment 关联 repo，有上限）。
- **理由**：知识跟 repo 走不跟工作项走（独立一层）；阈值是可调参数，不值得设计期纠结。

### Q9 ✅🔶 worker 崩溃恢复策略：能照搬 probe 的 `canResume:()=>false` 吗？
- **背景**：考古发现 agent-run handler `canResume:()=>false`（readonly 幂等、崩溃直接 redispatch）。worker 走 write 档已改盘（非幂等），redispatch 重跑会**污染 worktree / 重复改动**。
- **我的理解**：必须重新论证，不能照搬。
- **回答（推荐）**：worker run `recovery='resume-or-redispatch'`，`canResume` 查 `agentSessionId` 是否可续 + **worktree 是否已有未提交改动**：能 resume 则续；不能则**先 `git worktree` 重置/丢弃该分支半成品再 redispatch 新 assignment**（replaces 链），不在脏 worktree 上盲目重跑。
- **理由**：写档非幂等是真风险；崩溃恢复必须保证 worktree 回到干净基线再重派。详见 R12/R24。

### Q10 ✅ inflight Map 重构：键从 workitemId 改 assignmentId？
- **背景**：考古确认 `EffectRuntime.inflight: Map<workitemId, 单inflight>` 是真并行最大障碍，effects.ts 内 6+ 处依赖"一 workitem 一 inflight"。
- **回答（推荐）**：**键改 `assignmentId`**（值 = {effectId, controller}），连带改 poke/drainOne 守卫、findInflight 反查、executeEffect finally delete、recoverRun/recoverRunning 的 `inflight.has` 早退。owner run 仍单飞（靠 reducer 单飞门按 role 分流，不靠 inflight 键），worker 受 `WORKITEMS_MAX_WORKERS_PER_ITEM` 上限。
- **理由**：per-assignment 是真并行 + per-assignment abort（不误伤其它 worker）的物理前提；保留 per-workitem 键无法真并行。

### Q11 ✅🔶 修复/返工循环计数：复用 `assignment.retries` 还是独立？
- **背景**：考古发现 `retryBudget` 默认 1、全局共用于 watchdog stall 路径。总纲的"集成验证修复 2 轮""接口改 2-3 次举手"若复用 `assignment.retries` 会与 stall 重试串味。
- **回答（推荐）**：**独立计数**——集成验证修复循环、契约同接口反复改，各用 workitem 级独立计数器（存 `context_json` 或专用事件统计），不复用 `assignment.retries`（那是 stall 重试预算）。
- **理由**：两种"重试"语义不同（活性卡死重启 vs 语义返工），混用会让一处调参误伤另一处。

### Q12 ✅ 卡片按钮回调：要不要起 HTTP server？
- **背景**：考古发现飞书事件纯 ws（无 HTTP 回调端点）。卡片 action 回调可走 ws `EventDispatcher` 加事件键。
- **回答（推荐）**：**走 ws，不起 HTTP server**——在 `EventDispatcher.register` 加 `card.action.trigger`（之类）事件键即可；kernel/feishu 层只分发 **raw card action**（value 当不透明 payload 透传），不解释 `workitemId/checkpoint`，由上层 workitems adapter 解释。HTML 工作台的读视图另起轻量 HTTP（见 Q13），与卡片回调是两条线。
- **理由**：ws 已有、改造面小；守 kernel 红线（feishu 层不出现业务词）。

### Q13 ✅🔶 HTML 工作台：常驻进程内挂 HTTP，单文件 vs 多视图？
- **背景**：总纲§16/§17 要工作台读视图 + 事件回流写 API。用户补充："原型可细化/扩展，不必挤一个 HTML，可拆多文件；交互细节多派子 agent 走查找低级/不易用场景。"
- **回答（推荐）**：agent-pipe 常驻进程内挂**轻量 HTTP 服务**（Node 自带 http，不引前端框架），SSR `/workitem/<id>`。**原型从单文件 mock 扩成"按视图/路由拆分的多页"**（看板 `/`、工作台 `/workitem/<id>`、审设计 `/workitem/<id>/review`），共享样式/脚本。第 8 步**派多个子 agent 对抗式走查交互**，产出"低级/不易用场景清单"再迭代原型。
- **理由**：读视图复用现成 SQLite + artifact，不另起炉灶；多页拆分让每个交互场景可独立打磨；多 agent 走查是用户明确要求的质量手段。

### Q14 ✅ MR/上线纪律：多少写进 prompt 自律、多少代码兜？
- **背景**：总纲§11/铁律5。ai-sentinel 血泪：AI 自主开 MR 会误触发飞书研发任务节点。
- **回答（推荐）**：**写代码、提交自分支**自动；**开 MR/上线必须人亲手点**（灯④硬拦：系统只到"分支就绪 + 给出 MR 草稿/发布顺序"，开 MR 的动作不自动执行）。平台纪律（feature 基于 prod、`pull --ff-only`、MR 首行 `rd:<id>`）**少量高危用代码/hook 拦，大量靠 prompt 自律 + 写明 why**（沿用 ai-sentinel 经验）。
- **理由**：最危险那一下留给人（铁律5）；过度代码化平台纪律性价比低。

---

## 其他约定（设计过程中达成的零散共识）

- **向后兼容是红线**：容器改造后 probe/noop 行为逐字节不变（CI 回归），requirement 专有逻辑一律留在 `src/worktypes/requirement/`，不漏进容器层。
- **kernel 中性**：kernel 新增能力（写权限/worktree/卡片回调/优先级）必须"对纯飞书桥用户也有意义"，不得出现 `workitem|assignment|worktype|phase` 业务词（CI 强制）。
- **只用 Claude runner**：Codex 未接入；写权限、集成都按 Claude 路径设计。
- **单需求闭环**：本次只保证单需求端到端；多需求并行不做但 `maxOpen`（默认 3）准入上限保留、不堵死。
- **artifact 仓 ≠ worktree**：报告/契约/brief 进 `$DATA_DIR/workitems/<id>/` artifact git 仓；代码改动进 worker 的目标仓 worktree（cwd）。两套路径严格分开。
- **契约测试独立性**：跨端契约测试必须独立于实现 worker（从冻结合同机械生成或独立质检员产出），否则"绿"只证自洽不证对合同理解对。

---

## Sensor 1: PRD 准确性抽查

_本需求的"PRD"是项目自有设计文档（非外部飞书 PRD），抽查方式 = 把关键理解回到总纲/宏观原文逐条对照。_

### 抽查 1：4 灯位置
- **我 qa 里的理解**：灯①对齐需求（理解后）、灯②审设计（快慢两拍）、灯③验收（集成验证后）、灯④提交（开 MR 人点）。
- **原文（总纲§4 表）**：完全一致——灯①理解后 / 灯②设计契约后快慢两拍 / 灯③集成验证后 / 灯④提交时开 MR 人点。
- **偏差**：无。

### 抽查 2：容器改造"三件 + 红线"
- **我的理解**：多工人并行（reducer 单飞门 + effect 多 inflight + abort 粒度三层）、4 灯 checkpoint gate、isDecisionStale，且改造保持 probe/noop 不变、容器不出现 `phase===`/`switch(phase)`。
- **原文（总纲§6 + §22）**：一致——§6.1 明确"三层协同"、§6.2 checkpoint gate、§6.3 isDecisionStale；§22 红线"容器不解释 phase""probe/noop 不回归"。
- **偏差**：无。

### 抽查 3：写权限两层分叉
- **我的理解**：workitems 层 `PermissionProfile` 已 `readonly|write`，agents 层仍 `full|readonly`（`'write'` 未实现），需对齐 + 映射。
- **原文（总纲§14 + 代码考古）**：一致并经代码核验——`workitems/types.ts:88` = `readonly|write`，`agents/types.ts:98` = `full|readonly`（注释 `'write' lands in M2`）。
- **偏差**：无。

✅ Sensor 1 通过（2026-06-18，基于总纲 v1.1 + 代码考古核验，41 条断言 0 refuted）
