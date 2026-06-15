# 模块设计校验 -- 校验报告

> Step 2.2a | Feature: workitems-m0 | 模式: module (S3, AC-3.1~3.12) | 2026-06-12

## 校验范围

| 类别 | 文件 |
|------|------|
| 被检产出 | docs/ai-specs/workitems-m0/spec/S3-reducer-concurrency.md（§设计 对照 §需求） |
| 对照来源 | docs/ai-specs/workitems-m0/spec/overview.md（ADR-1/3/4 + G-3.1~3.7）；S1/S4 设计节（跨模块接口核对） |

## AC 覆盖

| AC | 设计覆盖位置 | 状态 |
|----|------------|------|
| AC-3.1~3.3 | #1 per-item FIFO + 同步 drain、独立队列独立 seq、MAX(seq)+1 + UNIQUE 兜底；集成并发注入/跨 item 用例 | COVERED |
| AC-3.4 | applyEvent 内 onEvent 纯函数 + postCommit 出事务；集成「apply 返回时效果行 pending 且 handler 未调」 | COVERED |
| AC-3.5/3.6 | emit→enqueue 回流 + insertRunEffect 单飞检查（wake_pending）；FLOW-3.1 集成 | COVERED |
| AC-3.7 | #3 批量带入——机制描述与 ADR-3 字段语义矛盾（见问题 #1），按当前契约「输入含 3 事件」不可达 | 部分 COVERED |
| AC-3.8 | insertEffect(seq,…)（effect.seq=based_on_seq，ADR-3）+ insertAssignment(based_on_seq=seq) | COVERED |
| AC-3.9/3.10 | #4 structuralCheck 四分支 + 「artifact 不动」；FLOW-3.2 + 场景表 | COVERED |
| AC-3.11 | 结论前置检查 + eventsSince 开区间 (based_on_seq, seq)；桩类型恒 true 用例 + FLOW-3.1 正常 apply | COVERED |
| AC-3.12 | discard_streak 持久化 + ≥2 升级 human wait + 成功 apply 清零；FLOW-3.2 集成 | COVERED |

## 问题清单

| # | 严重度 | 类型 | 描述 | 涉及位置 | 建议 |
|---|--------|------|------|---------|------|
| 1 | YELLOW | 矛盾 | AC-3.7 批量带入机制自相矛盾：唤醒新 run 效果 based_on_seq=当前结论 seq（=N，ADR-3 约束），而 3 个完成事件 seq 均 < N；设计却声称「run handler 经 ctx.eventsSince(basedOnSeq) 读取……3 个完成事件全部在内」——eventsSince(N) 为开区间下界，恰好**排除**这 3 个事件。状态基准 N 正确，但批量输入窗口起点应是上一次运行的 based_on_seq（M），handler 当前拿不到 M | S3 §内部结构 #3 | 明确批量窗口起点取数路径：经 replaces/上一 assignment 行读取前次 based_on_seq，或在唤醒 run 效果 payload 中显式携带 `batchFromSeq`；S3 集成测试「输入含 3 事件」以此为断言依据 |
| 2 | YELLOW | 矛盾 | applyEvent 成功路径对一切结论事件无条件 `setEffectStatus(effectId,'done')`，但 run_failed 路径下 S4 执行器已先置 aborted（AC-4.4：失败置 aborted 且为终态）——按伪代码会把 aborted 改写为 done，违反「效果终态不再变」 | S3 §内部结构 #2 ↔ S4 §内部结构 #2 | 置 done 仅限 run_completed（或条件化：仅当效果当前为 running 时置 done），run_failed 的终态置位归 S4 执行器 |
| 3 | YELLOW | 质量 | 唤醒/第 1 次作废重唤醒走 `defaultDispatch(item)`，其 AssignmentSpec 必填参数（deadlineTtlSec/wallclockCapSec，AC-5.7 校验为正数）来源未定义——实现者仍需做设计决策（从 item.context 取？沿用上一 assignment？） | S3 §内部结构 #3 | 写明 defaultDispatch 参数来源（建议：复制被替代/上一 assignment 的监督参数），与 S5 stalled 重派的「原参数」口径统一 |
| 4 | YELLOW | 矛盾 | G-3.5 兑现不完整：ADR 规定 decision_discarded payload 含 `assignment_id?/wait_id?`（可审计的判废依据），设计伪代码为 `{...verdict, effectId, basedOnSeq}` 而 structuralCheck 仅返回 {ok, reason}，触发判废的具体对象 id 丢失 | S3 §内部结构 #2/#4 对照 overview G-3.5 | structuralCheck 返回 {ok, reason, assignmentId?, waitId?}，并入 decision_discarded payload |
| 5 | YELLOW | 矛盾 | 与 S1 接口不一致：structuralCheck 使用 `getAssignment(id)`/`getWait(id)` 单行读取（S4 恢复、S5 stalled 处置、resolveWait 亦同），但 S1 WorkitemsStore 仅定义 listAssignments/listRunningAssignments/listOpenWaits，无按 id 单读方法 | S3 §内部结构 #4 ↔ S1 §对外接口 | S1 store 补 `getAssignment(id)` / `getWait(id)`（或在 S3/S4/S5 改用 list+过滤并写明） |

## 总结

- 检查项: 3/6 通过（③漂移——wake_pending/discard_streak/defaultDispatch 均为机制且有 ADR-1/G-3.2 来源，事件 kind 清单封闭，无漂移；④测试策略——桩 WorkType 隔离 S6、真 DB 集成形态可落地；⑤模式合规——纯转移/同步事务/postCommit 出事务全过；①AC 覆盖（AC-3.7 部分）、②数据契约（#3/#5）、⑥Gap 兑现（G-3.5 部分）各有扣项）
- RED: 0 | YELLOW: 5
- **结论**: PASS（#1/#2 为设计自洽硬伤，强烈建议 Step 3 前先修；其余可随实现修正）
