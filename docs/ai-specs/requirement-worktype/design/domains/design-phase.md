# Domain: design-phase

> 灯②"审设计"阶段的设计契约。覆盖 **R15 全部 AC**。
> 层：`worktypes`（业务逻辑全在 `src/worktypes/requirement/`，纯同步 worktype + 异步 effect handler）。
> 📖 复用资源锚点见 [../../codebase-findings.md](../../codebase-findings.md) Part B；新增 API 见 [../internal-apis.md](../internal-apis.md)，本域不就地写签名。

## 领域职责（负责什么 / 不负责什么）

**负责**：requirement 生命周期里"合同→详设→拆解"这一段（灯②前后）的设计流程编排——

- 进入设计 phase 时，通过 **effect 调起一个跑 spec-design 流程的 managed run**，让"设计契约"复用维护者自有的 spec-design 方法论（理解→考古→Requirement→详设→决策→AI 装配），产物落 artifact 仓 `contract/` + `design/`。
- 把 spec-design 产出的 `internal-apis.md`（单库内部 API 契约）**升格为本需求的"前后端对接合同"** = 灯②快拍的确认对象（发令枪）。
- 把 spec-design 产出的 `design/`（含 `design/domains/`）**按端/仓库再切一刀**，每个 repo 一份详设切片，供 worker-runtime 各端 worker 并行领走。
- 编排灯②的**快慢两拍**：快拍 = 人花两三分钟扫接口清单"够不够用、有没有漏"，认了→合同冻结=发令枪；慢拍 = 各端详设回工作台逐块细审。
- 启动 **Adversarial（唱反调 AI）独立子 Agent** 专挑接口的刺（上限/边界/字段缺失），尽量开工前挑净。
- 流程伸缩（Lite/Full）——伸缩对抗轮数 / 文档厚薄，但"设计→人审"内核不动。
- 灯②被打回时回退设计 phase 重走。

**不负责**（划清边界，避免与邻域重叠）：

- **不负责合同的结构表示、结构 diff、影响计算、变更/返工、isDecisionStale**——那是 `contract-engine` 域。本域只负责"调起 spec-design 跑出 internal-apis、把它喂给 contract-engine 去冻结成 `ContractSnapshot`"；冻结/diff 的算法实现不在本域。
- **不负责灯②的容器侧拦截机制（worktype 主动返 `waits:[human]`、resolveWait 带 decision、stale 校验）**——那是 `checkpoint-gate` 域。本域只声明"合同→详设(灯②快)""详设→拆解(灯②慢)"两个 phase 边界该挂灯，拦截/拍板/回退的状态机细节由 checkpoint-gate + requirement-statemachine 落。
- **不负责 worker 领切片后的写代码/自测/worktree**——那是 `worker-runtime` 域。本域只负责"把 `design/` 切成各端切片 + 标好 providerRepo/consumerRepos"，交付给 worker-runtime。
- **不负责跨端契约测试的生成/汇总**——那是 `worker-runtime` 域（D-24，灯②合同冻结后即生成，存 `contract/tests/`）。本域只产出"冻结合同"这个上游输入。

## 核心概念（本域特有）

- **spec-design managed run**：进入设计 phase 时由 effect 调起的一个 Claude managed run，跑 spec-design 这套 skill 的流程。它是 requirement worktype 内部"包工头委派给设计专员"的一个 run，按 assignmentId 走 managed 影子 task（复用 [claimThread / managed 影子 task](../../codebase-findings.md#res-claimthread)），产物用 [ArtifactStore](../../codebase-findings.md#res-artifactstore) 写即 commit 落 `contract/` + `design/`。
- **internal-apis 升格**：spec-design 产物里的 `internal-apis.md`（单库内部 API 契约）在 requirement 语境下被**升格**为"前后端对接合同"。升格 = 把 spec-design 的 internal-apis 章节（每个 §x.y 一条接口）抽取成本需求的 `ContractInterface[]`（§6.1，contract-engine 域定义），并补登 `providerRepo`/`consumerRepos`（spec-design 的 internal-apis 是单库内部 API，不带跨仓 provider/consumer，需在升格时按 repo 维度补全）。
- **灯②快拍 / 慢拍**：
  - **快拍（合同→详设）**：人扫接口清单（升格后的对接合同）够不够用、有没有漏。认了→`contract_frozen`=发令枪，各端可照冻结合同并行做详设。
  - **慢拍（详设→拆解）**：各端详设回工作台逐块细审。通过→进拆解，按仓切任务卡。
- **Adversarial（唱反调 AI）**：独立子 Agent，与"产合同的 run"分离（独立性是挑刺有意义的前提，与 D-24 跨端契约测试独立同源），专挑接口的上限/边界/字段缺失/语义模糊，在合同冻结**前**挑净。它的输出是"刺清单"喂回快拍卡，帮人决定认还是打回。
- **设计切片（design slice）**：`design/` 按 repo 再切的产物——每个 providerRepo 一份详设切片（该仓要实现哪些接口、依赖哪些上游接口）。这是 worker-runtime 域 worker prompt 的输入之一。
- **Lite / Full 轨道**：流程伸缩档位。Lite = 少对抗轮数 + 薄文档（小需求）；Full = 多对抗轮数 + 厚文档（大需求）。伸缩的是"对抗强度/文档厚薄"，**不伸缩"设计→人审"内核**（设计必审，不论大小）。

## 数据契约（TypeScript 接口）

本域**不新增独立数据结构**，复用 contract-engine 域的合同契约：

- 升格产出的对接合同结构 = `ContractInterface` / `ContractSnapshot`，详见 internal-apis.md **§6.1**（含 `providerRepo` / `consumerRepos` / `fields` / `semanticBreaking` / `fingerprint`）。本域只负责"从 spec-design internal-apis 填充出 `ContractInterface[]`"，结构本身不在此重复定义。
- 灯②快拍的确认对象 = `ContractSnapshot`（升格 + 补 provider/consumer 后的快照），慢拍的审阅对象 = `design/` 切片（artifact 仓 `.md` 文件，工作台就地渲染，R17）。
- 设计 phase 调起 spec-design 的 effect = requirement 专有 effect kind（新 `EffectDecl`，照 [EffectHandler / EffectContext](../../codebase-findings.md#res-effecthandler) 契约实现），run 结束产出 `design_ready` 事件（§7 事件清单）。

> spec-design 对接细节：本域调起的是 spec-design 这套 skill 的产物结构（`requirements.md` / `decisions.md` / `design/internal-apis.md` / `design/index.md` / `design/domains/`）。升格映射 = spec-design 的 `internal-apis.md §x.y`（每个章节一条内部 API）→ 本需求 `ContractInterface`（一条对接接口）。详见 internal-apis.md **§6.1**（合同结构）对接 spec-design 的 internal-apis 登记表。

## 涵盖的 AC（R15 全部 6 条）

> 以下逐条列出分配给本域的每条 AC，作为 Sensor2 校验依据。

- **R15.AC-1**（Happy）：WHEN 进入设计 phase THEN 系统 SHALL 通过 **effect 调起一个跑 spec-design 流程的 managed run**，产物落 artifact 仓 `contract/` + `design/`。
- **R15.AC-2**（Happy）：WHEN spec-design 的 `internal-apis.md`（单库内部 API 契约）产出 THEN 系统 SHALL **升格为"前后端对接合同"** = 灯②快拍确认对象。
- **R15.AC-3**（Happy）：WHEN spec-design 的 `design/` 产出 THEN 系统 SHALL **按端 / 仓库再切**、各端 worker 并行领走。
- **R15.AC-4**（Edge）：WHEN 灯②快拍 THEN 系统 SHALL 让人花两三分钟扫接口清单"够不够用、有没有漏"，认了→合同冻结=发令枪；慢拍各端详设回工作台逐块细审。
- **R15.AC-5**（Edge）：WHEN Adversarial（唱反调 AI）启动 THEN 系统 SHALL 用**独立子 Agent** 专挑接口的刺（上限/边界/字段缺失），尽量开工前挑净。
- **R15.AC-6**（Error）：IF 设计被打回 THEN 系统 SHALL 回退设计 phase 重走（流程伸缩 Lite/Full，"设计→人审"内核不动）。

## 设计细节（按功能点分节，写思路不写实现代码）

### 5.1 进入设计 phase 调起 spec-design managed run（R15.AC-1）

- **触发时机**：灯①（理解→合同）通过后，requirement 状态机进入"合同"phase。`requirementTransition`（internal-apis.md §4.2）在处理灯①拍板事件（`wait_resolved` 带 approved decision）后，返回 `Transition` 含一个 `effects:[{kind:'spec_design_run', ...}]` 声明，由容器落 pending effect，effects 层异步执行。
- **effect handler 实现**：照 [createAgentRunHandler / runAgent](../../codebase-findings.md#res-createagentrunhandler) 工厂改写——
  - prompt = "跑 spec-design 流程"的指令（喂 PRD/理解产物 + 各仓知识层 map.md 供代码考古复用，见 knowledge-layer 域 D-08），让 managed run 按 spec-design 六阶段产出 `requirements.md` / `decisions.md` / `design/`。
  - cwd：spec-design 是"设计不写代码"，这个 run 不需要 worktree 写权限——可走 readonly 或限定 artifact 仓写。**不复用 worker 的 write 档 + worktree**（那是实现阶段）。
  - 产物落地：run 通过 `ctx.writeArtifact` 把 spec-design 产物写进 artifact 仓 `contract/`（升格后的合同）+ `design/`（详设切片）。artifact 仓 ≠ worktree（D-20，[ArtifactStore](../../codebase-findings.md#res-artifactstore)）。
  - run 收尾 → emit `design_ready` 事件（§7），状态机据此知道"设计产物就绪、可进灯②快拍"。
- **Lite/Full 伸缩**（R15.AC-6 配套）：调起 spec-design run 时按需求规模/档位传"对抗轮数、文档厚薄"参数（Lite = 1 轮对抗 + 薄文档；Full = 多轮 + 厚文档）。档位可由灯①拍板时人选（payload 带档位），或按 PRD 规模启发式默认。**内核不变**：无论 Lite/Full，都产出 internal-apis（升格成合同）+ 必过灯②人审。
- **空态/退化**：理解 phase（worker 数 0、owner 单飞）与本域无关；本域只在"合同/详设"phase 活跃。若 spec-design run 崩溃，按通用 run 恢复（这个 run 是设计产物生成、可幂等重跑，`recovery:'rerun'`，不像 worker 写档非幂等）。

### 5.2 internal-apis 升格为对接合同（R15.AC-2）

- **升格 = 抽取 + 补 repo 维度**：spec-design 的 `internal-apis.md` 是**单库内部 API**（每个 §x.y 一条接口签名），但 requirement 的对接合同是**跨仓**的。升格步骤：
  1. 把 internal-apis 每条接口抽成 `ContractInterface`（§6.1）：`signature`/`fields` 直接来自 spec-design 的签名；`id` = 接口标识。
  2. **补 `providerRepo` / `consumerRepos`**（repo key，D-29）：spec-design 单库内部 API 不带跨仓 provider/consumer，升格时由设计 run（或包工头一个 phase 动作）按"哪个仓提供这个接口、哪些仓调用"标注。这是 contract-engine 影响计算（R09）、worker 拆分（R05）、isDecisionStale（R10）三处共用 repo 维度的源头。
  3. 计算 `fingerprint`（结构指纹），固化进后续 decision.data（D-05 数据流前提，contract-engine 域负责算法）。
- **冻结 = 灯②快拍通过后**：升格产出的 `ContractSnapshot` 是灯②快拍的确认对象（待确认草案），**不是已冻结合同**。人扫接口认了（快拍 approved）→ contract-engine 写 `contract/` git 化 + 记 `contract_frozen`（R09.AC-1）。本域只产出"待确认的升格合同草案"，冻结动作由 checkpoint-gate + contract-engine 完成。
- **UI 像素不进合同**（R09 Never / R14 Must）：升格抽取时只取接口/字段/类型，前端 UI 像素细节不进对接合同。

### 5.3 design/ 按端切片、各端 worker 并行领走（R15.AC-3）

- **切片维度 = repo key**（D-29，与升格的 providerRepo 同维度）：`design/`（spec-design 产出的总详设，含 `design/domains/`）按"每个 providerRepo 一份切片"再切一刀。一个 repo 一份切片 = 该仓 worker 的领活范围（一仓一 worker，D-01）。
- **切片内容**：每份切片含 = 该仓要实现的接口（providerRepo == 本仓的 `ContractInterface`）+ 该仓依赖的上游接口（consumerRepos 含本仓的接口）+ 对应的 `design/domains/*.md` 详设。
- **交付给 worker-runtime**：切片是 worker prompt 的输入之一（worker-runtime 域 `composeWorkerPrompt` 喂"任务卡 brief + 冻结合同 + 该 repo 知识 + 详设切片"）。本域负责切，worker-runtime 负责消费。
- **切片用 `repoOf`**（internal-apis.md §1.1）做"端/任务→repo key"归一，禁用业务端名（"后端/前端"）当映射键——只引用，不重新定义。
- **时机**：切片在灯②慢拍（详设逐块审）通过后、进拆解 phase 时定型。慢拍审的就是这些切片。

### 5.4 灯②快慢两拍编排（R15.AC-4）

- **快拍（合同→详设边界，挂灯）**：
  - 设计 run 产出升格合同草案（`design_ready`）后，状态机检测"将越过 `requirement:合同→详设` 边界且灯②快未拍板"→ 主动返回 `waits:[human]`（checkpoint-gate 域机制，本域只声明该边界挂灯）。
  - 焦点卡内容 = 接口清单（升格合同的接口列表）+ Adversarial 刺清单（5.5）。让人两三分钟扫"够不够用、有没有漏"。
  - 认了（快拍 approved，resolveWait 带 decision）→ contract-engine 冻结合同 + `contract_frozen`=发令枪 → 各端照冻结合同**并行做详设**（此时可起多个设计切片 run，但本次主要并行点在实现阶段；详设可由设计 run 一次产出或按端拆）。
- **慢拍（详设→拆解边界，挂灯）**：
  - 各端详设产出后，状态机检测"将越过 `requirement:详设→拆解` 边界且灯②慢未拍板"→ 返回 `waits:[human]`。
  - 慢拍审阅对象 = 各端 `design/` 切片，回工作台**逐块细审**（工作台就地渲染 MD，R17）。
  - 通过→进拆解 phase（按仓拆任务卡，worker-runtime 领活）。
- **两拍靠拆 phase 实现**（D-02）：复用现成 `checkpoints.requiredBefore: string[]`（phase 名列表）语义，快拍挂 `requirement:详设`、慢拍挂 `requirement:拆解`（即"越过该边界前挂灯"）。不引入"独立 checkpoint id"新概念。本域只声明这两个边界挂灯，拦截/拍板原子（resolveWait 带 decision）由 checkpoint-gate 落。
- **stale 防护**（R03.AC-7 / Gate3-C06）：慢拍拍板前若合同已被自治小改触动，checkpoint-gate 的 isDecisionStale 校验会拒绝拍板重弹卡——本域产出的合同草案 decision.data 须带 fingerprint 配合（contract-engine 负责固化）。

### 5.5 Adversarial 唱反调独立子 Agent（R15.AC-5）

- **独立性是关键**（D-24 同源）：Adversarial 子 Agent **必须独立于"产合同的 run"**——同一 AI 既产合同又自审会一致地漏同种刺。它是一个独立 managed run（独立 assignmentId、独立 prompt、独立 session），按 [createAgentRunHandler](../../codebase-findings.md#res-createagentrunhandler) 起。
- **挑刺对象 = 接口**：专挑升格合同里接口的上限/边界/字段缺失/语义模糊（如"分页有没有 limit 上限""金额单位是元还是分""可空字段未声明""错误码未枚举"）。
- **时机 = 合同冻结前**：Adversarial 在快拍**之前**跑，输出"刺清单"喂回快拍焦点卡，帮人决定认还是打回。"尽量开工前挑净"——结构 diff 抓不到的语义残余（D-31 semanticBreaking）靠 Adversarial + 人工标志 + 真联调三道兜底。
- **Lite/Full 伸缩对抗轮数**：Lite = 1 轮 Adversarial；Full = 多轮（挑→改合同→再挑直到无 HIGH 刺）。轮数由档位定，内核（必跑一次 Adversarial）不省。
- **挑刺 run 收尾**：刺清单作为 artifact 写进 `contract/`（或 `design/`）供工作台/快拍卡展示，不直接改合同（人拍板才改）。

### 5.6 设计打回回退（R15.AC-6）

- **灯②打回→回退设计 phase**（R03.AC-4）：快拍打回 → 回退到"合同"phase 重跑设计 run（重新升格/挑刺）；慢拍打回 → 回退到"详设"phase 重做详设切片。回退由 worktype 逻辑定（对容器只是 `phase_changed`），checkpoint-gate 域消费 decision 后由 requirement-statemachine 返回回退 Transition。本域定义"打回回退到哪个 phase"的语义。
- **连拒升级**（R03.AC-5）：同一灯连续被拒 2 次 → 升级为对话（复用 `discard_streak` 基因），不再自动重试。本域设计 run 不无限重跑。
- **流程伸缩内核不动**（R15 Must / Never）：Lite/Full 伸缩对抗轮数 + 文档厚薄，但"设计→人审"内核不动——**不因任务小跳过设计→人审**。即使最薄的 Lite，也产 internal-apis + 必过灯②。

## 与其他领域的交互（调用方向）

| 方向 | 交互对象 | 内容 |
|------|---------|------|
| 本域 → contract-engine | `contract-engine` | 产出升格合同草案（`ContractInterface[]`），交 contract-engine 冻结成 `ContractSnapshot`、算 fingerprint、记 `contract_frozen`；切片维度复用 `repoOf`/`providerRepo` |
| 本域 → worker-runtime | `worker-runtime` | 交付 `design/` 按端切片 + 升格合同，作 worker prompt 输入；跨端契约测试由 worker-runtime 在合同冻结后生成（D-24，本域只产上游冻结合同） |
| 本域 ↔ checkpoint-gate | `checkpoint-gate` | 本域声明"合同→详设(快)""详设→拆解(慢)"两边界挂灯；拦截（worktype 主动返 wait）、拍板原子（resolveWait 带 decision）、stale 校验由 checkpoint-gate 落 |
| 本域 → requirement-statemachine | `requirement-statemachine` | 设计 phase 的 onEvent 分支（调起设计 run / 处理 `design_ready` / 灯②打回回退 phase）由 requirement-statemachine 的 `requirementTransition` 统一承载，本域定义该段 phase 行为 |
| effect 调起 → kernel | `kernel-capabilities`（间接） | 设计 run / Adversarial run 走 [createAgentRunHandler](../../codebase-findings.md#res-createagentrunhandler) + pool（Owner 预留槽 D-18 保设计 run/owner 不饿死）；managed 影子 task + claimThread |
| 本域 ← knowledge-layer | `knowledge-layer` | 设计 run 跑 spec-design"代码考古"阶段时，复用各仓知识层 map.md 初版（D-08，spec-design 代码考古产物与知识层对接复用） |

## 相关决策（从 decisions 挑影响本域的）

- **D-02**：灯②快慢两拍靠"拆 phase"，7 phase 序列固定（快拍挂 `合同→详设`、慢拍挂 `详设→拆解`）。本域 5.4 直接落。
- **D-15**：requirement worktype 三处接线，复用通用 handler + 注册专有 handler——设计 run effect handler 是 requirement 专有 handler kind 之一（与 worker run / integration_check / checkpoint 并列）。
- **D-24**：跨端契约测试独立于实现 worker（机械生成或独立质检员）——与本域 Adversarial 独立子 Agent **同源**（独立性是"挑刺/绿"有意义的前提）。本域 5.5 引此理由。
- **D-29**：合同接口登记 providerRepo / consumerRepos（统一 repo 维度）——本域升格补 repo 维度（5.2）、按端切片（5.3）都用此维度。
- **D-31**：契约结构 diff 适用边界 + semanticBreaking 人工标志——Adversarial 挑语义刺、人工标 semanticBreaking 是结构 diff 抓不到那部分的兜底（5.5）。
- **D-05**：isDecisionStale 用结构 diff、结构指纹入 decision.data——本域升格合同的 fingerprint 须供 stale 校验消费（5.4 慢拍 stale 防护），算法由 contract-engine 落。
- **D-18**：Owner 预留槽防二级死锁——设计 run / owner 走预留槽，保设计 run 不被 worker 占满槽饿死（effect 调起依赖）。

## 引用的内部 API（给 internal-apis.md §x.y 锚点，不就地写签名）

- **§6.1** `ContractInterface` / `ContractSnapshot`——升格产出的对接合同结构（含 providerRepo/consumerRepos/fields/semanticBreaking/fingerprint），本域升格抽取的目标结构。**重点：本域产出对接 spec-design 的 internal-apis（每个 §x.y 一条内部 API → 一条 `ContractInterface`）。**
- **§6.2** `ContractDiff` + 变更判定——灯②慢拍 stale 校验、设计打回后重跑的 diff 依据（算法在 contract-engine，本域只触发）。
- **§4.2** `requirementTransition(item, ev)`——设计 phase 的 onEvent 分支（调起设计 run / 处理 `design_ready` / 灯②打回回退）由它统一承载。
- **§4.1** `requirementWorkType` 的 `checkpoints.requiredBefore`——声明 `requirement:详设` / `requirement:拆解` 边界挂灯（快慢两拍）。
- **§1.1** `repoOf(spec | assignment)`——切片/升格的"端/任务→repo key"归一（只引用，不重定义）。
- **§1.2** `contractStructuralDiff`——升格合同结构比对的唯一实现（本域只引用，diff 实现在 contract-engine）。
- **§7** 事件 kind 清单——本域产出 `design_ready`（设计 run 收尾）+ 触发 `contract_frozen`（经 contract-engine）；新 kind 须在 anchorAction 有显式映射（一致性约束）。

## 边界约束（Must / Never）

**Must**：

- 设计**必审**不论大小（Lite/Full 都必过灯②人审），设计→人审内核不动。
- spec-design 内核复用——调起跑 spec-design 流程的 managed run，不另造一套设计方法论。
- `internal-apis` 升格为对接合同（灯②快拍确认对象）；`design/` 按端拆（各端 worker 并行领走）。
- Adversarial 用**独立子 Agent**（独立 run/prompt/session），不与产合同的 run 同体。
- 升格补 `providerRepo`/`consumerRepos` 用 repo 维度（D-29），与 contract-engine/worker-runtime 共用。
- 快慢两拍靠拆 phase（D-02）声明边界挂灯，拦截/拍板细节交 checkpoint-gate。
- 本域所有逻辑在 `src/worktypes/requirement/`（worktypes 层）；worktype index.ts 纯同步（禁 async/await/fs/child_process）——调起 spec-design run 的副作用走 effect handler（异步层），不在 worktype 纯函数里跑。

**Never**：

- **不因任务小跳过"设计→人审"内核**（Lite 也必审）。
- 不让 Adversarial 与产合同的 run 同体（同一 AI 自审会一致漏刺）。
- UI 像素不进对接合同（升格抽取只取接口/字段/类型）。
- 不在本域重复实现合同结构 diff / 冻结 / isDecisionStale（那是 contract-engine，本域只引用 `contractStructuralDiff`）。
- 不用业务端名（"后端/前端"）当切片/升格映射键，统一 repo key。
- 设计 run 不写代码、不用 worker 的 write 档 + worktree（那是实现阶段；设计 run 走 readonly/限定 artifact 仓写）。

## 可能的实现提示（可选）

- 设计 run 的 effect kind 建议命名中性化承载（如 `design_run`/`spec_design_run`，worktypes 层可用业务词，但若 effect kind 字面值会流到 kernel 卡片层需走 anchorAction 纯映射）。run 收尾产 `design_ready`（已在 §7 权威清单）。
- 设计 run `recovery:'rerun'`（产物生成幂等可重跑），区别于 worker run 的 `'resume-or-redispatch'`（写档非幂等）——崩溃恢复直接重跑设计 run 即可，不需 worktree 重置。
- 升格映射（spec-design internal-apis §x.y → `ContractInterface`）可由设计 run 自身在收尾时产出结构化合同草案（写 `contract/draft.json` 之类），也可由包工头一个 phase 动作做抽取——前者让设计 run 自带升格逻辑、更内聚，推荐。
- Adversarial 刺清单建议结构化（按接口 id 分组 + 严重度 HIGH/MED/LOW），便于快拍卡展示"还有几条 HIGH 刺未消"，对齐 spec-design 自身的 plan-review-convergence"无 HIGH concern 才收敛"范式（Full 轨道）。
- Lite/Full 档位落点：可作为灯①拍板 payload 字段（人选档位），或按 PRD token 规模启发式默认；存进 workitem `context_json` 供设计 run 读。
