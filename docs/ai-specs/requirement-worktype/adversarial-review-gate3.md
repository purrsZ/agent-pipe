---
gate: Gate 3
reviewer: adversarial-agent（独立子 Agent，默认反对立场）
timestamp: 2026-06-18
target_files:
  - requirements.md（24 Requirement）
challenges_count: 10
blockers: 1
warnings: 6
hints: 3
status: resolved
---

# 对抗式审查 — Gate 3（requirements.md 骨架与切分）

## 审查立场声明
> 默认反对立场，暴露"合理但错误"处。红队抽查模块标签与真实代码 file:line（reducer.ts:603-610、run-handler.ts:147、:138、store.ts:623-635、mergeTransitions:888）均逐字命中，切分粒度本身无异议；挑战集中在**并发边界、契约维度映射、批次窗口、空态、跨 Requirement 接缝**。

## 处置总览
10 条挑战 **全部接受**（1 阻塞 + 6 警告 + 3 提示），已回补 requirements.md。

---

### C01【阻塞】R01「在途 worker 数」口径未指明 + 批量 dispatch + releaseWakePending 改造
- **对象**：R01 AC4 / R23 AC1
- **问题**：单飞门是 reducer 内同步判定，inflight 增减在 post-commit。"在途 worker 数"按 inflight Map（运行时态）还是 running assignment（DB 态、apply 内可见）口径未定。同帧 owner 一次派 N worker 时按 inflight 计数都读旧值→双双放行超放；若按 DB running 又与"releaseWakePending 只补一个 default solo run"冲突。
- **回应**：✅ **接受**。① **在途 worker 数按 DB `status=running` 且 `role=worker` 的 assignment 计数**（apply 内强一致，避 post-commit 时序）；② 新增 AC 覆盖"同一 transition 批量 dispatch N worker"逐个累加判定；③ 新增 AC 改造 `releaseWakePending`：owner-workers 下排队 worker 按 role 补派，不再单条 `defaultDispatchSpec(role:solo)`。
- **回补落点**：R01 AC4 改 + 新增 AC8/AC9；decisions D-10 补口径。

### C02【警告】批次窗口 eventsSince 排他边界语义未锁死
- **对象**：R23 AC1 / R02 AC3
- **问题**：`eventsSince(afterSeq, beforeSeq?)` 上下界排他。owner 运行期间 worker 完成事件的归属窗口未在 AC 写死，易重复消费或漏带。
- **回应**：✅ **接受**。owner 唤醒取 `(lastOwnerRunEffectSeq, currentOwnerRunEffectSeq]` 半开区间，**owner run 期间到达的事件归入下一批**；noop 夹具构造"owner 运行中 worker 完成"时序回归。
- **回补落点**：R02 AC3 细化 + 新增 AC；R23 AC3。

### C03【警告】R09/R10 影响计算「端↔repo↔assignment」三维度映射缺失
- **对象**：R09 AC2-3 / R10 AC2/AC5
- **回应**：✅ **接受**。**合同每条接口直接登记 `providerRepo` / `consumerRepos`（repo key，不用业务端名）**，R09↔R05↔R10 共用 repo 维度；"一端多仓/一仓多角色"按 repo 展开（一仓一 worker）。
- **回补落点**：R09 AC 新增 + R10 AC2 改 repo 维度；decisions 新增 D-29。

### C04【警告】缺空态/初始态 Requirement
- **对象**：R08 / R17 / R09 / R01
- **回应**：✅ **接受**。R08/R01 补"理解 phase worker 数=0 时拓扑分流退化为 solo 不报错"；R17 补"任一区块为空时空态渲染不抛显占位"；R09 补"合同冻结前读 contract/ 缺省返空不抛"。
- **回补落点**：R01/R08/R09/R17 各补空态 AC。

### C05【警告】R11 自测硬门未区分「测试失败」vs「测试无法运行」
- **对象**：R11 AC3/AC6 / R16 runbook
- **回应**：✅ **接受**。"断言失败"→ retry；"测试无法执行（命令缺失/环境/编译基础设施）"→ **不进自动 retry 直接举手**，病历标根因；R11 Boundaries 声明对 R16 runbook 依赖。
- **回补落点**：R11 AC + Boundaries。

### C06【警告】R03↔R10 接缝：checkpoint decision 是否过 isDecisionStale
- **对象**：R03 AC2 / R10 AC5
- **回应**：✅ **接受**。**checkpoint decision 在 reducer 消费前走 isDecisionStale**；若 stale → **拒绝 resolve 并重弹卡"合同已变、请重新确认"**；R10 Boundaries 声明 isDecisionStale 覆盖 checkpoint decision。
- **回补落点**：R03 AC + R10 Boundaries；decisions D-03。

### C07【提示】R04↔R05 writableDirs=worktree 路径耦合未声明
- **回应**：✅ **接受**。R05 新增 AC：**writableDirs 与 cwd 同源于该 assignment 的 worktree 路径，同时确定/同时变更**；R04↔R05 依赖入 Boundaries。

### C08【提示】R23↔R24 per-assignment 并发恢复查询/索引未认领
- **回应**：✅ **接受**。R24 新增 AC：声明 per-assignment 并发恢复所需查询（"列某 workitem 全部 running effect 按 assignment 逐个恢复"）；R23 Boundaries 引用为前提。

### C09【提示】R12/R13 契约测试切分边界模糊（「或」未拍板）
- **回应**：✅ **接受 + 拍板**。跨端契约测试**以"从冻结合同机械生成"为主**，独立质检员补语义层用例；存 artifact 仓 `contract/tests/`；**灯②合同冻结后即生成**。R11/R13 引用同一份。
- **回补落点**：R12 AC；decisions D-24。

### C10【提示】R19/R24 事件 kind 清单不一致
- **回应**：✅ **接受**。一致性 AC：**R24 声明的每个新事件 kind 必须在 anchorAction 有显式映射决定，清单以 R24 为准**；测试断言两清单不漂移。
- **回补落点**：R19 AC5 + R24 AC。

---

## 未发现问题的区域
模块标签 file:line 准确性；R03 phase 不覆写方向；R06 卡片回调红线；R16/R17 knowledge 前置改 architecture.ts；R21/R22 铁律；R24 容器不解释 kind。

## 自评
最少 max(3,24/3)=8，实际 10，达标。**主进程处置：10/10 接受并回补。**
