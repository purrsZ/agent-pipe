# 分组需求校验（S6 noop-verification）-- 校验报告

> Step 1.5a | Feature: workitems-m0 | 模式: group | 2026-06-11

## 校验范围

| 类别 | 文件 |
|------|------|
| 被检产出 | docs/ai-specs/workitems-m0/spec/S6-noop-verification.md（`## 需求` 节） |
| 对照来源 | docs/design/2026-06-11-workitem-macro-design.md（§4.5 / §4.3 前提 / §3.1 / §3.2 / §10 / §11 M0 行） |
| 事实核验 | src/lifecycle.ts（仅用于核实 G-6.1 / G-6.6 的事实描述） |

## 问题清单

| # | 严重度 | 类型 | 描述 | 涉及位置 | 建议 |
|---|--------|------|------|---------|------|
| 1 | YELLOW | 漂移 | 跨组归属引用错误：outbox 崩溃恢复策略（PRD §4.3 规则 4、§10）的所有权按 S1 概述（"效果执行与崩溃恢复及事件↔artifact 对账（G4）"）与 S3 边界声明（"效果的持久化/执行/崩溃恢复归 G4"）均为 **G4**，但 S6 三处写成 G5/Group 3/5：① AC-6.6 THEN "按 G5 恢复策略处置"（应为 G4）；② AC-6.10 THEN "outbox 重建在途效果，复用 G5 机制"（waits 重建归 G5 说得通，outbox 重建归 G4，统称 G5 不准确）；③ FLOW-6.2 跨组 "Group 3/5（outbox 与恢复机制归属组）"（应含 Group 4）。同文件 AC-6.3/AC-6.5 写的是 "G4/G5"，证明这三处是孤立笔误而非另一套编号约定。行为描述本身与 PRD 一致，但会把 Step 2 的恢复策略设计/测试错误路由到 G5 | S6 AC-6.6、AC-6.10、FLOW-6.2 | 三处引用改为 G4（或 G4/G5，按 waits/outbox 分别标注），与 S1/S3 的边界声明对齐 |
| 2 | YELLOW | 遗漏 | 启动恢复枚举漏「事件↔artifact 对账」：PRD §10 重启恢复序列为「单实例锁确认 → 状态表重建待办 → outbox 重建在途效果 → **事件↔artifact 对账**（以状态表为准、对 artifact 仓做校验提交）」。AC-6.10 的容器恢复枚举只列了前两项重建，FLOW-6.2（SIGKILL 崩溃恢复旅程）的验证点也未含对账断言。对账机制行为归 G4（S1 G-1.6 已明示），但 S6 是装配触点与端到端汇聚组——SIGKILL 恰好制造 DB/git 尾部不一致窗口（S1 G-1.6 的"写+提交"失败窗口），端到端旅程不验对账则该恢复步骤可能根本未被装配 | S6 AC-6.10、FLOW-6.2 验证点 | AC-6.10 恢复枚举补「事件↔artifact 对账」；FLOW-6.2 验证点补一条「崩溃后 DB 与 git 尾部不一致被对账收敛（校验提交存在 / 以状态表为准）」 |

## 事实核验结果（信封特别核对项）

- **G-6.1 准确**：lifecycle.ts:10-12 注释原文 "during a takeover restart, the NEW instance kills the old one and immediately writes its own pid into the lock" —— 确为 takeover 语义。G-6.1 对该事实的描述准确，标 YELLOW 并留 Step 2 对照 index.ts 锁获取逻辑核定 AC-6.8 断言形态（拒绝/接管/参数二选一）是恰当处理；FLOW-6.3 的不变量「任意时刻最多一个存活实例」在两种语义下均成立。
- **G-6.6 准确**：lifecycle.ts:4-6 退出码契约 "0 = intentional stop (don't restart), non-zero = crash (supervisor restarts)" 与 G-6.6 描述一致。
- **AC-6.9 与实现一致**：removeOwnPidFile 仅当锁文件内容等于自身 pid 时删除并返回 true，否则返回 false 且保留锁文件——AC-6.9 断言逐条对应（6329d35 回归成立）。

## 总结

- 检查项: 4/6 通过（PRD 功能覆盖 ✓、排除项对照 ✓、AC 质量 ✓、Gap 分级 ✓；跨组引用准确性 ✗、§10 恢复序列覆盖完整性 ✗）
- RED: 0 | YELLOW: 2
- **结论**: PASS（带 2 条 YELLOW，Step 2 进入前修正引用与补对账断言即可，不阻塞）
