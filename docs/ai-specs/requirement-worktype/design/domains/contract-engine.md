# Domain: contract-engine

> 层：worktypes（`src/worktypes/requirement/contract.ts`）。纯同步、禁 async/await/fs/child_process（除"冻结"经 EffectContext 注入的 `writeArtifact` 在 effect 侧落地外，本域的 diff/影响计算/stale 判定全是纯函数）。
> 业务全貌见 [design/index.md](../index.md)；可复用资源见 [codebase-findings.md Part B](../codebase-findings.md)；新增符号签名见 [internal-apis.md](../internal-apis.md)。

## 领域职责

**负责什么**：
- 把"各端对接合同"做成可冻结、可版本化、可机械比对的结构化数据契约（`ContractInterface` / `ContractSnapshot`），冻结进 artifact 仓 `contract/`（git 化拿版本史）。
- 提供合同结构比对的**唯一实现** `contractStructuralDiff`（小改/大改判定、isDecisionStale、集成验证静态对账三处共用）。
- 按 repo 维度（`providerRepo` / `consumerRepos`）算受影响 worker（`computeImpact`）。
- 契约冻结后变更的机械判定：纯增 → 小改自治（`contract_patched`）；破坏性 → 大改回灯②（`contract_change_*`）。
- `isRequirementDecisionStale` 的**纯同步实现**（仅消费 `decision.data` + `eventsSince`，不读 fs）。
- 反复改同接口的独立计数（与 stall 重试隔离），到阈值举手"设计本身可能有问题"。
- 数据流前提的固化：结构指纹固化进 `decision.data`、变更事件携带指纹/字段级 diff（让 stale 纯同步可判）。

**不负责什么**：
- ❌ checkpoint wait 的拦截/拍板/stale 拒绝重弹卡 —— 归 `checkpoint-gate`（本域只提供 `contractStructuralDiff` + 指纹供其消费；R03.AC7「消费 decision 前走 stale 校验、拒绝 resolve 重弹卡」在 checkpoint-gate，不在本域）。
- ❌ worker 写代码/自测/集成验证 effect 的执行 —— 归 `worker-runtime`（本域只供 diff 函数与合同结构供其静态对账）。
- ❌ 灯②跑 spec-design 产出 `internal-apis.md → 合同` 的流程编排 —— 归 `design-phase`（本域接其产物落 `contract/`）。
- ❌ 7 phase 状态机/onEvent 总调度 —— 归 `requirement-statemachine`（本域被它在 phase 动作里调用）。
- ❌ worktree 路径分配 —— 归 `kernel-capabilities`（本域只用 `repoOf` 归一 repo key，物理工作区不管）。

## 核心概念（本域特有）

- **对接合同冻结（Contract Freeze）**：灯②快拍通过后，把合同写入 artifact 仓 `contract/`（经 `writeArtifact` 写即 commit，"冻结"= git 一次提交免费拿版本史），记 `contract_frozen` 事件。冻结≠不可变，变更走一等流程。
- **ContractInterface**：单条接口定义，含 `providerRepo`（哪个仓提供）/ `consumerRepos`（哪些仓调用）的 **repo key**（不用业务端名"后端/前端"）、字段级 `fields[]`（结构 diff 依据）、人工 `semanticBreaking` 标志。
- **ContractSnapshot**：某一冻结版本的快照，含 `version`（git hash/版本号）、`interfaces[]`、`fingerprint`（结构指纹，固化进 `decision.data` 供纯同步 stale 判定）。
- **结构 diff vs 语义残余**：`contractStructuralDiff` 只抓结构级（字段增删/类型变）；语义等价但行为变（金额元→分、status 0=成功→失败、可空性/排序变）**结构 diff 抓不到**，靠人工 `semanticBreaking` 标志 + 真联调兜底（D-31）。
- **小改 / 大改机械判**：`breaking` 空 ∧ `semanticFlagged` 空 → 小改（纯增，Owner 自治即改、不惊动人但完整留痕）；否则大改（强制回灯②）。判定**由结构 diff 机械产出，不交 AI 自由裁量**。
- **影响计算（computeImpact）**：据接口的 provider/consumer 算 `affectedRepos`，再按 repo 映射受影响 worker；受影响的返工，其它端照跑不停。
- **返工 replaces 链**：受影响 worker 返工 = 新 assignment + `replaces_assignment_id` 链（分支保留），带"原活 + 接口改了哪 + 为何"。
- **反复改独立计数**：同接口反复改 2-3 次仍不定 → 举手；用 workitem 级独立计数（锚"逻辑任务 repo+phase"，不复用 `assignment.retries`，replacement 须继承计数，D-11）。
- **数据流前提（硬接口约定）**：decision 产出时把所基于的 `fingerprint` 固化进 `decision.data`；contract 变更事件 payload 携带变更后 `fingerprint` + 字段级 diff —— 使 `isRequirementDecisionStale` 仅凭这两样纯同步判定。

## 数据契约（TypeScript 接口）

签名不就地重写，给 internal-apis 锚点：

- `ContractInterface` / `ContractSnapshot`：详见 [internal-apis.md §6.1](../internal-apis.md#61-contractinterface--contractsnapshot)。关键字段：`providerRepo: string` / `consumerRepos: string[]`（repo key）/ `fields: Array<{name,type,optional}>`（字段级 diff 依据）/ `semanticBreaking?: boolean`（人工标志）；`ContractSnapshot.fingerprint`（结构指纹）。
- `ContractDiff` + 变更判定：详见 [internal-apis.md §6.2](../internal-apis.md#62-contractdiff--变更判定)。`added`（纯增）/ `breaking`（破坏性）/ `semanticFlagged`（人工标的接口 id）/ `affectedRepos`（受影响 repo）。
- 数据流前提（指纹固化）：详见 [internal-apis.md §6.3](../internal-apis.md#63-数据流前提硬接口约定d-05)。
- 跨域共享 utility（本域定义、登记一处，不重复写）：
  - `repoOf(spec | assignment): string` —— 见 [internal-apis.md §1.1](../internal-apis.md#11-repoofspec--assignment-string)（归属本域）。
  - `contractStructuralDiff(prev, next): ContractDiff` —— 见 [internal-apis.md §1.2](../internal-apis.md#12-contractstructuraldiffprev-contractsnapshot-next-contractsnapshot-contractdiff)（归属本域，唯一实现）。
- `isRequirementDecisionStale(decision, eventsSince): boolean` —— 见 [internal-apis.md §4.3](../internal-apis.md#43-isrequirementdecisionstaledecision-eventssince-boolean纯同步)。
- 事件 kind 权威清单（本域产出的 `contract_frozen/contract_patched/contract_change_proposed/approved/applied`）—— 见 [internal-apis.md §7](../internal-apis.md#7-事件-kind-清单容器不解释权威清单r24)。

## 涵盖的 AC

> Sensor2 校验依据。本域覆盖 R09 全部 + R10 全部（除 stale 拒绝 resolve 那条归 checkpoint-gate）。

**R09 对接合同（契约先行 + 冻结 + 影响计算）**
- R09.AC-1：灯②快拍通过 → 合同写 artifact 仓 `contract/`（git 化"冻结"）并记 `contract_frozen` 事件。
- R09.AC-2：每条接口定义含「提供方 / 调用方」字段（影响计算依据）。
- R09.AC-3：一条接口变更 → 据提供方/调用方精准算出受影响的 worker。
- R09.AC-4：合同冻结后受影响 worker 返工时，其它端照跑不停（只返工受影响的）。
- R09.AC-5：合同缺字段/接口不完整 → 灯② Adversarial 在冻结前挑出（本域提供"合同结构完整性"可校验的字段级结构；挑刺由 design-phase 的 Adversarial 子 Agent 执行）。
- R09.AC-6（回补·D-29）：每条接口记 `providerRepo`/`consumerRepos`（repo key，不用业务端名）；影响计算据此精准算受影响 worker，与 R05 拆分、R10 stale 判定**共用同一 repo 维度**（一端多仓/一仓多角色按 repo 展开）。
- R09.AC-7（回补·空态）：合同冻结前（`contract/` 目录尚不存在）读合同**返空、不抛**。

**R10 契约变更/返工 + isDecisionStale（除 R03.AC7 stale 拒绝 resolve 归 checkpoint-gate）**
- R10.AC-1：契约变更纯增（加字段/接口/可选项，不动已有签名）→ 判小改：Owner 自治即改、不惊动人但完整留痕（活动流标"自治·接口小改" + 决策台账归"系统替我做的"），事件 `contract_patched`。
- R10.AC-2：契约变更破坏性（减字段/改类型/改语义/删接口）→ 判大改：强制回灯②，给"接口要改"卡（谁发现/为何改/影响哪几端/哪些活返工），事件 `contract_change_proposed/approved/applied`。
- R10.AC-3：判定小改/大改由 contract 结构化 diff 机械产出（不靠 Owner 语义自裁）。
- R10.AC-4：受影响 worker 返工带"原活 + 接口改了哪 + 为何"重做（新 assignment，`replaces_assignment_id` 链，分支保留）。
- R10.AC-5（覆盖·repo 维度）：`isDecisionStale(decision, eventsSince)` 判据用 **repo 维度**（decision 基于的 contract 版本是否变 / eventsSince 是否含触及同一 repo 的 `contract_change_applied`），与 R09 `providerRepo/consumerRepos` 一致；与契约 diff 共用同一套结构比对。
- R10.AC-6：同接口反复改 2-3 次仍不定 → 举手"设计本身可能有问题"（复用连拒升级基因），不再自动转。
- R10.AC-7（回补·数据流硬约定）：decision 产出时把所基于的 contract 结构指纹固化进 `decision.data`；contract 变更事件 payload 携带变更后结构指纹/字段级 diff，使 `isDecisionStale` 仅凭 `decision.data` + `eventsSince` **纯同步判定、不读 fs**。
- R10.AC-8（回补·语义残余·D-31）：契约变更是语义等价但行为不同（含义/单位/可空性/排序变，结构 diff 抓不到）→ 要求人改契约时**人工标注 `semanticBreaking` 标志**（机械 diff + 人工标志双轨）；该类残余靠真联调兜底。

> ⚠️ **不在本域**：R10「reducer 消费 checkpoint decision 前走 isDecisionStale 校验、stale 则拒绝 resolve 并重弹卡"合同已变、请重新确认"」(对应 R03.AC-7 / 见 index.md AC 映射) → 在 `checkpoint-gate`。本域只提供 `contractStructuralDiff` + 指纹数据流，供其纯同步消费。

## 设计细节（按功能点分节）

### 5.1 合同冻结（contract/ git 化）
- 灯②快拍通过后，由 `requirement-statemachine` 在 `合同→详设` 边界的 phase 动作里触发"冻结"：把结构化的 `ContractSnapshot` 序列化写入 artifact 仓 `contract/`（如 `contract/contract.json` + 人读 `contract/contract.md`），复用 [ArtifactStore.writeFile](../codebase-findings.md#res-artifactstore)（写即 `git add -A && git commit`，"冻结"= 一次提交，免费拿版本史）。同帧记 `contract_frozen` 事件（写 `workitem_events.kind`，容器不解释）。
- 本域只产出"要写什么内容"与"diff 出什么结论"的纯函数；真正的 `writeArtifact` IO 走 EffectContext（worktype index.ts 纯同步、不碰 fs）。
- ⚠️ `ArtifactStore.isClean` 只判 git 工作区，**无内容/schema 校验**；合同结构完整性（字段齐不齐）由本域 `ContractInterface` 的类型约束 + design-phase Adversarial 挑刺保证（R09.AC-5）。`--allow-empty` 即内容未变也产空 commit，故契约 diff **按内容（fingerprint）判而非 commit 数**。

### 5.2 ContractInterface / ContractSnapshot（repo key + 字段级 + semanticBreaking）
- 每条接口直接登记 `providerRepo` 与 `consumerRepos`（repo key），**不用业务端名**（R09.AC-6 / D-29）。"一端多仓/一仓多角色"按 repo 展开（一仓一 worker）。这套 repo 维度被影响计算（R09）、worker 拆分（R05/worker-runtime）、isDecisionStale（R10）三处共用，统一靠 `repoOf`（§1.1）归一。
- `fields[]`（`{name, type, optional}`）是结构 diff 的依据（字段级，能区分纯增/破坏性）。
- `semanticBreaking?: boolean` 是人工标志：结构没变但语义变（D-31）。本域**不尝试机械检出语义残余**，只在数据结构上留这个旗标位，由人改契约时主动声明（R10.AC-8）。
- `ContractSnapshot.fingerprint` 是结构指纹（对 `interfaces[]` 结构归一后哈希），是数据流前提的核心载体。

### 5.3 contractStructuralDiff —— 唯一实现（§1.2）
- **三处共用一函数**：① 契约变更小改/大改判定（R10.AC-3）② `isRequirementDecisionStale`（R10.AC-5/D-05）③ 集成验证静态对账（R13，worker-runtime 调）。避免各写脆弱规则（D-05 共用避免两处漂移）。
- 入参是**已固化的 `ContractSnapshot`（含 fingerprint），不是文件路径** —— 纯函数、纯同步、**禁 fs**。
- 输出 `ContractDiff`：`added`（纯增）/ `breaking`（removed-field/type-changed/semantic-removed/interface-removed）/ `semanticFlagged`（人工标 `semanticBreaking` 的接口 id）/ `affectedRepos`。
- 语义等价改动（含义/单位/可空性/排序）**不在结构 diff 范围**（§1.2 Must）；这类只能进 `semanticFlagged`（来自人工标志），结构层 `added`/`breaking` 抓不到。

### 5.4 小改 / 大改机械判（自治 vs 回灯②）
- 判定规则：`diff.breaking.length === 0 && diff.semanticFlagged.length === 0` → **小改（纯增）**；否则 **大改（破坏性）**。判定纯机械、不交 AI 自由裁量（R10.AC-3，design-detail §6 判定表）。
- **小改路径（R10.AC-1）**：Owner 自治即改，**不弹卡不惊动人**，但完整留痕 —— 记 `contract_patched` 事件（payload 携带变更后 fingerprint + 字段级 diff，§6.3），活动流标"自治·接口小改"、决策台账归"系统替我做的"（工作台/飞书展示由 workbench 域消费事件渲染）。可事后批量审、可退回纠正。
- **大改路径（R10.AC-2）**：强制回灯②。事件三段 `contract_change_proposed`（给"接口要改"卡：谁发现/为何改/影响哪几端/哪些活返工）→ 人拍 → `contract_change_approved` → 落地 `contract_change_applied`。回灯②的 wait 拦截由 `checkpoint-gate` 实施（本域产出"这是大改"的判定 + 卡片所需数据）。

### 5.5 computeImpact —— 按 repo 算受影响 worker（§1.1/6.2）
- `computeImpact(diff): string[]`：据 `diff.affectedRepos`（由变更接口的 `providerRepo`/`consumerRepos` 算出）映射受影响 worker（一仓一 worker，`repoOf` §1.1 归一）。
- 受影响的返工，**其它端照跑不停**（R09.AC-4 / R10.AC-4）——只对 `affectedRepos` 命中的 assignment 派 replacement，未命中的在途 worker 不动。

### 5.6 返工 replaces 链
- 受影响 worker 返工 = 新 assignment（`role` 同 worker）+ `replaces_assignment_id` 指向前任 + 带"原活 brief + 接口改了哪 + 为何"重组 prompt（worker-runtime 的 `composeWorkerPrompt` 消费返工说明）；**分支保留**（worktree 回收但 feature 分支不删，半成品是资产）。
- ⚠️ 不复用 stall 路径的 `assignment.retries`（那是活性卡死预算）；返工是语义级，独立计数（见 §5.8）。
- replacement 须**继承前任的返工计数**（D-11 锚定维度）：否则 stall 重派会洗白返工次数、绕过举手上限。

### 5.7 数据流前提 —— 结构指纹固化（§6.3，R10.AC-7）
- **decision 产出时**：把所基于的 `ContractSnapshot.fingerprint` 固化进 `decision.data`（[Decision.data](../codebase-findings.md#res-worktype-interface) 字段，`unknown` 类型自由塞）。这是 R10 与 contract 相关 R 的**硬接口约定**（D-05 增补）。
- **contract 变更事件**：`contract_patched` / `contract_change_applied` 的 payload **必须携带变更后 fingerprint + 字段级 diff**（哪些 repo 被触及）。
- 这两条保证 `isRequirementDecisionStale` 拿得到判 stale 所需的全部数据，无需读 artifact 仓的合同文件（纯同步禁 fs）。

### 5.8 isRequirementDecisionStale 实现（§4.3，纯同步消费 decision.data + eventsSince）
- 接入点已就绪（[checkDecision/structuralCheck/eventsSince](../codebase-findings.md#res-checkdecision)，reducer.ts:746-801），**无需改 reducer**；本域只填 worktype 的纯函数。
- 实现：仅凭 `decision.data`（固化的 fingerprint）+ `eventsSince`（区间事件）判定 ——
  - decision 基于的 contract 结构指纹 ≠ 当前（从 eventsSince 里 `contract_change_applied`/`contract_patched` 事件携带的新 fingerprint 比对）→ stale；
  - 或 `eventsSince` 含触及**同一 repo** 的 `contract_change_applied`（repo 维度，R10.AC-5）→ stale。
- 用 `contractStructuralDiff`（§1.2）做指纹/字段级比对。**禁 fs/await**（worktype 纯同步红线）。
- ⚠️ 不在 reducer 调 LLM 判 stale（D-05），语义级若未来需判则下沉为异步 effect。

### 5.9 反复改举手（独立计数，R10.AC-6）
- 同接口反复改 2-3 次仍不定 → 举手"设计本身可能有问题"（复用 [discard_streak/redispatchOrEscalate](../codebase-findings.md#res-redispatchorescalate) 的连拒升级基因，但**独立计数**）。
- 独立计数器锚在"逻辑任务（repo+phase）"，存 `context_json` 或专用事件统计（D-11），**不复用 `assignment.retries`**（避免与 stall 重试串味）。

### 5.10 空态（合同冻结前读 contract/ 返空，R09.AC-7）
- 合同冻结前（`理解` phase，worker 数 = 0），`contract/` 目录尚不存在。读合同的入口（被 statemachine/workbench/worker-runtime 调用）**返空、不抛**（[ArtifactStore.readFile](../codebase-findings.md#res-artifactstore) 缺文件返 undefined，本域包一层归一为空 `ContractSnapshot{interfaces:[]}`）。
- `computeImpact` / `contractStructuralDiff` 对空集/空快照返空集，不报错（与 R01.AC-10 空态退化 solo 同源）。

## 与其他领域的交互（调用方向）

- **被 `requirement-statemachine` 调用**：phase 动作里调本域冻结合同（产 `contract_frozen` 内容）、调小改/大改判定决定 transition 走向（自治改 vs 回灯②）；`requirementWorkType.isDecisionStale` 委托给本域 `isRequirementDecisionStale`。
- **被 `checkpoint-gate` 调用**：stale 校验拒绝 resolve（R03.AC7）时调本域 `isRequirementDecisionStale` + `contractStructuralDiff`；大改回灯②的卡片数据由本域 `ContractDiff` 提供。
- **被 `worker-runtime` 调用**：集成验证静态对账（R13）调 `contractStructuralDiff`（各端实现 vs 合同逐条核）；返工 replaces 链的"接口改了哪"由本域 `ContractDiff` 提供；worker prompt 注入冻结合同（读 `contract/`）。
- **被 `design-phase` 喂入**：spec-design 产出的 `internal-apis.md` 升格为对接合同（R15.AC2），由 design-phase 转成本域 `ContractSnapshot` 落 `contract/`。
- **被 `workbench` 消费**：合同/变更事件（`contract_frozen`/`contract_patched`/`contract_change_*`）由 workbench 渲染进活动流/决策台账/合同区块。
- **依赖 `kernel-capabilities`**：`repoOf` 归一的 repo key 与 worktree 路径分配（R05）共用同一 repo 维度（但本域不碰物理 worktree）。
- **依赖 `data-model`**：新事件 kind（§7）由 data-model 登记进权威清单 + anchorAction 映射；`Decision.data` / `context_json` 是数据载体。

## 相关决策

- **D-05** isDecisionStale 用契约结构 diff，与契约变更共用、不下沉 LLM；增补：数据流前提（指纹固化进 decision.data + 事件携带指纹，纯同步禁 fs）。
- **D-11** 修复/返工循环用独立计数、不复用 `assignment.retries`；增补：锚"逻辑任务（repo+phase）"、replacement 须继承返工计数。
- **D-29** 合同接口登记 `providerRepo`/`consumerRepos`（统一 repo 维度）；影响计算/worker 拆分/isDecisionStale 共用。
- **D-31** 契约结构 diff 的适用边界 + `semanticBreaking` 人工标志（结构 diff 只覆盖结构级，语义残余人工标 + 真联调兜底）。
- （间接）**D-02** 灯②快慢两拍靠拆 phase —— 合同冻结挂在 `合同→详设`（灯②快拍）；**D-06** 集成验证静态对账复用本域 diff；**D-20** artifact 仓 ≠ worktree（合同进 artifact 仓）。

## 引用的内部 API

- [internal-apis.md §1.1](../internal-apis.md#11-repoofspec--assignment-string) —— `repoOf`（本域定义，跨域共享）。
- [internal-apis.md §1.2](../internal-apis.md#12-contractstructuraldiffprev-contractsnapshot-next-contractsnapshot-contractdiff) —— `contractStructuralDiff`（本域唯一实现，跨域共享）。
- [internal-apis.md §4.3](../internal-apis.md#43-isrequirementdecisionstaledecision-eventssince-boolean纯同步) —— `isRequirementDecisionStale`。
- [internal-apis.md §6.1](../internal-apis.md#61-contractinterface--contractsnapshot) —— `ContractInterface` / `ContractSnapshot`。
- [internal-apis.md §6.2](../internal-apis.md#62-contractdiff--变更判定) —— `ContractDiff` + 变更判定 + `computeImpact`。
- [internal-apis.md §6.3](../internal-apis.md#63-数据流前提硬接口约定d-05) —— 数据流前提（指纹固化）。
- [internal-apis.md §7](../internal-apis.md#7-事件-kind-清单容器不解释权威清单r24) —— `contract_*` 事件 kind 权威清单。

## 边界约束

### Must
- 合同存 artifact 仓 `contract/` git 化（写即 commit，"冻结"= 一次提交免费拿版本史）。
- 每条接口记 `providerRepo`/`consumerRepos`（**repo key**，不用业务端名）；影响计算据此。
- 小改/大改由 `contractStructuralDiff` **机械判**（`breaking` ∧ `semanticFlagged` 皆空 → 小改）；不交 AI 自由裁量。
- `contractStructuralDiff` 是**唯一实现**，变更判定/isDecisionStale/集成验证对账三处引用同一函数，不重复实现。
- `isRequirementDecisionStale` **纯同步、禁 fs/await**，仅消费 `decision.data` + `eventsSince`。
- 数据流前提：decision 产出固化 fingerprint 进 `decision.data`；变更事件携带 fingerprint + 字段级 diff。
- isDecisionStale 判据用 **repo 维度**（与 R09 provider/consumer、R05 拆分一致）。
- 大改强制回灯②；小改完整留痕（事件 + 活动流标记 + 台账）可退回纠正。
- 语义残余：人改契约时人工标 `semanticBreaking`，机械 diff + 人工标志双轨。
- 反复改用 workitem 级独立计数（锚 repo+phase），replacement 继承计数。
- 合同冻结前读 `contract/` **返空、不抛**。

### Never
- ❌ 不在 reducer 里调 LLM 判 stale（reducer 同步纯转移、不能 await；语义判断若需则下沉异步 effect）。
- ❌ 不把"小改还是大改"交给 AI 自由裁量（机械 diff 判）。
- ❌ UI 像素不进对接合同。
- ❌ 不假装机械 diff 能抓语义等价改动（必须显式 `semanticBreaking` 标 + 真联调兜底）。
- ❌ 不复用 `assignment.retries` 计反复改/返工（独立计数）。
- ❌ 合同/diff/影响计算/stale 判定的纯函数里**不含 async/await/fs/child_process**（worktype 纯同步红线，CI 拦）。
- ❌ 不用业务端名（"后端/前端"）当影响计算映射键（统一 repo 维度）。

## 可能的实现提示（可选）

- `fingerprint` 建议对 `interfaces[]` 做**结构归一**（按 `id` 排序、字段按 `name` 排序、忽略人读注释/描述）后哈希，保证"内容等价→指纹相等"，避免 `--allow-empty` 空 commit 误判变更。
- `contractStructuralDiff` 实现可分三步：① 接口集合 diff（added/removed-interface）② 同 id 接口的 `fields[]` 字段级 diff（added-field/removed-field/type-changed/optional 变化）③ 汇总 `semanticFlagged`（来自人工标志）+ 据 provider/consumer 算 `affectedRepos`。
- 小改自治留痕的"活动流标记/台账归类"是**消费侧渲染**（workbench 据事件 kind + payload 渲染），本域只负责事件 kind 与 payload 内容正确（`contract_patched` 携带 fingerprint + 字段级 diff）。
- `contract/contract.json`（机器可比对）与 `contract/contract.md`（人读 + 工作台就地渲染）双写：diff 只读 json，md 仅展示。
- 独立计数可用专用统计事件（如对每个 `interfaceId` 统计 `contract_change_applied` 次数）替代往 `context_json` 塞可变状态，更贴合 append-only 事件模型。
