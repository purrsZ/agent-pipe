# 跨组一致性校验 -- 校验报告

> Step 1.5b | Feature: workitems-m0 | 模式: cross | 2026-06-12

## 校验范围

| 类别 | 文件 |
|------|------|
| 被检产出 | docs/ai-specs/workitems-m0/spec/_index.md |
| 对照来源 | spec/S1-storage-foundation.md ~ S6-noop-verification.md（标题行 + 概述 + Gaps + Flow AC + 修正涉及 AC） |

## 问题清单

| # | 严重度 | 类型 | 描述 | 涉及位置 | 建议 |
|---|--------|------|------|---------|------|
| 1 | YELLOW | 矛盾（统计不一致） | _index 两处写「WHITE 14」，但各文件实际 WHITE Gap 为 4/2/3/2/2/3 = **16**（G-1.1~1.4、G-2.5/2.6、G-3.4~3.6、G-4.1/4.4、G-5.5/5.6、G-6.2/6.3/6.5），_index 自身分组目录表 WHITE 列合计也是 16，且 WHITE 汇总清单实际列出 16 项——仅两处汇总数字错 | _index.md「Gaps 汇总」标题行「WHITE（14 条…）」与「统计」行「WHITE 14」 | 两处 14 改为 16；总 Gap 口径相应为 22+16=38 |
| 2 | YELLOW | 质量（修正落地不完整，轻微） | Step 1.5 新增 AC-5.13（human/agent wait 主动 resolve 入口）已落 AC 列表与 PRD 校验表，但 S5 标题行 Scope（「按 kind 到期动作、watchdog、stalled 重试与升级、收尾校验」）与概述均未同步该职责——主动 resolve 不属于其中任一项，只读概述的 Step 2 设计者会漏掉。S4 概述同理未提 AC-4.12 中止通道（其 Scope「效果生命周期」尚可涵盖，程度更轻） | S5-waits-watchdog.md 标题行 Scope 与概述；S4-effects-outbox.md 概述（次要） | S5 Scope 追加「wait 主动 resolve 入口」；S4 概述补一句中止通道，Step 2 前顺手完成 |

## 检查明细

| 检查项 | 结果 | 说明 |
|---|---|---|
| ① 修正项闭合（信封重点） | PASS* | AC-5.13 与 S2 AC-2.7/2.8「等待消解」、FLOW-2.1 跨组 G5 标注、S3 AC-3.10「消费 resolved 状态」闭合（timer 由 AC-5.6 锁定，AC-5.13 显式排除 timer 无冲突）；AC-4.12 与 S5 AC-5.11「中止的执行机制属 G4」双向互引闭合，且与 AC-4.9 作废重派衔接、触发条件归 G5 的边界清晰；S6 AC-6.6「按 G4 恢复策略处置」、AC-6.10「waits 复用 G5 / outbox 复用 G4」分别标注、FLOW-6.2 跨组改为 G4+G5 并补对账断言（以状态表为准的校验提交、对账后 git 仓干净，引用 AC-4.10）——三处修正全部落地。*仅 S5/S4 Scope/概述未同步（问题 #2） |
| ② 统计一致性 | FAIL | 总 AC 76 ✓（14+13+12+12+13+12）、Flow 13 ✓、各组 AC 范围/AC 数/Flow 数/RED 0/YELLOW 22 全部与文件一致 ✓；WHITE 汇总数字 14 ≠ 实际 16（问题 #1） |
| ③ 跨组 Gap 配对（信封重点） | PASS | G-1.6（S1 脏区约定）↔ AC-4.10（S4 对账）互为抓手，两侧文本互指 ✓；G-4.3（noop resume 注入 + agent_session_id）↔ G-6.5（failAt 点位枚举）同属 noop 注入点设计，两条均在且 _index 标注对齐 ✓；G-5.6（心跳上报接口「需与 G4 协调」）↔ G4 仍成立 ✓；附带：G-5.4 扩展覆盖 S3 AC-3.12 的标注与 S5 原文不冲突 ✓ |
| ④ 术语一致性 | PASS | assignment 全程统一、无第二个 task 概念（AC-1.5 enforce）；effect 四态 pending/running/done/aborted 三组（S1/S4/S6）一致；wait 三 kind human/agent/timer（S1/S2/S5）一致；终态三值 done/failed/cancelled 一致；事件名 snake_case 风格统一（phase_changed / assignment_stalled / wait_resolved，候选 decision_discarded / thrash_escalated 同风格）；已知漂移「Owner 单飞 vs topology='solo'」「supersede vs failed/superseded」均被 G-3.3 / G-5.1 捕获且 _index ⑤ 已标注待 Step 2 统一，无新增漂移 |
| ⑤ AC / Gap 编号唯一性 | PASS | 76 个 AC、38 个 Gap 编号跨组无重复（脚本核验）；_index 引用的 38 个 Gap 与各文件一一对应，无悬空、无遗漏 |
| ⑥ 所有权冲突 | PASS | AC-5.13 落 G5（wait 对象归 G5 约定）、AC-4.12 落 G4（效果执行归 G4 约定），S5 AC-5.11 仅引用不重定义；五条所有权约定无新冲突 |
| ⑦ Flow AC 跨组引用 | PASS | 13 条 Flow 的跨组标注与各组实际能力逐条核对一致；FLOW-2.1 的「G5 wait 消解」由 AC-5.13/AC-5.6 承接（修正前为悬空，现已闭合）；FLOW-6.2 修正后标注与 S4/S5 归属一致 |

## 总结

- 检查项: 5/7 通过（①带轻微保留）
- RED: 0 | YELLOW: 2
- **结论**: PASS（两条 YELLOW 均为文档同步级问题，不阻塞 Step 2；建议进入 Step 2 前顺手修正 _index 的 WHITE 计数与 S5 Scope 行）
