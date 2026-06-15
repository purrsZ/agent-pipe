# 模块设计校验 -- 校验报告

> Step 2.2a | Feature: workitems-m0 | 模式: module (S6, AC-6.1~6.12) | 2026-06-12

## 校验范围

| 类别 | 文件 |
|------|------|
| 被检产出 | docs/ai-specs/workitems-m0/spec/S6-noop-verification.md（§设计 对照 §需求） |
| 对照来源 | docs/ai-specs/workitems-m0/spec/overview.md（ADR-2 + G-6.1~6.6）；S1/S3/S4 设计节（跨模块接口核对） |

## AC 覆盖

| AC | 设计覆盖位置 | 状态 |
|----|------------|------|
| AC-6.1 | #1 noopType 九成员全实现（isDecisionStale 恒 false、topology solo、空策略）；集成接口面用例 | COVERED |
| AC-6.2 | #2 run handler（delayMs 受控 + 仅 import src/workitems/types）；AgentPool spawn 计数为零断言 | COVERED |
| AC-6.3 | NoopParams failAt 三点位 + failsLeft=(failCount??0)-retries 链上持久计数（G-6.5 兑现）；注入参数面用例 | COVERED |
| AC-6.4 | FLOW-6.1 + 五面交叉断言用例（终态/seq/效果/wait/投影/git log） | COVERED |
| AC-6.5 | onEvent run_failed 分支（noopMaxRetries 耗尽 → terminal failed）+ failCount=∞ 用例——但判定依赖的 `ev.payload.retries` 不在结论事件契约内（见问题 #1） | 部分 COVERED |
| AC-6.6 | #6 SIGKILL 双窗口命中（轮询 DB + WAL 跨进程读，G-6.3 兑现）；进程级用例 | COVERED |
| AC-6.7 | 并发 ≥3 混合参数用例（各自 seq 连续、终态独立） | COVERED |
| AC-6.8/6.9 | #4 takeover 断言核定（ADR-2，A exit 0 / 锁=B.pid / 无双实例窗口）+ removeOwnPidFile 回归；进程级用例 | COVERED |
| AC-6.10 | #3 index.ts 接线 + container start/stop 序列（G-6.4 截断语义）——实现要点全；**无显式测试要点**（见问题 #2） | 部分 COVERED |
| AC-6.11 | #3 config.ts 两路径 + 环境变量覆盖、零语义——实现要点全；**无显式测试要点**（见问题 #2） | 部分 COVERED |
| AC-6.12 | #5 architecture.test.ts 四条规则 + npm test 一键；架构测试用例 | COVERED |

## 问题清单

| # | 严重度 | 类型 | 描述 | 涉及位置 | 建议 |
|---|--------|------|------|---------|------|
| 1 | YELLOW | 矛盾 | noop onEvent 的 run_failed 分支读 `ev.payload.retries`，但 S3/S4 定义的结论事件 payload 为 `{assignmentId, effectId, basedOnSeq, decision?, error?}`，不含 retries；onEvent 是纯函数无法查库 ⇒ AC-6.5「重派 N 次后 failed」按当前契约不可实现 | S6 §内部结构 #1 ↔ S3 §对外接口 / S4 §内部结构 #2 | S4 emit run_failed 时附带 assignment.retries（执行器持有 assignment 行），并同步进 S3 结论事件 payload 契约 |
| 2 | YELLOW | 遗漏 | AC-6.10 / AC-6.11 无显式测试要点：测试策略未列「优雅关闭——停 watchdog/停取新单/abort 在途、running 效果留库交恢复（G-6.4）」「crash guard cleanup 释放容器资源」「config 路径默认值与环境变量覆盖」的断言；且进程级 fixture 为「最小装配」而非真 index.ts，AC-6.10「装配代码仅接线」的验证手段未述 | S6 §测试策略 | 补：集成用例 stop() 后断言 watchdog 停、在途效果保持 running、重启走恢复路径；config 单测（默认落 DATA_DIR + 环境变量覆盖）；AC-6.10 装配面写明以 code review / 架构扫描兜底 |
| 3 | YELLOW | 质量 | NoopParams 契约不完整：run handler 心跳循环用到 `heartbeatIntervalMs`，未出现在 NoopParams 或任何配置定义中——实现者需自行决策取值与归属 | S6 §内部结构 #2 ↔ §对外接口 NoopParams | NoopParams 补 `heartbeatIntervalMs?: number`（含默认值），或写明取容器 cfg 派生值 |

## 总结

- 检查项: 3/6 通过（③漂移——noop 自有 phase 取值属不透明承诺范畴、timerWaitSec/noopMaxRetries 有 AC-6.4/6.5 及 overview「需求反馈」双路径说明支撑、不新增容器事件 kind，无漂移；⑤模式合规——noop 仅 import workitems 层、onEvent 纯、ADR-2 与 G-6.3~6.6 全部兑现；⑥Gap 兑现全过；①AC 覆盖（6.5/6.10/6.11 部分）、②契约（#1/#3）、④测试策略（#2）各有扣项）
- 跨模块备注（不重复计数）：S2 设计声称 architecture.test.ts 含「src/workitems/ phase 只读写不比较」断言而本组规则清单未含——已记录于 v2-S2 报告问题 #2。
- RED: 0 | YELLOW: 3
- **结论**: PASS（#1 为契约硬伤，建议 Step 3 前先修）
