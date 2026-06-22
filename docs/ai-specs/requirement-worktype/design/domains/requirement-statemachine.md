# Domain: requirement-statemachine

> 层：**worktypes**（`src/worktypes/requirement/`）。**纯同步** reducer —— `index.ts` 禁 `async/await/fs/child_process`（CI 强制，见 [红线词表/layerFor](../../codebase-findings.md#res-redlines)）。一切 IO（写 journal、起 spec-design run、worktree 操作）只能声明为 `Transition.effects`/`dispatch`/`waits`，由 effect handler 在 worktypes 异步层执行——本域不直接做。
> 本域是 requirement worktype 的"中枢神经"：定义 `WorkType` 自身（7 phase + onEvent + topology + permissions + checkpoints + artifacts）、注册、7 阶段状态机骨架、包工头现状快照权威 + journal 写回校验门、异常监督编排、`/cancel` 收尾、灯④人点。

## 领域职责（负责什么 / 不负责什么）

**负责**：
- `requirementWorkType` 定义：7 phase 序列、`onEvent`（`requirementTransition`）、`topology()` 返 `'owner-workers'`、`permissions: write`、`checkpoints.requiredBefore`、`artifacts`（reportRequired + journal 校验门）。
- `registerRequirement(registry)` 注册（仿 `registerProbe`）。
- `requirementTransition`：7 阶段状态机的**事件分发骨架与 phase 推进**（各 event kind 分支），含交付→沉淀两段式停在非终态等信号。
- 包工头（Owner）**现状快照机械生成的权威约定** + **journal 写回校验门**（reportRequired 范式 + journal 存在性）。
- **异常监督编排**：worker 失败/卡死的容器侧 watchdog 信号如何在 onEvent 里转 retry / 升级 human wait（病历）；checkpoint 连拒 2 次升级对话。
- **`/cancel` 收尾状态机**：确认卡 → abort 全 worker → 回收 worktree → 收尾 journal → cancelled 终态；不删 artifact 仓。
- **灯④**（提交/交付的人点硬拦）：交付 phase 后停在非终态、开 MR/上线不自动执行，等人亲手点；平台纪律 prompt 自律 + 少量高危代码兜的状态机落点。

**不负责**（属其它域）：
- 单飞门 role 分流、inflight 键、批量唤醒**窗口实现**、父子链写入、并发崩溃恢复 → [container-concurrency](container-concurrency.md)（本域只**约定**"快照从结构化状态机械生成、批量带入不漏不重"的语义，窗口查询在容器侧）。
- checkpoint 拦截的 worktype 侧机制细节、resolveWait 带 decision、stale 校验 → [checkpoint-gate](checkpoint-gate.md)（本域 `checkpoints.requiredBefore` 声明边界、onEvent 调用其拦截逻辑）。
- 合同冻结/结构 diff/影响计算/`isDecisionStale` 纯函数体 → [contract-engine](contract-engine.md)（本域 onEvent 路由 contract 事件、`isRequirementDecisionStale` 委托其 diff）。
- worker run handler / 自测硬门 / 集成验证 effect / 前端 / 交付物产出 → [worker-runtime](worker-runtime.md)。
- 灯②接 spec-design 的 run 编排 → [design-phase](design-phase.md)。
- worktree add/remove/reset 的 git 实现、写权限档、卡片回调、预留槽 → [kernel-capabilities](kernel-capabilities.md)。
- 新事件 kind 清单/迁移/查询 → [data-model](data-model.md)。

## 核心概念（本域特有）

- **7 phase 序列（固定）**：`requirement:理解 → requirement:合同 → requirement:详设 → requirement:拆解 → requirement:并行实现 → requirement:集成验证 → requirement:交付/沉淀`。phase 名带 `requirement:` 前缀（与 probe `probe:looking` 同构），是 worktype 内部字符串、容器不解释（[res-worktype-interface](../../codebase-findings.md#res-worktype-interface)）。
- **Owner 现状快照（authoritative snapshot）**：包工头每次唤醒拿到的**从结构化状态（events/assignments/contract/open waits）机械生成的现状全貌**，是它产合同/任务卡/验收/影响分析的**唯一权威输入**。会话历史不是接口，journal 不是真相源。
- **journal 写回校验门**：owner run 收尾必须写 `journal.md`（人类可读叙事），代码 enforce 存在性（缺/空判收尾失败），但**权威判断不押在它上**——它是叙事补充，结构化状态才是真相。
- **病历（escalation dossier）**：举手找人时给的"卡哪 / 试过啥 / 为啥不行"，不甩原始报错；多为一句话/一个选项的轻救场。
- **交付→沉淀两段式**：到 `交付/沉淀` phase **停在非终态**等"提交/沉淀"信号（借鉴 probe `idle→close` 两段式），不自动收终态——灯④（开 MR/上线）必须人亲手点。
- **取消收尾链**：`/cancel` 不是直接置终态，而是一串收尾动作（确认 → abort → 回收 worktree → 收尾 journal）后才进 `cancelled` 终态。

## 数据契约（TypeScript 接口）

- `requirementWorkType: WorkType` 与 `registerRequirement(registry)` —— 详见 internal-apis.md **§4.1**（不就地写签名）。
- `requirementTransition(item, ev): Transition` 7 阶段状态机 —— 详见 internal-apis.md **§4.2**。
- `isRequirementDecisionStale(decision, eventsSince): boolean` —— 本域**声明在 WorkType 上**，函数体委托 contract-engine 的 `contractStructuralDiff`（[§1.2](../internal-apis.md)）；详见 internal-apis.md **§4.3**。
- `WorkType` / `Transition` / `AssignmentSpec` / `Decision` / `CheckpointPolicy` 基础接口 → [res-worktype-interface](../../codebase-findings.md#res-worktype-interface)（types.ts:140-150）。
- 新事件 kind 权威清单（`checkpoint_reached`/`checkpoint_decision`/`contract_*`/`worker_report`/`integration_check_*`/`design_ready`）→ internal-apis.md **§7**（本域 onEvent 据这些 kind 分支）。
- `parentAssignmentId` 扩展（owner→worker 父子链，本域 dispatch worker 时填）→ internal-apis.md **§2.1**。

## 涵盖的 AC

> Sensor2 校验依据。分配给本域的每条 AC 逐条列出。

**R08 worktype 骨架与生命周期（全部 6 条）**
- R08.AC-1：`/req <描述/PRD>` 触发 → 创建 `type:'requirement'` workitem（initialPhase `requirement:理解`）、认领话题、发锚点卡。（本域定 `initialPhase`/触发产 `workitem_created` 后的 transition；话题认领/锚点卡的接线在 workbench + index，本域只产 dispatch/phase）
- R08.AC-2：requirement worktype 注册 → 在 `createWorkitemsRuntime`（registerProbe 后）`registerRequirement`，复用通用 agent-run handler + 注册专有 effect handler（worker run / 集成验证 / checkpoint）。（本域提供 `registerRequirement`；注册位置在 index 接线）
- R08.AC-3：onEvent 处理事件 → 返回声明式 `Transition`（phase/dispatch/waits/effects），容器不解释 phase 名。
- R08.AC-4：各 phase 边界对应灯 → `理解→合同`(灯①)、`合同→详设`(灯②快)、`详设→拆解`(灯②慢)、`集成验证→交付`(灯③) 挂 checkpoint。（本域声明 `checkpoints.requiredBefore`；拦截机制在 checkpoint-gate）
- R08.AC-5：到达交付 → 停在非终态等"提交/沉淀"信号（借鉴 probe idle→close 两段式）。
- R08.AC-6（Error）：worktype index.ts 含 async/await/fs/child_process → 视为违规（纯同步 reducer，CI 拦）。

**R02 Owner 协调与重建（本域负责 AC1/AC4/AC5/AC6 —— 快照权威 / journal 校验；AC2/AC3/AC7 父子链/批量唤醒窗口属 container-concurrency）**
- R02.AC-1：Owner 被唤醒 → 给一份**从结构化状态（events/assignments/contract/open waits）机械生成的「现状快照」作为权威输入**。
- R02.AC-4（Edge）：结构化状态与 `journal.md` 叙事冲突 → 以**结构化状态为准**（journal 过时即重生成，非真相源）。
- R02.AC-5（Edge）：owner run 收尾 → 校验 `journal.md` 存在（照 reportRequired 门），但权威判断不押在它上。
- R02.AC-6（Error）：`journal.md` 缺失/空 → 判该 owner assignment 收尾失败（写回义务代码 enforce）。

**R20 异常与监督（全部 6 条）**
- R20.AC-1：worker 失败/卡死/空转 → 复用 watchdog（心跳+墙钟+deadline）→ `assignment_stalled` → retry 预算 → 耗尽建 human wait（多 worker 各自被监督，beats 按 assignmentId 隔离）。
- R20.AC-2：举手找人 → 给"病历"（卡哪/试过啥/为啥不行）不甩报错，轻救场。
- R20.AC-3（Edge）：checkpoint 被拒/回退 → 按 R03 回退，连拒 2 次升级对话。
- R20.AC-4（Edge）：集成验证失败 → 按 R13 派修复 assignment，循环上限 2 轮超则 human wait。
- R20.AC-5（Edge）：契约变更 → 按 R10 一等事件处理。
- R20.AC-6（Error）：worker run handler 没挂 onActivity → 风险：长思考被误判 stalled（worker 必须照 run-handler:138 挂 onActivity）。（约束落 worker-runtime，本域在监督编排里记此前提）

**R21 人工取消 /cancel 收尾（全部 3 条）**
- R21.AC-1：`/cancel`（thread 内）→ 弹确认卡（防误触）→ abort 所有 running assignment → 回收 worktree（分支保留、worktree 删除）→ Owner 最后唤醒写收尾 `journal.md`（半成品在哪个分支）→ cancelled 终态。
- R21.AC-2（Edge）：取消 → **不删 artifact 仓**（半途成果是资产，收尾 journal 让"重启这个需求"有入口）。
- R21.AC-3（Error）：终态后 thread 追问 → 诚实回执（"该需求已结束，可重新 /req"），不假装受理（复用 M1b 终态守卫）。

**R22 提交/交付（本域负责灯④ AC：AC2 灯④人点硬拦 + AC4 平台纪律；AC1/AC3 交付物产出属 worker-runtime）**
- R22.AC-2：到交付/提交（灯④）→ 只到"分支就绪 + 给出 MR 草稿/发布顺序"，**开 MR/上线的动作不自动执行**（必须人亲手点）。
- R22.AC-4（Error）：平台纪律（feature 基于 prod、pull --ff-only、MR 首行 rd:<id>）→ 少量高危用代码/hook 拦、大量靠 prompt 自律 + 写明 why（沿用 ai-sentinel 经验）。（状态机落点：灯④硬拦；纪律 prompt 在 worker prompt 组装侧）

## 设计细节（按功能点分节，写思路不写实现代码）

### 5.1 `requirementWorkType` 定义（照 probe 范本放大）
对照 [probeWorkType](../../codebase-findings.md#res-probeworktype)（probe/index.ts:12-22）逐字段放大：
- `id: 'requirement'`（命名安全，不在 kernel 禁词表，D-17）。
- `triggers`：`/req` 命令 + api（仿 probe `{api:true}`）。
- `initialPhase: () => 'requirement:理解'`（对应 probe `probe:looking`）。
- `onEvent: requirementTransition`（§5.2）。
- `isDecisionStale: isRequirementDecisionStale`（声明在此，体在 contract-engine 委托，§5.6）。
- `topology: () => 'owner-workers'`（**这是并行分流总开关**——返非 `'solo'` 触发 container-concurrency 单飞门按 role 分流；probe 返 `'solo'`）。
- `permissions: { mode: 'write', repos: [...] }`（workitems 层 write 档；映射 agents write 在 kernel-capabilities/worker-runtime）。
- `checkpoints: { requiredBefore: ['requirement:合同', 'requirement:详设', 'requirement:拆解', 'requirement:交付'] }`（4 个边界各挂一灯，§5.3；具体拦截在 checkpoint-gate）。
- `artifacts: { reportRequired: true }` + journal 校验门（§5.5）。
- 详见 internal-apis.md **§4.1**。
- **红线自查**：本文件（worktype index.ts）禁 `async/await/fs/child_process`（R08.AC-6）；所有副作用走 `Transition` 声明。

### 5.2 `requirementTransition` 7 阶段状态机（各 kind 分支）
仿 [probeTransition](../../codebase-findings.md#res-probeworktype)（probe/index.ts:28-61）的 `switch(ev.kind)` 骨架放大。详见 internal-apis.md **§4.2**。各 kind 分支语义：

- **`workitem_created`**：phase → `requirement:理解`，dispatch 一个 `role:'owner'` 的 run（包工头先读 PRD 产理解）。对应 R08.AC-1、R02 包工头首次唤醒。
- **`run_completed` / `worker_report`**：按当前 phase 与 assignment role 分流——
  - owner run 在 `理解` 完成 → 检 checkpoint（将越 `理解→合同` 边界）→ 委托 checkpoint-gate 决定是返 `waits:[human]`（灯①未拍板）还是推进 phase。
  - worker run 完成（`worker_report`）在 `并行实现` → 不直接推进 phase，**记事件、等批量唤醒 owner**（窗口在 container-concurrency），owner 下次唤醒据快照判该批是否齐、是否进集成验证。
- **`checkpoint 拍板`（`wait_resolved` 带 decision）**：委托 checkpoint-gate 消费 decision（含 stale 校验，R03.AC-7）→ approved 则 onEvent 返回 phase 推进越过该边界并记 `checkpoint_decision`；rejected 则按灯回退（灯②→设计 phase、灯③→集成验证派修复，R20.AC-3）。回退由本域 worktype 逻辑定，对容器只是 `phase_changed`。
- **`contract_frozen` / `contract_patched` / `contract_change_*`**：路由给 contract-engine 处理（R20.AC-5、R10）；本域负责把其结果落成 phase 推进/回退/dispatch 返工 worker（带 `replacesAssignmentId` 链 + `parentAssignmentId`）。
- **`integration_check_passed` / `integration_check_failed`**：在 `集成验证` phase —— passed 且代码层绿 → 检 `集成验证→交付` 边界（灯③）→ 委托 checkpoint-gate；failed → 派修复 assignment（独立计数 ≤2 轮，超则 human wait，R20.AC-4，计数器约定见 §5.7）。
- **`design_ready`**：在 `详设` phase，spec-design run 产物就绪 → 检 `详设→拆解` 边界（灯②慢）。
- **`run_failed` / `assignment_stalled`**：异常监督路由（§5.7）。
- **`human_message`**：追问/介入——非终态时按当前 phase 注入 owner 唤醒（仿 probe `human_message` 重新 dispatch）；终态时由终态守卫拦（§5.9）。
- **`close_requested`**：交付→沉淀两段式收尾信号（§5.4）。
- **`default`**：返 `{}`（容器 default 不解释，[res-worktype-interface](../../codebase-findings.md#res-worktype-interface)）。
- ⚠️ **同帧不变量**：`terminal` 转移直接 drop 同帧 dispatch/waits/effects（[reducer 纯转移不变量](../../codebase-findings.md#res-reducer-purity) reducer.ts:277-308）——owner 收尾同帧不能再派 worker；取消/done 收尾的 phase 推进与终态不能同帧塞 dispatch。

### 5.3 checkpoint 边界声明（4 灯挂 phase 边界）
`checkpoints.requiredBefore` 列 4 个边界 phase（D-02 拆 phase 复用现成 `requiredBefore: string[]` 语义，不引入独立 checkpoint id）：

| 灯 | 边界（requiredBefore 列的目标 phase） | 含义 |
|----|------|------|
| 灯① | `requirement:合同` | 越 `理解→合同` 前停，对齐需求 + 定档位 |
| 灯②快 | `requirement:详设` | 越 `合同→详设` 前停，两三分钟扫接口清单 |
| 灯②慢 | `requirement:拆解` | 越 `详设→拆解` 前停，逐块细审各端详设 |
| 灯③ | `requirement:交付` | 越 `集成验证→交付` 前停，验收 |

本域只**声明边界**；onEvent 检测"将越界且未拍板"时**主动返回 `waits:[human]` 而非 phase 变更**（D-03 增补 Gate5-C06，机制在 [checkpoint-gate](checkpoint-gate.md)，容器完全不碰 phase）。R08.AC-4。**灯④（交付→提交）不靠 requiredBefore**，是交付 phase 后的两段式停（§5.4），因为它后面没有要"越过"的 phase 边界，而是停在非终态等人点。

### 5.4 交付→沉淀两段式 + 灯④人点（R08.AC-5 / R22.AC-2 / R22.AC-4）
借鉴 probe `run_completed→probe:idle`（非终态）、`close_requested→probe:done`（终态）的两段式：
- 进 `交付/沉淀` phase 后**停在非终态**（不自动 `terminal`），等"提交/沉淀"信号。
- 灯④ = 交付 phase 的人点硬拦：onEvent **不产出任何"开 MR/上线"的自动 effect**——只产"分支就绪 + MR 草稿 + 发布顺序"的交付物（产出在 worker-runtime），状态机停住等人。**AI 不自主开 MR**（D-14：会误触发飞书研发任务节点）。R22.AC-2。
- 平台纪律（feature 基于 prod、pull --ff-only、MR 首行 rd:<id>）：本域状态机层面只保证"灯④硬拦"这一处高危用代码拦死；大量纪律靠 worker prompt 自律 + 写明 why（prompt 组装在 worker-runtime，沿用 ai-sentinel 经验，D-14）。R22.AC-4。
- 人点提交信号到达（经飞书灯④卡 / 工作台按钮 → inject 门面）→ onEvent 收沉淀（写回知识层等动作在 worker-runtime/knowledge-layer 触发）→ 终态 `done`。

### 5.5 包工头现状快照权威 + journal 写回校验门（R02.AC-1/4/5/6）
- **快照权威（R02.AC-1/AC-4）**：每次 owner 唤醒，给它的输入是**从结构化状态机械生成的现状快照**（events/assignments/contract/open waits 投影），不是会话历史、不是 journal。快照生成的"组批窗口"（自上次 owner run 以来的事件，左开右闭半开区间）在 container-concurrency 实现（复用 [lastRunEffectSeqBefore + eventsSince](../../codebase-findings.md#res-checkdecision)）；本域**约定**："结构化状态为权威，journal 冲突时以结构化为准"（D-07）。快照内容的**组装**（把 events/assignments/contract 拼成 owner prompt）在 worker-runtime 的 owner run handler；本域只定权威性约束。
- **journal 写回校验门（R02.AC-5/AC-6）**：owner run 收尾必须写 `journal.md`，照 [validateRunReport / reportRequired 门](../../codebase-findings.md#res-validaterunreport)（effects.ts:295-312）范式**在 worktype 层另建校验**——[ArtifactStore.isClean](../../codebase-findings.md#res-artifactstore) 只判 git 工作区干净、无内容校验，故 journal 存在性校验要 worktype 自己做：缺/空 → 判该 owner assignment 收尾失败（run_failed），不放行。**权威判断不押在 journal 上**——它是叙事补充，结构化状态才是真相源。D-07。
- artifact 仓布局（`brief.md / journal.md / decisions.md / contract/ / design/`）见 [data-model](data-model.md) + [res-artifactstore](../../codebase-findings.md#res-artifactstore)；本域只约定 journal 校验门。

### 5.6 `isRequirementDecisionStale` 声明（委托 contract-engine）
本域在 `requirementWorkType` 上**声明** `isDecisionStale: isRequirementDecisionStale`（替换 probe 的 `()=>false`）。函数体是纯同步纯函数，**仅凭 `decision.data`（固化的 contract 结构指纹）+ `eventsSince` 判定**，禁 fs/await（D-05 增补 Gate5-C04），调用 contract-engine 的 [contractStructuralDiff](../internal-apis.md)（§1.2）。详见 internal-apis.md **§4.3**。接入点 [checkDecision](../../codebase-findings.md#res-checkdecision)（reducer.ts:746-801）**容器侧已就绪、无需改 reducer**——worktype 只填这个纯函数。

### 5.7 异常监督编排（R20）
复用现成监督设施，本域只做 onEvent 侧的转移决策：
- **worker 失败/卡死/空转（R20.AC-1）**：[Watchdog](../../codebase-findings.md#res-watchdog)（watchdog.ts:34-157，1Hz sweep）按 assignmentId 隔离 beats（多 worker 心跳天然不串），探到停滞产 `assignment_stalled`。onEvent 收 `assignment_stalled`/`run_failed` → 委托容器 [redispatchOrEscalate](../../codebase-findings.md#res-redispatchorescalate)（reducer.ts:519-559）：retries < retryBudget 则 superseded + 重派 replacement；耗尽则建 `{kind:'human', reason:'retry_exhausted'}` wait。多 worker 各自被监督。
- **病历（R20.AC-2）**：举手建 human wait 时，wait/事件 payload 带"卡哪 / 试过啥 / 为啥不行"，轻救场（一句话/一个选项），不甩原始报错。
- **测试无法执行 vs 断言失败的分流**（R11.AC-7 在 worker-runtime，但举手路径回到本域）：worker run 报"测试无法执行（命令缺失/环境/编译基础设施）"→ **不进自动 retry、直接举手**并标根因，避免烧 retry 预算（病历标根因类型）。本域在 onEvent 区分这两类 run_failed payload，决定走 redispatch 还是直接 human wait。
- **checkpoint 连拒升级（R20.AC-3）**：同一 checkpoint 连续被拒 2 次 → 升级为对话（复用 [discard_streak 基因](../../codebase-findings.md#res-five-tables)，store 有 `discard_streak` 列），不再自动重试。判定与回退在 checkpoint-gate，本域据其结果定 phase 回退。
- **集成验证修复循环（R20.AC-4）**：失败 → 派修复 assignment（新 worker，不复活旧），**独立计数 ≤2 轮**（D-11：锚在"逻辑任务 repo+phase"而非物理 assignment；replacement 继承前任返工计数；**不复用 [assignment.retries](../../codebase-findings.md#res-redispatchorescalate)**，那是 stall 预算）；超 2 轮建 human wait 升级。计数器存 `context_json` 或专用事件统计。
- **契约变更（R20.AC-5）**：路由给 contract-engine 一等事件流程（§5.2 contract_* 分支）。
- ⚠️ **前提（R20.AC-6）**：worker run handler 必须照 [run-handler:138](../../codebase-findings.md#res-createagentrunhandler) 挂 onActivity 喂心跳（约束落 worker-runtime），否则长思考被 watchdog 误判 stalled。本域监督编排依赖此前提成立。

### 5.8 `/cancel` 收尾状态机（R21）
`/cancel`（thread 内文本命令，命令解析在 bridge/commands.ts 只搬运不解释）→ 注入门面 → onEvent 编排一串收尾动作，**不是直接置终态**：
1. **确认卡防误触（R21.AC-1）**：首次 `/cancel` → onEvent 返回 `waits:[human]`（确认 wait）+ 发确认卡，不立即 abort。人点"确认取消"（resolveWait）后才真收尾。
2. **abort 全 worker**：收尾时对所有 `status='running'` 的 assignment 产 abort（容器 PostCommitAction abort_effect，[reducer 纯转移不变量](../../codebase-findings.md#res-reducer-purity)）；per-assignment abort 不误伤——靠 container-concurrency 的 inflight 键改造，本域产取消意图即可。
3. **回收 worktree**：声明 effect 调 kernel [worktreeRemove](../internal-apis.md)（§5.4，分支保留、worktree 删除）；git 操作在 kernel 异步层，本域只声明。
4. **收尾 journal**：最后唤醒 owner 写收尾 `journal.md`（记半成品在哪个分支），过 journal 校验门（§5.5）。
5. **cancelled 终态**：复用现有 `cancelled` 态 + finalizeTerminalState；**不删 artifact 仓**（R21.AC-2，半成品是资产，收尾 journal 让"重启这个需求"有入口；不删半成品分支）。
- ⚠️ 同帧约束：终态 phase 推进不能同帧再塞 worker dispatch（§5.2 同帧不变量），收尾动作分多帧推进。

### 5.9 终态守卫（R21.AC-3）
复用 M1b 终态守卫：cancelled/done/failed 终态后，thread 追问（`human_message`）→ onEvent **不假装受理**，诚实回执"该需求已结束，可重新 /req"（仿 probe 终态后行为）。判定下沉 `isTerminalStatus` 纯函数（kernel 侧由 [createWorkitemsRuntime](../../codebase-findings.md#res-createworkitemsruntime) 用 anchorAction + isTerminalStatus 分发，避 `status===`）。

### 5.10 `registerRequirement` 注册接线（R08.AC-2）
仿 [registerProbe](../../codebase-findings.md#res-probeworktype)：`registerRequirement(registry)` 调 `registry.register(requirementWorkType)`。注册位置在 [createWorkitemsRuntime](../../codebase-findings.md#res-createworkitemsruntime)（index.ts:871 registerProbe 后追加），由 index 接线（D-15 三处接线之一）。复用通用 agent-run handler；worker run / 集成验证 / checkpoint 的专有 effect handler 由 worker-runtime/checkpoint-gate 提供、index 侧 `effects.registerHandler` 注册。详见 internal-apis.md **§4.1**。

## 与其他领域的交互（调用方向）

- **本域 → container-concurrency**：`topology()` 返 `'owner-workers'` 触发单飞门 role 分流；dispatch owner/worker（带 `parentAssignmentId`）；依赖其批量唤醒窗口产快照输入、per-assignment abort、并发恢复。
- **本域 → checkpoint-gate**：`checkpoints.requiredBefore` 声明 4 边界；onEvent 委托其拦截（返 waits 而非 phase）、消费 decision（含 stale 校验）、连拒升级、灯回退判定。
- **本域 → contract-engine**：`isRequirementDecisionStale` 委托 `contractStructuralDiff`；contract_* 事件路由其处理；大改回灯②、小改自治留痕的结果落本域 phase。
- **本域 → worker-runtime**：dispatch worker run（专有 handler 在那）；owner 快照组装、journal 内容、交付物产出、自测硬门、集成验证 effect、前端在那；本域定 phase 推进与监督转移。
- **本域 → design-phase**：`详设` phase 触发 spec-design run（effect 编排在那），收 `design_ready` 推进。
- **本域 → kernel-capabilities**：取消收尾声明 worktreeRemove effect；worker write 档 permissions。
- **本域 → knowledge-layer**：交付沉淀写回知识（effect 在那触发）。
- **本域 → workbench**：phase/wait 状态驱动锚点卡 + 工作台焦点卡（投影读，单向）；灯④/确认卡/灯回退经 inject 门面回流（写）。
- **被调**：index 接线调 `registerRequirement`；容器 reducer 调 `onEvent`/`isDecisionStale`/`topology`/读 `checkpoints`/`permissions`/`artifacts`。

## 相关决策

- **D-02** 🔶 灯②快慢两拍靠拆 phase，7 phase 序列固定（§5.1/5.3）。
- **D-03** checkpoint 单轨 = human wait 用法 + 拦截做 worktype 侧（§5.2/5.3，机制在 checkpoint-gate）。
- **D-07** Owner 重建 = 结构化快照权威 + journal 辅，冲突结构化优先（§5.5）。
- **D-11** 🔶 修复/返工循环用独立计数、不复用 assignment.retries、replacement 继承计数（§5.7）。
- **D-14** 开 MR/上线人亲手点，平台纪律 prompt 自律为主（§5.4）。
- **D-15** requirement worktype 三处接线，复用通用 handler + 注册专有 handler（§5.10）。
- **D-17** 命名安全：requirement 安全，业务逻辑全在 worktypes 层（§5.1，红线自查）。
- **D-05/D-31** isDecisionStale 用结构 diff、结构指纹入 decision.data、纯同步不读 fs（§5.6，委托 contract-engine）。
- **D-09/D-27** worker 崩溃恢复 + worktree 重置子系统（取消回收 worktree §5.8 复用同一 kernel 层）。

## 引用的内部 API

> 给 internal-apis.md §x.y 锚点，不就地写签名。

- internal-apis.md **§4.1** — `requirementWorkType` + `registerRequirement`（§5.1/5.10）。
- internal-apis.md **§4.2** — `requirementTransition(item, ev)` 7 阶段状态机（§5.2）。
- internal-apis.md **§4.3** — `isRequirementDecisionStale`（§5.6，委托 §1.2 `contractStructuralDiff`）。
- internal-apis.md **§2.1** — AssignmentSpec `parentAssignmentId` 扩展（§5.2 dispatch worker 时填）。
- internal-apis.md **§2.6** — resolveWait 扩展 decision（§5.2 checkpoint/确认卡消费，机制在 checkpoint-gate）。
- internal-apis.md **§5.4** — kernel worktree 生命周期 `worktreeRemove`（§5.8 取消回收）。
- internal-apis.md **§7** — 事件 kind 权威清单（§5.2 onEvent 据此分支）。
- internal-apis.md **§1.2** — `contractStructuralDiff`（§5.6 跨域共享，只引用不重定义）。

## 边界约束（Must / Never）

**Must**：
- 7 phase 序列**固定**：`理解→合同→详设→拆解→并行实现→集成验证→交付/沉淀`。
- 业务逻辑全在 `src/worktypes/requirement/`；worktype `index.ts` **纯同步**（禁 async/await/fs/child_process，CI 拦，R08.AC-6）。
- `requirement` 命名安全（不在 kernel 禁词表），但 phase 状态机/WorkItem/Assignment 类型只在 worktypes 层自由用。
- 结构化状态为**权威**；快照机械生成；journal 冲突以结构化为准（R02.AC-1/AC-4）。
- owner 收尾 journal 写回校验门 enforce（缺/空判失败，R02.AC-5/AC-6）。
- 拍板 = resolve wait + decision **原子**（不另起双轨，复用 resolveWait）。
- 异常路径先自治重试再举手；举手给病历不甩报错（R20.AC-1/AC-2）。
- 修复/返工循环独立计数（不复用 assignment.retries），replacement 继承计数（R20.AC-4，D-11）。
- `/cancel` 确认卡防误触 → abort 全 worker → 回收 worktree → 收尾 journal → cancelled 终态（R21.AC-1）。
- 灯④硬拦：开 MR/上线**不自动执行**，停非终态等人点（R22.AC-2）。
- `terminal` 收尾同帧不再派 worker（reducer 同帧不变量）。

**Never**：
- 容器层**不出现** requirement 专有逻辑（phase 名/contract 语义/检查点判定不漏进 workitems/kernel）。
- 不在 worktype index.ts 用 async/await/fs/child_process（CI 红）。
- 不出现第二个叫 task 的概念（子任务统一 assignment，D-17）。
- 不把对话历史当 Owner/Worker 接口；不让 journal 成为真相源（R02 Never）。
- 不靠 prompt 提醒模型停下（灯 = human wait 硬卡，不是 prompt 提醒，R03 内核）。
- 不在本域纯函数里调 LLM / 读 fs 判 stale（reducer/worktype 纯同步，D-05）。
- 不删 artifact 仓、不删半成品分支（取消时，R21.AC-2 Never）。
- 不假装受理终态追问（R21.AC-3）。
- AI 不自主开 MR/上线（会误触发飞书研发任务节点，D-14）。
- 不用 `assignment.retries` 计修复/返工循环（D-11）。

## 可能的实现提示（可选）

- 7 phase 状态机建议用**当前 phase + event kind 双维 dispatch**（`switch(item.phase){ case ...: switch(ev.kind) }` 或表驱动），比 probe 单层 switch 复杂——因为同一 `run_completed` 在不同 phase（理解/并行实现）语义不同。
- checkpoint 边界检测可抽 helper `crossesCheckpoint(fromPhase, toPhase, requiredBefore)`：纯函数判"目标 phase 是否在 requiredBefore 且对应 gate 未 resolve"，供 onEvent 各推进点统一调用（机制细节归 checkpoint-gate）。
- journal 校验门复用 reportRequired 范式：在 worktype 侧加 `validateOwnerJournal(workitemId)`——读 [ArtifactStore.readFile](../../codebase-findings.md#res-artifactstore) 判 `journal.md` 非空（这是 effect handler 侧的 IO，不在纯同步 index.ts；onEvent 只声明"需要校验"，校验在 owner run handler 收尾，worker-runtime 协作）。
- 修复/返工独立计数器：建议存 `context_json` 的专用键（如 `integrationFixRounds` / `contractChangeRounds.<repo>`），onEvent 读 item.context 判上限；replacement 继承时把前任计数透传进新 dispatch 的 payload（D-11 锚"逻辑任务 repo+phase"）。
- 取消收尾用**多帧推进**：确认 wait resolve（帧1）→ abort + worktree 回收 effect + owner 收尾唤醒（帧2）→ 收 owner run_completed + journal 校验过 → cancelled 终态（帧3），避免同帧塞 dispatch 被 terminal drop。
