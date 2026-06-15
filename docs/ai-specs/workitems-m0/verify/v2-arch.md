# 架构校验 -- 校验报告

> Step 2.2b | Feature: workitems-m0 | 模式: arch | 2026-06-12

## 校验范围

| 类别 | 文件 |
|------|------|
| 被检产出 | spec/overview.md（全文）；spec/S1~S6 六文件 `## 设计` 节（接口签名/依赖关系/数据契约） |
| 对照来源 | spec/_index.md（AC 总览抽查） |

## 问题清单

| # | 严重度 | 类型 | 描述 | 涉及位置 | 建议 |
|---|--------|------|------|---------|------|
| 1 | RED | 矛盾 | **自报失败的 run_failed 结论必然被 ADR-7 前置检查作废，AC-6.5/G-4.5/ADR-9 失败决策路径不可达。** S4 执行器 catch 路径规定：handler 抛错 → `tx { setEffectStatus('aborted') }` → 再 `emit('run_failed', {..., assignmentRetries})`。而 S3 structuralCheck 第一条（ADR-7）规定：`effect.status=='aborted'` ⇒ 结论作废 `decision_discarded(reason='effect_aborted')`、不计 streak、不重唤醒。emit 经 enqueue 同步 drain，apply 时效果状态必然已是 aborted ⇒ **每一条自报失败的 run_failed 都会被作废**，永远到不了 noop onEvent——ADR-9 精心设计的 assignmentRetries 判定（noopMaxRetries 耗尽 → terminal:'failed'）成为死代码，AC-6.5「持续失败到达 failed 且可审计」按当前设计不可实现（assignment 悬在 running，只能靠 watchdog deadline/heartbeat 兜底走 stalled 管道，审计面与 AC 断言全不符）。注意这是 v2 修正轮引入的新矛盾：ADR-7 的「status=aborted 即作废」无法区分「中止/恢复作废置 aborted」（结论应作废）与「自报失败置 aborted」（结论必须回流）。另证：overview 组件交互图明言「效果终态在结论 apply 事务内置位」，与 S4 catch 路径在 apply 前抢先置 aborted 亦自相矛盾。S5 #5 的 artifact_missing 路径（handler 正常返回、效果保持 running 时 emit run_failed）反而能走通，更凸显 throw 路径（failAt='before-run'/'during-run'）被独断。 | S4-effects-outbox.md:181-186（catch 路径）；S3-reducer-concurrency.md:193-196, 246-247（前置检查与作废分支）；overview.md ADR-7 / 交互图「效果终态在结论 apply 事务内置位」行 | 三选一并同步 ADR-7 表述：(a) 失败路径不提前置 aborted——效果保持 running，由 run_failed 结论的 apply 事务内统一终态化（与成功路径、overview 交互图同构；崩溃窗口下 running 效果自然落入既有恢复策略）；(b) 在 abort()/恢复作废处留区分标记（如 effect 行 aborted_by 列或内存 abortedEffectIds），structuralCheck 仅对「中止通道置位」的 aborted 作废结论；(c) 弱化 ADR-7 检查为「effect_aborted 事件已 apply 过」判定。推荐 (a)，改动最小且消除两处矛盾 |
| 2 | YELLOW | 归属 | **Decision 类型归属错位，制造 types.ts ⇄ reducer.ts 文件级循环 import。** S2 在 `src/workitems/types.ts` 的 WorkType 九成员签名中引用 `isDecisionStale(decision: Decision, ...)`，而 Decision 定义在 S3 的 `// src/workitems/reducer.ts` 接口块内 ⇒ types.ts 须 import reducer.ts，reducer.ts 又 import types.ts（Transition/WorkItem 等）。与 overview「types.ts 收纳全部域类型」清单（未含 Decision）及 S2 数据契约「worktypes 仅 import types.ts」的单向意图不符 | S3-reducer-concurrency.md:152-155（Decision 定义）；S2-lifecycle-projection.md:145（types.ts 内引用）；overview.md types.ts 注释行 | Decision 移入 src/workitems/types.ts，并补进 overview types.ts 清单 |
| 3 | YELLOW | 归属 | **CreateInput/CreateResult 归属错位，制造 api.ts ⇄ reducer.ts 循环 import。** 两类型定义在 S2 的 `// src/workitems/api.ts` 块，而 S3 `ReducerRuntime.bootstrapApply(input: CreateInput): CreateResult` 签名引用之；api.ts 同时持有 ReducerRuntime 引用（createWorkItem → reducer.bootstrapApply）⇒ 双向 import。同属共享域类型未进 types.ts | S2-lifecycle-projection.md:183-189（定义）；S3-reducer-concurrency.md:146（bootstrapApply 签名） | CreateInput/CreateResult 移入 src/workitems/types.ts |
| 4 | YELLOW | 矛盾 | **S5「store 层不暴露 deadline_at 裸更新」承诺与 S1 通用 patch 接口冲突。** S5 #4 声明「除 renewWait 外无任何 deadline_at 写路径（store 层不暴露裸更新——续期是有记录的决定）」，但 S1 对外接口 `updateWait(id, patch: Partial<WaitRow>)` 的 Partial 天然允许任意调用方直写 deadlineAt（事实上 renewWait 的 apply 也只能经此接口写入）。承诺与接口形状不一致，实现者无所适从 | S5-waits-watchdog.md:243（承诺）；S1-storage-foundation.md:161（updateWait 签名） | 二选一：收窄 S1 patch 类型（`Partial<Omit<WaitRow,'deadlineAt'>>` + 专用 `renewWaitDeadline(id, newDeadlineAt)`），或将 S5 表述弱化为「唯一调用点约定，由测试断言兜底」 |

## 维度结论

| 维度 | 结论 |
|---|---|
| ① 循环依赖 | 模块级单向干净（worktypes→workitems→kernel ✓；reducer⇄effects 以注入 isRunClass/postCommit 显式解环 ✓）；workitems 内部存在 2 处类型归属导致的文件级环（#2 #3） |
| ② 职责单一 | PASS——store/artifacts/registry/projection/reducer/effects/watchdog/recovery/api/backup/container 各一句话职责清晰；wait 校验、收尾校验、stalled 处置均单点实现，无双模块重复 |
| ③ API 冲突 | getAssignment/getWait/getEffect/lastRunEffectSeqBefore/batchFromSeq/emit/poke/abort/resolveWait/renewWait 跨模块逐一比对签名一致；store.eventsSince（两端开）与 EffectContext.eventsSince（半开含上界）同名异界但已由 ADR-6+S3 数据契约「两窗口不混用」显式声明，不计问题；1 处承诺/接口冲突（#4） |
| ④ 共享类型归属 | Transition/Assignment/Wait/Effect/WorkItemEvent/WorkType/Clock 归 types.ts 且消费方引用一致 ✓；Decision、CreateInput/CreateResult 归属错位（#2 #3） |
| ⑤ 事件契约 | 14 个 kind 清单封闭，wait_resolved/decision_discarded/assignment_stalled/thrash_escalated 等产生方与消费方 payload 字段两侧一致 ✓；run_failed 的产生-消费链路被 #1 切断 |
| ⑥ ADR 完整性 | ADR-1~10 编号唯一、均有设计节落点（ADR-6→S1.lastRunEffectSeqBefore+S3#3+S4.ctx+S6.noop；ADR-8→S5#2/#3；ADR-9→S3 接口+S4#2+S6#1；ADR-10→S3#3+S5 配置段）✓；但 ADR-7 修正引入新矛盾（#1）；变更影响矩阵覆盖全部 3 处 kernel 触点与 14+2 新文件 ✓ |

附注（不计问题的观察项）：overview ADR 台账中 G-3.5 payload 写作 snake_case（wait_id/effect_id），S3/S4/S5 设计节统一 camelCase——以设计节为实现口径即可；各 S 伪代码中行字段沿用 DDL 列名（a.started_at 等）与 S1「camelCase 字段映射」声明存在书写层差异，属伪代码惯例。

## 总结

- 检查项: 6 维度中 2 项全 PASS（②职责单一、⑤事件契约的清单封闭面），其余 4 项各有问题挂靠
- RED: 1 | YELLOW: 3
- **结论**: BLOCKED（#1 自报失败结论被 ADR-7 前置检查必然作废，AC-6.5/G-4.5/ADR-9 路径不可达，须先修正再放行 Step 3）
