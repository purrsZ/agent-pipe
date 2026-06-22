# Decisions — requirement worktype

> **✅ 状态：2026-06-22 维护者审核通过**——全部 D-01~D-31 + 4 DEFER 采纳，后续实现以此为准。
> 本次需求过程中所有关键决策的统一台账。遇到分歧最后一次统一，所有后续设计/实现以此为准。
> ⚠️ 本轮维护者不在场，标 **🔶** 的决策是我替你拍的、影响面较大、最该你回来复核的（已汇总进 `决策待审.md`）。来源标 `调研` = 代码考古实证；`总纲` = 实现总纲已拍板；`推荐` = 我据现状的推荐裁决。

## D-01 🔶 本次只做「按代码仓库拆」，同仓竖切不做但接口不堵死
- **决策内容**：一仓一 worker、仓内默认不再拆；同仓多 worker（功能竖切）不实现，但 `AssignmentSpec`/worktree 接口上不堵死（未来放开只需补串行合并）。
- **来源**：总纲§5/§23① + 推荐
- **影响范围**：R01, R05, R11, R23
- **理由**："对得上"靠对接合同（逻辑一致）、"踩不到一起"靠各占一仓（物理隔离）。竖切要 worktree 隔离 + 串行合并，是另一个量级，违背"一次到位但不贪"。
- **备选方案**：本次就支持竖切 —— 放弃，串行合并复杂度高、收益在单需求场景有限。
- **⚖️ 增补（对抗审查 Gate5-C07）**：典型需求只动 2-3 仓、并行度低。**D-10/D-18 的首要理由从"真并行省墙钟"改为"per-assignment 物理隔离 + abort 不误伤其它 worker"**（正确性收益，并行度=2 也成立）；墙钟收益是次要。本次并行改造首要目标 = 隔离不踩踏。

## D-02 🔶 灯②快慢两拍靠「拆 phase」，7 phase 序列固定
- **决策内容**：phase 序列 = `理解 → 合同 → 详设 → 拆解 → 并行实现 → 集成验证 → 交付/沉淀`；灯①挂 `理解→合同`、灯②快拍挂 `合同→详设`、灯②慢拍挂 `详设→拆解`、灯③挂 `集成验证→交付`。
- **来源**：总纲§4/§6.2（倾向拆 phase）+ 推荐
- **影响范围**：R03, R08, R15
- **理由**：复用现成 `checkpoints.requiredBefore: string[]`（phase 名列表）语义，不引入"独立 checkpoint id"新概念；phase 边界天然对应"该停下来给人看"。
- **备选方案**：checkpoint 改独立 id 不绑 phase 边界 —— 放弃，新增概念、复杂度高于拆 phase。

## D-03 checkpoint 单轨：= human wait 用法，扩展 resolveWait 携带 decision
- **决策内容**：容器在 phase 越界到 `requiredBefore` 边界前自动插 human wait 拦截；拍板复用 `resolveWait(waitId,{operator,reason,decision:{approved,payload?}})`（一个动作 resolve wait + 产出决定）；不新增并行 inject 方法。
- **来源**：总纲§6.2 + 调研（api.ts:40 现 input 仅 {operator,reason}）
- **影响范围**：R03, R18, R19
- **理由**：守"单一注入口"；避免"wait resolved 但 phase 没动 / decision 绕过 wait"的不一致。
- **关键约束（调研）**：`mergeTransitions` 只取 worktype 侧 phase，容器侧**无法直接覆写 transition.phase**。
- **⚖️ 增补（对抗审查 Gate5-C06）拦截机制落到可实现粒度**：checkpoint 拦截**做在 worktype 侧** —— worktype 的 onEvent 检测到"将越过 requiredBefore 边界且该 gate 未 resolve"时，**主动返回 `waits:[human]` 而非 phase 变更**（容器完全不碰 phase，保 mergeTransitions 不变量）；gate resolve 后 onEvent 再返回 phase 推进。容器侧只提供"requiredBefore 声明 + gate 状态查询"，不做 phase 压制。
- **⚖️ 增补（Gate3-C06）checkpoint decision 过 stale 检查**：checkpoint decision 在 reducer 消费前走 isDecisionStale；若 stale → **拒绝 resolve 并重弹卡"合同已变、请重新确认"**（不静默推进）。防"人基于旧合同版本拍板、合同已被自治小改"。

## D-04 🔶 Claude 写权限档 = 纵深三层（--add-dir + PreToolUse hook + worktree）
- **决策内容**：write 档 = ① `--add-dir <worktree>` 声明可写范围（软约束）② **PreToolUse hook** 校验 Bash/Write/Edit 目标路径在 worktree 内、否则 deny（硬约束）③ worker 跑专属 worktree、凭证不进 prompt、适配器配置进 deny。
- **来源**：总纲§14/§23③ + 调研（agents-kernel 考古）
- **影响范围**：R04, R05, R11
- **理由（调研实证）**：`--add-dir` **放宽不收紧**，无法限定写入；现 readonly 靠 `--disallowedTools`（工具级）拦不住 Bash `>`/curl。唯一能真路径级硬拦的是 PreToolUse hook。
- **坑（调研）**：hook/settings 注入基建当前**不存在**（grep PreToolUse/hooks/--settings 在 src 零命中），要新建；write 档**绝不能**退化成 agents `full`（=`--dangerously-skip-permissions` 无限制丢目录限定）。
- **DEFER 判据**：hook 对 Bash 命令的路径解析有绕过面（如变量拼接路径）—— R04 详设给出"尽力拦 + 写明残余风险"的可验证方案，不追求 100% 拦死（强沙箱是 investigation/Codex 的事，write 档明确不依赖沙箱）。
- **⚖️ 增补（对抗审查 Gate5-C03）fail-closed**：hook 注入失败（settings 写失败/Claude 不认 hook/hook 崩溃）时**绝不能静默退化成无限制写**。worker 启动前**必须发一条"已知应被 deny 的探针命令"实测确认 hook 生效**，验证不通过则**拒绝以 write 档启动该 worker**（降级 readonly 或报人）。把"hook 在不在"从隐含前提变成启动时显式断言。
- **⚖️ 增补（Gate5-C13）write 档最终 args 拍死**：`--add-dir <worktree>`（声明范围）+ PreToolUse hook（路径硬拦，**主约束**）+ 写工具集收敛 `Write Edit NotebookEdit`。**不用 `--allowedTools` 白名单作主约束**（hook 管路径、工具集收敛只清过时 MultiEdit，两者不重叠）。

## D-05 isDecisionStale 用契约结构 diff，与契约变更共用，不下沉 LLM
- **决策内容**：`isDecisionStale(decision, eventsSince)` 判 decision 基于的 contract 版本是否变 / eventsSince 是否含触及同一 repo 的 `contract_change_applied`；与 R10 契约变更判定**共用同一套 contract 结构比对**。
- **来源**：总纲§6.3/§23② + 调研（reducer.ts:757 接入点已就绪）
- **影响范围**：R10
- **理由**：契约结构化（字段/提供方/调用方），diff 可机械化；共用避免两处各写脆弱规则；reducer 里不能调 LLM。
- **备选方案**：纯函数里调 LLM 判语义 —— 放弃，reducer 同步纯转移、不能 await；若未来确需语义判断，下沉为异步 effect。
- **⚖️ 增补（对抗审查 Gate5-C04）数据流前提（硬接口约定）**：isDecisionStale 是纯同步纯函数、**禁 fs/await，拿不到 artifact 仓的 contract 文件**。故 **decision 产出时把所基于的 contract 结构指纹固化进 `decision.data`；contract 变更事件 payload 必须携带变更后的结构指纹/字段级 diff**，使 isDecisionStale 仅凭 `decision.data` + `eventsSince` 即可纯同步判定、不读 fs。这是 R10 与 contract 相关 R 的硬接口约定（见 D-31 适用边界）。

## D-06 集成验证 = 契约测试汇总 + 跨端静态对账 effect，不锁框架，真联调按需
- **决策内容**：代码层 = ① 各端契约测试结果汇总（测试独立生成 D-24）② 跨端静态对账（读各端实现 vs 合同逐条核）经新 effect kind `integration_check`，产差异报告。契约测试框架不锁定（按各 repo runbook 既有测试栈）。真实联调（拉各端分支起服务）= 人上、非标配。
- **来源**：总纲§10/§23④ + 推荐
- **影响范围**：R13, R12
- **理由**：静态 + 契约覆盖大部分跨端错配、成本低；联调工作量差一个数量级，按需。
- **备选方案（对抗审查 Gate5-C12 补）**：每需求强制最小真实联调 —— 放弃，工作量差一个数量级、多数需求静态+契约已够；联调列为按需增量（语义等价错配等结构 diff 抓不到的残余才需联调兜底，见 D-31）。

## D-07 Owner 重建 = 结构化快照权威 + journal 辅，重建税埋点观测
- **决策内容**：每次唤醒给 owner 从结构化状态机械生成的"现状快照"作权威输入；journal 降为人类可读叙事补充、非真相源；冲突结构化优先。重建税第 7 步端到端埋点观测（记每次 owner run token/输入规模），不预先优化。
- **来源**：总纲§5/§23⑤ + 调研（lastRunEffectSeqBefore/eventsSince 可作组批砖）
- **影响范围**：R02
- **理由**：与 P3"状态在服务侧"一致；先有数据再谈优化。
- **备选方案（对抗审查 Gate5-C12 补）**：journal 为权威 + 结构化为辅（反过来）—— 放弃，journal 是 LLM 自由叙事、会漂移/自圆其说（ai-sentinel 最大痛点），把权威押在它上等于让模型自证；结构化状态是代码 enforce 的真相，必须为权威。

## D-08 知识层一次性索引 + 保鲜阈值经验默认可配
- **决策内容**：每 repo 一次性索引任务生成初版（与 spec-design 代码考古产物对接复用）；`_system/` 人+agent 访谈式整理；保鲜锚定生成时 commit hash、消费时 HEAD 偏离超阈值标 stale 重建；阈值经验默认（如 >200 commits 或 >30 天）可配，第 7 步校准；选择性注入有上限。
- **来源**：总纲§15/§23⑥ + 推荐
- **影响范围**：R16
- **理由**：知识跟 repo 走不跟工作项走；阈值是可调参数。

## D-09 🔶 worker 崩溃恢复不照搬 probe canResume:()=>false
- **决策内容**：worker run `recovery='resume-or-redispatch'`，`canResume` 查 agentSessionId 可续 + worktree 是否有未提交脏改动：能续则 resume；不能则**先 git worktree 重置/丢弃半成品回干净基线再 redispatch**。
- **来源**：调研（run-handler.ts:73 probe canResume:()=>false 因 readonly 幂等）+ 推荐
- **影响范围**：R11, R23, R05
- **理由（调研）**：probe readonly 幂等可直接 redispatch；worker write 已改盘（非幂等），盲目 redispatch 重跑会污染 worktree/重复改动。崩溃恢复必须保证 worktree 回干净基线再重派。
- **⚖️ 增补（对抗审查 Gate5-C01）resume 分支的前置依赖**：run-handler.ts:74-77 注释明确"M1b 无 onSession 回调 → session id 崩溃前不可靠落库 → 真 --resume 不可能"，故 **resume 分支在崩溃场景几乎必然取不到 session id**。处置：**新增 D-30「补 runner onSession 回调」作为前置**（session 创建即同步落库，让 resume 可达）；若不补 onSession，则 D-09 **诚实退化为"worktree 重置 + 全量 redispatch"单分支**，删 resume 承诺（不制造永不可达死代码）。
- **⚖️ 增补（Gate5-C02）worktree 重置基建**：D-09 的"git worktree 重置"依赖 **D-27「worktree 生命周期管理子系统」**（ArtifactStore 只管 artifact 仓、对 worktree 用不上），见 D-27。

## D-10 inflight Map 键 workitemId → assignmentId
- **决策内容**：`EffectRuntime.inflight` 键从 workitemId 改 assignmentId（值 {effectId, controller}），连带改 poke/drainOne 守卫、findInflight 反查、executeEffect finally delete、recoverRun/recoverRunning 早退（6+ 处）。owner 单飞靠 reducer 单飞门按 role 分流（不靠 inflight 键）。
- **来源**：调研（effects.ts inflight Map 是真并行最大障碍）+ 总纲§6.1
- **影响范围**：R01, R23
- **理由**：per-assignment 是 **per-assignment abort（不误伤其它 worker）的物理前提**（正确性收益，首要；并行度=2 也成立，墙钟次要——见 D-01 增补）。
- **⚖️ 增补（对抗审查 Gate3-C01）"在途 worker 数"口径**：单飞门按 role 分流时，**在途 worker 数按 DB `status=running` 且 `role=worker` 的 assignment 计数**（reducer apply 内强一致，避 inflight 的 post-commit 时序）；同一 transition 批量 dispatch N worker 时**逐个累加计数、不各读快照**；`releaseWakePending` 在 owner-workers 下**按 role/排队信息补派**，不再单条 `defaultDispatchSpec(role:solo)`。
- **⚖️ 增补（Gate5-C09）恢复早退升正确性约束**：`recoverRun/recoverRunning` 的早退条件从 `inflight.has(workitemId)`（workitem 粒度）改 **assignmentId/effectId 粒度**（否则同 workitem 多 worker 崩溃恢复只恢复第一个、其余静默吞掉）；noop 夹具专锁"同 workitem 多 worker 全部恢复"断言。

## D-11 🔶 修复/返工循环用独立计数，不复用 assignment.retries
- **决策内容**：集成验证修复循环（2 轮）、契约同接口反复改（2-3 次举手）各用 workitem 级独立计数器（存 `context_json` 或专用事件统计），不复用 `assignment.retries`。
- **来源**：调研（config.ts:18 retryBudget 默认1、全局共用于 watchdog stall）+ 推荐
- **影响范围**：R10, R13, R20
- **理由**：两种"重试"语义不同（活性卡死重启 vs 语义返工），混用会让一处调参误伤另一处。
- **⚖️ 增补（对抗审查 Gate5-C08）锚定维度 + stall 对账**：独立计数**锚在"逻辑任务（repo+phase）"而非物理 assignment**；`redispatchOrEscalate` 产生的 replacement assignment **必须继承前任的返工计数**（与继承 retries 类似但分开两个字段）。否则 stall 重派会洗白返工次数、绕过 2-3 次举手上限、掩盖死循环。

## D-12 卡片回调走 ws，不起 HTTP；kernel 不解释 value
- **决策内容**：在 `EventDispatcher.register` 加 `card.action` 事件键（走 ws）；kernel/feishu 层只分发 raw card action（value 当不透明 payload 透传），不解释 workitemId/checkpoint；上层 workitems adapter 解释。
- **来源**：调研（feishu 纯 ws、无 HTTP 端点）+ 总纲§16
- **影响范围**：R06, R19
- **理由**：ws 已有、改造面小；守 kernel 红线（feishu 层不出现业务词，CI 拦）。
- **备选方案（对抗审查 Gate5-C12 补）**：复用现有 `im.message.receive_v1` 入站通道（把按钮点击当文本消息处理）—— 放弃，卡片 action 回调与消息是飞书两类事件、payload 结构不同，硬塞入站通道要反解析、且拿不到 3 秒 toast 时机；新增 `card.action` 事件键是飞书原生、走同一 ws、改造面同样小。

## D-13 🔶 HTML 工作台 = 轻量 HTTP + 多页拆分 + 多 agent UX 走查
- **决策内容**：常驻进程内挂轻量 HTTP（Node 自带 http，不引前端框架）SSR；原型从单文件 mock 扩成按视图/路由拆分多页（看板 `/`、工作台 `/workitem/<id>`、审设计 `/workitem/<id>/review`），共享样式/脚本；交互细化阶段**派多个子 agent 对抗式走查交互**找低级/不易用场景再迭代。
- **来源**：总纲§16/§17 + 用户补充（"可拆多文件、多派子 agent 走查"）
- **影响范围**：R17, R18
- **理由**：读视图复用现成 SQLite + artifact；多页拆分让交互场景独立打磨；多 agent 走查是用户明确要求的质量手段。

## D-14 开 MR/上线人亲手点，平台纪律 prompt 自律为主
- **决策内容**：写码/提交自分支自动；灯④只到"分支就绪 + MR 草稿/发布顺序"，**开 MR/上线动作不自动执行**；平台纪律少量高危用代码/hook 拦、大量 prompt 自律 + 写明 why。
- **来源**：总纲§11/铁律5 + ai-sentinel 经验
- **影响范围**：R22
- **理由**：最危险那一下留给人（AI 自主开 MR 会误触发飞书研发任务节点）；过度代码化平台纪律性价比低。

## D-15 requirement worktype 三处接线，复用通用 handler + 注册专有 handler
- **决策内容**：落地三处 —— ① `src/worktypes/requirement/index.ts` 定义 `requirementWorkType` + `registerRequirement`；② `createWorkitemsRuntime`（index.ts:871 registerProbe 后）注册；③ 仿 `runProbe`（index.ts:498）写 `/req` 触发闭包。复用通用 agent-run handler，另注册 requirement 专有 effect handler（worker run / `integration_check` / checkpoint）。
- **来源**：调研（index-bridge 考古：probe 是直接照搬范本）
- **影响范围**：R08, R11, R13
- **理由**：三处之外的运行时（pool/影子 task/话题认领/入站路由/出站锚点/进度卡/备份/停机）全部已通用、零改动复用。

## D-16 知识层前置改 architecture.ts 加 knowledge/ 分支
- **决策内容**：实现 `src/knowledge/` 前**先在 `tests/helpers/architecture.ts:109-114` 的 layerFor 加 `knowledge/` 层分支**，否则 src/knowledge/ 落 kernel 触发禁词检测（CI 红）。knowledge 不依赖 workitems。
- **来源**：调研（arch-redlines 考古：layerFor 无 knowledge 分支，是红线盲区）
- **影响范围**：R16
- **理由**：知识层代码大概率含业务词（map/conventions 描述仓库），不加分支会被判 kernel 触发禁词。

## D-17 命名安全：requirement 安全，业务逻辑全在 worktypes 层
- **决策内容**：`requirement` 不在 kernel 禁词表（`workitem|workitems|assignment|worktype|phase`），命名安全；requirement 全部业务逻辑（phase 状态机、WorkItem/Assignment 类型自由用）放 `src/worktypes/requirement/`（worktypes 层不查禁词，但禁 async/await/fs/child_process）；kernel 侧（feishu 卡片回调、index 接线）只搬运不解释、判定下沉 `isTerminalStatus`/`anchorAction` 纯函数。
- **来源**：调研（arch-redlines 逐字词表 + layerFor + index-wiring grep）
- **影响范围**：R06, R08, R19, 全局
- **理由**：CI 硬门，命名/分层踩雷会直接红。

## D-18 Owner 预留槽改 pool Semaphore（§19 独立于 §14）
- **决策内容**：Owner 预留槽改 `pool.ts` 的 Semaphore（加预留计数/优先级队列让 owner acquire 插队）+ send 加中性 `priority`/`role` 入参（task.owner_kind 区分不了 owner-vs-worker，都 managed）+ evictLRU 可选保护 owner。
- **来源**：调研（agents-kernel：Semaphore 单一无差别池 FIFO → 优先级反转确凿）
- **影响范围**：R07, R01
- **理由（调研）**：worker 占满槽 → owner FIFO 排队尾饿死。总纲§14⑤"不用改 pool"指写权限档；§19 Owner 预留槽是另一条、确实改 pool（两者别混）。
- **⚖️ 增补（对抗审查 Gate5-C10）防二级死锁**：仅预留槽解决"排队公平"，但 owner 派 N worker 时**派 worker 本身也要槽**，会回队尾等 worker 释放、worker 又等 owner 指令 → **循环依赖卡死**。处置：**区分两类 acquire** —— owner 自身运行走预留槽；**owner 派 worker 是 reducer 内 dispatch（产出 pending effect 落库），worker run 的 acquire 在 effects 层异步发生、不阻塞 owner run 完成**（owner run 派完即结束、释放自己的槽，不在自己 run 内同步等 worker 槽）。DEFER-2 判据相应改为"端到端派出全部 worker 时长 + 是否出现 owner-worker 循环等待"。

## D-19 父子链 parent_id 启用写入 + 消费（非「免费拿」）
- **决策内容**：`AssignmentSpec` 增 `parentAssignmentId?`；`insertDispatchOrWake` 把它写入 assignment.parentId（替换 reducer.ts:616 恒 null）；补"读 parent_id"消费逻辑（批次归属/级联 abort）。
- **来源**：调研（reducer.ts:616 parentId 恒 null 从不读、是死列）
- **影响范围**：R02
- **理由**：schema 有列 ≠ 逻辑就绪；建 Owner→Worker 父子链要补完整写入+消费两端。

## D-20 artifact 仓 ≠ worktree，双路径严格分离
- **决策内容**：报告/契约/brief/journal/decisions 进 `$DATA_DIR/workitems/<id>/` artifact git 仓（writeArtifact）；代码改动进 worker 目标仓 worktree（cwd）。两套路径不混用。
- **来源**：调研（worktypes 考古明确区分）
- **影响范围**：R05, R11, R21
- **理由**：职责分离 —— artifact 是过程产物/审计、worktree 是代码工作区；混用会导致回收/恢复错乱。

## D-21 写档 fingerprint 纳入 writableDirs（堵隐藏缺口）
- **决策内容**：`runOptionsFingerprint`（agents/types.ts:119）除 permission.mode 外**纳入 write 的 writableDirs**，否则同 task 换 repo 集时 runner 不重建、旧 `--add-dir` 指旧目录。
- **来源**：调研（agents-kernel：fingerprint 只取 permission.mode 是隐藏缺口）
- **影响范围**：R04
- **理由**：换 repo 不重建 runner = 写到错目录的隐患，必须连 R04 一起改。

## D-22 写工具集收敛为 Write Edit NotebookEdit（MultiEdit 已过时）
- **决策内容**：write 档若用 `--allowedTools` 白名单，写工具集收敛为 `Write Edit NotebookEdit`（MultiEdit 已合并进 Edit）。readonly 的 deny 列表留着 MultiEdit 无害（deny 不存在工具不报错）。
- **来源**：调研（agents-kernel + 总纲"MultiEdit 过时"）+ 推荐
- **影响范围**：R04
- **理由**：白名单含已废弃工具会失效/误导。
- **⚖️ 增补（对抗审查 Gate5-C13）与 D-04 对齐**：write 档**不用 `--allowedTools` 白名单作主约束**，路径硬拦交 PreToolUse hook（见 D-04 增补的最终 args 组合）；本决策只负责"写工具集去过时 MultiEdit"这一项，不再讨论白名单。

## D-23 worker prompt 重写系统句（去「只读不改」）
- **决策内容**：`composeWorkerPrompt` 必须重写系统句、去掉 probe 的"只读、不要修改任何文件"（run-handler.ts:199-200），不能仅替换 title 入参。
- **来源**：调研（worktypes：probe prompt 第一句硬编码只读，与 write 档矛盾）
- **影响范围**：R11
- **理由**：模型被告知不要改文件却要写代码 = 自相矛盾。

## D-24 跨端契约测试独立于实现 worker
- **决策内容**：跨端契约测试从冻结合同**机械生成**或由**独立角色（质检员）**产出，实现 worker 不许碰；本端单测可 worker 自写。
- **来源**：总纲§9（采纳审查）
- **影响范围**：R12, R11, R13
- **理由**：同一 AI 既写实现又写验证、会一致地错还照绿 —— 独立性是"绿"有意义的前提（与 spec-design Adversarial 用独立子 Agent 同源）。
- **⚖️ 增补（对抗审查 Gate3-C09）拍板分工 + 存放 + 时机**：跨端契约测试**以"从冻结合同机械生成"为主**（确定性、可重复），独立质检员在机械生成覆盖不足时**补语义层用例**；**存 artifact 仓 `contract/tests/`**；产出时机 = **灯②合同冻结后即生成**。R11"worker 跑绿它"、R13"汇总它"引用同一份明确产物。

## D-25 前端代码层硬门照旧（人改 UI 后重跑绿）
- **决策内容**："人调满意=前端过"只指 UI 体验/视觉层不另设 gate；人手改完 UI，该端契约测试 + 类型/编译要**重跑绿**；前端汇入灯③条件 = 代码层硬门绿 ∧ 人对 UI 满意（∧ 如需真交互）。
- **来源**：总纲§12（采纳审查）
- **影响范围**：R14
- **理由**：防人改破坏对接；UI 体验的人审不替代代码层硬门。

## D-26 一次交付，但内部按依赖序推进（每段可测）
- **决策内容**：实现序 = ① 地基改造（reducer 并行 + checkpoint gate + noop 夹具回归）② kernel 能力（写权限 + worktree + 卡片回调 + Owner 预留槽）③ requirement worktype 骨架（先 noop 级 run handler 跑通流程）④ 接真 agent（worker run + 集成验证 + 对接合同 + isDecisionStale）⑤ 知识层 + 设计审接 spec-design ⑥ HTML 工作台 + 事件回流 ⑦ 端到端（真双端需求：1 Owner + 后端 + 前端 worker）。
- **来源**：总纲§21 + 调研
- **影响范围**：全局（这是给执行 skill 的开发顺序参考，不是 phase 划分）
- **理由**：虽一次交付，内部按依赖推进最稳；每段可独立测；端到端验证"几个 AI 照合同并行还能拼起来"是本项目要立住的核心命题。

---

## 对抗审查催生的新增决策（D-27~D-31）

## D-27 🔶 worktree 生命周期管理子系统（从 0 到 1）
- **决策内容**：worker 目标仓 worktree 的"创建/定位/脏检测/重置/回收"是**全新子系统**（挂 R05/R11），不复用 ArtifactStore（它只管 artifact 仓）。能力：路径分配（一 assignment 一 worktree）、`git worktree add <path> <branch>`/`remove`、脏检测 `git status --porcelain` on worktree、**重置策略 = `git reset --hard <feature 基线>` + `git clean -fd` 仅清本 assignment 已知产物目录（不全清，以免误伤未跟踪有用文件）**。
- **来源**：调研（artifacts.ts 只操作 artifact 仓）+ 对抗审查 Gate5-C02
- **影响范围**：R05, R09(D-09), R11, R21
- **理由**：D-09 的"git worktree 重置"、D-20 的双路径分离都依赖它，但全仓零基建；"重置回基线"错一次=worker 真实代码产出被销毁（改盘操作），必须立项并把重置策略的未跟踪文件风险讲清。
- **备选方案**：复用 ArtifactStore.isClean/reconcile —— 放弃，那操作的是 artifact 仓不是 worktree，D-20 已定二者严格分离。

## D-28 (并入 D-26，编号保留占位以免跳号)
- 见 D-26 实现切分序。

## D-29 合同接口登记 providerRepo / consumerRepos（统一 repo 维度）
- **决策内容**：对接合同每条接口**直接登记 `providerRepo` 与 `consumerRepos`（repo key）**，而非业务端名（"后端/前端"）。影响计算（R09）、worker 拆分（R05）、isDecisionStale（R10）**共用同一套 repo 维度标识**；"一端多仓/一仓多角色"按 repo 展开（一仓一 worker）。
- **来源**：对抗审查 Gate3-C03
- **影响范围**：R09, R05, R10
- **理由**：合同用"端"、影响落"worker"、stale 用"repo"三套维度间映射是影响计算正确性前提，统一到 repo 维度才能精准算受影响 worker、避免漏返工/过度返工。

## D-30 🔶 补 runner onSession 回调（worker resume 前置）
- **决策内容**：runner 新增 `onSession` 回调，**session 创建/首条事件即 `setAgentSessionId` 同步落库**，让 worker 崩溃恢复的 resume 分支可达（kernel 通用能力，对 probe 多轮 resume 也有益）。**若不补此前置，D-09 的 worker 恢复诚实退化为"worktree 重置 + 全量 redispatch"单分支**（删 resume 承诺，不留死代码）。
- **来源**：调研（run-handler.ts:74-77 注释：M1b 无 onSession、session id 崩溃前不可靠落库）+ 对抗审查 Gate5-C01
- **影响范围**：R11, R23, kernel agents 层
- **理由**：D-09 默认"崩溃时 session id 可查"，但崩溃恰是 session id 大概率未落库的场景，resume 分支几乎必然走不到。要么补 onSession 让它可达，要么诚实承认单分支——不给执行 skill 制造永不可达死代码。
- **推荐**：补 onSession（真实 kernel 缺口、收益超出 requirement）。

## D-31 契约结构 diff 的适用边界 + semanticBreaking 人工标志
- **决策内容**：结构 diff（D-05/D-10）**只覆盖结构级变化（字段增删/类型变）**，**语义等价改动（含义/单位/可空性/排序变）不可机械检出，属已知残余**。处置：**contract 变更事件要求人工标注 `semanticBreaking` 标志**（人改契约时主动声明语义级变更），机械 diff + 人工标志双轨；语义残余靠 D-06 的"人上真联调"兜底。
- **来源**：对抗审查 Gate5-C05
- **影响范围**：R09, R10
- **理由**：结构没变、语义变了（如金额元→分、status 0=成功→失败）恰是跨端联调最易翻车处，而 isDecisionStale/静态对账全失灵；不能假装机械 diff 能抓语义，必须显式标残余 + 人工标志补。

---

## DEFER（读完真实代码仍需实测/外部确认才能定，给明判据）

- **DEFER-1（R04）Claude 写档对 Bash 路径的拦截强度**：PreToolUse hook 能拦 Write/Edit 的 path，但 Bash 命令里变量拼接/管道写盘的路径解析有绕过面。判据：R04 详设给出 hook 实现 + 列明残余风险 + 验证用例（直接 `echo>越界路径` 应被拦、`VAR=路径; echo>$VAR` 标为已知残余）。**不追求 100% 拦死**（强沙箱明确不在本次范围）。
- **DEFER-2（R07）Owner 预留槽大小**：因 D-18 增补已把"owner 派 worker"移出 owner run 的同步 acquire，预留槽主要保 owner 自身运行。判据**改为可单样本证伪的二元探测**：第 7 步若出现 ①owner 唤醒到执行等待 > 30s 或 ②owner-worker 循环等待（watchdog 探测到）即判预留不足，否则默认预留 1 足够。**不靠单样本"校准"分布**。
- **DEFER-3（R16）知识层冷启质量 / 保鲜阈值**：⚖️（对抗审查 Gate5-C11）单样本无法校准统计阈值。**诚实声明**：stale 阈值（>200 commits / >30 天）**首版按经验默认上线，靠生产埋点持续校准**；第 7 步只验"埋点管道通 + map.md 初版能让 worker 跑通一个 repo 的活"（二元），不假装一次端到端能定阈值。
- **DEFER-4（R02）Owner 重建税**：⚖️（Gate5-C11）同理。**诚实声明**：重建税阈值靠生产持续观测；第 7 步只验"埋点记到了 owner run 输入规模/token（管道通）+ 单需求重建未超 context 上限"（二元），增量快照/分段策略待生产数据积累后再定，非第 7 步定值。
