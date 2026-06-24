# Domain: intake-phase（立项）

> requirement 生命周期最前面新增的一段：**立项**。把"一行 `/req` + 立刻硬考古"的轻量入口，
> 换成"**建专属项目群 → 引导者把前置料收齐 → 立项 gate 放行**"的重量级前门。
> 层：`worktypes`（状态机/清单逻辑）+ `feishu`（建群/读文档新能力）+ `bridge`（触发流）。
>
> 背景：真机首跑暴露的问题——引擎（7 phase + 4 灯 + 真考古）是好的，但**前门太薄**：没有
> PRD/UI/验收就开跑，AI 只能反过来"请把描述发我"，体感像随口追问。本域把立项前置化，让
> 后面的 spec-design run 有 PRD+UI+多仓喂着，而不是裸描述硬考古。

## 领域职责（负责什么 / 不负责什么）

**负责**：requirement 真正开干**之前**的"立项"这一段——

- `/req` 触发后，**先问群名**，按用户给的名字**建一个专属飞书群**，把发起人拉进去；后续全程在群里推进。
- 在群里由**引导者（facilitator）**驱动一张**立项清单**，一项项把前置料收齐：需求名称、一句话需求+背景、涉及仓库、PRD、验收标准、UI 地址、范围边界等（清单 v1 见 §核心概念）。
- **混合式引导**：清单项是确定的结构（缺哪项卡哪项），AI 只在"读 PRD 飞书文档→摘要+预填候选字段""识别描述里还缺哪几项"处出力——既不是死表单，也不是漫谈。
- 必填齐 → 弹**立项 gate**（"立项完成"卡）；人确认 → 产一份**结构化立项书**落 artifact 仓 → 放行进 `理解` phase。
- 立项材料（尤其 PRD/UI/仓库/验收）作为下游 spec-design run 与 worker 的**上游输入**装配好。

**不负责**（划清边界）：

- **不负责"理解→合同→详设→…"的设计与实现流程**——那是 design-phase / worker-runtime 等域。本域只把料备齐、放行，**到 `理解` phase 为止**。
- **不负责合同结构/冻结/对账**——contract-engine 域。
- **不负责灯①~④的设计审批语义**——本域只新增"立项 gate"这一个**前置 gate**（材料齐+人确认开干），与 4 灯（审设计）并列但语义不同。拦截/拍板原子复用 checkpoint-gate。
- **不负责建群/读文档的 SDK 底层**——那是 feishu 层新增能力（§新能力），本域只声明"需要建群 + 读飞书文档"两个能力并消费。

## 核心概念（本域特有）

- **立项群（project group）**：一个需求一个专属飞书群，群名由用户在 `/req` 后指定。建群 = 新能力（§新能力）。建群后所有交互（清单、灯卡、流式 run、追问）都回贴到该群，路由 `claimThread` 改以**群 chatId** 为 key（而非原来的话题 thread）。
- **立项清单（intake checklist）v1**：

  | # | 项 | 必填？ | 怎么收（引导者行为） | 喂给下游 |
  |---|---|---|---|---|
  | 1 | 需求名称 | ✅ | `/req` 后第一问，= 群名 | 群/锚点标识 |
  | 2 | 一句话需求 + 背景 | ✅ | 问"要解决什么/为谁/为什么现在" | spec-design 理解 |
  | 3 | 涉及代码仓库 | ✅ | 要绝对路径（可多个），**当场校验 git 仓+HEAD** | worker 拆分 + 合同 repo key |
  | 4 | PRD | ✅ | **群里上传 MD 文件→bot 下载到 `intake/prd.md`→读取并摘要**；无则允许文字 | spec-design Requirement 规划 |
  | 5 | 验收标准 / 完成定义 | ✅ | 问"怎么算做完"；可从 PRD 抽草稿待确认 | 灯③集成/灯④交付判据 + worker 自测目标 |
  | 6 | UI 设计稿地址 | 条件 | **涉及 UI 改动时必填**（Figma/蓝湖/飞书） | 前端 worker 详设依据 |
  | 7 | 范围边界（明确不做什么） | 选填 | 主动问一句"有没有明确不做的" | 合同边界 + 防蔓延 |
  | 8 | 相关端 / 相关方 | 选填 | — | 沟通 + 灯卡知会谁 |
  | 9 | 优先级 / 期望交付时间 | 选填 | — | 排期参考 |
  | 10 | 已知依赖 / 技术约束 / 不能动的 | 选填 | 问"有没有硬约束/不能碰的" | spec-design 考古 + 合同约束 |

- **引导者（facilitator）混合模型**：清单**状态确定性地存在 workitem 上**（见 §数据契约），bridge/worktype 用确定逻辑驱动清单卡 + 槽位填充（缺哪项卡哪项）；**AI 只作为"工件读取 + 缺口抽取"的短 effect 被点用**（读 PRD 文档摘要、从描述里预填候选验收/范围/仓库线索），不是一个常驻对话 run。这样契合现有"确定性 worktype + 异步 effect"架构，避开"持久对话 run"（run 模型是一次性产报告，不适合多轮收集）。
- **立项 gate（立项→理解 边界挂灯）**：必填项齐 → "立项完成"卡可点；人点通过（resolveWait 带 decision）→ 放行进 `理解`。这是一个 checkpoint 边界（复用 checkpoint-gate 机制），但语义是"料齐了、确认开干"，区别于 4 灯的"审设计"。
- **立项书（intake brief）**：立项 gate 通过时产出的结构化 MD（清单全量 + PRD 摘要 + 仓库/端/验收/边界），落 artifact 仓 `intake/intake.md`，作为 `理解`/spec-design run 的首要输入；可同步成飞书文档贴群。

## 数据契约（TypeScript 接口）

立项清单状态存在 `workitem.context`（已有的 json 字段，无需新表），新增一段 `intake`：

```ts
// 位置：src/worktypes/requirement/intake.ts（新建，纯逻辑：清单定义/校验/完成判定）
interface IntakeField {
  key: 'name' | 'summary' | 'repos' | 'prd' | 'acceptance'
     | 'ui' | 'scope' | 'stakeholders' | 'priority' | 'constraints';
  required: boolean | 'conditional'; // 'conditional' = UI：涉及 UI 改动才必填
  value?: string | string[];          // repos 是 string[]，其余文本
  filledBy?: 'user' | 'ai-extracted';  // ai 预填的需用户确认
  confirmed?: boolean;                  // ai 预填项要 confirmed=true 才算齐
}
interface IntakeState {
  groupChatId: string;        // 建群后回填；路由 key
  fields: IntakeField[];
  prdSummary?: string;        // 读 PRD 文档后的摘要（artifact 也留一份）
  gateReady: boolean;         // 全部"必填+条件必填(若触发)"已 confirmed → true
}
```

- 纯函数：`requiredMissing(state): IntakeField[]`（缺哪些必填）、`isGateReady(state): boolean`、`buildIntakeBrief(state): string`（产立项书）、`applyFieldInput(state, key, value): IntakeState`。这些是本域可单测核心（不读 fs / 不建群 / 不调 AI）。
- 建群 / 读 PRD / 起 AI 抽取 = 异步副作用，走 effect handler / bridge，不在纯函数里。

## 设计细节（按功能点分节）

### 5.1 触发流：`/req` → 群名 → 建群 → 立项

- `/req`（**不再需要 `--repo`/描述内联**——仓库等都进清单收）触发后，bridge 在原会话问一句"给这个需求起个群名"。
- 用户回群名 → bridge 调**新能力 createGroup(name, [发起人])** 建群、拿 `groupChatId`。
- `createWorkItem({ type:'requirement', phase:'requirement:立项', title:群名, source:{ kind:'feishu', chatId:groupChatId, … }, context:{ intake: 初始清单 } })`；`claimThread(groupChatId, 'managed', item.id, …)` 让群内消息/卡回调路由进本单元。
- 在群里发**立项清单卡**（全项 + ✅/⬜ + 进度"必填 x/5"）。
- 失败兜底：建群失败 → 原会话回错误、不创建 workitem；群名为空 → 重问。

### 5.2 引导者收料（混合，§核心概念）

- 群内用户消息 → bridge 按"当前待填项"解析填槽（`applyFieldInput`）；也支持清单卡上点项补填。
- **仓库项**：当场校验绝对路径是 git 仓 + 有 HEAD（复用真机校验逻辑），不合格当场退回。
- **PRD 项**：用户在群里**上传 MD 文件** → bridge 从入站消息的 `attachments`（event-router 已解析）取 fileKey → `Sender.downloadAttachment` 下载到 `intake/prd.md` → 起一个**短 AI effect** 读该文件 → 摘要回贴 + 标 ✅ + 从摘要里**预填**候选（验收/范围/仓库线索，`filledBy:'ai-extracted'`，待用户 confirm）。无 PRD 时允许直接发文字描述。
- bridge **主动逐项追**还缺的必填项（"还差：验收标准、PRD"）；每次填完刷新清单卡。
- 全程在群里；流式 run 卡、灯卡后续也都回贴群。

### 5.3 立项 gate + 衔接

- `isGateReady` 为真 → 清单卡上"立项完成"按钮可点（否则置灰/拒绝并提示缺项）。
- 点"立项完成"（card.action，复用 checkpoint resolveWait 单写路径）→ 产 `intake/intake.md`（立项书）→ 状态机把 `立项` 越过 gate 进 `理解`，**后续就是现有引擎**（理解→合同→…）。
- spec-design run（合同 phase）这次 `composeSpecDesignPrompt` 的输入从立项书装配：PRD 摘要 + UI 地址 + 多仓 + 验收 + 边界，而非裸 title。

### 5.4 状态机改动（requirement-statemachine 域配合）

- `PHASE` 新增 `intake: 'requirement:立项'`，置为 `initialPhase`，序列变为 `立项 → 理解 → 合同 → 详设 → 拆解 → 并行实现 → 集成验证 → 交付`。
- `checkpoints.requiredBefore` 新增 `理解`（立项→理解 挂 gate）。
- `requirementTransition`：`workitem_created` 不再直接 dispatch owner run，而是进 `立项`（收料由 bridge/effect 驱动，不在纯 worktype 里跑副作用）；立项 gate `wait_resolved(approved)` → 进 `理解` 并 dispatch 首个 owner run（即原 `workitem_created` 的动作后移一格）。

## 新能力（feishu 层，本域依赖、需新增）

> bot 现状只封装了 `client.im.message.*`（见 `src/feishu/sender.ts`）。**只有"建群"是真新增能力**；
> PRD 走 MD 上传，复用 bot 已有的文件下载（`Sender.downloadAttachment` + event-router 已解析的
> `attachments`），不需要新 scope。

| 能力 | SDK 入口 | 需要的 scope | 落点 |
|---|---|---|---|
| **建群 + 拉人**（新增） | `client.im.chat.create` + `client.im.chatMembers.create` | `im:chat`（建群/管理群成员） | 新增 `Sender.createGroup(name, members)` |
| **下载 PRD MD**（已有，复用） | `client.im.messageResource.get`（已封装为 `Sender.downloadAttachment`） | 现有消息权限即可 | 群内文件消息 → `attachments[].fileKey` → 下载到 `intake/prd.md` |

- 风险/缺口：① **唯一硬前置**——app 需开通 `im:chat` scope（建群/拉人），未授则建群直接 401，实现前必查；② PRD 非 MD（飞书文档链接/Confluence/Notion）本期只记链接不读取，AI 预填降级（读飞书文档 = 后续可选增强，届时才需 `docx:document:readonly`）；③ 群爆炸（一需求一群，用户已确认"无论大小都建群"，接受此成本）。

## 与其他域的交互

| 方向 | 对象 | 内容 |
|---|---|---|
| 本域 → requirement-statemachine | requirement-statemachine | 新增 `立项` phase + 立项 gate；`workitem_created` 行为后移到 gate 通过后 |
| 本域 ↔ checkpoint-gate | checkpoint-gate | 立项 gate 复用 human wait + resolveWait 带 decision；本域只声明 `立项→理解` 边界挂 gate |
| 本域 → design-phase | design-phase | 立项书（PRD 摘要/UI/多仓/验收/边界）作为 spec-design run 的上游输入，`composeSpecDesignPrompt` 从立项书装配 |
| 本域 → feishu 层 | feishu(sender) | 依赖新增 createGroup / readDoc 两能力 |
| 本域 ↔ bridge | bridge(index.ts) | `/req` 触发流改造（问群名→建群→建单→清单卡）；群内收料的消息/卡路由 |

## 边界约束（Must / Never）

**Must**：
- 需求开发**一律建群**（无论大小），群名用户指定。
- 立项材料**必填齐才放行**进理解（缺哪项卡哪项）。
- 引导**混合式**：清单结构确定 + AI 只读工件/抽缺口；不退回"漫谈式追问"。
- 立项的副作用（建群/读文档/AI 抽取）走 effect/bridge，worktype 纯函数只管清单状态/校验/完成判定。
- 实现前先确认 app 已授 `im:chat` scope（建群；PRD 走 MD 上传复用现有下载，无需 docx scope）。

**Never**：
- 不在没收齐 PRD/UI/仓库/验收时就开跑设计（杜绝裸描述硬考古）。
- 不把建群/读文档的 SDK 调用塞进纯 worktype。
- 不用一个常驻对话 run 去做多轮收料（run 是一次性产报告模型）。

## 开放问题（待用户/后续拍）

- 立项 gate 是否要做"超时/催办"（材料长期不齐怎么办）？（v1 暂不做，留后续）
- ~~PRD 非飞书文档~~ → **已定**：PRD 走**群里上传 MD 文件**，bot 下载到 `intake/prd.md` 后读取；无 PRD 时允许文字描述。读飞书文档链接 = 后续可选增强。
- "涉及 UI 改动"触发 UI 必填 → **v1 用户勾选**（简单可靠）。
- 群成员 → **v1 只拉发起人**（自动拉相关方需先有"相关方→open_id"映射，后续）。

## 实现计划（proposed — 待用户最终拍板后开干）

> 两个**新架构决策**（待确认）：① 立项清单状态**走事件溯源**（每填一项=一条 `intake_field_set`
> 事件，gateReady=fold 算出，和 runningWorkers/集成失败计数同套路），**不塞** `workitem.context`；
> ② `/req` 后"等群名"用一个**临时待答态**（keyed by 用户+会话+超时，v1 放内存）。
>
> **硬前置**（动 live 前第一件事）：飞书开放平台确认 app 已授 **`im:chat`** scope（建群/拉人），
> 否则建群直接 401。PRD 走 MD 上传复用现有 `Sender.downloadAttachment`，无需别的 scope。

### M-I1　立项骨架（全沙箱可测，不碰建群/AI）
1. 纯 intake 核心 `worktypes/requirement/intake.ts`(新)：`IntakeField/IntakeState`+清单 v1 定义+`applyFieldInput`/`requiredMissing`/`isGateReady`/`buildIntakeBrief`。纯单测。
2. 状态机加 `立项`：`PHASE.intake` 置初始、序列前插、`requiredBefore += 理解`；`workitem_created`→进立项**不 dispatch**；`intake_field_set`→gateReady 则 raise 立项 gate；gate `wait_resolved(approved)`→进理解+dispatch 首个 owner run（即原 `workitem_created` 的动作后移一格）。改 `phases.ts`/`requirement/index.ts`。transition 单测+e2e(假 runner)。
3. 立项卡 `buildIntakeChecklistCard`(✅/⬜+进度+就绪时"立项完成"按钮，value.kind 新增)。`feishu/card.ts`。卡快照测。
4. 立项书喂 spec-design：`composeSpecDesignPrompt` 增 intake brief 入参(PRD摘要/UI/仓/验收/边界)。`requirement/design.ts`。单测。
   - 完成判据：立项 phase 端到端用假数据走通（清单 fold→gate→进理解→spec-design 拿到立项书），无需建群/真 AI。

### M-I2　建群能力 + 触发流（沙箱+少量 live）
5. `Sender.createGroup(name, members)`（`im.chat.create`+`chatMembers.create`）。`feishu/sender.ts`。单测(假 client)；真建群=live。
6. `/req` 触发流：去掉 `--repo`，改问群名→临时待答态→建群→建单(phase=立项,chatId=群)→claim→发清单卡。`bridge/commands.ts`/`index.ts`。

### M-I3　群内引导者（大头，多为 live）
7. 群内收料路由：群消息→当前待填项填槽→append `intake_field_set`→刷新清单卡；仓库项当场校验 git 仓+HEAD。`index.ts`。
8. PRD MD：群内上传(`attachments` 已解析)→`downloadAttachment`→`intake/prd.md`→短 AI effect 摘要+预填候选(`filledBy:'ai-extracted'` 待 confirm)。
9. "立项完成"按钮→走 checkpoint resolveWait 单写路径→产 `intake/intake.md` 立项书。

> 建议先做 M-I1（纯沙箱、把骨架钉死）；M-I2/M-I3 等 `im:chat` scope 确认后上 live。
