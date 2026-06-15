# 模块设计校验 -- 校验报告

> Step 2.2a | Feature: workitems-m0 | 模式: module (S4, AC-4.1~4.12) | 2026-06-12

## 校验范围

| 类别 | 文件 |
|------|------|
| 被检产出 | docs/ai-specs/workitems-m0/spec/S4-effects-outbox.md（§设计 对照 §需求） |
| 对照来源 | docs/ai-specs/workitems-m0/spec/overview.md（ADR-4/5 + G-4.1~4.6）；S1/S3 设计节（跨模块接口核对） |

## AC 覆盖

| AC | 设计覆盖位置 | 状态 |
|----|------------|------|
| AC-4.1/4.2 | #1 同事务落库（委托 S3 applyTransitionWrites，权责清晰）+ better-sqlite3 整体回滚；集成可见性/注入失败回滚用例 | COVERED |
| AC-4.3/4.4 | #2 执行器（poke + drainOne，每 item 串行跨 item 并行）+ listInflightEffects 终态永不返回；集成用例齐 | COVERED |
| AC-4.5 | #4 startupRecovery 三步固定顺序 + recovery.step2/3/4 日志——实现要点全；「顺序/日志可观测」**无显式测试断言**（见问题 #1） | 部分 COVERED |
| AC-4.6~4.9 | #4 outbox 分策略（pending 保留 / rerun 重跑原行 / canResume 续跑 / abort+effect_aborted→replaces 重派）；恢复三策略各一集成用例 | COVERED |
| AC-4.10 | #4 step 4 reconcile + artifact_reconciled 事件；DB-git 不一致注入用例 | COVERED |
| AC-4.11 | 恢复仅读状态表与 effects 表；「清空 events 表后恢复结果不变」用例 | COVERED |
| AC-4.12 | #3 abort（AbortController + aborted + effect_aborted 回流，无结论回流）；集成用例 + 重派衔接 | COVERED |
| FLOW-4.1/4.2 | 流水线用例 + 进程内 close/start 模拟（SIGKILL 归 S6，分工明确） | COVERED |

## 问题清单

| # | 严重度 | 类型 | 描述 | 涉及位置 | 建议 |
|---|--------|------|------|---------|------|
| 1 | YELLOW | 遗漏 | AC-4.5 的「恢复按固定顺序执行且每步留有日志可观测」无显式测试要点：测试策略覆盖了三策略与对账各自的结果断言，但没有用例断言 recovery.step2/3/4 的执行顺序或日志输出（FLOW-4.2 验证点提及，测试清单未落） | S4 §测试策略 | 补一条集成断言：捕获 logger 输出，断言 recovery.step2 → step3 → step4 标签按序出现且各一次 |

## 总结

- 检查项: 5/6 通过（②契约——EffectHandler/EffectContext/EffectRuntime/Effect 行/各事件 payload 完整；③漂移——setAgentSessionId/stopIntake 等均有 G-4.3/G-6.4 来源，无漂移；⑤模式合规——同事务 outbox、执行出事务、Clock 注入全过；⑥Gap 兑现 G-4.1~4.6 全部落地，effect_aborted 双场景（恢复重派 / stalled 后到达即忽略）经 status=='running' 门控自洽；①/④ 因 AC-4.5 测试断言缺失各扣一项）
- 跨模块备注（不重复计数）：结论事件置 done 与 run_failed 已 aborted 的冲突、`getAssignment(id)` 不在 S1 store 接口——均已记录于 v2-S3 报告问题 #2/#5。
- RED: 0 | YELLOW: 1
- **结论**: PASS（YELLOW 建议 Step 3 前补齐）
