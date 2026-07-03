# ENHANCE 方案：事故参谋（建议先行·人改后行）+ 大事记摘要

> 日期：2026-07-03 ｜ 状态：**待实施** ｜ 读者：**执行本方案的 AI**
> 来源：用户对 OVERHAUL 后流程的完整性诉求——**研发过程中出问题时，流程里必须先有一个给人出建议的角色；
> 人参考建议、补充/修正后，按修正后的方向继续执行**。现状缺口：监工判大/病历卡是"机器直出的原始事故单"
> （工人原话+仓名，零解读零建议），会解释的包工头（steer）不在这条汇报链上，人拿到最生的信息独自想方案。
> 本方案自包含（背景、决策、改动清单、测试要求全在文内），行号基线：overhaul/req-v1 分支
> HEAD ≈ 5d20924 + F6/改名未提交改动。若行号漂移以符号名定位。

---

## 0. 执行须知（必读）

- 仓库 `/Users/zwh/agent-pipe`，TypeScript + Node（ESM，import 带 `.js` 后缀），测试 vitest。
- 验证命令：`npm run check`。**每刀提交前全绿**。基线约 768 测试 / 97 文件（含 F6 与「终止需求」改名，若尚未
  提交请先确认工作区状态，勿混提）。
- 架构红线沿用 OVERHAUL 文档 §0.2：容器层 `src/workitems/` 零业务语义；worktype 纯核心纯同步无 IO；
  `src/feishu/` 不 import worktypes；run 结论只出自 `emitRunConclusion`；新事件 kind 须登记 `phases.ts`
  ——**本方案不新增任何事件 kind**（advise 是 dispatch payload 的 stage，不是事件）。
- 词汇守卫（`tests/architecture.test.ts`）：feishu/kernel 层注释禁 `workitem|assignment|worktype|phase` 独立词。
- **不要重开 §2 已拍板的决策**；与代码现状对不上时按本文意图适配并在落地记要注明。

### 建议提交划分

| 刀 | 内容 | 建议 commit |
|---|---|---|
| 1 | E1 事故参谋全链 | `feat(requirement): 事故参谋——判大/病历先出建议，人修正后继续 (ENHANCE E1)` |
| 2 | E2 大事记摘要 | `feat(requirement): 大事记摘要织入 steer/参谋 prompt (ENHANCE E2)` |
| 3 | E3+E4 + 文档收尾 | `feat(requirement): 参谋收尾——上报带建议 + 卡片提示 (ENHANCE E3/E4)` |

---

## 1. 目标流程（用户拍板的完整性诉求）

```
出问题（判大/对账冲突/集成修不动）
  → 弹事故卡（现状保留：机器直出、判定不经 AI）
  → 同时自动派「参谋」run（只读 AI）：读全部上下文 → 产出解读 + 建议方案，以卡片贴回群   ← 新增
  → 人读建议 → 在事故卡意见框写补充/修正（或改图纸）→ 点按钮裁决                        ← 现有
  → 意见经既有 D-E 通道注入 → 下一轮 run（重对账/steer）读到人修正后的方向 → 继续执行     ← 现有
```

三权分立不变且更完整：**判定 = 监工（机器，铁面）；建议 = 参谋（AI，只出主意）；裁决 + 改图纸 = 人**。

## 2. 设计决策台账（已拍板，执行时不要重开）

- **D-1 参谋 = 只读 owner run，stage=`advise`，零行动权**。复用 steer 全套基建（owner 槽、readonly +
  readableDirs 全仓、流式卡出群、批语义）。与 steer 的唯一区别：**收尾无任何流转**（`onRunCompleted`
  stage=advise → `{}`，不接 steer_apply，报告里即便出现 ```steer 块也无人消费）。建议只进人眼，不进状态机。
- **D-2 只挂三类业务事故**：`gatekeeper_big`（监工判大）、`reconcile_conflict`（跨仓对账冲突）、
  `integration_unresolved`（集成验证修不动）。机械故障（run_failed / retry_exhausted / thrash /
  stalled_no_path）**不派参谋**——它们的处置是重试/重跑/人工确认，AI 建议无增量，纯烧 token。
- **D-3 建议晚到不作废、不打断**。人手快先点了「返工」→ 返工对账 run 被 owner single-flight park，参谋跑完
  自动释放（WS-1 补派机制天然保证顺序），接受这几分钟延迟；参谋报告照常贴出（事后参考价值）。不做
  「resolve 时中止参谋」（复杂度不值当）。
- **D-4 人的修正走既有通道，不发明新事件**。意见框 → `injectHumanMessage`（D-E，注入先于 resolve）→
  下一轮 owner run 的 followups（已核实：`composeReconcilePrompt` / `composeOwnerPrompt` /
  `composeSteerPrompt` 均已织入 followups，`worker-handler.ts:94,108,80`）。**工人不直接读人的意见**——由
  重对账把意见吸收进契约/图纸产物，工人按新图纸返工（图纸 = 单一事实源，红线不变）。
- **D-5 大事记摘要 = 纯函数渲染事件流**。容器/agent-run 层只透传 opaque events（中性），解释权在
  requirement 纯核心。织进 steer 与 advise 两个 prompt（解决包工头「记忆靠接力、长链衰减」的痛点，也让
  参谋知晓全程）。
- **明确不做**：常驻参谋会话（同 D-A 否决理由）；参谋自动改图纸/自动触发返工；给机械故障派参谋；
  参谋结论的结构化解析（它就是给人看的一篇分析，不是指令）。

---

## E1 事故参谋（核心）

### E1.1 stage 词表 + 派发规格

- `src/worktypes/requirement/index.ts` `STAGE`（:36-43）加 `advise: 'advise'`。
- 新 helper（同文件，仿 `workerReworkSpec` 的 payload 扩展方式）：
  `adviseSpec(item, incident: string): AssignmentSpec` = `{ ...ownerSpec(item, STAGE.advise), payload: { stage: STAGE.advise, incident } }`
  （`ownerSpec` 在 :533；incident 是渲染好的事故上下文文本，见 E1.2）。

### E1.2 三个 raise 点顺带派参谋

三处 transition（都已有 openWaitReasons 幂等守卫，crash 重跑不会重复 raise → 也不会重复派参谋）：

- `onGatekeeperBig`（:219 附近）：返回值从 `{ waits: [...] }` 改为
  `{ waits: [...], dispatch: [adviseSpec(item, renderGatekeeperIncident(ev.payload))] }`。
- `onReconcileConflict`（:186 附近）：同样追加 `adviseSpec(item, renderReconcileIncident(ev.payload))`。
- `integration_unresolved` 的 raise 分支（`INTEGRATION_UNRESOLVED_REASON`，:200 附近）：追加
  `adviseSpec(item, renderIntegrationIncident(...))`（从最近一条 integration_check_failed 的
  payload——round/affectedRepos/breaking——渲染；该事件在 `ev` 或事件流中可取，实现时按现场适配）。

`renderXxxIncident(payload): string` 三个纯函数放 steering.ts 或新建 `advisor.ts`（纯核心，防御式，
坏 payload 回落 `'(事故详情缺失)'`，永不抛）。内容 = 事故类型人话 + 机械提取的关键字段（哪个接口/哪些仓/
第几轮/工人原话）。

### E1.3 参谋 prompt（新纯函数 `composeAdvisePrompt`，放 advisor.ts 或 steering.ts）

输入 = `composeSteerPrompt` 的全部输入 + `incident: string`（+ E2 落地后的 `digest`）。织入顺序对齐
steer；角色句与产出要求：

- 角色：「你是这个需求的参谋。流程出了一个需要人裁决的问题（见下方事故单）。你的任务是**替人把问题
  研究透并给出可执行的建议**，供他拍板参考。你只读浏览、只出建议——判定已由监工做出，裁决和改图纸的
  权力在人。你可以直接翻阅所有涉及仓的代码来验证你的判断。」
- 产出要求（报告主体，会以卡片贴回群）：①这个问题是什么、为什么会被拦下（人话，别复述术语）；
  ②影响面：波及哪些仓/哪些接口/哪些已完成的工作；③建议方案 A/B（各自的改法、代价、风险），明确推荐哪个；
  ④如果需要改图纸：具体建议改哪个文件的哪一节、怎么改（给出可直接抄的文字）；⑤结尾固定提示：
  「以上仅供参考。请在上方事故卡的意见框写下你的裁决理由或对建议的修正，再点按钮——你的话会被下一轮
  执行读到。」
- 若 followups 非空（参谋跑动期间用户说了话），prompt 要求一并回应（参谋是 steer 的超集姿态，保证
  消息必达语义不因参谋 run 占窗口而漏消费）。
- **不要**要求输出 ```steer 块（防误触发行动；即便模型自发输出也无消费方，见 D-1）。

### E1.4 接线（`worker-handler.ts` composePrompt + 路由）

- composePrompt owner 分支（:71-87 附近）：`stage === 'advise'` → `composeAdvisePrompt({ ...steer 同款输入,
  incident: incidentFromPayload(effectPayload) })`。incidentFromPayload 仿 `noteFromPayload` 防御式读。
- `onRunCompleted` owner 路由（stage 优先区）：`stage === STAGE.advise` → `withPendingSteer(item, ev, {})`
  （收尾零流转；包 withPendingSteer 保证参谋跑动期间攒下的新消息有 steer 补派消费）。
- `onRunFailed` 开头的 steer 特判扩为 `stage === STAGE.steer || stage === STAGE.advise → return {}`
  （参谋失败不弹病历——事故 wait 本来就 open 着，人照常裁决，只是没建议可参考；也不给自动重试）。
- afterRun 无需改（advise 非 reconcile/assess，天然不写任何契约产物）。
- runOptions 无需改（owner 分支已是 readonly + 全仓可读）。

### E1.5 幂等与时序（写进代码注释）

- 派发幂等：三个 raise 点的 openWaitReasons 守卫已保证事故只 raise 一次 → 参谋只派一次。
- owner 槽冲突：参谋在跑时人点「返工」→ reconcile dispatch 被 park，参谋收尾自动释放（WS-1 机制），
  顺序天然正确（D-3）。
- 参谋报告出群：走既有 owner run 流式卡（ProgressCards），**零新增 feishu 代码**。

### E1.6 测试

- 纯核心：`composeAdvisePrompt` 织入完整性（incident/契约摘要/followups 在场；含「仅供参考」结尾提示）；
  三个 renderXxxIncident 的正常/坏 payload 两例。
- 状态机（requirement-type）：gatekeeper_big / reconcile_conflict / integration_unresolved 三个 raise
  返回值同批含 `role:'owner', payload.stage='advise'` 的 dispatch；重复事件（幂等守卫路径）不再派；
  advise 收尾 → `{}` 且 unconsumed>0 时追加 steer；advise run_failed → `{}`。
- e2e（requirement-e2e，复用监工判大用例的 harness）：判大 → 断言参谋 assignment 出现（stage=advise）→
  合成参谋报告收尾 → 人 resolve(action='rework') → 后续链路不受参谋影响照常收敛（可与既有 T2 用例合并
  扩展，注意 harness 的合成报告分支需认 stage=advise）。

---

## E2 大事记摘要（参谋与包工头共用的"全程记忆"）

### E2.1 事件透传

- `src/worktypes/agent-run/run-handler.ts` `RunStrategy.composePrompt` 输入对象加
  `events: WorkItemEvent[]`；`runAgent` 传 `ctx.eventsSince(0)`（agent-run 层 opaque 透传，与
  priorReportPaths 同性质，中性）。probe 默认策略忽略，零回归。

### E2.2 渲染纯函数

- 新纯函数 `renderEventDigest(events): string`（建议放 advisor.ts；requirement 纯核心解释自己的事件，合规）。
  只挑人关心的节点渲染成时间线（每行 `- [MM-DD HH:mm] 事实`，时间戳字段以 `workitems/types.ts` 的事件
  形状为准）：
  - phase 变迁（含 reason 人话：lite_single_repo=单仓直跳 等）；
  - checkpoint / 病历 resolve（approved/declined + resolve reason——WS-5 起 reason 即人的意见原文，天然入账）;
  - gatekeeper_big（接口+仓）、steer_directive（action+note 截断）、rework_requested（仓）、
    integration_check_failed（第几轮）、run_failed（role/repo）、manifest_ready；
  - 其余 kind 一律跳过。
- 上界：最多 40 行 / 2500 字符，超出保头（立项/拆解节点）保尾（最近事件），中间折叠为
  `-（中间 N 件事略）`。防御式，坏 payload 行降级为 kind 名。

### E2.3 织入

- `composeSteerPrompt` 与 `composeAdvisePrompt` 输入加 `digest?: string`，织入位置在「当前阶段」之后、
  「涉及仓库」之前，标题 `# 本单大事记（供你了解全程来龙去脉）`。worker-handler 两个分支传
  `renderEventDigest(events)`。
- reconcile/assess prompt **暂不织**（它们有各自的窄上下文，防 prompt 膨胀；留作后续观察）。

### E2.4 测试

- renderEventDigest：典型事件流 → 断言含 phase 变迁行/打回意见原文/判大行；40 行截断折叠；空流 → 空串。
- composePrompt 层：steer/advise prompt 含大事记标题；probe 零回归（既有套件）。

---

## E3 包工头上报必须带建议（一行 prompt 改动）

`composeSteerPrompt` 的选择规则处（steering.ts:74-88 附近），`raise_human` 的说明从「note 写要人裁决什么」
改为「note 必须包含：要人裁决什么 + **你的建议方案与理由**（人会参考你的建议来裁决）」。
测试：既有 prompt 织入用例补一条文案断言。

## E4 事故卡提示参谋在路上（可选低优先，做不动跳过并注明）

`surfaceCheckpoints` 对三类事故 reason 出卡时（gatekeeper-big 卡与病历卡），detail 尾部追加一行灰字：
`🧭 参谋正在分析，建议稍后以卡片贴出——可参考后在上方意见框写下你的修正再点按钮。`
实现落点：`src/index.ts` 出卡分支拼 detail 处按 `waitCardKindFor`/reason 判断追加；注意 reason 集合与
E1.2 的三类保持一处常量（避免两份清单漂移——常量放 requirement 纯核心导出，index.ts 是 kernel-exempt
可 import）。测试：card 层断言该行出现在判大卡、不出现在 run_failed 病历卡。

---

## 完成定义

- E1/E2/E3 落地（E4 可选），`npm run check` 全绿；**无新增事件 kind**（anchor-drift 断言数不变）；
- 红线自查：advisor.ts 纯同步无 IO；容器层零改动（E2 的 events 透传在 worktypes/agent-run 层，不碰
  src/workitems/）；feishu 层零改动（E4 除外，且只拼字符串）；
- 本文档头部状态改「已实施」，末尾追加落地记要（逐项状态/出入/跳过项）；
- 手验 runbook 项（追加到 OVERHAUL 文档附录 B）：真机诱导判大 → 事故卡先到 + 参谋流式卡随后贴出建议 →
  在意见框写「按方案 B，另外注意兼容旧客户端」→ 点返工 → 观察重对账报告引用该意见 → 新契约 → 定向返工。
