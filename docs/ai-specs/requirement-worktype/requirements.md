# Requirements: requirement worktype

## Introduction

- **业务背景**：让 agent-pipe 从「飞书 × coding CLI 桥」长出「一个人 + 系统 = 一个全栈工程师 + 半个 PM」的能力。一个跨多端多服务的完整需求，人只在 **4 个决策灯**（对齐需求 / 审设计 / 验收 / 提交）出场，其余系统自治推进。底座（M0 容器 + M1a kernel + probe/noop worktype + M2 流式卡）已落地，本次在其上一次性长出 **requirement worktype**。
- **范围**：requirement 单需求端到端闭环 —— 7 phase + 4 灯 + 中间自治；Owner + N Worker **真并行**；对接合同（契约先行 + 变更/返工）；集成验证（代码层 AI 兜底）；写代码 + worktree；仓库知识层；HTML 工作台 + 飞书灯卡双向集成。
- **不在范围**：多需求并行（`maxOpen` 上限保留不堵死）；bugfix/investigation worktype；Codex runner；强只读 OS 沙箱；同仓多 worker 竖切（接口不堵死）。

## Requirements 总览

| # | 标题 | 一句话概述 | 涉及模块 |
|---|------|-----------|----------|
| R01 | 多工人真并行调度 | 单飞门按 role 分流 + effect 多 inflight + abort per-assignment | `workitems/reducer.ts`, `effects.ts`, `config.ts` |
| R02 | Owner 协调与重建 | 父子链写入消费 + 批量唤醒 + 结构化快照权威 + journal 校验 | `reducer.ts`, `worktypes/requirement/`, `artifacts.ts` |
| R03 | 4 灯 checkpoint gate | 容器拦 phase 越界自动插 human wait + resolveWait 携带 decision（单轨） | `reducer.ts`, `types.ts`, `api.ts` |
| R04 | 写权限档 | agents 加 write+writableDirs + Claude 写档 hook + fingerprint 纳目录 | `agents/types.ts`, `claude/runner.ts`, `run-handler.ts` |
| R05 | worktree 工作区供给 | kernel git worktree add/remove + 回收 + 作 cwd | kernel 新通用层, `run-handler.ts` |
| R06 | 卡片按钮回调原语 | event-router 加 card.action 分发 + value schema（不解释业务） | `feishu/event-router.ts`, `card.ts` |
| R07 | Owner 预留槽 | pool Semaphore 加优先级/预留防优先级反转 | `agents/pool.ts`, `types.ts` |
| R08 | requirement worktype 骨架 | 7 phase + onEvent + topology + artifacts + 注册 + /req 触发 | `worktypes/requirement/`, `index.ts`, `bridge/commands.ts` |
| R09 | 对接合同（契约先行+冻结） | contract/ git 化 + 提供方/调用方 + 影响计算 | `worktypes/requirement/`, `artifacts.ts` |
| R10 | 契约变更/返工 + isDecisionStale | 结构 diff 判小改/大改 + 一等事件 + replaces 链 + 共用 diff | `worktypes/requirement/`, `reducer.ts` |
| R11 | Worker 执行 | 任务卡+合同+repo 知识 prompt + write 档 + worktree + 自测硬门 + 崩溃恢复 | `worktypes/requirement/run-handler.ts`, `effects.ts` |
| R12 | 跨端契约测试独立生成 | 契约测试从冻结合同机械生成/独立质检员，实现 worker 不许碰 | `worktypes/requirement/` |
| R13 | 集成验证 | 质检员 + 契约测试汇总 + 跨端静态对账 + 差异报告 + 修复循环 | `worktypes/requirement/`, 新 effect kind |
| R14 | 前端 UI 特殊处理 | 搭到能跑 + 人精修 + 代码层硬门重跑 + 汇入灯③条件 | `worktypes/requirement/` |
| R15 | 灯②设计审接 spec-design | 跑 spec-design 流程 + 跨端一刀 + 快慢两拍 + Adversarial | `worktypes/requirement/`, artifact `design/` |
| R16 | 仓库知识层 | 新建 knowledge 层 + map/conventions/runbook/pitfalls + 保鲜 + 选择性注入 | 新建 `src/knowledge/`, `architecture.ts` |
| R17 | HTML 工作台读视图 | 轻量 HTTP + SSR 多页 + 活动流/工人/焦点卡/台账/文档就地渲染 | 新建 HTTP 模块 |
| R18 | 工作台事件回流写 API | 页面按钮 → inject 门面 → reducer + 鉴权 + 刷新 | 新建 HTTP 模块, `api.ts` |
| R19 | 飞书灯卡 + 一需求一话题 | 锚点卡 + 4 灯交互卡 + 新构造器去"调查"化 + claimThread | `feishu/card.ts`, `index.ts` |
| R20 | 异常与监督 | checkpoint 拒绝回退 + worker 失败 + 契约一等事件 + 连拒升级 + 集成循环 | `worktypes/requirement/`, `watchdog.ts` |
| R21 | 人工取消 /cancel 收尾 | 确认卡 + abort 全 worker + 回收 worktree + 收尾 journal | `bridge/commands.ts`, `worktypes/requirement/` |
| R22 | 提交/交付 | 自分支自动 + 开 MR/上线人点 + 平台纪律 | `worktypes/requirement/` |
| R23 | 并发一致性 + noop 夹具回归 | 批次完整性 + 两条非单飞路径崩溃恢复 + noop 扩展注入 | `worktypes/noop/`, `effects.ts`, tests |
| R24 | 数据模型增量 + config | 新事件 kind + role 投入 + artifact 布局 + 新 config + 迁移 | `store.ts`, `config.ts`, `types.ts` |

---

## Requirement 1: 多工人真并行调度

**User Story**：作为系统，我希望一个 requirement 的多个 worker（各占一仓）能**真并行**地跑 agent，以便跨端需求按合同同时推进而不互相串台。

### Acceptance Criteria
#### Happy Path
1. WHEN worktype `topology()` 返回 `'owner-workers'` AND owner 派发多个 `role:'worker'` 的 dispatch THEN 系统 SHALL 为每个 worker 各创建一个 assignment 并各起一个 run effect，**并发执行**（不被单飞门拦成 wakePending）。
2. WHILE 一个 workitem 有 N 个 worker run 在途 THEN 系统 SHALL 各自维护独立 inflight（按 assignmentId）与独立 AbortController。
3. WHEN owner 自身的 run 被派发 THEN 系统 SHALL 保持 **owner run 单飞**（同一时刻至多一个 owner run 在途）。
#### Edge Cases
4. WHEN 在途 worker 数已达 `maxWorkersPerItem`（默认 2）AND 又来一个 worker dispatch THEN 系统 SHALL 把该 dispatch 转为 wakePending（排队），不超上限。
5. WHEN 取消/超时一个 worker AND 同 workitem 还有其它 worker 在跑 THEN 系统 SHALL 只 abort 该 worker 的 run，不误伤其它在途 worker。
6. WHEN 一个返工(replacement) assignment 与多个 worker 同时在途 THEN 系统 SHALL 把 replacement 纳入 worker 并发上限计数（replacement 绕单飞门但不绕上限）。
#### Error Cases
7. IF `topology()` 返回 `'solo'`（如 probe/noop）THEN 系统 SHALL 保持原单飞行为逐字节不变（CI 回归绿）。

### Boundaries
- **Must**：owner run 单飞；worker 受 `maxWorkersPerItem` 上限；abort 粒度 per-assignment；改造收敛在 `reducer.ts:603-610` 单飞门 + `effects.ts` inflight 键。
- **Should**：worker 上限可由 env `WORKITEMS_MAX_WORKERS_PER_ITEM` 覆盖。
- **Never**：不按 role 之外的维度分流；不在 reducer 里 await agent；不破坏 probe/noop（solo）单飞语义。

---

## Requirement 2: Owner 协调与重建

**User Story**：作为系统，我希望 Owner（包工头）每次按需唤醒时持有一份**权威、连续**的需求全貌，以便它产契约/任务卡、验收 worker、做影响分析时判断不衰减、不依赖会话记忆。

### Acceptance Criteria
#### Happy Path
1. WHEN Owner 被唤醒 THEN 系统 SHALL 给它一份**从结构化状态（events/assignments/contract/open waits）机械生成的「现状快照」作为权威输入**。
2. WHEN owner 派发 worker THEN 系统 SHALL 把 owner 当前 assignment id 写入 worker assignment 的 `parent_id`（启用父子链）。
3. WHEN 多个 worker 在 owner 运行期间先后完成 THEN 系统 SHALL 在 owner 下次唤醒时**批量带入「自上次 owner run 以来的全部事件」**（一次唤醒，不漏不重）。
#### Edge Cases
4. WHEN 结构化状态与 `journal.md` 叙事冲突 THEN 系统 SHALL 以**结构化状态为准**（journal 过时即重生成，非真相源）。
5. WHEN owner run 收尾 THEN 系统 SHALL 校验 `journal.md` 存在（照 reportRequired 门），但权威判断不押在它上。
#### Error Cases
6. IF `journal.md` 缺失/空 THEN 系统 SHALL 判该 owner assignment 收尾失败（写回义务代码 enforce）。

### Boundaries
- **Must**：结构化状态为权威；快照机械生成；父子链 `parent_id` 写入；批量唤醒不漏不重（用 `lastRunEffectSeqBefore`+`eventsSince`）。
- **Should**：journal 写回校验复用 reportRequired 门范式。
- **Never**：不把对话历史当 Owner/Worker 接口；不让 journal 成为真相源；不复活 v1"父子链免费拿"的乐观假设（需补完整写入+消费）。

---

## Requirement 3: 4 灯 checkpoint gate

**User Story**：作为维护者，我希望系统在该我拍板的地方**真卡住**等我，而不是靠 prompt 提醒模型停下，以便我对需求方向/设计/验收/提交有不可绕过的把关。

### Acceptance Criteria
#### Happy Path
1. WHEN phase 即将转移到 `checkpoints.requiredBefore` 所列边界 AND 该 gate 未 resolve THEN 系统 SHALL **自动插一个 human wait 拦截**，阻止 phase 越过。
2. WHEN 维护者拍板 THEN 系统 SHALL 通过扩展的 `resolveWait(waitId,{operator,reason,decision:{approved,payload?}})` 一个动作同时 resolve wait + 产出决定，reducer apply 后由 worktype onEvent 据决定推进/回退 phase。
3. WHEN gate 通过 THEN 系统 SHALL 推进 phase 越过该边界并记 `checkpoint_decision` 事件。
#### Edge Cases
4. WHEN 灯②打回 THEN 系统 SHALL 回退到设计 phase；WHEN 灯③打回 THEN 系统 SHALL 回退到集成验证并派修复 assignment（回退由 worktype 逻辑定，对容器只是 `phase_changed`）。
5. WHEN 同一 checkpoint 连续被拒 2 次 THEN 系统 SHALL 升级为对话（复用 `discard_streak` 基因），不再自动重试。
#### Error Cases
6. IF 容器侧试图直接覆写 `transition.phase` 拦截 THEN 系统 SHALL **不**这么做（mergeTransitions 只取 worktype 的 phase）—— 拦截在 `applyTransitionWrites` 消费 phase 前或改走 wait 机制。

### Boundaries
- **Must**：单轨（checkpoint = human wait 的用法，不另起双轨）；扩展 resolveWait 不新增并行 inject 方法；拍板=resolve+decision 原子。
- **Should**：灯②的两拍（快审合同/慢审详设）靠**拆 phase** 各挂一 checkpoint。
- **Never**：不靠 prompt 提醒停下；不出现"wait resolved 但 phase 没动"或"decision 绕过 wait"。

---

## Requirement 4: 写权限档

**User Story**：作为系统，我希望 worker 能在**限定的仓库目录**里写代码、跑测试，而不是裸奔无限制，以便写代码安全可控。

### Acceptance Criteria
#### Happy Path
1. WHEN worktype `permissions.mode === 'write'` AND assignment 关联 repos THEN 系统 SHALL 把 workitems 层 `{mode:'write', repos}` 映射成 agents 层 `RunOptions{mode:'write', writableDirs:[...]}`（agents 层只认路径不认 repo）。
2. WHEN 启动 write 档 Claude runner THEN 系统 SHALL 生成 `--add-dir <worktree>` + **不带** `--dangerously-skip-permissions` + 写工具集 + PreToolUse hook 校验路径。
3. WHEN write 档的 writableDirs 变化 THEN 系统 SHALL 触发 runner 重建（`runOptionsFingerprint` 纳入 writableDirs）。
#### Edge Cases
4. WHEN agent 试图用 Bash/Write/Edit 写 worktree 外路径 THEN PreToolUse hook SHALL deny 该操作（硬约束）。
5. WHEN 写工具集构造 THEN 系统 SHALL 收敛为 `Write Edit NotebookEdit`（MultiEdit 已合并进 Edit）。
#### Error Cases
6. IF workitems `write` 被误映射成 agents `full` THEN 系统 SHALL 视为缺陷（full=`--dangerously-skip-permissions` 无限制，会丢目录限定）—— 映射必须 write→write。

### Boundaries
- **Must**：agents 层加 `'write'` 档 + `writableDirs`；fingerprint 纳入目录；映射落 `run-handler.ts:147`；不退化成 full。
- **Should**：PreToolUse hook 解析 Bash 目标路径（尽力拦），凭证不进 prompt、适配器配置路径进 deny。
- **Never**：不依赖 OS 沙箱（那是 investigation/Codex 的）；不指望 `--add-dir` 收窄写入（它放宽不收紧）。

---

## Requirement 5: git worktree 工作区供给

**User Story**：作为系统，我希望每个 worker 在「某仓某分支的独立 worktree」里改代码，以便各端并行写不互相覆盖、崩溃可回收。

### Acceptance Criteria
#### Happy Path
1. WHEN worker assignment 派发 THEN 系统 SHALL 用 kernel 通用能力 `git worktree add <path> <branch>`（从需求基线切 feature 分支）准备工作区。
2. WHEN worker run 启动 THEN 系统 SHALL 把该 worker 的 managed task `cwd` 指向其 worktree 路径（一 assignment 一 managed task 一 cwd）。
3. WHEN worktree 不再需要 THEN 系统 SHALL `git worktree remove` 回收（**分支保留**，worktree 删除）。
#### Edge Cases
4. WHEN worker 写产物 THEN 系统 SHALL 区分 artifact 仓（`$DATA_DIR/workitems/<id>/`，报告/契约）与 worktree（cwd，代码改动），两套路径不混用。
5. WHEN 崩溃恢复发现 worktree 有未提交脏改动 THEN 系统 SHALL 在 redispatch 前重置/丢弃半成品回到干净基线（接 R11）。
#### Error Cases
6. IF worktree add 失败（基线缺失/路径冲突）THEN 系统 SHALL 判该 worker 派发失败并举手，不在错误工作区跑 agent。

### Boundaries
- **Must**：worktree 供给是 kernel 通用能力（中性命名，对纯桥也有意义）；cwd 经 managed task（不是 RunOptions）。
- **Should**：worktree 路径可预测、可回收、可清点。
- **Never**：kernel worktree 层不出现 worktype/assignment 业务词；不在 artifact 仓里改代码。

---

## Requirement 6: 卡片按钮回调原语

**User Story**：作为维护者，我希望在飞书卡片上点按钮（通过/打回/裁决）就能驱动系统，以便不用每次都打字回复。

### Acceptance Criteria
#### Happy Path
1. WHEN 飞书卡片按钮被点击 THEN 系统 SHALL 经 `EventDispatcher` 新增的 `card.action` 事件键（走 ws，不起 HTTP）分发该回调。
2. WHEN kernel/feishu 层处理 card action THEN 系统 SHALL 把 `value` 当**不透明 payload 透传**，**不解释**里面的 `workitemId/checkpoint`。
3. WHEN 上层 workitems adapter 收到 raw card action THEN 系统 SHALL 解释 payload 并走 inject 门面（resolveWait 等）。
#### Edge Cases
4. WHEN 按钮点击 THEN 系统 SHALL 3 秒内回 toast，真实动作异步执行。
5. WHEN 卡片构造 THEN 系统 SHALL 给卡片元素加 `tag:'button'` 并约定 value schema（携带 `{workitemId, checkpoint, decision}`，只有 workitems 层认得）。
#### Error Cases
6. IF 文本回复兜底 THEN 系统 SHALL 仍支持 thread 文本 + injectHumanMessage 路径（按钮缺失时可用）。

### Boundaries
- **Must**：走 ws EventDispatcher，不起 HTTP；feishu/kernel 层只分发 raw action 不解释业务（守红线）。
- **Should**：value schema 可扩展承载多种灯的决策。
- **Never**：event-router/card 里不出现 `workitemId/checkpoint` 业务词解释（CI 拦）；卡片 value 不在 kernel 层被消费。

---

## Requirement 7: Owner 预留槽（防优先级反转）

**User Story**：作为系统，我希望 worker 把并发池占满时 Owner 仍能被唤醒，以便"解锁池的人"不被它解锁的对象饿死。

### Acceptance Criteria
#### Happy Path
1. WHEN pool 并发槽被 worker 占满 AND owner run 需要唤醒 THEN 系统 SHALL 让 owner run 通过**预留槽/优先级队列**优先获得执行（不 FIFO 排队尾）。
2. WHEN `send()` 被调用 THEN 系统 SHALL 接收优先级/role 信号（task.owner_kind 区分不了 owner-vs-worker，需新增入参）。
#### Edge Cases
3. WHEN evictLRU 选驱逐对象 THEN 系统 SHALL（可选）优先保护 owner runner。
#### Error Cases
4. IF 无空闲槽可驱逐 THEN 系统 SHALL 保持现有"hot 数暂超 + log"语义不崩。

### Boundaries
- **Must**：Owner 预留槽改 `pool.ts` Semaphore（这是 §19 独立于 §14 写权限的另一条）；kernel 中性（priority/role 中性入参）。
- **Should**：预留槽大小可配置。
- **Never**：不把 owner/worker 业务语义塞进 kernel pool（用中性 priority）。

---

## Requirement 8: requirement worktype 骨架与生命周期

**User Story**：作为维护者，我希望 `/req <PRD>` 能启动一个 requirement 工作项，按 `理解→合同→详设→拆解→并行实现→集成验证→交付/沉淀` 7 phase 自治推进。

### Acceptance Criteria
#### Happy Path
1. WHEN `/req <描述/PRD>` 被触发 THEN 系统 SHALL 创建 `type:'requirement'` workitem（initialPhase `requirement:理解`）、认领话题、发锚点卡。
2. WHEN requirement worktype 注册 THEN 系统 SHALL 在 `createWorkitemsRuntime`（registerProbe 后）`registerRequirement`，并复用通用 agent-run handler + 注册 requirement 专有 effect handler（worker run / 集成验证 / checkpoint）。
3. WHEN onEvent 处理事件 THEN 系统 SHALL 返回声明式 `Transition`（phase/dispatch/waits/effects），容器不解释 phase 名。
#### Edge Cases
4. WHEN 各 phase 边界对应灯 THEN 系统 SHALL 在 `理解→合同`(灯①)、`合同→详设`(灯②快)、`详设→拆解`(灯②慢)、`集成验证→交付`(灯③) 挂 checkpoint。
5. WHEN 到达交付 THEN 系统 SHALL 停在非终态等"提交/沉淀"信号（借鉴 probe idle→close 两段式）。
#### Error Cases
6. IF worktype index.ts 含 async/await/fs/child_process THEN 视为违规（worktype 必须纯同步 reducer，CI 拦）。

### Boundaries
- **Must**：7 phase 序列固定；业务逻辑全在 `src/worktypes/requirement/`；worktype 纯同步；`requirement` 命名安全（不在禁词表）。
- **Should**：触发命令 `/req` 仿 `/probe`（命令层只搬运不解释）。
- **Never**：容器层不出现 requirement 专有逻辑；不出现第二个叫 task 的概念（子任务统一 assignment）。

---

## Requirement 9: 对接合同（契约先行 + 冻结 + 影响计算）

**User Story**：作为 Owner，我希望先冻结一份「各端对接合同」当并行发令枪与验收标尺，以便各端 worker 照同一份契约并行实现还能拼起来。

### Acceptance Criteria
#### Happy Path
1. WHEN 灯②快拍通过 THEN 系统 SHALL 把对接合同写入 artifact 仓 `contract/`（git 化，"冻结"语义免费拿版本史）并记 `contract_frozen` 事件。
2. WHEN 合同每条接口定义 THEN 系统 SHALL 含 `提供方 / 调用方` 字段（影响计算的依据）。
3. WHEN 一条接口变更 THEN 系统 SHALL 据 `提供方/调用方` 精准算出受影响的 worker。
#### Edge Cases
4. WHEN 合同冻结后受影响 worker 返工 THEN 系统 SHALL 让其它端**照跑不停**（只返工受影响的）。
#### Error Cases
5. IF 合同缺字段/接口不完整 THEN 灯② Adversarial（唱反调 AI）SHALL 在冻结前挑出（上限/边界/字段缺失）。

### Boundaries
- **Must**：合同存 `contract/` git 化；每接口含提供方/调用方；影响计算据此。
- **Should**：合同是双向标尺（开工发令枪 + 各端验收尺）。
- **Never**：UI 像素不进对接合同。

---

## Requirement 10: 契约变更/返工 + isDecisionStale

**User Story**：作为系统，我希望契约冻结后的变更走一等流程、按结构 diff 机械判定小改/大改，以便"小改不惊动人、大改强制回灯②"，且决策过期能被判出。

### Acceptance Criteria
#### Happy Path
1. WHEN 契约变更是**纯增**（加字段/加接口/加可选项，不动已有签名）THEN 系统 SHALL 判**小改**：Owner 自治即改、**不惊动人**但完整留痕（活动流标"自治·接口小改" + 决策台账归"系统替我做的"），事件 `contract_patched`。
2. WHEN 契约变更是**破坏性**（减字段/改类型/改语义/删接口）THEN 系统 SHALL 判**大改**：强制回灯②，给"接口要改"卡（谁发现/为何改/影响哪几端/哪些活返工），事件 `contract_change_proposed/approved/applied`。
3. WHEN 判定小改/大改 THEN 系统 SHALL 由 **contract 结构化 diff** 机械产出（不靠 Owner 语义自裁）。
#### Edge Cases
4. WHEN 受影响 worker 返工 THEN 系统 SHALL 带"原活+接口改了哪+为何"重做（新 assignment，`replaces_assignment_id` 链，分支保留）。
5. WHEN `isDecisionStale(decision, eventsSince)` 被容器调用 THEN 系统 SHALL 判：decision 基于的 contract 版本是否变 / eventsSince 是否含触及同一 repo 的 `contract_change_applied` —— 与本需求的契约 diff **共用同一套结构比对**。
#### Error Cases
6. IF 同接口反复改 2-3 次仍不定 THEN 系统 SHALL 举手"设计本身可能有问题"（复用连拒升级基因），不再自动转。

### Boundaries
- **Must**：小改/大改由结构 diff 机械判；isDecisionStale 与契约 diff 共用；大改强制回灯②；小改完整留痕可退回纠正。
- **Should**：反复改举手用独立计数（不复用 assignment.retries）。
- **Never**：不在 reducer 里调 LLM 判 stale；不把"小改还是大改"交给 AI 自由裁量。

---

## Requirement 11: Worker 执行（write 档 + worktree + 自测硬门 + 崩溃恢复）

**User Story**：作为 Worker，我希望领到任务卡+冻结合同+该 repo 知识，在专属 worktree 里写代码并自测绿了才交活，以便交付物对得上合同、踩不到别人。

### Acceptance Criteria
#### Happy Path
1. WHEN worker 领活 THEN 系统 SHALL 组 `composeWorkerPrompt`（任务卡 brief + 冻结合同 + 该 repo 知识 + 返工说明），**去掉 probe 的"只读不改"系统句**。
2. WHEN worker run 启动 THEN 系统 SHALL 用 write 档（R04）在该 worker 的 worktree（R05）cwd 里跑。
3. WHEN worker 交活前 THEN 系统 SHALL 跑绿 ① 跨端契约测试（R12）② 本端单测 + 类型/编译，**绿了才交活**（不绿判 run_failed，照 reportRequired 门新增"测试结果门"）。
#### Edge Cases
4. WHEN worker run 崩溃恢复 THEN 系统 SHALL `canResume` 查 agentSessionId 可续 + worktree 是否脏：能续则 resume；不能则**先重置/丢弃 worktree 半成品再 redispatch**（不照搬 probe 的 `canResume:()=>false`）。
5. WHEN 输出报告 THEN 系统 SHALL 产结构化报告（代码校验必备项）+ 代码分支，报告进 artifact 仓、代码进 worktree。
#### Error Cases
6. IF 测试不绿 THEN 系统 SHALL 判 run_failed（不放行），进 retry/返工。

### Boundaries
- **Must**：单仓单 assignment 无状态；write 档 + worktree；各端自测硬门（绿了才交活）；崩溃恢复回干净基线再重派。
- **Should**：worker prompt 自包含（从 batch 重组，单飞 wake 重派也能工作）。
- **Never**：不照搬 probe canResume:()=>false；worker 不能 `ctx.emit('run_completed')` 伪造完成（emit 拦截）；本端单测可 worker 自写但跨端契约测试不许碰（R12）。

---

## Requirement 12: 跨端契约测试独立生成

**User Story**：作为系统，我希望跨端契约测试独立于实现 worker 产出，以便"绿"证明的是"对合同理解对"而非"自己跟自己自洽"。

### Acceptance Criteria
#### Happy Path
1. WHEN 需要跨端契约测试 THEN 系统 SHALL **从冻结合同机械生成**，或由**独立角色（质检员）产出**，实现 worker 不许碰。
2. WHEN 本端单测 THEN 系统 SHALL 允许实现 worker 自写（验自己逻辑）。
#### Edge Cases
3. WHEN 契约变更 THEN 系统 SHALL 重新生成受影响的契约测试。
#### Error Cases
4. IF 实现 worker 自己写了"我符合合同"的测试 THEN 系统 SHALL 视为无效（同一 AI 按同种可能错的理解既写实现又写验证、会一致地错还照绿）。

### Boundaries
- **Must**：跨端契约测试独立于实现 worker（机械生成或独立质检员）。
- **Should**：与 spec-design"Adversarial 用独立子 Agent"同源（独立性是"绿"有意义的前提）。
- **Never**：实现 worker 不许写/改跨端契约测试。

---

## Requirement 13: 集成验证

**User Story**：作为系统，我希望在各端实现后做集成验证（代码层 AI 兜底），以便交给人验收前先确认各端真的对得上合同。

### Acceptance Criteria
#### Happy Path
1. WHEN 进入集成验证 phase THEN 系统 SHALL 由"质检员"角色（owner 的一个 phase 动作或专门 assignment）拿冻结合同当标尺。
2. WHEN 代码层验证 THEN 系统 SHALL ① 汇总各端契约测试结果 ② 跨端静态对账（各端实现 vs 合同逐条核：接口/字段类型/调用），经新 effect kind `integration_check` + handler，产出**差异报告**。
3. WHEN 代码层绿 AND（如需）人过真交互 THEN 系统 SHALL 进灯③验收。
#### Edge Cases
4. WHEN 对不上 THEN 系统 SHALL 接 R10 返工流程派修复 assignment（新 worker，不复活旧），修复循环上限 2 轮。
5. WHEN 需真交互验证 THEN 系统 SHALL 用临时 worktree 把各端分支拉一起、按各仓 runbook 起服务，**交给人点**（该上才上，非每需求标配）。
#### Error Cases
6. IF 修复循环超 2 轮 THEN 系统 SHALL 建 human wait 升级（连续集成失败说明契约或拆解有问题）。

### Boundaries
- **Must**：代码层绿了才放行；差异报告对不上接返工；修复循环上限 2 轮（独立计数）。
- **Should**：真交互验证按需，不标配。
- **Never**：不用 assignment.retries 计修复循环。

---

## Requirement 14: 前端 UI 特殊处理

**User Story**：作为维护者，我希望前端 worker 只搭到"能本地一键跑起来看"，UI 精修由我主导，以便像素体验这种 AI 难自验的事留给人。

### Acceptance Criteria
#### Happy Path
1. WHEN 前端 worker"完成" THEN 系统 SHALL 定义为"搭到用户能本地一键跑起来看（结构 + 数据对接，可自验）"，UI 精修不另设 gate 由人主导（小改人改、大改甩回 AI）。
#### Edge Cases
2. WHEN 人手改完 UI THEN 系统 SHALL 要求该端的契约测试 + 类型/编译**重跑绿**（防人改破坏对接）。
3. WHEN 前端汇入灯③总验收 THEN 系统 SHALL 要求条件 = 代码层硬门绿 ∧ 人对 UI 满意（∧ 如需真交互），都满足才算这端过。
#### Error Cases
4. IF 人改 UI 后代码层硬门不绿 THEN 系统 SHALL 不算该端过。

### Boundaries
- **Must**：UI 像素不进对接合同；"人调满意=前端过"只指 UI 体验层不另设 gate，代码层硬门照旧。
- **Should**：前端搭到可本地自验。
- **Never**：不让 UI 体验的人审替代代码层硬门。

---

## Requirement 15: 灯②设计审接 spec-design + 跨端一刀

**User Story**：作为维护者，我希望 requirement 的"设计契约"阶段复用我自有的 spec-design 方法论 + 跨端一刀，以便设计必审、对抗挑刺、按端切并行。

### Acceptance Criteria
#### Happy Path
1. WHEN 进入设计 phase THEN 系统 SHALL 通过 effect 调起一个跑 spec-design 流程的 managed run，产物落 artifact 仓 `contract/` + `design/`。
2. WHEN spec-design 的 `internal-apis.md`（单库内部 API 契约）产出 THEN 系统 SHALL **升格为"前后端对接合同"** = 灯②快拍确认对象。
3. WHEN spec-design 的 `design/` 产出 THEN 系统 SHALL **按端/仓库再切**、各端 worker 并行领走。
#### Edge Cases
4. WHEN 灯②快拍 THEN 系统 SHALL 让人花两三分钟扫接口清单"够不够用、有没有漏"，认了→合同冻结=发令枪；慢拍各端详设回工作台逐块细审。
5. WHEN Adversarial（唱反调 AI）启动 THEN 系统 SHALL 用独立子 Agent 专挑接口的刺（上限/边界/字段缺失），尽量开工前挑净。
#### Error Cases
6. IF 设计被打回 THEN 系统 SHALL 回退设计 phase 重走（流程伸缩 Lite/Full，"设计→人审"内核不动）。

### Boundaries
- **Must**：设计必审不论大小；spec-design 内核复用；internal-apis 升对接合同、design 按端拆。
- **Should**：流程伸缩用 spec-design 的 Lite/Full 轨道（伸缩对抗轮数/文档厚薄）。
- **Never**：不因任务小跳过"设计→人审"内核。

---

## Requirement 16: 仓库知识层

**User Story**：作为系统，我希望各端 worker 懂各自仓库（架构/约定/构建测试命令/坑），以便不用每个工作项重新读懂仓库一遍。

### Acceptance Criteria
#### Happy Path
1. WHEN 知识层建立 THEN 系统 SHALL 在 `$DATA_DIR/knowledge/<repo_key>/{map.md, conventions.md, runbook.md, pitfalls.md}` + `_system/topology.md` 整体 git 化。
2. WHEN worker 任务卡组装 THEN 系统 SHALL 按 assignment 关联 repo **选择性注入**知识（有上限），不全塞。
3. WHEN 建立知识 THEN 系统 SHALL 每 repo 一次性索引任务生成初版（与 spec-design"代码考古"产物对接复用），`_system/` 人+agent 访谈式整理。
#### Edge Cases
4. WHEN 知识文件锚定生成时 commit hash AND 消费时 HEAD 偏离超阈值 THEN 系统 SHALL 标 stale 触发重建（阈值经验默认可配，第 7 步校准）。
#### Error Cases
5. IF `src/knowledge/` 含业务词 THEN 系统 SHALL **先在 `architecture.ts:109-114` 加 `knowledge/` 层分支**（否则落 kernel 触发禁词，R16 前置改动）。

### Boundaries
- **Must**：knowledge 独立一层、不依赖 workitems（知识跟 repo 走）；选择性注入有上限；架构红线加 knowledge 分支。
- **Should**：保鲜阈值可配置、第 7 步实测校准。
- **Never**：不全塞知识；不让 knowledge 依赖 workitems。

---

## Requirement 17: HTML 工作台读视图

**User Story**：作为维护者，我希望有一个"需求批阅台"网页看需求全貌（活动流/各端工人/决策台账/产物文档），以便锚点卡被群消息淹没时一眼总览、就地读文档。

### Acceptance Criteria
#### Happy Path
1. WHEN 访问工作台 THEN 系统 SHALL 在常驻进程内挂**轻量 HTTP 服务**（Node 自带 http，不引前端框架）SSR 渲染。
2. WHEN 渲染单需求工作台 THEN 系统 SHALL 从现有数据源读：活动流←`workitem_events`、各端工人←`workitem_assignments`、"该你了"焦点卡←open `workitem_waits`(human)、决策台账/大纲/详览/合同←artifact 仓 `.md`。
3. WHEN 展示 MD 文档（大纲/详览/各端详设）THEN 系统 SHALL **在 HTML 内就地渲染**（marked.js 或后端），不本地打开。
#### Edge Cases
4. WHEN 页面拆分 THEN 系统 SHALL 按视图/路由拆多页（看板 `/`、工作台 `/workitem/<id>`、审设计 `/workitem/<id>/review`），共享样式/脚本，不必挤单 HTML。
5. WHEN 状态更新 THEN 系统 SHALL 第一版前端轮询版本号变了整页/局部刷（零框架，后续可升 SSE）。
#### Error Cases
6. IF 公司外访问 THEN 系统 SHALL 走内网穿透（如 cloudflare）。

### UI 交互
- 视觉走"决策者批阅台"纸张朱批风（原型 `prototype-req-flow.html` 为蓝本）。
- 单需求工作台为主（活动流 + 各端工人面板 + 决策台账 + 产物文档 + "该你了"焦点卡 + @包工头介入条），看板退成轻入口。
- 焦点卡"该你拍一下"+ 选项；工人面板进度条 + 当前动作；决策台账可展开看理由。

### Boundaries
- **Must**：读视图复用现成 SQLite + artifact，不另起炉灶；MD 就地渲染；轻量 HTTP 不引框架。
- **Should**：多页拆分；轮询刷新可升 SSE。
- **Never**：不引前端框架；agent 不碰页面（页面只读投影）。

---

## Requirement 18: 工作台事件回流写 API

**User Story**：作为维护者，我希望在工作台点按钮（通过/打回/裁决/@包工头）就能驱动系统，以便网页操作与飞书等价。

### Acceptance Criteria
#### Happy Path
1. WHEN 页面按钮触发 THEN 系统 SHALL 转事件经 **workitems 既有 inject 门面**（resolveWait / injectHumanMessage / 扩展的 checkpoint decision）→ reducer → 推进。
2. WHEN 写路径执行 THEN 系统 SHALL 保持"单写入口、页面只读投影"（agent 只按既有机制改状态/写文件、不碰页面）。
#### Edge Cases
3. WHEN 打回 THEN 系统 SHALL 带理由写进决策台账，包工头据此回去改这一处、不重走整套。
#### Error Cases
4. IF 非本人操作 THEN 系统 SHALL 本地服务鉴权拒绝（仅本人可操作，参考 ai-sentinel owner 校验）。

### UI 交互
- 通过/打回/裁决按钮；打回带理由输入框；@包工头介入条（不打断正在跑的工人）。

### Boundaries
- **Must**：写经 inject 门面（不新建写路径）；本地服务鉴权；单写入口。
- **Should**：操作与飞书灯卡等价。
- **Never**：页面不直接改 DB；非本人不可操作。

---

## Requirement 19: 飞书灯卡 + 一需求一话题

**User Story**：作为维护者，我希望一个需求一个飞书话题、4 灯是交互卡，以便在 IM 里也能拍板、进度可见。

### Acceptance Criteria
#### Happy Path
1. WHEN 创建 requirement THEN 系统 SHALL 复用 `claimThread`（managed）+ 锚点卡，一需求一话题。
2. WHEN 灯需要拍板 THEN 系统 SHALL 用飞书交互卡（按钮回调 R06），value 带 `{workitemId, checkpoint, decision}`。
3. WHEN 新增 requirement 卡片 THEN 系统 SHALL 新建"4 灯 rail / 各端工人 1/4 / 决策台账"卡片，守 kernel 中性命名（stage/status，不出现 phase 等业务词）。
#### Edge Cases
4. WHEN 复用现有卡片构造器 THEN 系统 SHALL 把标题前缀"调查 ·"参数化/新建专用构造器（否则显示"调查"误导）。
5. WHEN 新事件 kind（design_ready/checkpoint_*）THEN 系统 SHALL 在 `anchorAction` 加映射决定是否刷锚点（否则静默）。
#### Error Cases
6. IF 拿不到 threadRoot THEN 系统 SHALL 回落 chatId（同 postReport），updateCard 无回落则 log。

### UI 交互
- 锚点卡：4 灯 rail + 进度 + 状态。
- 每 worker 一张 M2 流式卡（按 assignmentId 分流，title 带 role/repo 区分）。

### Boundaries
- **Must**：一需求一话题复用 claimThread；灯卡守 kernel 中性命名；新事件 kind 同步扩 anchorAction。
- **Should**：去"调查"化标题。
- **Never**：飞书卡 value 不在 kernel 层被解释（业务词不进 feishu 层）。

---

## Requirement 20: 异常与监督

**User Story**：作为维护者，我希望系统出岔子时先自治重试、反复搞不定才举手并给"病历"，以便我退到决策点仍可预期。

### Acceptance Criteria
#### Happy Path
1. WHEN worker 失败/卡死/空转 THEN 系统 SHALL 复用 watchdog（心跳+墙钟+deadline）→ `assignment_stalled` → retry 预算 → 耗尽建 human wait（多 worker 各自被监督，beats 按 assignmentId 隔离）。
2. WHEN 举手找人 THEN 系统 SHALL 给"病历"（卡哪/试过啥/为啥不行）不甩报错，轻救场（多为一句话/一个选项）。
#### Edge Cases
3. WHEN checkpoint 被拒/回退 THEN 系统 SHALL 按 R03 回退，连拒 2 次升级对话。
4. WHEN 集成验证失败 THEN 系统 SHALL 按 R13 派修复 assignment，循环上限 2 轮超则 human wait。
5. WHEN 契约变更 THEN 系统 SHALL 按 R10 一等事件处理。
#### Error Cases
6. IF worker run handler 没挂 onActivity THEN 系统 SHALL 风险：长思考被误判 stalled（worker 必须照 run-handler:138 挂 onActivity）。

### Boundaries
- **Must**：异常路径与正向同等建模；先自治重试再举手；给病历不甩报错。
- **Should**：救场轻量（一句话/一个选项）。
- **Never**：不靠 prompt 让模型自己停；worker 不挂 onActivity。

---

## Requirement 21: 人工取消 /cancel 收尾

**User Story**：作为维护者，我希望能 `/cancel` 一个需求并安全收尾，以便半途叫停不留烂摊子、半成品有入口。

### Acceptance Criteria
#### Happy Path
1. WHEN `/cancel`（thread 内）THEN 系统 SHALL 弹确认卡（防误触）→ abort 所有 running assignment → **回收 worktree**（分支保留、worktree 删除）→ Owner 最后唤醒写收尾 `journal.md`（半成品在哪个分支）→ cancelled 终态。
#### Edge Cases
2. WHEN 取消 THEN 系统 SHALL **不删 artifact 仓**（半途成果是资产，收尾 journal 让"重启这个需求"有入口）。
#### Error Cases
3. IF 终态后 thread 追问 THEN 系统 SHALL 诚实回执（"该需求已结束，可重新 /req"），不假装受理（复用 M1b 终态守卫）。

### Boundaries
- **Must**：确认卡防误触；abort 全 worker；回收 worktree；收尾 journal；不删 artifact 仓。
- **Should**：复用现有 cancelled 态 + finalizeTerminalState。
- **Never**：不删半成品分支；不假装受理终态追问。

---

## Requirement 22: 提交 / 交付

**User Story**：作为维护者，我希望写码/提交自分支自动、但开 MR/上线必须我亲手点，以便最危险那一下留给我。

### Acceptance Criteria
#### Happy Path
1. WHEN worker 写代码、提交到自己 feature 分支 THEN 系统 SHALL 自动完成。
2. WHEN 到交付/提交（灯④）THEN 系统 SHALL 只到"分支就绪 + 给出 MR 草稿/发布顺序"，**开 MR/上线的动作不自动执行**（必须人亲手点）。
#### Edge Cases
3. WHEN 生成交付产物 THEN 系统 SHALL 产契约 + 设计决策 + N 个 PR（含发布顺序）+ 沉淀文档（写回知识层）。
#### Error Cases
4. IF 平台纪律（feature 基于 prod、pull --ff-only、MR 首行 rd:<id>）THEN 系统 SHALL 少量高危用代码/hook 拦、大量靠 prompt 自律 + 写明 why（沿用 ai-sentinel 经验）。

### Boundaries
- **Must**：写码/提交自分支自动；开 MR/上线人亲手点（灯④硬拦）。
- **Should**：平台纪律 prompt 自律为主、高危代码兜。
- **Never**：AI 不自主开 MR（会误触发飞书研发任务节点）。

---

## Requirement 23: 并发一致性 + noop 夹具回归

**User Story**：作为系统，我希望多 worker 真并发下的批次完整性与崩溃恢复被回归锁定，以便"几个 AI 照合同并行还能拼起来"可被测试证明。

### Acceptance Criteria
#### Happy Path
1. WHEN N 个 worker 并发完成 → 各自 enqueue `run_completed` → 串行 apply → 触发 Owner 唤醒 THEN 系统 SHALL 证明这批事件**不漏不重**（worker 在 Owner 运行期间完成的事件归入下一批）。
2. WHEN replacement 与多个 worker run 同时在途 THEN 系统 SHALL 在 `startupRecovery` 重建在途 effect、按 assignment 恢复 abort，覆盖这些组合。
#### Edge Cases
3. WHEN 回归测试 THEN 系统 SHALL 用扩展的 noop 夹具（注入 topology owner-workers / dispatch 多 role / checkpoints / failAt+failCount 编排失败序列）专打并发路径，像 M0 打 outbox 那样锁定。
#### Error Cases
4. IF recoverRun/recoverRunning 的 `inflight.has(workitemId)` 早退在多并发恢复下漏恢复 THEN 系统 SHALL 改之（随 inflight 键改造连带）并夹具验证。

### Boundaries
- **Must**：批次完整性 + 两条非单飞路径（replacement/worker）崩溃恢复论证；noop 夹具回归。
- **Should**：先 noop 跑通流程再接真 agent。
- **Never**：不假设 replacement 与 worker 两条非单飞路径互不影响。

---

## Requirement 24: 数据模型增量 + config

**User Story**：作为系统，我希望复用五表 + 增量字段/事件/config 承载 requirement 语义，以便不重起炉灶。

### Acceptance Criteria
#### Happy Path
1. WHEN 新增事件 kind THEN 系统 SHALL 把 `checkpoint_reached/checkpoint_decision/contract_frozen/contract_patched/contract_change_proposed/approved/applied/worker_report/integration_check_passed/failed/design_ready` 等写进 `workitem_events.kind`（容器不解释，DB 无 CHECK）。
2. WHEN assignment THEN 系统 SHALL 投入使用 `role='owner'/'worker'` + `parent_id`（现 schema 有，启用写入消费）。
3. WHEN artifact 仓布局 THEN 系统 SHALL 按 `brief.md / journal.md（校验）/ decisions.md / contract/ / design/ / assignments/<id>/{brief,report}.md / report.md` 组织（worktype 约定，ArtifactStore 不强制）。
#### Edge Cases
4. WHEN 新增列/config THEN 系统 SHALL 走 `user_version<3` 迁移 + 新增 `maxWorkersPerItem`（默认2）+ env。
#### Error Cases
5. IF 引入新持久化文件/库 THEN 系统 SHALL 挂 BackupJob 纳入日备份。

### Boundaries
- **Must**：复用五表；新事件 kind 容器不解释；role/parent_id 投入使用；新列走新迁移版本。
- **Should**：新持久化纳入备份。
- **Never**：不破坏 append-only 事件触发器；不在 reducer 解释新 kind 名（只 worktype onEvent switch）。

---

## 对抗审查回补（v1.1 增补/覆盖 AC）

> 23 条对抗挑战全部接受后的 AC 增补，明确标注覆盖/新增哪条。详细回应见 `adversarial-review-gate3.md` / `adversarial-review-gate5.md`。

### R01 多工人真并行调度（覆盖 AC4 + 新增 AC8/AC9/AC10）
- **AC4（覆盖）**：WHEN 判定 worker 并发上限 THEN 系统 SHALL 按 **DB 内 `status=running` 且 `role=worker` 的 assignment 计数**（reducer apply 内强一致，**不**用 inflight Map 那个 post-commit 才更新的运行时态），< `maxWorkersPerItem` 才放、否则转 wakePending。〔Gate3-C01 阻塞〕
- **AC8（新增）**：WHEN 同一 owner transition 一次 dispatch N 个 worker THEN 系统 SHALL **逐个累加在途计数**判入门（不让每个各读同一份旧快照而双双放行超放）。
- **AC9（新增）**：WHEN 被 wakePending 排队的 worker 在 owner-workers 拓扑下释放 THEN 系统 SHALL **按 role/排队信息补派对应 worker**，不再单条 `defaultDispatchSpec(role:solo)`（否则 worker 被派成 solo、role 错乱）。
- **AC10（新增·空态）**：WHILE 处于 `理解` phase（worker 数 = 0、owner 单飞）THEN 系统 SHALL 让 owner-workers 拓扑分流**退化为 solo 语义不报错**（worker 计数查询遇空集返 0）。〔Gate3-C04〕

### R02 Owner 协调与重建（覆盖 AC3 + 新增 AC7）
- **AC3（覆盖）**：WHEN owner 唤醒批量带入事件 THEN 系统 SHALL 取 **`(lastOwnerRunEffectSeq, currentOwnerRunEffectSeq]` 半开区间**（左开右闭，对齐 eventsSince 排他边界）。
- **AC7（新增）**：WHEN 事件在 owner 本次 run **运行期间**到达 THEN 系统 SHALL 把它**归入下一批**（锚到下次 owner run 起点 seq），保证不漏不重；配 noop 夹具回归"owner 运行中 worker 完成"时序。〔Gate3-C02〕

### R03 4 灯 checkpoint gate（覆盖 AC1 + 新增 AC7）
- **AC1（覆盖）**：WHEN worktype onEvent 检测到"将越过 `requiredBefore` 边界且该 gate 未 resolve" THEN 系统 SHALL 由 **worktype 主动返回 `waits:[human]` 而非 phase 变更**（拦在 worktype 侧，容器完全不碰 phase，保 mergeTransitions 不变量）；gate resolve 后 onEvent 再返回 phase 推进。〔Gate5-C06〕
- **AC7（新增）**：WHEN reducer 消费 checkpoint decision 前 THEN 系统 SHALL 走 isDecisionStale 校验；IF stale（合同在拍板前已被自治小改触动）THEN 系统 SHALL **拒绝 resolve 并重弹卡"合同已变、请重新确认"**，不静默推进。〔Gate3-C06〕

### R04 写权限档（新增 AC7）
- **AC7（新增·fail-closed）**：WHEN 以 write 档启动 worker 前 THEN 系统 SHALL **发一条"已知应被 deny 的探针命令"实测确认 PreToolUse hook 生效**；IF 验证不通过 THEN 系统 SHALL **拒绝以 write 档启动该 worker**（降级 readonly 或报人），绝不静默退化成无限制写。〔Gate5-C03 阻塞〕
- **Boundaries 增补**：write 档最终 args = `--add-dir` + PreToolUse hook（路径硬拦·主约束）+ 写工具集 `Write Edit NotebookEdit`，**不用 `--allowedTools` 白名单作主约束**；R04↔R05 强耦合（见 R05 AC7）。

### R05 worktree 工作区供给（新增 AC7/AC8）
- **AC7（新增）**：WHEN 准备 worker 工作区 THEN 系统 SHALL 让该 worker 的 **`writableDirs`（R04）与 managed task `cwd` 同源于该 assignment 的 worktree 路径**，二者同时确定/同时变更（redispatch 换 worktree 时一起更新，否则 hook 用旧 writableDirs deny 掉对新 worktree 的合法写）。〔Gate3-C07〕
- **AC8（新增·worktree 生命周期，见 D-27）**：系统 SHALL 提供 worktree 脏检测（`git status --porcelain`）与重置（`git reset --hard <feature 基线>` + `git clean -fd` **仅清本 assignment 已知产物目录、不全清**以免误伤未跟踪文件）；崩溃恢复 redispatch 前先重置回干净基线。〔Gate5-C02 阻塞〕

### R09 对接合同（新增 AC6 + 空态 AC7）
- **AC6（新增）**：WHEN 登记合同接口 THEN 系统 SHALL 每条接口记 **`providerRepo` / `consumerRepos`（repo key，不用业务端名）**；影响计算据此精准算受影响 worker，与 R05 拆分、R10 stale 判定共用同一 repo 维度（一端多仓/一仓多角色按 repo 展开）。〔Gate3-C03，见 D-29〕
- **AC7（新增·空态）**：WHILE 合同冻结前（`contract/` 目录尚不存在）THEN 系统 SHALL 让读合同**返空、不抛**。〔Gate3-C04〕

### R10 契约变更 + isDecisionStale（覆盖 AC5 + 新增 AC7/AC8）
- **AC5（覆盖）**：isDecisionStale 判据用 **repo 维度**（eventsSince 含触及同一 repo 的 `contract_change_applied`），与 R09 providerRepo/consumerRepos 一致。
- **AC7（新增·数据流硬约定）**：WHEN decision 产出 THEN 系统 SHALL 把所基于的 **contract 结构指纹固化进 `decision.data`**；contract 变更事件 payload SHALL 携带变更后的结构指纹/字段级 diff，使 isDecisionStale **仅凭 `decision.data` + `eventsSince` 纯同步判定、不读 fs**。〔Gate5-C04 阻塞〕
- **AC8（新增·语义残余）**：WHEN 契约变更是**语义等价但行为不同**（含义/单位/可空性/排序变，结构 diff 抓不到）THEN 系统 SHALL 要求人改契约时**人工标注 `semanticBreaking` 标志**（机械 diff + 人工标志双轨）；该类残余靠真联调兜底。〔Gate5-C05，见 D-31〕

### R11 Worker 执行（新增 AC7 + Boundaries）
- **AC7（新增）**：WHEN 自测不绿 THEN 系统 SHALL 区分两类结局——"**测试执行失败（断言红）**"→ retry/返工；"**测试无法执行（命令缺失/环境/编译基础设施问题）**"→ **不进自动 retry、直接举手**并在病历标根因类型（避免无限烧 retry 预算）。〔Gate3-C05〕
- **AC8（新增·恢复前置）**：worker resume 依赖 onSession 回调（D-30）让 session id 崩溃前已落库；不可 resume 时按 R05 AC8 重置 worktree 再 redispatch。〔Gate5-C01〕
- **Boundaries 增补**：worker 自测命令**来源于 R16 runbook**；runbook 缺失/过期时按"测试无法执行"降级举手。

### R12 跨端契约测试（覆盖 AC1）
- **AC1（覆盖·拍板）**：跨端契约测试**以"从冻结合同机械生成"为主**，独立质检员在机械生成覆盖不足时补语义层用例；**存 artifact 仓 `contract/tests/`**；产出时机 = **灯②合同冻结后即生成**。R11 跑绿它、R13 汇总它引用同一份。〔Gate3-C09〕

### R17 工作台（新增 AC7·空态）
- **AC7（新增·空态）**：WHEN 活动流/工人/合同/台账任一区块为空（刚创建、artifact 仓只有 brief.md）THEN 系统 SHALL **空态渲染（不抛、显占位），不返 500**。〔Gate3-C04〕

### R19 飞书灯卡（覆盖 AC5·一致性）
- **AC5（覆盖）**：系统 SHALL 保证 **R24 声明的每个新事件 kind 都在 `anchorAction` 有显式映射决定（刷新/不刷新），清单以 R24 为准**，二者同步；加测试断言两份清单不漂移（防漏挂导致锚点静默）。〔Gate3-C10〕

### R23 并发一致性（覆盖 AC4 + Boundaries）
- **AC4（覆盖）**：`recoverRun/recoverRunning` 的早退条件 SHALL 从 workitem 粒度改 **assignmentId/effectId 粒度**（否则同 workitem 多 worker 崩溃恢复只恢复第一个、其余静默吞掉）；noop 夹具专锁"同 workitem 多 worker **全部**恢复"断言。〔Gate5-C09〕
- **Boundaries 增补**：per-assignment 并发恢复以 R24 的"列某 workitem 全部 running effect 按 assignment 逐个恢复"查询为前提。

### R24 数据模型（新增 AC6/AC7）
- **AC6（新增）**：系统 SHALL 提供 **per-assignment 并发恢复所需查询**（"列出某 workitem 全部 running effect 并按 assignment 逐个恢复"，复用/新增 listInflightEffects 的 per-assignment 视图 + 必要索引）。〔Gate3-C08〕
- **AC7（新增·一致性）**：R24 新事件 kind 清单为 anchorAction 映射的**唯一权威**；每个 kind 必须有显式映射决定，CI 测试断言不漂移。〔Gate3-C10〕
