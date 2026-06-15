# Execution Log -- workitems-m0

## Meta
- Feature: workitems-m0（WorkItem 容器 M0 里程碑）
- Track: DDD（Step 0.5 裁剪为「领域模型映射」并入 Step 1-2，待用户确认）
- UI: 否
- Verify-Env: web（实际形态：vitest 进程级集成测试，无浏览器；详见 evaluation.md）
- Started: 2026-06-11
- Current: Step 4（ready for build）
- Stage: ready-for-build
- Stage-History:
  - design: DONE
  - tasking: DONE
  - build: READY
  - close: -

## Dispatch Log

### [001] Step 0: 评估需求 -- 18:56
- Dispatch: prompts/evaluate.md
- Input: [docs/design/2026-06-11-workitem-macro-design.md, src/ 实勘, package.json, vitest.config.ts]
- Status: DONE（Subagent 会话中断于产出完成后，结果已核验完整）
- Output: docs/ai-specs/workitems-m0/evaluation.md —— 轨道判定 DDD；UI 否；Verify-Env web（进程级集成测试）；MVP 排除项 EX-1~EX-10；spec/ tasks/ 目录已建
- Issues: 4 项待确认 —— [I-001] backup 扩展是否进 M0；[I-002] §4.3 规则 2/3 是否全量进 M0；[I-003] open 上限 ≤3 enforce 是否进 M0；[I-004] M0 创建入口仅编程 API（默认按此执行）
- Decisions: [D-001] Step 0.5 领域建模建议由设计文档 §4 替代，裁剪为 spec/ 中一页「领域模型映射」（待用户确认）
- Gate: PASS（用户跳过问询，按推荐默认落定；如需调整可随时叫停回退）

### [002] Step 0 Gate 裁决 -- 19:05
- Dispatch: （编排者决策，无派发）
- Status: DONE
- Output: 轨道与范围落定
- Issues: 无
- Decisions:
  - [D-002] 轨道 = DDD，Step 0.5 不独立执行，裁剪为 spec/ 中「领域模型映射」页（设计文档 §4 即领域模型）
  - [D-003] I-001 backup 扩展纳入 M0（§10 依据）
  - [D-004] I-002 §4.3 规则 2/3 全量纳入 M0：单飞 + 批量带入、based_on_seq 结构检查、防颠簸计数；isDecisionStale 仅接口 + noop 退化实现（§4.3 标题即「M0 实现约束」）
  - [D-005] I-003 open 工作项 ≤3 enforce 纳入 M0（§9.1 / P3）
  - [D-006] I-004 M0 创建入口仅容器编程 API，不新增 CLI/飞书命令
- Gate: PASS

### [003] Step 1a: 分组规划 -- 19:10
- Dispatch: prompts/requirements-plan.md
- Input: [docs/design/2026-06-11-workitem-macro-design.md, evaluation.md]
- Status: DONE
- Output: 6 分组计划（返回值传递）：S1 storage-foundation / S2 lifecycle-projection / S3 reducer-concurrency / S4 effects-outbox / S5 waits-watchdog / S6 noop-verification；13 项交付清单全覆盖；依赖 G1→G2→G3→(G4∥G5)→G6 单向无环；预计 ~51 AC
- Issues: 无
- Decisions: [D-007] WorkType 接口归 G2；[D-008] 同事务 outbox AC 唯一归属 G4；[D-009] G6 承载 PID 锁验证与 kernel 装配触点；[D-010] 领域模型映射页为 spec/ 顶层共享页（Step 2 产出）
- Gate: PASS（无 Issues、分组数 3-6，自动放行）

### [004-009] Step 1b: 分组编写（并行 ×6） -- 19:35
- Dispatch: prompts/requirements-group.md ×6
- Input: [设计文档（各组指定章节）, evaluation.md, 部分组加读 backup.ts/config.ts/lifecycle.ts]
- Status: 全部 DONE
- Output: spec/S1~S6 六文件。AC 合计 74 点状 + 13 Flow；Gaps 合计 38（RED 0 / YELLOW 22 / WHITE 16）
  - [004] S1-storage-foundation: 14AC+1Flow, 7Gap —— 发现 backup 修剪正则与 workitems.sqlite 命名冲突隐患（G-1.5）
  - [005] S2-lifecycle-projection: 13AC+2Flow, 6Gap —— open 直达终态边、空活动 rollup 无定义、≤3 计数口径待 Step 2
  - [006] S3-reducer-concurrency: 12AC+2Flow, 7Gap —— 发现 PRD 字段对齐问题：based_on_seq 在 assignments 表而效果侧仅 seq（G-3.6）；事件 apply 时点两种解读（G-3.1）
  - [007] S4-effects-outbox: 11AC+2Flow, 6Gap —— 效果级失败重试、作废回流机制待 Step 2
  - [008] S5-waits-watchdog: 12AC+3Flow, 6Gap —— stalled 旧 assignment 终态取值、deadline_at/心跳/墙钟三者分工待 Step 2
  - [009] S6-noop-verification: 12AC+3Flow, 6Gap —— **发现 PID 锁语义疑似冲突：lifecycle.ts 是 takeover 语义（新杀旧）而非拒绝启动（G-6.1）**；退出码与 run-forever.sh 重启契约联动（G-6.6）
- Issues: 无 RED；G-6.1/G-1.5/G-3.6 为 Step 2 必解项
- Decisions: 各组裁决见对应 S{n} 文件（NULL dedupe_key 不参与幂等、终态不占名额、index.ts/config.ts 为依赖规则唯一装配豁免点等）
- Gate: PASS（全组 DONE，自动放行进入 1c）

### [010] Step 1c: 索引生成 -- 19:42
- Dispatch: prompts/requirements-index.md
- Input: [spec/S1~S6]
- Status: DONE
- Output: spec/_index.md（169 行）—— AC 74 + Flow 13；Gaps RED 0 / YELLOW 22 / WHITE 14；22 YELLOW + G-3.6 全部标注 Step 2 必解
- Issues: 跨组 3 实质问题：[I-005] S6 三处把 outbox 恢复机制误标 G5/G3（实归 G4）；[I-006] human/agent wait 主动 resolve 入口无组定义（建议归 G5，Step 2 必补）；[I-007] AC-5.11 委托 G4 的「中止 running 运行」通道在 S4 无对应 AC
- Decisions: [D-011] G-3.6 保留 WHITE 但升格标注 Step 2 必解对齐项
- Gate: PASS（无 RED Gap，自动放行进入 1.5a）

### [011] Step 1.5a: 分组校验 (S4) -- 20:01
- Dispatch: prompts/verify-requirements.md (mode=group)
- Input: [spec/S4-effects-outbox.md, 设计文档]
- Status: DONE
- Output: PASS 6/6 检查项通过，未写报告文件
- Issues: 无
- Decisions: 无
- Gate: PASS
- 备注: 原计划并行 ×6，其余 5 个派发被用户拒绝（并行过重）；调整为合并单发，见 [012]

### [012] 编排者决策：用户授权自主推进 -- 2026-06-11
- Dispatch: （无）
- Status: DONE
- Output: 用户明确授权「不需要产生交互来问我，你自己做决策」。此后所有 🔴/🟡 门禁由编排者代行裁决并留痕；派发模式倾向合并/小并发以控制开销
- Issues: 无
- Decisions: [D-012] 全流程自主决策授权生效；[D-013] 交互卡片原语（ai-sentinel interactive_choices 调研结论）不并入 M0 范围，维持设计文档 M2 排期，调研结论留档备用
- Gate: N/A

### [013] Step 1.5a: 分组校验（S1/S2/S3/S5/S6 合并单发） -- 2026-06-11
- Dispatch: prompts/verify-requirements.md (mode=group) 合并 ×5
- Input: [spec/S1,S2,S3,S5,S6, 设计文档, src/lifecycle.ts]
- Status: DONE
- Output: S1/S2/S3/S5 → PASS；S6 → verify/v1-S6-noop-verification.md（RED 0 / YELLOW 2：①AC-6.6/6.10/FLOW-6.2 outbox 恢复归属误写 G5/G3，应为 G4；②AC-6.10/FLOW-6.2 漏 §10 第四步事件↔artifact 对账断言）。特别核对确认：G-3.1 取向自洽、AC-3.12 可测、S5 不变量三面合围、G-6.1 takeover 语义事实准确
- Issues: S6 两条 YELLOW + 承接 [010] 的 I-005/I-006/I-007
- Decisions: [D-014] 无 RED 门禁放行，但在 Step 2 前一次性修正需求文件（S6 归属与对账、S5 补 wait 主动 resolve 入口、S4 补中止通道），避免设计阶段面对悬空引用
- Gate: PASS（无 RED；修正派发见 [014]）

### [014] Step 1.5 阻塞项修正（S4/S5/S6/_index） -- 2026-06-12
- Dispatch: 定点修正信封（首派 2026-06-11 末撞会话限额无落盘，2026-06-12 重派成功）
- Input: [verify/v1-S6, spec/_index.md, spec/S4/S5/S6, 设计文档]
- Status: DONE
- Output: S6 归属更正（FLOW-6.2 → G4+G5 分别标注）+ 补事件↔artifact 对账断言；S5 新增 AC-5.13 wait 主动 resolve 入口；S4 新增 AC-4.12 running 效果中止通道；_index 同步，总 AC 74→76
- Issues: [I-008] 校验报告称 AC-6.6 归属有误但落盘文件已正确（推测前次中断会话落过该处改动），已留审计标注
- Decisions: 修正标注统一「〔已修正 · Step 1.5〕」前缀且原文保留
- Gate: PASS

### [015] Step 1.5b: 跨组校验 -- 2026-06-12
- Dispatch: prompts/verify-requirements.md (mode=cross)
- Input: [spec/_index.md, spec/S1~S6]
- Status: DONE
- Output: verify/v1-cross.md（RED 0 / YELLOW 2，结论 PASS）：修正闭合确认（AC-5.13/AC-4.12 双向互引闭合）、计数脚本核验、配对项成立、术语统一、编号无重复无悬空
- Issues: YELLOW#1 _index WHITE 计数 14→16；YELLOW#2 AC-5.13/AC-4.12 未进 S5/S4 概述
- Decisions: [D-015] 两条 YELLOW 为机械同步，编排者直接修正（_index 计数、S5 Scope+概述、S4 概述），不再派发
- Gate: PASS（Step 1.5 全部完成，进入 Step 2）

### [016] Step 2: 设计方案 -- 2026-06-12
- Dispatch: prompts/design.md（首派 529 过载未执行，重试成功）
- Input: [spec/ 全部 7 文件, 设计文档, src/{store,config,backup,lifecycle,index}.ts, src/agents/types.ts]
- Status: DONE
- Output: spec/overview.md（187 行：模块索引 14+2+3 文件、领域模型映射、组件交互图、ADR 5 条 + 38 Gap 全量决策、影响矩阵、测试策略）+ S1~S6 设计节（116~188 行/节，接口签名/DDL/伪代码/AC 内联标注）
- Issues: [I-009] AC-6.8「后启拒绝」与实勘 takeover 语义不符，按预授权以 takeover 核定断言（Step 4 测试以设计节为准）；[I-010] AC-6.5 与 AC-5.10 表面冲突，拆「自报失败归类型决策/活性失败归容器升级」两路径消解
- Decisions: [D-016] ADR-1 事件即时 apply + wake_pending 持久化；[D-017] ADR-2 PID takeover 语义，kernel 锁零改动；[D-018] ADR-3 effects.seq=based_on_seq 单字段两用；[D-019] ADR-4 assignment/wait 行在转移事务内创建，outbox 仅承载事务外副作用；[D-020] ADR-5 三套超时收敛 stalled 管道幂等；[D-021] 时间戳按实勘纠偏 INTEGER epoch ms
- Gate: PASS（DONE 即放行，架构检查移至 2.2）

### [017] Step 2.2a: 模块设计校验（S1 单独 + S2~S6 合并续派） -- 2026-06-12
- Dispatch: prompts/verify-design.md (mode=module)；S1 完成后撞限额，S2~S6 续派完成
- Input: [spec/S1~S6 + overview.md]
- Status: DONE
- Output: 6 报告全落盘 verify/v2-S{n}-*.md。S1 PASS(Y1)/S2 PASS(Y2)/S3 PASS(Y5)/S4 PASS(Y1)/S5 PASS(Y3)/S6 PASS(Y3)，RED 0
- Issues: 实质缺陷 4 条——[I-011] S3 AC-3.7 批量窗口开区间排除运行期事件，自相矛盾；[I-012] S3 结论事件会把 aborted 效果改写为 done，违反终态不变；[I-013] S5 agent wait 到期但 origin 非 running 时早退→wait 永不 resolve + stalled 事件每 tick 刷屏；[I-014] S6 noop onEvent 读 ev.payload.retries 但上游事件 payload 无此字段，纯函数无法查库，契约不可实现。其余 10 条为测试要点缺失/字段补全级
- Decisions: [D-022] 无 RED 门禁放行，但 4 条实质缺陷 + 10 条补全在 2.2b 前一次性修正（设计文件是 Step 3/4 的输入，带病拆任务返工成本更高）
- Gate: PASS（修正派发见 [018]）

### [018] Step 2.2 设计修正（v2 问题清零） -- 2026-06-12
- Dispatch: 定点修正信封
- Input: [verify/v2-S1~S6 六份报告, spec/S1~S6 + overview.md]
- Status: DONE（15/15 项落地）
- Output: ADR-6~10 新增（批量窗口分离 batchFromSeq/效果终态单向/悬空 wait resolve/assignmentRetries 契约/dispatch 配置默认值）；S1 store 接口补 getAssignment/getWait/getEffect/lastRunEffectSeqBefore；各模块测试要点补全；编排者顺手同步 overview 交互图与映射表两处旧措辞
- Issues: 无遗留（修正 Agent 发现的 4 个连带问题均已闭合）
- Decisions: [D-023] payload 字段 camelCase（assignmentRetries）；[D-024] 批量窗口起点从 effects 表查询导出（lastRunEffectSeqBefore），不走 assignments 链；[D-025] effect_aborted 作废不计 discard_streak 不重唤醒（防 stalled 管道双发）
- Gate: PASS（进入 2.2b）

### [019] Step 2.2b: 架构校验 -- 2026-06-12
- Dispatch: prompts/verify-design.md (mode=arch)
- Input: [overview.md, S1~S6 设计节, _index.md]
- Status: DONE
- Output: verify/v2-arch.md —— RED 1 / YELLOW 3，结论 BLOCKED。其余维度全过（依赖单向、职责单一、14 事件 kind 封闭、ADR-1~10 有落点、双窗口口径四处一致）
- Issues: [I-015|RED] S4 失败路径提前置 aborted × ADR-7 前置检查 ⇒ 所有 run_failed 必然被作废，AC-6.5 死路（v2 修正轮新引入）；[I-016] Decision 类型归属致 types⇄reducer 循环；[I-017] CreateInput/CreateResult 归属致 api⇄reducer 循环；[I-018] S5 deadline_at 不裸更承诺与 S1 updateWait(Partial) 冲突
- Decisions: [D-026] 按校验推荐方向 (a) 修正 RED：失败路径不提前置终态，结论 apply 事务内统一终态化；三条 YELLOW 一并修（类型移 types.ts、收窄 updateWait patch）
- Gate: BLOCKED → 修正后重检（见 [020]）

### [020] Step 2.2b 阻塞修正 -- 2026-06-12
- Dispatch: 定点修正信封
- Input: [verify/v2-arch.md, spec/S1/S3/S4/S5/S6/overview]
- Status: DONE（4/4 清零）
- Output: ADR-11（自报失败不提前置态，终态化统一在结论 apply 事务，成功/失败同构）；Decision/CreateInput/CreateResult 归位 types.ts；updateWait 收窄至六字段 Pick；附 AC-6.5 全路径可达推演与 import 无环说明
- Issues: 无
- Decisions: [D-027] 采纳方案 (a)；[D-028] 幂等类失败无结论事件，保留执行器小事务置 aborted
- Gate: 待复检（见 [021]）

### [021] Step 2.2b 复检 -- 2026-06-12
- Dispatch: prompts/verify-design.md (mode=arch) 聚焦复检
- Input: [修正后 spec/ 全部设计节]
- Status: DONE
- Output: verify/v2-arch-recheck.md —— RED 0 / YELLOW 2，PASS。四问题确认闭合：AC-6.5/4.4/4.9/4.12 纸面推演全通、import 图有拓扑序无环、updateWait 五写点全在允许集
- Issues: 2 处 overview 概览措辞残留（交互图中止行、G-4.6「一律」）
- Decisions: [D-029] 残留为机械同步，编排者直改（交互图拆「完成/失败」与「中止」两行、G-4.6 改幂等类例外表述）
- Gate: PASS（Step 2.2 全部完成，进入 Step 3 拆任务）

### [022] 模型交接标记 -- 2026-06-12
- Dispatch: 用户恢复会话后要求标记交接点，并由 Codex 继续推进
- Status: DONE
- Output: 本条为审计边界：`[001]`~`[021]` 及其已落盘产物为前序 Claude 模型处理结果；自本条起（含后续 Step 3 详细拆分、校验与实现执行）由 Codex / GPT-5 接手维护
- Issues: 无
- Decisions: [D-030] 不回滚前序模型产物；以 Step 2.2 PASS 后的 spec/overview/S1~S6 与 tasks/overview.md 为权威输入继续 Step 3
- Gate: N/A

### [023] Step 3: 详细任务拆分补齐 -- 2026-06-12
- Dispatch: Codex 续接 Step 3，以 tasks/overview.md 为骨架补齐 phase-1~phase-6
- Status: DONE
- Output: 新增 docs/ai-specs/workitems-m0/tasks/phase-1.md ~ phase-6.md；T1~T33 全局连续编号逐项展开，每项含 AC、依赖、文件、RED/GREEN 验证与完成判据；overview 顶部补交接说明
- Issues: 无业务代码改动；本步仍属任务拆分，不进入 src/ 实现
- Decisions: [D-031] Phase 文件采用「任务级 RED→GREEN→验证」粒度，而非在 Step 3 复制完整实现代码；执行期从 T1 开始按 phase 顺序推进，Phase 4/5 可在 T16/T17 后局部并行
- Gate: PASS（Step 3 任务拆分完成，下一步进入 T1 开发实现）

### [024] T1: 域类型、Clock 与容器配置骨架 -- 2026-06-12
- Dispatch: Codex 执行 Phase 1 / T1（TDD）
- Status: DONE
- Output: 新增 `src/workitems/types.ts`、`src/workitems/clock.ts`、`src/workitems/config.ts` 与 `tests/workitems/types.test.ts`；定义 WorkType 九成员、WorkItem/Assignment/Wait/Effect/Event/Transition/CreateInput/CreateResult/Clock 等域类型；实现 SystemClock 与 WORKITEMS_* 调参默认值/正整数校验
- Issues: 初次全量检查仅 Biome 格式化失败，按格式提示做最小修正后通过
- Decisions: [D-032][Codex] Workitems 调参保持在 `src/workitems/config.ts` 自管，kernel `src/config.ts` 仅在 T29 加路径声明；`retryBudget` 在 M0 配置中按正整数处理，默认 1，避免 0 次预算语义提前扩散
- Verification: `npm test -- tests/workitems/types.test.ts` PASS（4 tests）；`npm run typecheck` PASS；`npm run check` PASS（7 files / 50 tests）
- Gate: PASS

### [025] T2: WorkitemsStore migration v1 与五表基础 API -- 2026-06-12
- Dispatch: Codex 执行 Phase 1 / T2（TDD）
- Status: DONE
- Output: 新增 `src/workitems/store.ts` 与 `tests/workitems/store.test.ts`；创建独立 `workitems.sqlite` migration v1（五张 workitem_* 表、WAL、FK、user_version=1、事件 append-only triggers）；实现 workitems/assignments/waits/effects/events 基础读写、事务包装、JSON 映射、nextSeq/eventsSince、online backup
- Issues: 初次全量检查仅 Biome 格式化失败，运行 Biome 写回后通过
- Decisions: [D-033][Codex] T2 一次性补齐后续阶段会用到的 store API（如 getEffect/listInflightEffects/lastRunEffectSeqBefore/listRunningAssignments），但不实现 reducer/effects 行为语义；store 层只承载表结构和同步读写，不引入工作类型概念
- Verification: `npm test -- tests/workitems/store.test.ts` PASS（4 tests）；`npm run typecheck` PASS；`npm run check` PASS（8 files / 54 tests）
- Gate: PASS

### [026] T3: ArtifactStore 每工作项 git 仓 -- 2026-06-12
- Dispatch: Codex 执行 Phase 1 / T3（TDD）
- Status: DONE
- Output: 新增 `src/workitems/artifacts.ts` 与 `tests/workitems/artifacts.test.ts`；实现每 workitem 独立 git 仓初始化、repo-local git 身份、初始空提交、artifact 写文件一写一提交、读取、净区检查、dirty/missing reconcile
- Issues: 目标测试首次通过时 git 输出默认分支提示；显式 `git init -b main` 后目标测试输出干净；全量检查仅 Biome 格式化失败，写回后通过
- Decisions: [D-034][Codex] Artifact 仓统一初始化为 `main` 分支，避免依赖机器全局 `init.defaultBranch`；`writeFile` 使用 `git commit --allow-empty` 保证「每次写 artifact 提交一次」即使内容不变也可审计
- Verification: `npm test -- tests/workitems/artifacts.test.ts` PASS（4 tests）；`npm run typecheck` PASS；`npm run check` PASS（9 files / 58 tests）
- Gate: PASS

### [027] T4: kernel backup 前缀参数化与 extraJobs 钩子 -- 2026-06-12
- Dispatch: Codex 执行 Phase 1 / T4（TDD）
- Status: DONE
- Output: 修改 `src/backup.ts` 与 `tests/backup.test.ts`；新增 `BackupNameOptions`、`SelectBackupsOptions`、`BackupJob`；backup 命名/解析/修剪支持 prefix/ext options；`scheduleDailyBackup` 支持 extraJobs 且 job 间独立 try/catch
- Issues: 目标测试通过后 typecheck 暴露 logger stub 与完整 pino Logger 类型不匹配；将 schedule logger 形状收窄为实际依赖的 info/error；全量检查随后仅 Biome lint/format，修正后通过
- Decisions: [D-035][Codex] 保持旧 API 兼容：`backupFileName(now)`、`parseBackupTimestamp(name)`、`selectBackupsToPrune(names, keep)` 默认仍按 kernel `db-*.sqlite` 工作；workitems 能力通过 options/extraJobs 增量开启，不把 workitem 语义写进 kernel backup
- Verification: `npm test -- tests/backup.test.ts` PASS（10 tests）；`npm run typecheck` PASS；`npm run check` PASS（9 files / 61 tests）
- Gate: PASS

### [028] T5: workitems backup job -- 2026-06-12
- Dispatch: Codex 执行 Phase 1 / T5（TDD）
- Status: DONE
- Output: 新增 `src/workitems/backup.ts` 与 `tests/workitems/backup.test.ts`；实现 `createWorkitemsBackupJob`，生成 `workitems-*.sqlite` 单文件副本与 `workitems-files-*.tar.gz` artifact 包，按独立 prefix 修剪；DB 与 artifact 子任务各自 try/catch，失败只记日志
- Issues: 目标测试首次通过时 tar 失败隔离用例的 stderr 泄漏到测试输出；将 tar 子进程 stdio 改为 pipe，失败信息留在错误对象中；全量检查仅 Biome 格式化失败，写回后通过
- Decisions: [D-036][Codex] workitems 备份 job 内部也做 DB/files 双向失败隔离，不只依赖 kernel `extraJobs` 的外层隔离；artifact tar 使用 `tar -czf -C <artifactsDir> .`，恢复物包含每个工作项仓的 `.git` 历史
- Verification: `npm test -- tests/workitems/backup.test.ts` PASS（4 tests）；`npm run typecheck` PASS；`npm run check` PASS（10 files / 65 tests）
- Gate: PASS

### [029] T6: 架构守护测试提前落地 -- 2026-06-12
- Dispatch: Codex 执行 Phase 1 / T6（TDD）
- Status: DONE
- Output: 新增 `tests/architecture.test.ts` 与 `tests/helpers/architecture.ts`；扫描 src import 方向、kernel 业务词汇、workitems→worktypes 反向依赖、phase 比较/switch 解释行为；真实源码必须零违规，并用合成 fixture 证明违规可被检测
- Issues: 初次 RED 为 helper 缺失；实现后目标测试与 typecheck 通过；全量检查仅 Biome 格式化失败，写回后通过
- Decisions: [D-037][Codex] 架构守护采用测试内自写静态扫描器，不新增 dependency-cruiser 等依赖；扫描规则以 M0 设计要求为准，允许 `src/workitems/**` import kernel 通用模块，但禁止 kernel（除 index/config 豁免）import workitems/worktypes 或出现业务词
- Verification: `npm test -- tests/architecture.test.ts` PASS（2 tests）；`npm run typecheck` PASS；`npm run check` PASS（11 files / 67 tests）
- Gate: PASS

### [030] T7: 存储全链路集成 / Phase 1 收口 -- 2026-06-12
- Dispatch: Codex 执行 Phase 1 / T7（TDD）
- Status: DONE
- Output: 新增 `tests/workitems/storage-flow.test.ts` 与 `tests/helpers/workitems.ts`；验证初始化 store/artifacts → 插入 workitem → 初始化 git 仓 → 写 artifact → 追加事件 → 执行 workitems backup job；DB 副本可查 workitem/events，tar 恢复物含 `.git` 与 artifact 文件
- Issues: T7 为集成闭环，生产能力已由 T2/T3/T5 提供；本步只新增测试 helper 与集成测试；全量检查仅 Biome 格式化失败，写回后通过
- Decisions: [D-038][Codex] 将通用测试 fixture（makeWorkItem/makeAssignment/makeWait）沉到 `tests/helpers/workitems.ts`，后续 Phase 2~5 复用，避免每个测试文件重复造行对象
- Verification: `npm test -- tests/workitems/storage-flow.test.ts` PASS（1 test）；`npm run typecheck` PASS；`npm run check` PASS（12 files / 68 tests）
- Gate: PASS（Phase 1 完成；当前已具备 types/store/artifacts/backup/architecture 地基，尚未实现 api/reducer/effects/watchdog/noop）

### [031] T8: WorkTypeRegistry -- 2026-06-12
- Dispatch: Codex 执行 Phase 2 / T8（TDD）
- Status: DONE
- Output: 新增 `src/workitems/registry.ts` 与 `tests/workitems/registry.test.ts`；实现内存 WorkTypeRegistry、重复 id 拒绝、missing lookup 返回 undefined
- Issues: 初次 RED 为 registry 模块缺失；实现后目标测试和 typecheck 通过；全量检查仅 Biome 格式化失败，写回后通过
- Decisions: [D-039][Codex] registry 保持纯内存 Map，不接触 store 或 worktypes；重复注册使用专门 `WorkTypeAlreadyRegisteredError`，后续 api/create 路径可精确断言
- Verification: `npm test -- tests/workitems/registry.test.ts` PASS（2 tests）；`npm run typecheck` PASS；`npm run check` PASS（13 files / 70 tests）
- Gate: PASS

### [032] T9: rollup 投影纯函数 -- 2026-06-12
- Dispatch: Codex 执行 Phase 2 / T9（TDD）
- Status: DONE
- Output: 新增 `src/workitems/projection.ts` 与 `tests/workitems/projection.test.ts`；实现 `computeRollup` 优先级矩阵、终态冻结、空活动边界，以及 `recomputeRollup` 从 waits/assignments/events 权威表重算并写回 workitem status/statusDetail
- Issues: 初次 RED 为 projection 模块缺失；实现后目标测试、typecheck、全量检查一次通过
- Decisions: [D-040][Codex] `recomputeRollup` 接受可选 `updatedAt` 参数，生产默认 Date.now，测试可注入固定值；投影只读权威表并写回展示列，不作为执行调度条件
- Verification: `npm test -- tests/workitems/projection.test.ts` PASS（4 tests）；`npm run typecheck` PASS；`npm run check` PASS（14 files / 74 tests）
- Gate: PASS

### [033] T10: createWorkItem 与 bootstrapApply 骨架 / Phase 2 收口 -- 2026-06-12
- Dispatch: Codex 执行 Phase 2 / T10（TDD）
- Status: DONE
- Output: 新增 `src/workitems/errors.ts`、`src/workitems/api.ts`、`src/workitems/reducer.ts` 与 `tests/workitems/create-workitem.test.ts`；实现 TypeNotRegisteredError/OpenLimitError、WorkitemsApi.createWorkItem、ReducerRuntime.bootstrapApply 创建事务、dedupe 静默返回、非终态上限、创建事件、artifact repo 初始化、初始 transition 的 dispatch/wait/effect 最小落库
- Issues: 初次 RED 为 api/errors/reducer 模块缺失；实现后目标测试与 typecheck 通过；全量检查仅 Biome 格式化失败，写回后通过
- Decisions: [D-041][Codex] T10 的 ReducerRuntime 只承载创建骨架和最小 transition 写入，不实现 per-item FIFO、postCommit、结构检查、单飞合并等 Phase 3/4 语义；创建成功后 artifact repo 初始化仍在事务外，由后续恢复/对账机制兜底异常窗口
- Verification: `npm test -- tests/workitems/create-workitem.test.ts` PASS（7 tests）；`npm run typecheck` PASS；`npm run check` PASS（15 files / 81 tests）
- Gate: PASS（Phase 2 完成；当前已具备 registry/projection/createWorkItem，下一步进入 Phase 3 reducer 运行时）

### [034] T11: ReducerRuntime per-workitem FIFO apply -- 2026-06-12
- Dispatch: Codex 执行 Phase 3 / T11（TDD）
- Status: DONE
- Output: 修改 `src/workitems/reducer.ts`，新增 `PendingEvent` 与 `ReducerRuntime.enqueue`；新增 `tests/workitems/reducer-fifo.test.ts`，覆盖同一 workitem FIFO、嵌套 enqueue、跨 workitem seq 独立、终态事件审计追加、transition effects 只落库不执行
- Issues: 初次 RED 为 `enqueue`/`PendingEvent` 缺失；实现后目标测试通过；全量检查仅 Biome 格式化失败，运行 Biome 格式化后通过
- Decisions: [D-042][Codex] FIFO 队列放在 ReducerRuntime 内存中，按 workitemId 单独 drain；重入 enqueue 只追加队列，不递归 apply，保证同一 workitem 事件顺序与 seq 连续。终态 workitem 仍追加审计事件但不调用 worktype reducer，避免终态被后续事件重新激活
- Verification: `npm test -- tests/workitems/reducer-fifo.test.ts` PASS（4 tests）；`npm run check` PASS（16 files / 85 tests）
- Gate: PASS

### [035] T12: applyTransitionWrites 同事务 outbox 与单飞合并 -- 2026-06-12
- Dispatch: Codex 执行 Phase 3 / T12（TDD）
- Status: DONE
- Output: 修改 `src/workitems/reducer.ts`，新增可注入 `isRunClass`、run 类单飞判定、wakePending 合并、run 结论收尾与默认 dispatch 释放；新增 `tests/workitems/reducer-transition.test.ts` 覆盖 dispatch/effect 同 seq、转移写失败全回滚、在途 run 合并、wakePending 只释放一次、`lastRunEffectSeqBefore` 上一 run 窗口基准
- Issues: 初次 RED 证明基础 dispatch/回滚已有，失败集中于单飞、结论收尾、批量窗口；实现后目标测试通过；全量检查仅 Biome 格式化失败，运行 Biome 格式化后通过
- Decisions: [D-043][Codex] T12 默认将 `run` 视为运行类以保持当前测试/创建路径可用，同时在 `ReducerRuntimeDeps.isRunClass` 预留 EffectRuntime 注册表注入点；单飞发生在 assignment/effect 双写之前，因此合并唤醒不会产生孤儿 assignment。wakePending 释放使用 `cfg.defaultDeadlineTtlSec/defaultWallclockCapSec`，不复制上一 assignment 参数
- Verification: `npm test -- tests/workitems/reducer-transition.test.ts` PASS（5 tests）；`npm run check` PASS（17 files / 90 tests）
- Gate: PASS

### [036] T13: 结论结构检查与 isDecisionStale 契约 -- 2026-06-12
- Dispatch: Codex 执行 Phase 3 / T13（TDD）
- Status: DONE
- Output: 修改 `src/workitems/reducer.ts`，在 run_completed/run_failed append 前执行结构检查与 `isDecisionStale`；新增 `tests/workitems/reducer-decisions.test.ts` 覆盖 superseded assignment、resolved wait、已 aborted effect、`eventsSince(basedOnSeq, currentSeq)` 开区间、noop stale=false 正常 apply
- Issues: 初次 RED 暴露 T12 仍先收尾 effect/assignment 再调用 worktype，未做结构检查/语义 stale；实现后目标测试通过；全量回归时发现 T12 测试对同 timestamp assignment 返回顺序有随机假设，改为按 `basedOnSeq` 排序后通过
- Decisions: [D-044][Codex] 作废结论不追加原始 run_completed/run_failed，而是以同一个 seq 追加 `decision_discarded` 作为审计事件；payload 保留 reason、effectId、basedOnSeq 与触发对象 id。`effect_aborted` 不改写 effect 状态、不调用 stale hook；其他作废原因将 pending/running effect 终态化为 done，后续 T14 只扩展 streak/重唤醒/升级
- Verification: `npm test -- tests/workitems/reducer-decisions.test.ts` PASS（5 tests）；`npm test -- tests/workitems/reducer-transition.test.ts` PASS（5 tests）；`npm run check` PASS（18 files / 95 tests）
- Gate: PASS

### [037] T14: 防颠簸升级 human wait -- 2026-06-12
- Dispatch: Codex 执行 Phase 3 / T14（TDD）
- Status: DONE
- Output: 修改 `src/workitems/reducer.ts`，作废结论后维护 workitem 级 `discardStreak`；第 1 次作废使用默认 dispatch 自动重唤醒；第 2 次连续作废追加 `thrash_escalated` 并创建 human wait；成功结论清零 streak；新增 `tests/workitems/reducer-thrash.test.ts`
- Issues: 初次 RED 暴露作废路径只审计、不计 streak、不重唤醒；实现后目标测试通过；全量检查仅 Biome 格式化失败，运行 Biome 格式化后通过
- Decisions: [D-045][Codex] `effect_aborted` 保持免疫：不计入 discardStreak、不重唤醒、不升级 human wait，因为中止/恢复作废通道已由 S4/S5 处理。thrash human wait 使用 `cfg.humanWaitTtlSec`，reason 固定为 `thrash`，`thrash_escalated` 与 wait 创建在同一 reducer 事务内
- Verification: `npm test -- tests/workitems/reducer-thrash.test.ts` PASS（4 tests）；`npm run check` PASS（19 files / 99 tests）
- Gate: PASS

### [038] T15: 生命周期、phase 与投影集成 / Phase 3 收口 -- 2026-06-12
- Dispatch: Codex 执行 Phase 3 / T15（TDD）
- Status: DONE
- Output: 修改 `src/workitems/reducer.ts`，phase transition 追加 `phase_changed` 审计事件；新增 `tests/workitems/lifecycle-projection.test.ts`，覆盖 open→active→waiting→active→done、human wait 优先级不钳制执行、phase 回退、非 ASCII phase 逐字节回读
- Issues: 初次 RED 仅 phase_changed 缺失，说明前面 reducer/projection 已能覆盖生命周期投影；实现后目标测试通过；全量检查仅 Biome 格式化失败，运行 Biome 格式化后通过
- Decisions: [D-046][Codex] phase 仍保持任意字符串、不做排序或枚举解释；`phase_changed` 使用声明事件的 `seq + 1` 写入审计事件，payload 记录 `{from,to,reason}`，而 assignment/effect 的 basedOnSeq 仍指向声明转移的原事件 seq
- Verification: `npm test -- tests/workitems/lifecycle-projection.test.ts` PASS（4 tests）；`npm run check` PASS（20 files / 103 tests）
- Gate: PASS（Phase 3 完成；当前已具备 FIFO reducer、同事务 outbox 写入、单飞合并、结构检查、防颠簸升级、phase/lifecycle 投影集成）

### [039] T16: EffectRuntime 执行器与结论事件回流 -- 2026-06-12
- Dispatch: Codex 执行 Phase 4 / T16（TDD）
- Status: DONE
- Output: 新增 `src/workitems/effects.ts` 与 `tests/workitems/effects-runtime.test.ts`；实现 EffectHandler 注册表、EffectRuntime.poke、每 workitem 串行/跨 workitem 并行 drain、pending→running、run_completed/run_failed 回流、rerun 失败直接 aborted、EffectContext heartbeat/eventsSince/setAgentSessionId/writeArtifact/emit
- Issues: 初次 RED 为 effects 模块缺失；实现后目标测试通过；全量检查仅 Biome 格式化失败，运行 Biome 格式化后通过
- Decisions: [D-047][Codex] run 类 handler 成功/失败均由 EffectRuntime 统一封装结论 payload（assignmentId/effectId/basedOnSeq/assignmentRetries/error）并经 reducer.enqueue 回流；run_failed 不提前置 aborted，保持 ADR-11：effect 终态化在 reducer 结论 apply 事务内完成。`ctx.eventsSince(afterSeq)` 对 run handler 使用 `(afterSeq, effect.seq]` 上界包含窗口，区别于 reducer stale 的开区间
- Verification: `npm test -- tests/workitems/effects-runtime.test.ts` PASS（5 tests）；`npm run check` PASS（21 files / 108 tests）
- Gate: PASS

### [040] T17: running 效果中止通道 -- 2026-06-12
- Dispatch: Codex 执行 Phase 4 / T17（TDD）
- Status: DONE
- Output: 修改 `src/workitems/effects.ts`，新增 `EffectRuntime.abort(effectId, reason)`、inflight AbortController 查找、DB running 行无内存命中时的 abort 回流；新增 `tests/workitems/effects-abort.test.ts` 覆盖 AbortSignal、effect_aborted payload、无 run_completed/run_failed、迟到结论被 T13 作废
- Issues: 初次 RED 为 `effects.abort` 缺失；实现后目标断言通过但出现 abort 后 finally 自动 poke 的异步尾巴，在测试关闭 DB 后触发 unhandled rejection；调整为 AbortSignal 已触发时不自动继续 drain，等待 `effect_aborted`/恢复逻辑决定后续
- Decisions: [D-048][Codex] abort 是中止/恢复作废通道，不等同普通 effect 完成；置 aborted 并回流 `effect_aborted` 后，EffectRuntime 不主动拾取同 workitem 后续 pending，避免绕过 reducer 的 stalled/恢复决策。`abortInflight()` 复用 `abort(..., 'shutdown')` 语义
- Verification: `npm test -- tests/workitems/effects-abort.test.ts` PASS（3 tests）；`npm run check` PASS（22 files / 111 tests）
- Gate: PASS

### [041] T18: startupRecovery 基础序列、pending 与 rerun 策略 -- 2026-06-12
- Dispatch: Codex 执行 Phase 4 / T18（TDD）
- Status: DONE
- Output: 新增 `src/workitems/recovery.ts` 与 `tests/workitems/recovery-basic.test.ts`；实现 `startupRecovery` 三步日志、状态表投影重建、pending effect poke、running rerun effect 原行重跑；为 `EffectRuntime` 新增 `recoverRunning(effectId)` 复用执行路径
- Issues: 初次 RED 为 recovery 模块缺失；实现后目标测试通过；全量检查仅 Biome lint/format，修正后通过
- Decisions: [D-049][Codex] recovery step2 使用状态表重算而不读 `workitem_events`：无 wait/assignment 时保留当前非 open 状态作为 state-authoritative 信号，避免事件表被清空时把 active 误降回 open。running rerun 不重插 effect 行，直接通过 `EffectRuntime.recoverRunning` 执行原行
- Verification: `npm test -- tests/workitems/recovery-basic.test.ts` PASS（4 tests）；`npm run check` PASS（23 files / 115 tests）
- Gate: PASS

### [042] T19: resume-or-redispatch 与 artifact 对账 -- 2026-06-12
- Dispatch: Codex 执行 Phase 4 / T19（TDD）
- Status: DONE
- Output: 修改 `src/workitems/effects.ts`、`src/workitems/recovery.ts`、`src/workitems/reducer.ts`；新增 `tests/workitems/recovery-run.test.ts`；实现 running run effect 的 canResume/resume 恢复分支、canResume=false 时 abort→effect_aborted→reducer 标准 dispatch 重派、artifact dirty/missing reconcile 后 `artifact_reconciled` 事件
- Issues: 初次 RED 暴露 recovery 跳过 run 类 running effect 且 reconcile 不留审计事件；实现后目标测试通过；全量检查仅 Biome lint/format，修正后通过
- Decisions: [D-050][Codex] run 类 redispatch 不在 recovery 中直接插 assignment，而是复用 T17 abort 回流；reducer 在 `effect_aborted` 容器 transition 内将仍 running 的 assignment 置 superseded，并通过 `Transition.dispatch` 创建 `replacesAssignmentId` 新 assignment。artifact reconcile 通过可选 `startupRecovery({ reducer })` 追加审计事件，未传 reducer 时保持 T18 基础恢复可用
- Verification: `npm test -- tests/workitems/recovery-run.test.ts` PASS（4 tests）；`npm run check` PASS（24 files / 119 tests）
- Gate: PASS

### [043] T20: G3/G4 流程集成 / Phase 4 收口 -- 2026-06-12
- Dispatch: Codex 执行 Phase 4 / T20（TDD）
- Status: DONE
- Output: 新增 `tests/workitems/reducer-effects-flow.test.ts`；集成覆盖运行期间事件批量带入、过期决策防颠簸升级且 artifact 保留、pending→running→done 时 reducer 继续接收事件、一次 startupRecovery 同时覆盖 pending/rerun/redispatch/reconcile
- Issues: 初次目标测试只有夹具默认 `maxOpen=3` 不足以容纳综合恢复用例，调高该测试 harness 的 WORKITEMS_MAX_OPEN 后目标测试通过；全量检查仅 Biome 格式化失败，运行 Biome 格式化后通过
- Decisions: [D-051][Codex] T20 不新增生产代码，作为跨模块流程收口测试；前置 T16~T19 已填平执行器、恢复、abort、reconcile 的接口缝隙。综合恢复用例显式调大 maxOpen，避免测试容量与业务上限 AC 混淆
- Verification: `npm test -- tests/workitems/reducer-effects-flow.test.ts` PASS（4 tests）；`npm run check` PASS（25 files / 123 tests）
- Gate: PASS（Phase 4 完成；当前已具备 EffectRuntime、abort 通道、startupRecovery 三策略基础、artifact reconcile 与 G3/G4 集成流）

### [044] T21: wait 与 assignment 创建校验 -- 2026-06-12
- Dispatch: Codex 执行 Phase 5 / T21（TDD）
- Status: DONE
- Output: 修改 `src/workitems/reducer.ts`，在 `applyTransitionWrites` 内统一校验 WaitSpec/AssignmentSpec；新增 `tests/workitems/wait-assignment-validation.test.ts`，覆盖非法 wait kind、缺/非正/非有限 deadline、agent wait origin、dispatch 监督参数、远期 deadline 合法入库
- Issues: 初次 RED 显示当前实现部分依赖 SQLite CHECK/NOT NULL，0/负数/Infinity 等无显式拒绝且可能入库；实现后目标测试通过；全量检查仅 Biome 格式化失败，运行 Biome 格式化后通过
- Decisions: [D-052][Codex] 校验放在 reducer transition 写入前，错误消息使用字段名（deadlineTtlSec/wallclockCapSec/originAssignmentId/wait kind）而非 SQLite 约束细节；远期 ttl 合法但 deadline_at 永远由 `clock.now() + ttl*1000` 派生，不开放绝对时间写入
- Verification: `npm test -- tests/workitems/wait-assignment-validation.test.ts` PASS（13 tests）；`npm run check` PASS（26 files / 136 tests）
- Gate: PASS

### [045] T22: Watchdog tick、wait 到期与活性入口 -- 2026-06-12
- Dispatch: Codex 执行 Phase 5 / T22（TDD）
- Status: DONE
- Output: 新增 `src/workitems/watchdog.ts` 与 `tests/workitems/watchdog.test.ts`；实现手动 `tick()`、start/stop unref interval、human wait 单次 reminder、timer_fired resolve、agent wait 到期 stalled、heartbeat_silent、wallclock_exceeded、同 tick 单 assignment 优先级去重；reducer containerMechanics 消费 `wait_reminder` 与 `timer_fired`
- Issues: 初次 RED 为 watchdog 模块缺失；实现后目标测试通过；全量检查仅 Biome lint/format，修正后通过
- Decisions: [D-053][Codex] Watchdog 自身不直接写 DB，只 enqueue 容器事件；remindedAt 与 timer resolved 状态都在 reducer apply 中更新。stalled candidate 使用 priority（wallclock > heartbeat > deadline > agent_wait）保证同 tick 同 assignment 只产生一条事件
- Verification: `npm test -- tests/workitems/watchdog.test.ts` PASS（7 tests）；`npm run check` PASS（27 files / 143 tests）
- Gate: PASS

### [046] T23: stalled 处置、重派链与升级 human wait -- 2026-06-12
- Dispatch: Codex 执行 Phase 5 / T23（TDD）
- Status: DONE
- Output: 修改 `src/workitems/reducer.ts`，在 containerMechanics 中处理 `assignment_stalled`：预算内旧 assignment 置 `superseded` 并通过 `replacesAssignmentId` 创建重派链，预算耗尽置 `failed`、追加 `assignment_retry_exhausted` 并创建 human wait；新增 post-commit `abort_effect` 动作；新增 `tests/workitems/stalled.test.ts`
- Issues: 初次 RED 暴露 reducer 未消费 stalled；实现后目标测试发现替换重派被 single-flight 保护拦截，收窄为非替换 dispatch 才触发 wakePending；全量检查仅 Biome 格式/未使用导入，清理后通过
- Decisions: [D-054][Codex] `replacesAssignmentId` 是受控重派例外，可在旧 run effect abort 完成前创建新 assignment，以免 watchdog/stalled 路径被 single-flight 卡住；实际 abort 留给事务提交后的 `postCommit`，避免 reducer 事务内直接调用 EffectRuntime。agent wait 到期但 origin 已终止时只 resolve wait 并追加一次 `wait_resolved(reason=origin_terminal)`，不再重派
- Verification: `npm test -- tests/workitems/stalled.test.ts` PASS（5 tests）；`npm run check` PASS（28 files / 148 tests）
- Gate: PASS

### [047] T24: resolveWait 与 renewWait API -- 2026-06-12
- Dispatch: Codex 执行 Phase 5 / T24（TDD）
- Status: DONE
- Output: 修改 `src/workitems/api.ts`、`src/workitems/reducer.ts`、`src/workitems/store.ts`、`src/workitems/errors.ts`；新增 `resolveWait`/`renewWait` API、`TimerNotResolvableError`、`wait_resolved`/`wait_renewed` 容器事件 apply、专用 `renewWaitDeadline`；新增 `tests/workitems/wait-api.test.ts`
- Issues: 初次 RED 为 API 方法与专用改期方法缺失；实现后目标测试通过；全量检查仅 Biome 可选链/格式/未使用导入，清理后通过
- Decisions: [D-055][Codex] API 仅做同步前置校验与事件入队，wait 行状态仍由 reducer 事务 apply；`clock` 作为 WorkitemsApi 可选依赖注入，测试/生产可传 FakeClock，未传时退回 Date.now。deadline 改期不再走通用 `updateWait`，而通过 `renewWaitDeadline` 显式收敛为 renew 路径
- Verification: `npm test -- tests/workitems/wait-api.test.ts` PASS（5 tests）；`npm run check` PASS（29 files / 153 tests）
- Gate: PASS

### [048] T25: 收尾 artifact 校验 / Phase 5 收口 -- 2026-06-12
- Dispatch: Codex 执行 Phase 5 / T25（TDD）
- Status: DONE
- Output: 修改 `src/workitems/effects.ts`、`src/workitems/reducer.ts`，并更新运行时测试 harness；新增 `tests/workitems/report-validation.test.ts`。EffectRuntime 对 run 类 handler 成功返回后强制校验 `assignments/<assignmentId>/report.md` 非空；通过才 emit `run_completed` 并落 `assignment.reportPath`，缺失/空/空白统一 emit `run_failed(error='artifact_missing')`
- Issues: 初次 RED 暴露成功路径未落 `reportPath`、缺失报告仍完成、handler 可直接 emit `run_completed` 绕过校验；实现后目标测试通过；旧运行时/恢复测试显式改为 `reportRequired=false`，避免非报告主题用例被 T25 新义务干扰；全量检查通过
- Decisions: [D-056][Codex] EffectRuntime 构造依赖显式加入 `WorkTypeRegistry`，以 WorkType.artifacts.reportRequired 作为是否校验的唯一来源；run 类 context.emit 屏蔽 `run_completed`/`run_failed`，结论事件只能由运行时收口发出。报告路径固定为 `assignments/<assignmentId>/report.md`，非空判定使用 `trim().length > 0`
- Verification: `npm test -- tests/workitems/report-validation.test.ts` PASS（6 tests）；`npm run check` PASS（30 files / 159 tests）
- Gate: PASS（Phase 5 完成；wait、watchdog、stalled、resolve/renew 与 report artifact 校验均已闭合）

### [049] T26: noop WorkType 九成员 -- 2026-06-12
- Dispatch: Codex 执行 Phase 6 / T26（TDD）
- Status: DONE
- Output: 新增 `src/worktypes/noop/index.ts` 与 `tests/workitems/noop-type.test.ts`；实现 noop WorkType 固定成员、`registerNoop`、context 参数默认值、workitem_created dispatch、run_completed timer wait、timer_fired done、run_failed 按 `noopMaxRetries` 重派或 failed
- Issues: 初次 RED 为 noop 模块缺失；实现后目标测试通过；全量检查仅 Biome 格式，格式化后通过
- Decisions: [D-057][Codex] noop 类型保持纯 WorkType 模块，只从 `src/workitems/types.ts` 导入类型；`registerNoop` 使用结构化 `{register(type)}` 参数，避免 worktypes 层依赖 registry 实现。默认参数由 Codex 定为 deadline=60s、wallclock=30s、timerWait=1s、noopMaxRetries=0
- Verification: `npm test -- tests/workitems/noop-type.test.ts` PASS（4 tests）；`npm run check` PASS（31 files / 163 tests）
- Gate: PASS

### [050] T27: noop run handler -- 2026-06-12
- Dispatch: Codex 执行 Phase 6 / T27（TDD）
- Status: DONE
- Output: 新增 `src/worktypes/noop/run-handler.ts` 与 `tests/workitems/noop-handler.test.ts`；实现 `createNoopRunHandler()`，覆盖 delayMs、failAt/failCount、heartbeatMode、simulateResumable canResume、brief/report artifact、eventsSince(batchFromSeq) 计数；扩展 `EffectHandler.canResume` 签名以接收 WorkItem
- Issues: 初次 RED 为 run-handler 模块缺失；实现后目标测试通过；全量检查仅 Biome 格式，格式化后通过
- Decisions: [D-058][Codex] noop handler 成功路径只写报告并返回，由 T25 的 EffectRuntime 统一发结论事件，避免 handler 绕过 artifact 校验。`canResume` 读取 WorkItem.context 判断 `simulateResumable`，不污染 run effect payload；`beat-no-finish` 通过 AbortSignal 退出，供 watchdog/stop/recovery 测试驱动
- Verification: `npm test -- tests/workitems/noop-handler.test.ts` PASS（7 tests）；`npm run check` PASS（32 files / 170 tests）
- Gate: PASS

### [051] T28: WorkitemsContainer -- 2026-06-12
- Dispatch: Codex 执行 Phase 6 / T28（TDD）
- Status: DONE
- Output: 新增 `src/workitems/container.ts` 与 `tests/workitems/container.test.ts`；实现 createWorkitemsContainer 装配 store/artifacts/registry/reducer/effects/watchdog/api、start recovery→watchdog、stop watchdog→stopIntake→abortInflight→store.close、backupJob；调整 `EffectRuntime.abortInflight()` 为停机只触发 AbortSignal、不把 running effect 置 aborted
- Issues: 初次 RED 为 container 模块缺失；实现后目标测试通过；全量检查仅 Biome 格式，格式化后通过
- Decisions: [D-059][Codex] 显式 abort（watchdog/stalled/recovery redispatch）继续调用 `effects.abort()` 并写 aborted/effect_aborted；容器 stop 的 `abortInflight()` 改为 graceful shutdown 语义，只中断内存 handler，DB running 行留给下次 startupRecovery 处理。reducer 的 postCommit abort 通过 container 内闭包桥接 EffectRuntime，避免 reducer 直接依赖 effects
- Verification: `npm test -- tests/workitems/container.test.ts` PASS（5 tests）；`npm run check` PASS（33 files / 175 tests）
- Gate: PASS

### [052] T29: kernel config 路径声明 -- 2026-06-12
- Dispatch: Codex 执行 Phase 6 / T29（TDD）
- Status: DONE
- Output: 修改 `src/config.ts` 与 `tests/config.test.ts`；新增 `workitemsDbPath`、`workitemsDir`，默认分别为 `$DATA_DIR/workitems.sqlite` 与 `$DATA_DIR/workitems`，支持 `WORKITEMS_DB_PATH` / `WORKITEMS_DIR` 覆盖与 `~` 展开
- Issues: 初次 RED 为新字段缺失；实现后目标测试通过；全量检查仅 Biome 格式，格式化后通过
- Decisions: [D-060][Codex] kernel config 只声明 workitems 的两个存储路径，不引入 `loadWorkitemsConfig`，也不解析 retry/heartbeat/watchdog 等行为调参，保持业务配置归 `src/workitems/config.ts`
- Verification: `npm test -- tests/config.test.ts` PASS（12 tests）；`npm run check` PASS（33 files / 178 tests）
- Gate: PASS

### [053] T30: index.ts 装配与 backup 接线 -- 2026-06-12
- Dispatch: Codex 执行 Phase 6 / T30（TDD）
- Status: DONE
- Output: 修改 `src/index.ts` 与新增 `tests/workitems/index-wiring.test.ts`；main 在 `ensureSingleInstance` 后创建 workitems runtime，注册 noop WorkType 与 run handler，启动 container；releaseResources 停止 workitems；`scheduleDailyBackup` 接入 `workitems.backupJob()`；新增 CLI main guard，避免测试 import 时自启动
- Issues: 初次 RED 显示 index 未接线；实现后目标测试通过；全量检查仅 Biome 格式，格式化后通过
- Decisions: [D-061][Codex] 保留现有 CLI 主流程，只抽出 `createWorkitemsRuntime` 与 `createReleaseResources` 两个可测 helper；index.ts 作为架构豁免装配点 import workitems/worktypes，但不解释 workitem status/phase。backup extraJob 失败隔离沿用 T4/T5 的 scheduleDailyBackup 语义
- Verification: `npm test -- tests/workitems/index-wiring.test.ts` PASS（5 tests）；`npm run check` PASS（34 files / 183 tests）
- Gate: PASS

### [054] T31: noop 进程内端到端 -- 2026-06-12
- Dispatch: Codex 执行 Phase 6 / T31（TDD）
- Status: DONE
- Output: 新增 `tests/workitems/noop-e2e.test.ts`；修改 `src/workitems/api.ts`/`container.ts`，为 container API 新增 create 后自动 `effects.poke`；覆盖正常 delay+timer、持续失败 retry 链、三 workitem 并发、heartbeat_silent 两次升级 human wait+renew、beat-no-finish 墙钟超限优先于 heartbeat_silent
- Issues: 初次 RED 暴露 create 后 pending effect 无执行入口；实现自动 poke 后目标测试发现 retry 链断言需按 retries 排序、stalled 后旧 inflight 退出前需要等待式 poke；修正测试等待方式并清理 noop handler AbortSignal listener 后通过；全量检查仅 Biome 格式，格式化后通过
- Decisions: [D-062][Codex] WorkitemsApi 保持通用门面，仅增加可选 `afterCreate` hook；container 负责把新建 workitem 转为执行器 poke，避免非 container 环境改变既有测试语义。端到端测试允许通过 container.effects.poke 驱动 stalled 后的替换 pending，因为它不绕过 reducer 写表，只补齐旧 inflight 退出后的执行调度
- Verification: `npm test -- tests/workitems/noop-e2e.test.ts` PASS（5 tests）；`npm run check` PASS（35 files / 188 tests）
- Gate: PASS

### [055] T32: SIGKILL 崩溃恢复进程级测试 -- 2026-06-12
- Dispatch: Codex 执行 Phase 6 / T32（TDD）
- Status: DONE
- Output: 新增 `tests/fixtures/workitems-app.ts` 与 `tests/workitems/noop-crash.test.ts`；进程级覆盖 pending 窗口 SIGKILL 后恢复、running resumable 原 assignment 恢复、running non-resumable 作废重派、seq 续写、dirty artifact startup reconcile 后 git 工作区干净
- Issues: 初次运行被 Vitest 默认 5s 超时截断；放宽进程测试超时后发现 fixture keepalive 使用 unref 导致等待 timer 时进程自然退出，移除 unref 后目标测试通过；全量检查仅 Biome 格式，格式化后通过
- Decisions: [D-063][Codex] T32 fixture 使用真实 `tsx` 子进程、真实 SQLite、真实 git，不 mock signals；通过 `WINDOW=pending` 暂停 intake 制造 pending crash 窗口，通过真实 SIGKILL 验证恢复。fixture 的 keepalive 必须是 ref'ed handle，生产 watchdog interval 仍保持 unref
- Verification: `npm test -- tests/workitems/noop-crash.test.ts` PASS（3 tests）；`npm run check` PASS（36 files / 191 tests）
- Gate: PASS

### [056] T33: PID 锁 takeover 与退出清理验证 / Phase 6 收口 -- 2026-06-12
- Dispatch: Codex 执行 Phase 6 / T33（TDD）
- Status: DONE
- Output: 新增 `tests/fixtures/pid-app.ts` 与 `tests/workitems/pid-takeover.test.ts`；导出 `src/index.ts` 的 `ensureSingleInstance` 供 fixture 复用；真实进程 A/B 竞争同一 DATA_DIR，验证 B takeover 后 A SIGTERM exit 0、锁文件归 B、ready+pid alive 只剩 B，B 退出时删除自己的锁
- Issues: 初次 RED 为 fixture 无法导入未导出的 `ensureSingleInstance`，导致 ready marker 不出现；导出函数后目标测试通过；全量检查仅 Biome 格式，格式化后通过
- Decisions: [D-064][Codex] 不修改 `src/lifecycle.ts`，继续使用既有 `removeOwnPidFile` 所有权语义；PID 进程 fixture 复用生产 `ensureSingleInstance`，只提供 ready marker 与 graceful SIGTERM 脚手架。T33 不新增业务逻辑，只用进程级测试固定 takeover 合约
- Verification: `npm test -- tests/workitems/pid-takeover.test.ts` PASS（1 test）；`npm run check` PASS（37 files / 192 tests）
- Gate: PASS（Phase 6 完成；workitems-m0 T1-T33 研发与验证全部完成）

### [057] v3 评审与 P1 修复 -- 2026-06-12
- Dispatch: Claude 续接——用户要求三步核查（总计划完成度 → 方案漏洞 → code review）后授权修复
- Status: DONE
- Output: `verify/v3-code-review.md`（完成度 18/18 ✅；方案漏洞 S-1~S-8；代码问题 P1×4 / P2×5 / P3×8）；修复全部 4 个 P1：
  - P1-1 `watchdog.ts` 去掉过期 agent wait 的 `status==='running'` 门禁——origin 已终态也进 stalled 管道，reducer 幂等处置并 resolve 悬空 wait（ADR-8 生产链路打通；此前测试以手工 enqueue 绕过 watchdog 掩盖了断链）
  - P1-2 `reducer.ts` stalled 重派 deadline 改为「原 TTL（deadline_at−created_at）自 now 重新计满」，废弃剩余时间继承（deadline_exceeded 重派不再 1s 必死）
  - P1-3 `reducer.ts` 作废结论时将发起 assignment（running 且非 effect_aborted 来源）置 superseded+ended_at，消除残留 running 被 watchdog 二次 stalled 的冗余重派
  - P1-4 `reducer.ts` effect_aborted 重派收敛到共用 `redispatchOrEscalate`（含预算检查）——崩溃循环下预算耗尽升级 human wait，不再无界 retries
- Issues: reducer-thrash.test.ts 原断言 `['running','running']` 固化了 P1-3 缺陷行为，已随修复更新为 `['superseded','running']`
- Decisions: [D-065] 重派监督参数统一语义：deadline=原 TTL 重计、wallclock=原值复制、retries+1、replaces 链；stalled 与 effect_aborted 两条重派路径共用一个实现；spec S3/S4/S5 已加〔已修正 · v3 评审〕标注
- Verification: `npm run check` PASS（37 files / 196 tests，新增 4 个回归：watchdog 悬空 wait 经真实 tick 消解、deadline 重计、运行中 origin 的 agent wait 一并 resolve、effect_aborted 预算耗尽升级）
- Gate: PASS（P2/P3 与 S-4~S-8 留存 verify/v3-code-review.md 待 M1 处置）

### [058] P1-5: 重派 pending effect 无执行驱动 + SIGKILL 测试幽灵进程 -- 2026-06-12
- Dispatch: Claude 续接——[057] 修复后全量回归出现 noop-crash 偶发失败，根因排查升级为缺陷修复
- Status: DONE
- Output: 两项修复 + 留痕：
  - **生产缺陷（P1-5）**：恢复重派 / stalled 替换产出的 pending run effect 无任何执行驱动——abort 路径的 executeEffect finally 不 poke（D-048 的条件判断偏离了 S4 §2 伪代码的无条件 `finally{poke}`），recovery abort 又无 finally。真实崩溃后替代任务永不执行，~1s 后被 watchdog 误判 heartbeat_silent → 预算耗尽 → 工作项卡死 waiting(human)。修复：reducer applyEvent 在事务内插入 run 效果后追加 postCommit `{kind:'poke'}`（落实 overview 交互图第 7 步与 G-4.1 的 post-commit poke 驱动）；executeEffect finally 恢复为无条件 poke（finally 时点 abort 决策已同步落库，不存在绕过决策）；container postCommit 桥接 poke
  - **测试基建缺陷**：noop-crash 经 `node_modules/.bin/tsx` wrapper spawn，SIGKILL 只杀 wrapper，真正的 fixture 孙子进程成为孤儿继续运行（"幽灵进程"替重启进程驱动了重派 effect，长期掩盖 P1-5；偶发失败即幽灵进程与重启进程赛跑落败）。修复：spawnFixture 改为 `process.execPath --import tsx` 直接 spawn 真实进程
  - 回归锁定：noop-e2e 移除 D-062 的手动 poke workaround（活性由运行时自证）；effects-abort 测试对齐生产关闭顺序（stopIntake → close）并让替换 handler 挂停以保持原断言语义；stalled 测试 postCommit 断言补 poke 动作
- Issues: 旧 e2e/进程级测试的"全绿"部分依赖幽灵进程残留，属假阳性——后续凡 SIGKILL 类测试一律直接 spawn node，不经 bin wrapper
- Decisions: [D-066] 推翻 D-048 的"abort 后不自动拾取"：post-commit poke + finally 无条件 poke 是 G-4.1 的正确实现；显式 abort 的决策由 reducer 事务先行落库，自动拾取的恰是决策产物
- Verification: `npm run check` 连续两轮 PASS（37 files / 196 tests，无 unhandled error）；noop-crash 隔离复跑 3 轮 PASS
- Gate: PASS
