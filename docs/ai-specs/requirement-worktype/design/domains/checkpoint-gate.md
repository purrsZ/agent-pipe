# Domain: checkpoint-gate

> 4 灯关卡领域。把"该人拍板处真卡住"做成 **human wait 的一种用法（单轨）**，拦截做在 **worktype 侧**（不碰容器 phase），拍板复用扩展后的 `resolveWait` 携带 decision，并在消费前过 stale 校验。
> 层：workitems（容器侧只提供 `requiredBefore` 声明 + decision 消费管道）+ worktypes（拦截/拍板/回退/升级逻辑全在 `src/worktypes/requirement/checkpoint.ts`）。

## 领域职责（负责什么 / 不负责什么）

**负责**：
- 4 灯（灯①对齐需求 / 灯②审设计·快慢两拍 / 灯③验收 / 灯④提交）作为 phase 边界 human wait 拦截的**统一机制**——在 worktype onEvent 检测"将越过 `requiredBefore` 边界且该 gate 未 resolve"时，**主动返回 `waits:[human]` 而非 phase 变更**，让容器完全不碰 phase。
- 拍板动作语义：扩展 `resolveWait(waitId, {operator, reason, decision})` 让"解 wait + 产出决定"一个动作原子完成（不新增并行 inject 方法）。
- 拍板被 reducer 消费前的 **isDecisionStale 校验**（R10.AC7）——decision 基于的合同版本若已被自治小改触动 → 拒绝 resolve 并重弹卡"合同已变、请重新确认"，不静默推进。
- 灯②打回回设计 phase、灯③打回回集成验证 phase（回退由 worktype 逻辑定，对容器只是一次 `phase_changed`）。
- 同一 checkpoint 连拒 2 次升级为对话（复用 `discard_streak` 基因）。
- 灯②快慢两拍各挂一个 phase 边界（`合同`/`详设`/`拆解`），靠**拆 phase** 实现两拍而非引入独立 checkpoint id。

**不负责**：
- 合同结构 diff / `contractStructuralDiff` / 合同指纹固化的**实现**——属 contract-engine 域，本域只**调用**它来判 stale，并约定"decision.data 必须携带指纹"这一硬接口前提。
- 7 phase 状态机主干、phase 名常量、onEvent 其它 kind 分发——属 requirement-statemachine 域，本域只贡献其中"checkpoint 拦截/拍板/回退"这几条转移分支的设计。
- 飞书灯卡的卡片构造 / 卡片回调透传 / 工作台按钮回流——属 workbench 域；本域只约定"拍板入口必经 `resolveWait` 门面"。
- effect 多并发 / inflight 键 / abort 粒度——属 container-concurrency 域。

## 核心概念（本域特有）

- **关卡（Checkpoint）= phase 边界 human wait**：不是独立的 checkpoint id，而是"`checkpoints.requiredBefore` 声明的某个 phase 名"。要越过它必须先有一条被 resolve 的 human wait。这是"单轨"的全部含义：关卡就是 human wait 的一种用法。
- **拦截在 worktype 侧（不碰容器 phase）**：因为 `mergeTransitions` 只取 worktype 侧的 phase（容器无法覆写 `transition.phase`），所以拦截**不能**靠容器在消费 phase 前压制，而必须由 worktype onEvent 自己"在该越界时改返 `waits:[human]`"。容器侧只保留两件事：`requiredBefore` 声明 + decision 消费（resolveWait → wait_resolved → onEvent 重新被唤醒）。
- **拍板原子（resolve + decision）**：拍板 = 通过/打回 + 理由 + payload，一个 `resolveWait` 调用同时解 wait、记 `checkpoint_decision` 事件、产出决定数据，由 onEvent 据决定推进/回退 phase。
- **decision 过期（stale）**：人在 t0 看到合同版本 V1 后拍板，但 t0→拍板期间合同被自治小改成 V2，则这次拍板"基于旧版本"。stale 判定靠**预先固化进 `decision.data` 的合同结构指纹** + `eventsSince`（纯同步、不读 fs）。
- **快慢两拍（灯②）**：灯②不是一个关卡，而是两个 phase 边界——`合同→详设`（快拍：两三分钟扫接口清单够不够用）+ `详设→拆解`（慢拍：逐块细审各端详设）。
- **连拒升级**：同一关卡被打回 2 次，不再自动重试，升级为人工对话 human wait（病历 = "改了 2 次还没定，设计本身可能有问题"）。

## 数据契约（TypeScript 接口）

- **`resolveWait` 扩展决策语义**：input 加 `decision?: { approved: boolean; payload?: unknown }`——详见 internal-apis.md §2.6，不就地重写签名。enqueue `wait_resolved` 时 payload 携带 decision；reducer 消费前过 isDecisionStale，stale 则拒绝 resolve + 重弹卡。
- **`requirementTransition`（7 阶段状态机，含 checkpoint 拦截分支）**：详见 internal-apis.md §4.2。本域贡献"检测到将越 `requiredBefore` 边界且未 resolve → 返 `waits:[human]`"这条分支，以及打回回退分支。
- **`isRequirementDecisionStale(decision, eventsSince)`**：纯同步、禁 fs/await——详见 internal-apis.md §4.3。本域**调用方**：在 reducer 的 `checkDecision`（[res-checkdecision](../codebase-findings.md#res-checkdecision)）链路里被 `type.isDecisionStale(...)` 调用消费。其内部用 contract-engine 的 `contractStructuralDiff`（internal-apis.md §1.2，跨域共享 utility，本域只引用不定义）。
- **`checkpoints: { requiredBefore: string[] }`**：requirementWorkType 上声明 `['requirement:合同', 'requirement:详设', 'requirement:拆解', 'requirement:交付']`——详见 internal-apis.md §4.1。容器侧 `CheckpointPolicy` 类型见 [res-worktype-interface](../codebase-findings.md#res-worktype-interface)。
- **decision.data 固化合同指纹（硬接口前提）**：见 internal-apis.md §6.3——decision 产出时把所基于的 `ContractSnapshot.fingerprint` 固化进 `decision.data`，使 stale 判定纯同步可达。这是 checkpoint-gate 对 contract-engine 的**消费约定**，不在本域实现。
- **事件 kind**：`checkpoint_reached` / `checkpoint_decision`——见 internal-apis.md §7（权威清单），容器不解释，worktype onEvent switch 自行处理。

## 涵盖的 AC

> 分配给本域：R03 全部 7 条 AC（含回补 AC7）+ R10.AC7（checkpoint decision 过 stale 校验）。逐条列出作为 Sensor2 校验依据。

- **R03.AC-1（回补覆盖）**：worktype onEvent 检测到"将越过 `requiredBefore` 边界且该 gate 未 resolve" → 由 **worktype 主动返回 `waits:[human]` 而非 phase 变更**（拦在 worktype 侧，容器完全不碰 phase，保 mergeTransitions 不变量）；gate resolve 后 onEvent 再返回 phase 推进。〔Gate5-C06〕
- **R03.AC-2**：维护者拍板 → 通过扩展的 `resolveWait(waitId, {operator, reason, decision:{approved, payload?}})` 一个动作同时 resolve wait + 产出决定；reducer apply 后由 worktype onEvent 据决定推进/回退 phase。
- **R03.AC-3**：gate 通过 → 推进 phase 越过该边界并记 `checkpoint_decision` 事件。
- **R03.AC-4**：灯②打回 → 回退到设计 phase；灯③打回 → 回退到集成验证并派修复 assignment（回退由 worktype 逻辑定，对容器只是 `phase_changed`）。
- **R03.AC-5**：同一 checkpoint 连续被拒 2 次 → 升级为对话（复用 `discard_streak` 基因），不再自动重试。
- **R03.AC-6**：容器侧**不**试图直接覆写 `transition.phase` 拦截（mergeTransitions 只取 worktype 的 phase）——拦截在 `applyTransitionWrites` 消费 phase 前或改走 wait 机制（本设计选"改走 wait 机制 + worktype 侧返 waits"，即 AC1 的落法）。
- **R03.AC-7（新增）**：reducer 消费 checkpoint decision 前走 isDecisionStale 校验；IF stale（合同在拍板前已被自治小改触动）→ **拒绝 resolve 并重弹卡"合同已变、请重新确认"**，不静默推进。〔Gate3-C06〕
- **R10.AC-7**：checkpoint decision 过 stale 校验的数据流硬约定——decision 产出时把所基于的 contract 结构指纹**固化进 `decision.data`**；contract 变更事件 payload 携带变更后结构指纹/字段级 diff，使 isDecisionStale **仅凭 `decision.data` + `eventsSince` 纯同步判定、不读 fs**。〔Gate5-C04 阻塞〕（本域为消费方，约定该数据流前提；指纹生成在 contract-engine。）

## 设计细节（按功能点分节）

### 5.1 关卡 = phase 边界 human wait（单轨）

灯不另起双轨，就是"phase 越界前必须有一条被 resolve 的 human wait"。`requirementWorkType.checkpoints.requiredBefore` 声明四个边界 phase 名：

```
requiredBefore = ['requirement:合同', 'requirement:详设', 'requirement:拆解', 'requirement:交付']
```

- 灯①对齐需求 → 挂 `理解 → 合同`（`requirement:合同` 在 requiredBefore）
- 灯②快拍审合同 → 挂 `合同 → 详设`（`requirement:详设`）
- 灯②慢拍审详设 → 挂 `详设 → 拆解`（`requirement:拆解`）
- 灯③验收 → 挂 `集成验证 → 交付`（`requirement:交付`）

> 灯④（开 MR/上线人亲手点）属 requirement-statemachine 域的"交付/沉淀停非终态等外部信号"，不通过 requiredBefore 拦 phase，本域不重复设计——见 design-phase / requirement-statemachine。

### 5.2 拦截做在 worktype 侧（容器不碰 phase）—— R03.AC-1/AC-6 落法

**根因约束**：`mergeTransitions`（[res-containertransition](../codebase-findings.md#res-containertransition)，reducer.ts:886-894）合并规则是 **phase/terminal 只取 worktype 侧**，容器侧无法直接覆写 `transition.phase`。`applyTransitionWrites`（reducer.ts:263-276）消费 `transition.phase` 时已无拦截余地。因此 AC6 明确：**不在容器层拦 phase**。

**落法**：拦截逻辑放 worktype onEvent（`requirementTransition`，internal-apis.md §4.2）。当某事件本会推动 phase 越过 `requiredBefore` 里的某个边界、而该 gate 对应的 human wait 尚未 resolve 时：

- onEvent **不返回 `phase` 变更**，改返回 `waits: [{ kind: 'human', reason: 'checkpoint:<边界名>', ... }]`（同时可记 `checkpoint_reached` 事件供锚点卡刷新）。
- 容器照常 insert 这条 human wait（容器只认"建一条 human wait"，不解释 reason 里的业务含义）。投影 `computeRollup`（[res-projection](../codebase-findings.md#res-projection)）让 status 显示 `waiting/human`，焦点卡据此查"该你了"。
- 维护者拍板 resolve 后，`wait_resolved`（带 decision）事件再次唤醒 worktype onEvent，此时 gate 已 resolve，onEvent 才返回 `phase` 推进越过边界（R03.AC-3），并记 `checkpoint_decision`。

> 这样容器**全程不碰 phase**，mergeTransitions 不变量保住；checkpoint 是纯 worktype 行为，feishu/index 层零业务词。

### 5.3 拍板 = resolve + decision 原子 —— R03.AC-2/AC-3

- 扩展 `resolveWait` input 加 `decision?: { approved: boolean; payload?: unknown }`（internal-apis.md §2.6，改 api.ts:40-54）。当前 input 仅 `{operator, reason}`（[res-workitemsapi](../codebase-findings.md#res-workitemsapi)），新增 decision 字段，**不新增并行 inject 方法**（守"单一注入口"）。
- 拍板路径（飞书卡片回调 / 工作台按钮，均经 workbench 域 → inject 门面）调 `resolveWait(waitId, {operator, reason, decision})`。
- reducer enqueue `wait_resolved`，payload 携带 decision。`applyWaitResolved`（reducer.ts:452-467）消费 wait_resolved 把 wait 标 resolved；其后 onEvent 据 decision.approved：
  - `approved=true` → 返回 phase 推进越界 + 记 `checkpoint_decision`（payload 记 approved/reason/决策快照）。
  - `approved=false` → 走 5.4 打回回退。
- `checkpoint_decision` 是新事件 kind（internal-apis.md §7），容器不解释，worktype onEvent switch 自行处理。

> ⚠️ decision.data 必须固化所基于的合同结构指纹（5.5 用），由产出 decision 的拍板路径在 payload 里带上。

### 5.4 打回回退 —— R03.AC-4

打回（`decision.approved=false`）由 **worktype onEvent 逻辑**决定回退到哪个 phase，对容器只是一次普通 `phase_changed`：

- 灯②（快拍/慢拍）打回 → onEvent 返回 `phase: { to: 'requirement:详设', reason: 'checkpoint_rejected' }`（回设计 phase 重走，流程伸缩 Lite/Full 见 design-phase）。
- 灯③打回 → onEvent 返回 `phase: { to: 'requirement:集成验证', ... }` + `dispatch`（派修复 assignment，新 worker 不复活旧；修复 assignment 的派发细节属 worker-runtime 域，本域只定"打回触发回集成 phase + 带修复 dispatch"）。

> 回退 phase 一律由 worktype 返 `phase`，容器照单接受（worktype 侧 phase 权威）。打回理由（reason）写入 decision，工作台决策台账可展开看（workbench 域）。

### 5.5 decision 消费前过 stale 校验 —— R03.AC-7 / R10.AC-7

**接入点已就绪、无需改 reducer 结构**：reducer 的 `checkDecision`（[res-checkdecision](../codebase-findings.md#res-checkdecision)，reducer.ts:746-761）已经是"先 `structuralCheck`，再 `eventsSince` + `type.isDecisionStale(...)`"。checkpoint decision 走同一链路：

- decision 产出时把所基于的 `ContractSnapshot.fingerprint` **固化进 `decision.data`**（5.3 拍板路径负责，硬约定见 internal-apis.md §6.3）。
- `isRequirementDecisionStale(decision, eventsSince)`（internal-apis.md §4.3，纯同步）判：`decision.data` 里固化的指纹 != 当前 / `eventsSince` 含触及同一 repo 的 `contract_change_applied`（或 `contract_patched`）→ stale。判据复用 contract-engine 的 `contractStructuralDiff`（§1.2，跨域共享）。
- **stale 时的处置（R03.AC-7 重弹卡）**：`checkDecision` 返回 `{ok:false, reason:'semantically_stale'}`。这条 decision 被判 discarded，**拒绝推进 phase**；worktype onEvent 据此**重弹关卡卡**"合同已变、请重新确认"——即不消费这次拍板的 approved、重新建一条 checkpoint human wait（或保留原 wait 不 resolve），把最新合同版本指纹带进新卡。不静默推进。

> ⚠️ stale 判定必须纯同步、禁 fs/await（reducer 不能 await，纯函数拿不到 artifact 仓合同文件）——这是 internal-apis.md §6.3 数据流前提存在的全部原因：把"读文件比对"前移成"固化指纹 + 事件携带指纹"。本域**不在** reducer/纯函数里调 LLM 判 stale。

### 5.6 连拒 2 次升级对话 —— R03.AC-5

**复用现成 `discard_streak` 基因**（[res-checkdecision](../codebase-findings.md#res-checkdecision) 邻域）：`handleDiscardedDecision`（reducer.ts:651-691）已实现"decision 被 discard → `discardStreak + 1`；streak >= 2 → 建 `thrash` human wait + audit `thrash_escalated` + 清 streak；否则 redispatch"。

- checkpoint decision 被打回 / 判 stale 走 discarded 路径时，自然累加 `discardStreak`；连续 2 次 → 现成升级机制建人工对话 human wait（不再自动重试）。
- **本域注意**：checkpoint 的"连拒"语义（打回/stale 不定）与 redispatchOrEscalate 的"stall 卡死重试"语义不同；本域升级走 `discard_streak`（决策语义返工），**不复用** `assignment.retries`（那是 stall 预算，决策 D-11）。契约同接口反复改 2-3 次举手（R10.AC6）属 contract-engine 域，用其独立计数；本域只管 checkpoint 自身连拒。

### 5.7 灯②快慢两拍靠拆 phase —— R03 Should / D-02

灯②两拍不是一个关卡分两次，而是**两个独立 phase 边界**各挂一个 checkpoint（复用现成 `requiredBefore: string[]` 语义，不引入独立 checkpoint id）：

- 快拍（合同→详设）：人两三分钟扫接口清单"够不够用、有没有漏"，认了 → 合同冻结=发令枪（冻结实现属 contract-engine 域）。
- 慢拍（详设→拆解）：各端详设回工作台逐块细审 + Adversarial 唱反调（属 design-phase 域）。

> 两拍各自独立 resolve、独立 stale 校验、独立连拒计数（同一 `discard_streak` 但按当前 phase 区分语境）。本域只声明"两个边界各挂一关卡"，快拍冻结合同 / 慢拍 Adversarial 的内容由 contract-engine / design-phase 域负责。

## 与其他领域的交互（调用方向）

- **checkpoint-gate → contract-engine**：调用 `contractStructuralDiff`（§1.2）做 stale 判定；约定 decision.data 固化合同指纹、合同变更事件携带指纹（§6.3）。**消费方向**：本域依赖 contract-engine 把指纹固化好。
- **checkpoint-gate → requirement-statemachine**：本域贡献的"checkpoint 拦截/拍板/回退"是 `requirementTransition`（§4.2）里的若干转移分支，由 requirement-statemachine 域统一组装进 7 phase onEvent。phase 名常量、状态机主干属 requirement-statemachine。
- **checkpoint-gate ← workbench**：飞书灯卡按钮 / 工作台审设计页按钮触发拍板，经 workbench 域 → inject 门面 → `resolveWait(waitId, {decision})`。本域只定"拍板必经 resolveWait 门面 + decision 原子"，卡片构造/回调透传/鉴权属 workbench。
- **checkpoint-gate ← container-concurrency**：本域不改 effect 并发；灯③打回派的修复 assignment 走 container-concurrency 的 dispatch/并发上限。
- **checkpoint-gate ← data-model**：`checkpoint_reached`/`checkpoint_decision` 事件 kind 在 data-model 域的权威清单 + anchorAction 映射里登记（防漂移）。

## 相关决策

- **D-02**（灯②快慢两拍靠拆 phase，7 phase 序列固定）——5.1/5.7 直接落。
- **D-03**（checkpoint 单轨 = human wait 用法，扩展 resolveWait 携带 decision；含 Gate5-C06 拦截落 worktype 侧 + Gate3-C06 decision 过 stale 检查）——本域核心决策，5.2/5.3/5.5 全部据此。
- **D-05**（isDecisionStale 用契约结构 diff，与契约变更共用，不下沉 LLM；含 Gate5-C04 数据流前提：decision.data 固化指纹 + 事件携带指纹纯同步判）——5.5 据此。
- **D-11**（修复/返工循环用独立计数，不复用 assignment.retries）——5.6 注意点据此（本域连拒走 discard_streak、不碰 retries）。
- **D-31**（契约结构 diff 适用边界 + semanticBreaking 人工标志）——语义等价改动结构 diff 抓不到，本域 stale 校验同样受此边界约束（语义残余靠真联调兜底，不假装 stale 能抓语义）。

## 引用的内部 API

- internal-apis.md §2.6 — `resolveWait` 扩展决策语义（input 加 decision）。
- internal-apis.md §4.1 — `requirementWorkType` + `registerRequirement`（checkpoints.requiredBefore 声明四边界）。
- internal-apis.md §4.2 — `requirementTransition`（checkpoint 拦截分支：检测越界未 resolve → 返 waits:[human]；拍板后 → 返 phase）。
- internal-apis.md §4.3 — `isRequirementDecisionStale`（纯同步消费 decision.data + eventsSince）。
- internal-apis.md §1.2 — `contractStructuralDiff`（跨域共享 utility，本域只调用做 stale 判定，不重新定义）。
- internal-apis.md §6.3 — 数据流前提（decision.data 固化指纹 + 变更事件携带指纹），本域消费约定。
- internal-apis.md §7 — 事件 kind 清单（`checkpoint_reached`/`checkpoint_decision`），与 anchorAction 映射同步。

## 边界约束

### Must
- 单轨：checkpoint = human wait 的用法，**不另起双轨**（不出现独立 checkpoint id 概念）。
- 扩展 `resolveWait` 携带 decision，**不新增并行 inject 方法**；拍板 = resolve + decision 原子。
- 拦截做在 **worktype 侧**：onEvent 检测将越 `requiredBefore` 边界且未 resolve → 主动返 `waits:[human]` 而非 phase 变更（容器完全不碰 phase，保 mergeTransitions 不变量）。
- gate 通过推进 phase 越界 + 记 `checkpoint_decision` 事件。
- checkpoint decision 在 reducer 消费前走 isDecisionStale；stale → 拒绝 resolve + 重弹卡"合同已变、请重新确认"，不静默推进。
- isDecisionStale 纯同步、禁 fs/await——仅凭 `decision.data`（固化指纹）+ `eventsSince` 判定。
- decision 产出时固化所基于的合同结构指纹进 `decision.data`（消费方约定，stale 判定的数据流前提）。
- 灯②快拍/慢拍各挂一个 phase 边界（拆 phase），不在一个关卡内塞两拍。
- 连拒升级走 `discard_streak` 基因，**不复用** `assignment.retries`（D-11）。

### Never
- 不靠 prompt 提醒模型停下（必须状态机硬卡）。
- 不出现"wait resolved 但 phase 没动"或"decision 绕过 wait"的不一致。
- 容器侧不直接覆写 `transition.phase` 拦截（mergeTransitions 只取 worktype 的 phase）。
- 不在 reducer / 纯函数里调 LLM 判 stale；不把"小改还是大改"交给 AI 自由裁量（结构 diff 机械判）。
- 不因任务小跳过"设计→人审"内核（灯②设计必审，不论大小——见 design-phase）。
- worktype/checkpoint 业务逻辑不漏进容器层（容器只提供 requiredBefore 声明 + decision 消费管道）。

## 可能的实现提示（可选）

- 本域代码主体落 `src/worktypes/requirement/checkpoint.ts`（worktypes 层，可自由用 phase/WorkItem 等业务词，但**禁 async/await/fs/child_process**——纯同步 reducer），由 requirement-statemachine 的 onEvent 主干 import/分派。
- "将越过 requiredBefore 边界"判定：worktype 自己知道"当前 phase + 本次事件本应推进到的 next phase"，检查 next phase 是否在 `requiredBefore` 且对应 gate 的 human wait 未 resolve。gate 状态查询可由容器侧提供"列某 workitem 的 open human waits"（已有 store 查询），worktype 据 reason 前缀 `checkpoint:<边界名>` 反查该关卡是否已 resolve。
- 容器侧只需保证 `checkpoints.requiredBefore` 声明可读 + open waits 可查；不做 phase 压制（守 AC6）。
- stale 重弹卡时，避免与原 wait 重复：可"原 wait 保持未 resolve（拒绝这次 resolve）"或"resolve 旧 wait + 立刻建新 wait 带最新指纹"，二选一须在实现时定，保证不出现"两条同语义 open wait"。
- 灯③打回派修复 assignment 时，修复循环计数（≤2 轮）属 worker-runtime/contract-engine 的独立计数，本域 onEvent 只负责"打回 → 回集成 phase + 触发 dispatch"，不在此计数。
- noop 夹具回归（container-concurrency / data-model 域）应能注入 `checkpoints.requiredBefore` 编排"到边界自动卡 → resolve 带 decision → 推进 / 打回回退 / stale 拒绝"全路径——本域行为靠它锁定。
