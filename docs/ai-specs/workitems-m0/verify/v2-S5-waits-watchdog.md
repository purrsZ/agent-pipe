# 模块设计校验 -- 校验报告

> Step 2.2a | Feature: workitems-m0 | 模式: module (S5, AC-5.1~5.13) | 2026-06-12

## 校验范围

| 类别 | 文件 |
|------|------|
| 被检产出 | docs/ai-specs/workitems-m0/spec/S5-waits-watchdog.md（§设计 对照 §需求） |
| 对照来源 | docs/ai-specs/workitems-m0/spec/overview.md（ADR-5 + G-5.1~5.6）；S1 设计节（跨模块接口核对） |

## AC 覆盖

| AC | 设计覆盖位置 | 状态 |
|----|------------|------|
| AC-5.1 | #1 applyWaitSpec（kind/deadline 校验 + 无禁用开关 + 2099 不豁免）；集成 + 远期 deadline 用例 | COVERED |
| AC-5.2 | #2 tick 仅扫 resolved_at IS NULL；「resolve 后推进时钟再 tick 零动作」用例 | COVERED |
| AC-5.3/5.4 | reminded_at 单次提醒 + renewWait（renewed_count+1、reminded_at=NULL、唯一 deadline 写路径）；用例齐 | COVERED |
| AC-5.5 | #2 agent 到期 → stalledCandidates → assignment_stalled——实现要点有；**无显式测试要点**（见问题 #2），且 origin assignment 已非 running 时设计有自洽漏洞（见问题 #1） | 部分 COVERED |
| AC-5.6 | timer_fired → resolved_at 置值；FLOW-5.3 用例 | COVERED |
| AC-5.7 | #1 末段 assignment 创建校验（缺/非正 → 事务回滚）——实现要点有；**无显式测试要点**（见问题 #3） | 部分 COVERED |
| AC-5.8~5.10 | #2 心跳检查 + #3 stalled 处置（superseded+replaces / failed+human wait origin 溯源 + retry_exhausted 事件）；FLOW-5.1 + 预算耗尽链用例 | COVERED |
| AC-5.11 | 墙钟独立防线（优先级 wallclock>heartbeat>deadline）；FLOW-5.2「断言无 heartbeat_silent」 | COVERED |
| AC-5.12 | #5 EffectRuntime 收尾钩子校验 report 存在且非空（handler 不可绕过）；report 缺失/空用例 | COVERED |
| AC-5.13 | #4 resolveWait（幂等拒绝 + timer 不开放 + operator/reason 留痕）；用例齐 | COVERED |

## 问题清单

| # | 严重度 | 类型 | 描述 | 涉及位置 | 建议 |
|---|--------|------|------|---------|------|
| 1 | YELLOW | 矛盾 | agent wait 到期但 origin assignment 已非 running（如先正常完结/已被重派）时：stalled 处置在 `a.status != 'running'` 早退 return {}，「附带 resolve 该 agent wait」写在分支末尾、早退路径触达不到 ⇒ 该 wait 永不 resolve、永远过期，watchdog 每 tick（默认 1s）重复 enqueue assignment_stalled——事件日志刷屏；设计声称「下一 tick 看到的是已处置状态，无跨 tick 重复触发」对该路径不成立 | S5 §内部结构 #2/#3 | agent_wait_expired 来源的处置在早退分支也 resolve 该 wait（或 tick 阶段发现目标非 running 即直接 resolve 不发 stalled），并补对应 Edge 用例 |
| 2 | YELLOW | 遗漏 | AC-5.5 无显式测试要点：测试清单未列「agent wait 到期 → assignment_stalled → 进入重试/升级路径」用例（心跳/墙钟路径都有，agent wait 入口缺），「附带 resolve 该 agent wait」亦无断言 | S5 §测试策略 | 补集成用例：agent wait 到期 → stalled(reason='agent_wait_expired') → replaces 重派 + 该 wait 已 resolve |
| 3 | YELLOW | 遗漏 | AC-5.7 无显式测试要点：场景表仅有「agent wait 缺 origin」，缺「assignment 缺 deadlineTtlSec/wallclockCapSec 或取值非正 → 事务回滚不落库」断言 | S5 §测试策略 | 补集成用例：dispatch 缺监督参数/取值 0 或负 → 整事务回滚、assignment 与效果行均不存在 |

## 总结

- 检查项: 3/6 通过（②契约——Watchdog/resolveWait/renewWait 签名与全部事件 payload 完整；③漂移——deadline_exceeded 有 ADR-5 来源、reminded_at/renewed_count 有 S1 DDL 来源，无漂移；⑤模式合规——watchdog 零 DB 写、事件经 reducer 唯一通道、FakeClock+手动 tick，全过；⑥Gap 兑现 G-5.1~5.6 全部落地；①AC 覆盖（5.5/5.7 部分）、④测试策略两条缺口、自洽性问题 #1 各有扣项）
- 跨模块备注（不重复计数）：`getAssignment(id)`/`getWait(id)` 不在 S1 store 接口——已记录于 v2-S3 报告问题 #5；stalled 重派「原参数」中 deadlineTtlSec 的还原口径与 S3 defaultDispatch 同源，见 v2-S3 问题 #3。
- RED: 0 | YELLOW: 3
- **结论**: PASS（#1 为活性漏洞，建议 Step 3 前先修）
