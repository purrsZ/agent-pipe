# Domain: worker-runtime

> 工人执行运行时 —— requirement worktype 里把"领活→写代码→自测→交活"跑通的那一层。是 probe `agent-run` run handler 的放大版（换 prompt + 换权限档 + 换 cwd + 加自测硬门 + 加非幂等恢复），并往上长出三件 probe 没有的事：跨端契约测试独立生成、集成验证（代码层 AI 兜底）、前端 UI 特殊处理。最后收口到交付物（契约 + 决策 + N PR + 发布顺序 + 沉淀）。

## 领域职责（负责什么/不负责什么）

**负责**：
- worker run handler：照 [createAgentRunHandler 工厂](../codebase-findings.md#res-createagentrunhandler) 改写三处（prompt 去"只读不改"系统句、write 档、worktree cwd），加"自测硬门""非幂等崩溃恢复"。
- 自测硬门（绿了才交活）：跑绿 ①跨端契约测试 ②本端单测 + 类型/编译；区分"测试执行失败（断言红）"vs"测试无法执行（命令缺失/环境/编译基础设施）"两类结局。
- 跨端契约测试的**独立生成**（机械生成为主 + 质检员补语义用例）、存放（`contract/tests/`）、产出时机（灯②冻结后即生成）、隔离（实现 worker 不许碰）。
- 集成验证：质检员拿冻结合同当标尺，汇总各端契约测试结果 + 跨端静态对账（`integration_check` effect + handler），产差异报告，对不上派修复 assignment（上限 2 轮、独立计数）。
- 前端 UI 特殊处理：worker 搭到"能本地一键跑起来看"，UI 精修人主导，人改 UI 后代码层硬门重跑、汇入灯③条件。
- 交付物组装（R22 交付物 AC）：契约 + 设计决策 + N 个 PR（含发布顺序）+ 沉淀文档（写回知识层）；写码/提交自分支自动。

**不负责**：
- 单飞门分流、inflight 键、abort 粒度、父子链、批量唤醒、并发恢复 → `container-concurrency` 域。
- worktree 的 add/remove/脏检测/重置原语、write 档 args 构造、onSession 回调、PreToolUse hook → `kernel-capabilities` 域（本域只**调用**，路径来源 `worktreePathFor` §1.3）。
- 合同冻结/结构 diff/影响计算/变更判定/`contractStructuralDiff` 实现 → `contract-engine` 域（本域集成验证**复用**其 diff，不重新实现）。
- 灯③/灯④的拦截与拍板推进、phase 越界拦截 → `checkpoint-gate` + `requirement-statemachine` 域（本域只产"代码层绿"信号汇入灯③条件、产"分支就绪 + MR 草稿"交给灯④）。
- 7 phase onEvent 主状态机、owner 快照/journal、异常监督编排、取消收尾 → `requirement-statemachine` 域。
- repo 知识的生成/保鲜/选择性注入 → `knowledge-layer` 域（本域 prompt 组装时**消费**注入的知识，不负责产知识）。

## 核心概念（本域特有）

- **Worker（工人）run handler**：`role:'worker'` assignment 对应的 effect handler，`recovery:'resume-or-redispatch'`。一仓一工人、无状态、prompt 自包含（从 batch 重组，单飞 wake 重派也能工作）。
- **自测硬门**：worker 交活前的两道绿——跨端契约测试 + 本端单测/类型/编译。门照 [validateRunReport reportRequired 门](../codebase-findings.md#res-validaterunreport) 范式新增"测试结果门"。
- **两类不绿**：①测试执行失败（断言红）→ retry/返工；②测试无法执行（命令缺失/环境/编译基础设施问题）→ 不进自动 retry、直接举手 + 病历标根因类型。
- **跨端契约测试**：从冻结合同**机械生成为主**、独立质检员**补语义层用例**，存 `contract/tests/`，灯②冻结后即生成，实现 worker **不许碰**。R11 跑绿它、R13 汇总它，三处引用**同一份**。
- **集成验证（质检员）**：拿冻结合同当标尺，汇总各端契约测试结果 + 跨端静态对账（各端实现 vs 合同逐条核），经 `integration_check` effect kind 产差异报告。
- **修复循环（≤2 轮，独立计数）**：集成对不上 → 派修复 assignment（新 worker、不复活旧）；计数**锚在逻辑任务（repo+phase）**、不复用 `assignment.retries`、replacement 继承前任计数。
- **前端"完成"语义**：搭到"用户能本地一键跑起来看（结构 + 数据对接，可自验）"；UI 像素精修不另设 gate，由人主导（小改人改、大改甩回 AI）。
- **交付物**：契约 + 设计决策 + N 个 PR（含发布顺序）+ 沉淀文档（写回知识层）。

## 数据契约（TypeScript 接口）

本域不新定义独立数据结构，复用/引用如下（签名见各引用处，不就地重复）：

- worker run handler 实现 `EffectHandler` / 消费 `EffectContext` —— 见 [res-effecthandler](../codebase-findings.md#res-effecthandler)（`kind` / `recovery` / `run` / `canResume` / `resume`；ctx 提供 `signal/heartbeat()/emit/writeArtifact/readArtifact/setAgentSessionId/batchFromSeq/eventsSince`）。
- write 档映射、`writableDirs`、`onSession` 回调 —— 详见 internal-apis.md §5.1（PermissionProfile write + writableDirs 映射）、§5.2（buildClaudeArgs write 分支）、§5.3（onSession 回调）。本域只在 run handler 里**消费**这些 kernel 能力。
- worktree 路径来源 —— 详见 internal-apis.md §1.3 `worktreePathFor`（cwd 与 writableDirs **同源**）；worktree 原语（add/dirty/reset/remove）详见 internal-apis.md §5.4。
- 集成验证静态对账复用合同结构 diff —— 详见 internal-apis.md §1.2 `contractStructuralDiff`、§6.1 `ContractInterface`/`ContractSnapshot`、§6.2 `ContractDiff`/`computeImpact`。**不在本域重新实现 diff**。
- 测试结果门 —— 详见 internal-apis.md §3.3（validateRunReport 旁新增，或 worktype 侧校验）。
- 集成验证 effect —— `integration_check` effect kind + handler，事件 `integration_check_passed/failed`，详见 internal-apis.md §7 事件清单。
- 交付物相关事件 `worker_report` —— 详见 internal-apis.md §7。
- 流式卡按 assignmentId 分流（每 worker 一张）—— 见 [res-progresscards](../codebase-findings.md#res-progresscards)，接口无需改。

## 涵盖的 AC（Sensor2 校验依据）

### R11 Worker 执行
- **R11.AC-1**：worker 领活时组 `composeWorkerPrompt`（任务卡 brief + 冻结合同 + 该 repo 知识 + 返工说明），**去掉 probe 的"只读不改"系统句**。
- **R11.AC-2**：worker run 启动用 write 档（R04）在该 worker 的 worktree（R05）cwd 里跑。
- **R11.AC-3**：交活前跑绿 ①跨端契约测试（R12）②本端单测 + 类型/编译，**绿了才交活**（不绿判 run_failed，照 reportRequired 门新增"测试结果门"）。
- **R11.AC-4**：崩溃恢复 `canResume` 查 agentSessionId 可续 + worktree 是否脏；能续则 resume，不能则**先重置/丢弃 worktree 半成品再 redispatch**（不照搬 probe 的 `canResume:()=>false`）。
- **R11.AC-5**：输出结构化报告（代码校验必备项）+ 代码分支；报告进 artifact 仓、代码进 worktree（两套路径分开）。
- **R11.AC-6**：测试不绿则判 run_failed（不放行），进 retry/返工。
- **R11.AC-7（回补）**：自测不绿区分两类——"测试执行失败（断言红）"→ retry/返工；"测试无法执行（命令缺失/环境/编译基础设施问题）"→ **不进自动 retry、直接举手**并在病历标根因类型（避免无限烧 retry 预算）。
- **R11.AC-8（回补·恢复前置）**：worker resume 依赖 onSession 回调（D-30）让 session id 崩溃前已落库；不可 resume 时按 R05 AC8 重置 worktree 再 redispatch。
- **R11 Boundaries 增补**：worker 自测命令**来源于 R16 runbook**；runbook 缺失/过期时按"测试无法执行"降级举手。

### R12 跨端契约测试独立生成
- **R12.AC-1（含覆盖·拍板）**：需要跨端契约测试时**从冻结合同机械生成为主**，独立质检员在机械生成覆盖不足时**补语义层用例**，实现 worker 不许碰；**存 artifact 仓 `contract/tests/`**；产出时机 = **灯②合同冻结后即生成**。R11 跑绿它、R13 汇总它引用同一份。
- **R12.AC-2**：本端单测允许实现 worker 自写（验自己逻辑）。
- **R12.AC-3**：契约变更时**重新生成**受影响的契约测试。
- **R12.AC-4**：实现 worker 自己写"我符合合同"的测试视为无效（同一 AI 既写实现又写验证会一致地错还照绿）。

### R13 集成验证
- **R13.AC-1**：进入集成验证 phase 时由"质检员"角色（owner 的一个 phase 动作或专门 assignment）拿冻结合同当标尺。
- **R13.AC-2**：代码层验证 ①汇总各端契约测试结果 ②跨端静态对账（各端实现 vs 合同逐条核：接口/字段类型/调用），经新 effect kind `integration_check` + handler，产出**差异报告**。
- **R13.AC-3**：代码层绿 AND（如需）人过真交互 → 进灯③验收。
- **R13.AC-4**：对不上时接 R10 返工流程派修复 assignment（新 worker、不复活旧），修复循环上限 2 轮。
- **R13.AC-5**：需真交互验证时用临时 worktree 把各端分支拉一起、按各仓 runbook 起服务，**交给人点**（该上才上、非每需求标配）。
- **R13.AC-6**：修复循环超 2 轮 → 建 human wait 升级（连续集成失败说明契约或拆解有问题）。

### R14 前端 UI 特殊处理
- **R14.AC-1**：前端 worker"完成"定义为"搭到用户能本地一键跑起来看（结构 + 数据对接、可自验）"，UI 精修不另设 gate、由人主导（小改人改、大改甩回 AI）。
- **R14.AC-2**：人手改完 UI 后该端的契约测试 + 类型/编译**重跑绿**（防人改破坏对接）。
- **R14.AC-3**：前端汇入灯③总验收时要求条件 = 代码层硬门绿 ∧ 人对 UI 满意（∧ 如需真交互），都满足才算这端过。
- **R14.AC-4**：人改 UI 后代码层硬门不绿则不算该端过。

### R22 交付物（本域负责的部分）
- **R22.AC-1**：worker 写代码、提交到自己 feature 分支由系统**自动完成**。
- **R22.AC-3**：生成交付产物时产**契约 + 设计决策 + N 个 PR（含发布顺序）+ 沉淀文档（写回知识层）**。
- **R22.AC-4（交付物侧）**：平台纪律（feature 基于 prod、`pull --ff-only`、MR 首行 `rd:<id>`）少量高危用代码/hook 拦、大量靠 prompt 自律 + 写明 why（沿用 ai-sentinel 经验）。worker 写码/提交时遵守。

> R22.AC-2（灯④"开 MR/上线不自动、人亲手点"硬拦）归 `requirement-statemachine` 域；本域只产"分支就绪 + MR 草稿/发布顺序"喂给灯④。

## 设计细节（按功能点分节）

### 5.1 worker run handler —— 照 createAgentRunHandler 工厂改写三处（R11.AC-1/2/5）

照 [createAgentRunHandler / runAgent 工厂](../codebase-findings.md#res-createagentrunhandler)（run-handler.ts:70-179 七步）结构整体复用，改三处：

1. **prompt：`composeProbePrompt` → `composeWorkerPrompt`**（去"只读不改"系统句）。
   - probe 的 `composeProbePrompt`（run-handler.ts:193-212）第一句硬编码"只读、不要修改任何文件"（:199-200），与 write 档矛盾，**必须重写系统句**而非仅替换 title（D-23）。
   - 新 prompt 自包含 = 任务卡 brief + 冻结合同（从 `contract/` 读，[ArtifactStore.readFile](../codebase-findings.md#res-artifactstore)）+ 该 repo 知识（`knowledge-layer` 选择性注入、按 assignment 关联 repo）+ 返工说明（replacement 时带"原活 + 接口改了哪 + 为何"）。
   - 自包含要求：单飞 wake / 批量重派时从 batch 重组也能工作（不靠会话记忆）。

2. **权限：run-handler.ts:147 硬编码 `{permission:{mode:'readonly'}}` → 由 worktype.permissions + repos 映射 write 档**。
   - workitems 层 `{mode:'write', repos}` → agents 层 `{mode:'write', writableDirs:[worktree 路径]}`，映射落 run-handler.ts:147（详见 internal-apis.md §5.1）。
   - **绝不退化成 agents `full`**（full=`--dangerously-skip-permissions` 无限制、丢目录限定，D-04）。
   - write 档 args 由 kernel 构造（internal-apis.md §5.2）；本域只负责把 worktype permissions 翻译成 RunOptions。

3. **cwd：`pickCwd(repos[0])` → 该 assignment 的 worktree 路径**。
   - worktree 路径来源 `worktreePathFor(workitemId, assignmentId, repo)`（internal-apis.md §1.3），与 writableDirs **同源**。
   - cwd 经 managed task（[upsertTask](../codebase-findings.md#res-upserttask)，cwd 是 Task 字段、不是 RunOptions）：每 worker 一个 `id=managed:${assignment.id}`、owner_kind:'managed' 的影子 task，cwd=worktree 路径。
   - **artifact 仓（writeArtifact 写处）≠ worktree（cwd）**（D-20）：报告/journal 进 `$DATA_DIR/workitems/<id>/`，代码改动进 worktree。R11.AC-5 的"报告进 artifact 仓、代码进 worktree"由此双路径保证。

结构（kind/recovery/canResume/run/resume）整体复用；onActivity 心跳必须照 run-handler.ts:138 挂（否则长思考被误判 stalled，R20.AC-6 风险）；流式卡按 assignmentId 天然分流（[res-progresscards](../codebase-findings.md#res-progresscards)），多 worker 下 onRunStart title 带 role/repo 区分。

### 5.2 自测硬门（绿了才交活）+ 两类不绿（R11.AC-3/6/7，Boundaries 增补）

- 在 run() 正常返回前、交活之际跑绿两道：①跨端契约测试（§5.4 那份）②本端单测 + 类型/编译。**绿了才交活**。
- 门照 [validateRunReport reportRequired 门](../codebase-findings.md#res-validaterunreport)（effects.ts:295-312）范式，在其旁新增"测试结果门"（详见 internal-apis.md §3.3）：不绿判 run_failed。
- **两类不绿区分（R11.AC-7）**：
  - "测试执行失败（断言红）"→ 走 retry/返工（[redispatchOrEscalate](../codebase-findings.md#res-redispatchorescalate) 的正常重试路径）。
  - "测试无法执行（命令缺失/环境/编译基础设施挂）"→ **不进自动 retry、直接举手**（建 human wait）+ 病历标根因类型；否则无限烧 retry 预算。
- **自测命令来源 = R16 runbook**（`knowledge-layer` 注入的该 repo runbook）；runbook 缺失/过期时按"测试无法执行"降级举手（不烧 retry）。
- ⚠️ worker **不能 `ctx.emit('run_completed')` 伪造完成**（[res-effecthandler](../codebase-findings.md#res-effecthandler) 的 emit 拦截 isRunConclusion），只能 run() 正常返回 + 测试结果门通过。

### 5.3 非幂等崩溃恢复（R11.AC-4/8）

照 [res-effecthandler](../codebase-findings.md#res-effecthandler)：worker run = `recovery:'resume-or-redispatch'` + 实现 `canResume`，**不照搬 probe 的 `canResume:()=>false`**（probe readonly 幂等可直接 redispatch；worker write 已改盘、非幂等）。

- `canResume(payload, assignment, workitem)`：查 ①agentSessionId 可续（依赖 onSession 落库，见下）②worktree 是否有未提交脏改动（调 worktree 脏检测原语，internal-apis.md §5.4 `worktreeIsDirty`）。
- **能续 → resume**；**不能续 → 先重置/丢弃 worktree 半成品回干净基线再 redispatch**（调 `worktreeReset`，internal-apis.md §5.4：`git reset --hard <feature 基线>` + `git clean -fd` **仅清本 assignment 已知产物目录、不全清**，以免误伤未跟踪文件）。
- **resume 前置（R11.AC-8 / D-30）**：resume 分支可达**依赖 kernel 补 onSession 回调**（session 创建即 `setAgentSessionId` 同步落库），否则崩溃恰是 session id 未落库场景、resume 永远走不到。若 D-30 不补，D-09 诚实退化为"worktree 重置 + 全量 redispatch"单分支（删 resume 承诺、不留死代码）。onSession 回调本体在 `kernel-capabilities` 域；本域 run handler 接它桥到 `ctx.setAgentSessionId`。
- 多 worker / replacement 同时在途的崩溃恢复编排复用 [startupRecovery](../codebase-findings.md#res-startuprecovery)，但 per-assignment 早退改造归 `container-concurrency` 域（本域只保证 worktree 重置策略正确）。

### 5.4 跨端契约测试独立生成（R12 全部）

- **机械生成为主**（确定性、可重复）：从冻结合同（`ContractSnapshot`，internal-apis.md §6.1）机械生成测试——按 `ContractInterface` 的 signature/fields/provider/consumer 逐条生成"调用方按合同调、提供方按合同应"的断言。
- **独立质检员补语义层用例**：机械生成覆盖不足处由独立角色（质检员，owner 的 phase 动作或专门 assignment）补语义用例。
- **存放**：artifact 仓 `contract/tests/`（[ArtifactStore.writeFile](../codebase-findings.md#res-artifactstore) 写即 commit）。
- **产出时机**：灯②合同冻结后即生成（`contract_frozen` 事件后触发，由 `requirement-statemachine` 在合同冻结 phase 派质检员 / 或机械生成 effect）。
- **隔离（R12.AC-4 / D-24）**：实现 worker **不许写/改跨端契约测试**——这是"绿"有意义的前提（同一 AI 既写实现又写验证会一致地错还照绿，与 spec-design"Adversarial 用独立子 Agent"同源）。本端单测可 worker 自写（R12.AC-2）。
- **变更重生成（R12.AC-3）**：契约变更（`contract_change_applied`）时由 `contract-engine` 的 `computeImpact` 算受影响 repo，重新生成那部分契约测试。
- **三处引用同一份**：R11 自测硬门跑绿它、R13 集成验证汇总它，都指向 `contract/tests/` 这一份明确产物。

### 5.5 集成验证（integration_check effect + 静态对账 + 差异报告 + 修复循环）（R13 全部）

- **质检员拿冻结合同当标尺**（R13.AC-1）：进入集成验证 phase 时，由 owner 的 phase 动作或专门 assignment 充当质检员。
- **代码层两件（R13.AC-2）**：
  1. **汇总各端契约测试结果**（§5.4 那份在各 worker 自测时已跑、结果汇总）。
  2. **跨端静态对账**：各端实现 vs 合同逐条核（接口/字段类型/调用），**复用 `contractStructuralDiff`**（internal-apis.md §1.2，**不重新实现**）+ `computeImpact`（§6.2）算对不上的点。
  - 经新 effect kind **`integration_check`** + handler（[res-effecthandler](../codebase-findings.md#res-effecthandler) 契约；若幂等用 `recovery:'rerun'`），产出**差异报告**（写 artifact 仓）。
- **代码层绿 → 灯③**（R13.AC-3）：产 `integration_check_passed` 事件，汇入灯③验收条件（拦截/拍板由 `checkpoint-gate` 域）。如需人过真交互则附条件。
- **对不上 → 派修复 assignment（R13.AC-4）**：接 R10 返工流程，派**新 worker（不复活旧）**，带"原活 + 哪条对不上 + 为何"（`replaces_assignment_id` 链、分支保留）。修复循环**上限 2 轮**。
- **修复循环独立计数（D-11，Never 复用 retries）**：计数**锚在逻辑任务（repo+phase）而非物理 assignment**；replacement 必须**继承前任的返工计数**（否则 stall 重派洗白返工次数、绕过 2 轮上限）；存 `context_json` 或专用事件统计，**不复用 `assignment.retries`**（那是 stall 预算，[res-redispatchorescalate](../codebase-findings.md#res-redispatchorescalate)）。
- **超 2 轮 → human wait 升级**（R13.AC-6）：连续集成失败说明契约或拆解有问题，产 `integration_check_failed` 累计到阈值后建 human wait（病历：哪几条反复对不上）。
- **真交互验证按需（R13.AC-5 / D-06）**：用临时 worktree 把各端分支拉一起、按各仓 runbook 起服务，**交给人点**；该上才上、非每需求标配（语义等价错配等结构 diff 抓不到的残余才需联调兜底，见 D-31）。

### 5.6 前端 UI 特殊处理（R14 全部）

- **前端"完成"语义（R14.AC-1）**：worker 搭到"用户能本地一键跑起来看（结构 + 数据对接、可自验）"即算 worker 完成；UI 像素精修**不另设 gate**、由人主导（小改人改、大改甩回 AI）。
- **人改 UI 后代码层硬门重跑（R14.AC-2/4）**：人手改完 UI，该端的契约测试 + 类型/编译**重跑绿**（防人改破坏对接）；不绿则**不算该端过**（R14.AC-4）。重跑走 §5.2 同一套测试结果门。
- **汇入灯③条件（R14.AC-3 / D-25）**：前端汇入灯③验收条件 = **代码层硬门绿 ∧ 人对 UI 满意（∧ 如需真交互）**，都满足才算这端过。本域负责产"代码层硬门绿"信号；"人对 UI 满意"由 `checkpoint-gate`/工作台收集。
- **Never（R14 / D-25）**：UI 体验的人审**不替代**代码层硬门；UI 像素**不进对接合同**。

### 5.7 交付物组装（R22 交付物 AC）

- **写码/提交自分支自动（R22.AC-1）**：worker 在专属 worktree 写代码、提交到自己 feature 分支由系统自动完成（write 档 + worktree 已支撑）。
- **交付产物（R22.AC-3）**：到交付时产 **契约（`contract/`）+ 设计决策（`decisions.md`）+ N 个 PR（含发布顺序）+ 沉淀文档（写回知识层）**。沉淀写回 `knowledge-layer`（各 repo `pitfalls.md` 等更新）。
- **平台纪律（R22.AC-4）**：feature 基于 prod、`pull --ff-only`、MR 首行 `rd:<id>`——少量高危用代码/hook 拦、大量靠 prompt 自律 + 写明 why（沿用 ai-sentinel）。
- **交给灯④**：本域只到"分支就绪 + MR 草稿/发布顺序"，**开 MR/上线动作不自动执行**（R22.AC-2 灯④硬拦在 `requirement-statemachine` 域，D-14）。

## 与其他领域的交互（调用方向）

- **← kernel-capabilities**（本域调用）：write 档映射/args（§5.1/§5.2）、worktree 路径 `worktreePathFor`（§1.3）+ worktree 原语 add/dirty/reset/remove（§5.4）、onSession 回调（§5.3）。本域只**消费**，不实现 kernel 原语。
- **← contract-engine**（本域调用）：集成验证静态对账复用 `contractStructuralDiff`（§1.2）+ `computeImpact`/`ContractDiff`（§6.2）；契约变更重生成测试复用 `computeImpact` 算受影响 repo。读冻结合同 `ContractSnapshot`（§6.1）组 prompt。
- **← knowledge-layer**（本域调用）：worker prompt 组装时消费该 repo 的选择性注入知识（map/conventions/runbook/pitfalls）；自测命令来源 runbook。
- **→ requirement-statemachine**（本域产出供其消费）：worker run 产 `worker_report`、集成验证产 `integration_check_passed/failed`、自测门产 run_completed/run_failed —— 状态机 onEvent 据此推进/派修复/汇入灯③；交付物组装产"分支就绪 + MR 草稿"喂灯④。
- **→ checkpoint-gate**：产"代码层硬门绿"信号汇入灯③验收条件。
- **container-concurrency** 提供 effect 多并发 + abort per-assignment + 崩溃恢复 per-assignment 早退（本域 run handler 跑在其上、但不改其逻辑）。

## 相关决策（影响本域）

- **D-04**：写权限档纵深三层（`--add-dir` + PreToolUse hook + worktree）；write 档**绝不退化成 full**；fail-closed 探针验证（启动前实测 hook 生效）。本域 run handler 走 write 档。
- **D-06**：集成验证 = 契约测试汇总 + 跨端静态对账 `integration_check` effect；不锁框架；真联调按需人上、非标配。
- **D-09 + D-30**：worker 崩溃恢复**不照搬** probe `canResume:()=>false`；resume 依赖补 onSession（不补则诚实退化为"worktree 重置 + 全量 redispatch"单分支）。
- **D-11**：修复/返工循环**独立计数、不复用 `assignment.retries`**；计数锚逻辑任务（repo+phase）、replacement 继承前任计数。
- **D-20**：artifact 仓 ≠ worktree，双路径严格分离（报告进 artifact、代码进 worktree）。
- **D-23**：`composeWorkerPrompt` 必须重写系统句、去掉 probe"只读不改"，不能仅替换 title。
- **D-24**：跨端契约测试独立于实现 worker（机械生成为主 + 质检员补语义用例，存 `contract/tests/`、灯②冻结后即生成、实现 worker 不许碰）。
- **D-25**：前端代码层硬门照旧（人改 UI 后重跑绿）；UI 人审不替代代码层硬门；汇入灯③ = 代码层绿 ∧ UI 满意。
- **D-31**：契约结构 diff 适用边界——语义等价改动（含义/单位/可空性/排序）结构 diff 抓不到，靠真联调兜底（R13.AC-5 的真交互验证是这类残余的兜底）。
- **D-14**：开 MR/上线人亲手点（本域只产 MR 草稿/发布顺序，不自动开）。
- **D-15**：requirement worktype 复用通用 agent-run handler + 注册专有 effect handler（worker run / `integration_check` / checkpoint）。本域 worker run handler 与 integration_check handler 即这里注册的专有 handler。

## 引用的内部 API（给章节锚点，不就地写签名）

- internal-apis.md **§1.2** `contractStructuralDiff`（集成验证静态对账复用，不重新实现）
- internal-apis.md **§1.3** `worktreePathFor`（worker cwd + writableDirs 同源路径来源）
- internal-apis.md **§3.3** 测试结果门（照 reportRequired 门，不绿判 run_failed，区分两类不绿）
- internal-apis.md **§5.1** PermissionProfile write 档 + writableDirs 映射（run handler 消费）
- internal-apis.md **§5.2** buildClaudeArgs write 分支（run handler 走 write 档）
- internal-apis.md **§5.3** onSession 回调（resume 前置，run handler 桥到 ctx.setAgentSessionId）
- internal-apis.md **§5.4** worktree 生命周期原语（dirty/reset 供崩溃恢复调用）
- internal-apis.md **§6.1** `ContractInterface`/`ContractSnapshot`（读冻结合同组 prompt、机械生成测试依据）
- internal-apis.md **§6.2** `ContractDiff`/`computeImpact`（集成对账 + 契约变更重生成测试）
- internal-apis.md **§7** 事件 kind 清单（`worker_report` / `integration_check_passed/failed`）

复用资源锚点：[res-createagentrunhandler](../codebase-findings.md#res-createagentrunhandler)、[res-upserttask](../codebase-findings.md#res-upserttask)、[res-effecthandler](../codebase-findings.md#res-effecthandler)、[res-validaterunreport](../codebase-findings.md#res-validaterunreport)、[res-redispatchorescalate](../codebase-findings.md#res-redispatchorescalate)、[res-startuprecovery](../codebase-findings.md#res-startuprecovery)、[res-artifactstore](../codebase-findings.md#res-artifactstore)、[res-progresscards](../codebase-findings.md#res-progresscards)、[res-buildclaudeargs](../codebase-findings.md#res-buildclaudeargs)。

## 边界约束（Must / Never）

### Must
- worker run handler 照 `createAgentRunHandler` 工厂结构改写三处（prompt / 权限 / cwd），结构整体复用。
- `composeWorkerPrompt` **重写系统句去掉"只读不改"**（不能仅替换 title）。
- worker 跑 **write 档 + 专属 worktree**；cwd 与 writableDirs **同源**（`worktreePathFor`），同时确定/同时变更。
- 各端自测硬门：①跨端契约测试 ②本端单测/类型/编译，**绿了才交活**；不绿判 run_failed。
- 自测不绿**区分两类**：断言红 → retry；测试无法执行 → 不进 retry、直接举手 + 病历标根因。
- 自测命令**来源于 R16 runbook**；runbook 缺失/过期按"测试无法执行"降级举手。
- 崩溃恢复**回干净基线再重派**（worktree 重置：`reset --hard <基线>` + `clean -fd` **仅清本 assignment 已知产物目录、不全清**）。
- resume 依赖 onSession 落库（不补 onSession 则诚实退化为重置 + 全量 redispatch 单分支）。
- 跨端契约测试**独立于实现 worker**（机械生成为主 + 质检员补），存 `contract/tests/`、灯②冻结后即生成；契约变更重生成受影响那部分。
- 集成验证经 `integration_check` effect 产差异报告；对不上接返工、修复循环**上限 2 轮、独立计数**（continuance 锚逻辑任务、replacement 继承前任计数）。
- 集成验证静态对账**复用 `contractStructuralDiff`**（§1.2），不重新实现。
- 前端代码层硬门照旧：人改 UI 后契约测试 + 类型/编译重跑绿；汇入灯③ = 代码层绿 ∧ UI 满意。
- artifact 仓 ≠ worktree：报告进 artifact 仓、代码进 worktree。
- worker run handler 挂 onActivity 心跳（否则长思考误判 stalled）。
- 交付物产契约 + 决策 + N PR（含发布顺序）+ 沉淀（写回知识层）；写码/提交自分支自动。

### Never
- 不照搬 probe `canResume:()=>false`（worker write 非幂等）。
- worker **不能 `ctx.emit('run_completed')` 伪造完成**（emit 拦截 isRunConclusion）。
- 实现 worker **不许写/改跨端契约测试**（本端单测可自写）。
- write 档**绝不退化成 agents `full`**（`--dangerously-skip-permissions` 无限制丢目录限定）。
- 修复/集成循环**不用 `assignment.retries` 计数**（那是 stall 预算、会串味）。
- `git clean` **不全清**（只清本 assignment 已知产物目录，以免误伤未跟踪有用文件）。
- UI 像素**不进对接合同**；UI 体验人审**不替代代码层硬门**。
- AI **不自主开 MR/上线**（本域只到分支就绪 + MR 草稿，开 MR 人亲手点）。
- 本域 effect handler **禁 `AgentPool|Runner|spawn|execFile|child_process`**（副作用走 EffectContext 注入，[res-effecthandler](../codebase-findings.md#res-effecthandler) 隔离红线）；worktype index.ts 纯同步禁 async/fs（本域 handler 在 effects 层、可 async，但不引 pool/runner 直依赖）。

## 可能的实现提示（可选）

- worker run handler 与 probe run handler 共用 `createAgentRunHandler` 工厂：可考虑给工厂加 `composePrompt` / `permission` / `cwd` 三个可注入策略点，probe 传 readonly 套、requirement worker 传 write 套，避免 fork 整个 runAgent。
- 测试结果门可作为 `EffectContext` 旁的一个校验步骤，在 run() return 前调用；与 reportRequired 门串联（先报告门、后测试门，或合一）。
- "两类不绿"的判别：靠 worker 报告里结构化的"测试退出码 + 是否产出测试结果文件"区分——有结果文件且有断言失败 = 执行失败；命令未找到/编译失败/无结果文件 = 无法执行。
- `integration_check` handler 若设计为幂等（纯读各端实现 + 合同做静态对账、不改盘）可用 `recovery:'rerun'`，崩溃后直接重跑。
- 修复循环计数建议用专用事件（如 `integration_check_failed` 计数 + repo+phase 维度聚合）而非塞 context_json，便于工作台/anchorAction 观测。
- 先在 noop 夹具（[res-noop-fixture](../codebase-findings.md#res-noop-fixture)）上验"worker 自测门 + 修复循环 ≤2 轮 + 崩溃恢复回干净基线"再接真 agent（D-26 实现序④）。
