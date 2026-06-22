---
gate: Gate 5
reviewer: adversarial-agent（独立子 Agent，默认反对立场）
timestamp: 2026-06-18
target_files:
  - decisions.md（26 决策 + 4 DEFER）
challenges_count: 13
blockers: 4
warnings: 8
hints: 1
status: resolved
---

# 对抗式审查 — Gate 5（decisions.md 决策台账）

## 审查立场声明
> 默认反对立场。4 条阻塞均经真实代码交叉核验、非臆测。决策台账是最关键的人审文档，分歧在此最后一次统一。

## 处置总览
13 条挑战 **全部接受**（4 阻塞 + 8 警告 + 1 提示），已回补 decisions.md（含新增 D-27~D-31、改写 D-03/04/05/09/10/11/18/22、补备选、改 DEFER 判据）。4 条阻塞是真命门，处置如下。

---

### C01【阻塞】D-09 崩溃时 session id 大概率未写入，resume 分支基本走不到
- **对象**：D-09 / run-handler.ts:74-77 / runner.ts:307,334
- **问题**：run-handler.ts:74-77 注释明确"M1b 无 onSession 回调 → session id 崩溃前不可靠落库 → 真 --resume 不可能"。session id 在事件流中途/run 结束才写，而崩溃恢复恰恰是 run 未正常结束、session id 大概率未落库的场景。D-09 的 resume 分支在最需要时几乎必然取不到 session id。
- **回应**：✅ **接受**。这是把"当前架构不支持的能力当既有前提"。处置：**新增 D-30「补 runner onSession 回调」作为 R11 前置** —— runner 在 session 创建/首条事件即 `setAgentSessionId` 同步落库，让 resume 分支可达；**若不补 onSession，则 D-09 诚实退化为"worktree 重置 + 全量 redispatch"单分支**，删 resume 承诺（不给执行 skill 制造永不可达的死代码路径）。推荐补 onSession（它是真实 kernel 缺口、对 probe 多轮 resume 也有益）。
- **回补落点**：decisions 改 D-09 + 新增 D-30；requirements R11 AC4 补前置。

### C02【阻塞】worktree 脏检测+重置基建不存在，ArtifactStore 不通用
- **对象**：D-09 / D-20 / artifacts.ts:51-72
- **问题**：唯一 git 工作区操作是 ArtifactStore（操作 artifact 仓），D-20 自己定"artifact 仓 ≠ worktree"。worker 目标仓 worktree 的 git status/reset --hard/clean **全仓零基建**。D-09"先 git worktree 重置"写得像现成调用，实为从 0 到 1 新子系统，且"重置回基线"错一次=数据损毁。
- **回应**：✅ **接受**。新增 **D-27「worktree 生命周期管理子系统」**（挂 R05/R11）：定义 worktree 路径分配、`git worktree add/remove`、脏检测（`git status --porcelain` on worktree）、重置策略（`reset --hard <base>` + `git clean -fd` 的取舍及未跟踪文件风险——**默认 reset --hard 到 feature 基线，git clean 仅清本 assignment 已知产物目录，不全清以免误伤**）；D-09 引用它而非含糊"git worktree 重置"。
- **回补落点**：decisions 新增 D-27；requirements R05 AC 补 worktree 生命周期。

### C03【阻塞】D-04 hook 注入失败静默退化成无限制写（fail-open）
- **对象**：D-04 / 总纲§14 / runner.ts:57-61
- **问题**：唯一硬约束全压 PreToolUse hook，但 hook 基建不存在要新建、且有绕过面。**hook 注入失败（settings 写失败/Claude 不认 hook/hook 崩溃）时怎么办未答**——write 档只剩"放宽不收紧"的 --add-dir，等于可写任意路径，且静默。
- **回应**：✅ **接受**。改 D-04 加 **fail-closed 约束**：**worker 启动前必须发一条"已知应被 deny 的探针命令"实测确认 hook 生效，验证不通过则拒绝以 write 档启动该 worker（降级 readonly 或报人）**。把"hook 在不在"从隐含前提变成启动时显式断言。
- **回补落点**：decisions D-04 改；requirements R04 AC 补 fail-closed 探针。

### C04【阻塞】isDecisionStale 纯同步禁 fs，拿不到 contract 文件做 diff
- **对象**：D-05 / reducer.ts:757 / worktype 纯同步约束
- **问题**：isDecisionStale 接入点是纯同步纯函数（禁 fs/await）。contract 是 artifact 仓文件，diff 需新旧两份 contract 内容。纯函数里既不能 fs 读 artifact、也不能 await —— diff 数据怎么进纯函数手里这个真正难点被跳过。
- **回应**：✅ **接受**。改 D-05 显式声明**数据流前提（硬接口约定）**：**decision 产出时把所基于的 contract 结构指纹固化进 `decision.data`；contract 变更事件 payload 必须携带变更后的结构指纹/字段级 diff**，使 isDecisionStale 仅凭 `decision.data` + `eventsSince` 即可纯同步判定、不读 fs。作为 R10 与 contract 相关 R 的硬接口约定。
- **回补落点**：decisions D-05 改；requirements R10 AC 补 payload 携带结构指纹。

### C05【警告】结构 diff 抓不到语义等价改动（含义/单位/可空性/排序变）
- **对象**：D-05 / D-06 / D-10
- **回应**：✅ **接受**。新增 **D-31**：明确结构 diff 适用边界 ——"结构 diff 只覆盖结构级变化，**语义等价改动（含义/单位/可空性/排序）不可机械检出，属已知残余**"；**contract 变更事件要求人工标注 `semanticBreaking` 标志**，让人改契约时主动声明，不指望机械检出；这类残余靠 D-06 的"人上真联调"兜底。
- **回补落点**：decisions 新增 D-31；requirements R10 AC 补 semanticBreaking 标志。

### C06【警告】D-03 checkpoint 拦截机制在"拦在消费前"与"容器不能覆写 phase"间留洞
- **对象**：D-03 / mergeTransitions:888 / applyTransitionWrites:265
- **问题**：容器在 applyTransitionWrites 看到 worktype 已算好的 phase.to，要拦却又不能覆写 phase——到底"拦住不让 phase 变+插 wait"（破坏 mergeTransitions 不变量）还是"让 phase 变了再补 wait"（拦了个寂寞）？
- **回应**：✅ **接受**。改 D-03 把机制讲到可实现粒度：**checkpoint 拦截做在 worktype 侧** —— worktype 的 onEvent 自己检测到"将越过 requiredBefore 边界且该 gate 未 resolve"时，**主动返回 `waits:[human]` 而非 phase 变更**（拦在 worktype 侧，容器完全不碰 phase，保 mergeTransitions 不变量）；gate resolve 后 onEvent 再返回 phase 推进。容器侧只提供"requiredBefore 声明 + gate 状态查询"，不做 phase 压制。
- **回补落点**：decisions D-03 改；requirements R03 AC1 改"worktype 主动返 wait"。

### C07【警告】D-01 按仓拆并行度低，"真并行"性能理由站不住
- **对象**：D-01 / D-10 / D-18
- **回应**：✅ **接受（reframe）**。典型需求 2-3 仓，并行度上限低。**把 D-10/D-18 的首要理由从"真并行省墙钟"改为"per-assignment 物理隔离 + abort 不误伤其它 worker"**（后者并行度=2 也成立、是正确性而非性能收益）；D-01 补边界说明"本次并行改造首要目标是隔离不踩踏，墙钟收益是次要"。
- **回补落点**：decisions D-01/D-10/D-18 理由改。

### C08【警告】D-11 独立计数与 stall 重试交叉：stall 重派洗白返工次数绕过举手上限
- **对象**：D-11 / redispatchOrEscalate:519-559
- **回应**：✅ **接受**。改 D-11：独立计数**锚在"逻辑任务（repo+phase）"而非物理 assignment**；`redispatchOrEscalate` 产生的 replacement assignment **必须继承前任的返工计数**（与继承 retries 类似但分开两个字段），确保 stall 重试不洗白语义返工次数。
- **回补落点**：decisions D-11 改；requirements R10/R13 AC 补继承。

### C09【警告】D-10 recoverRun/recoverRunning 早退在多并发恢复下静默吞 worker
- **对象**：D-10 / effects.ts:78,94
- **问题**：`inflight.has(workitemId)` 早退在"一 workitem 多 worker"下：恢复第一个 worker 后它进 inflight，恢复第二个同 workitem worker 时早退 return，第二个永不恢复。D-10 只当"机械改键"，没列为静默吞 worker 的正确性 bug。
- **回应**：✅ **接受**。改 D-10：把 recoverRun/recoverRunning 改造从"机械改键"**升级为显式正确性约束** —— 恢复循环早退条件从 workitem 粒度改 **assignmentId/effectId 粒度**（按本次要恢复的具体 effect 判 inflight）；noop 夹具专门锁定"同 workitem 多 worker 全部恢复"断言。
- **回补落点**：decisions D-10 改；requirements R23 AC4 改断言。

### C10【警告】D-18 owner 预留槽只解决排队公平，owner 派 N worker 也要槽→二级死锁
- **对象**：D-18 / pool.ts:22-56 / DEFER-2
- **问题**：owner 抢到预留 1 槽，但派 worker 本身也要 acquire 槽，又回队尾等 worker 释放，worker 等 owner 指令——循环依赖卡死。DEFER-2"观测 owner 唤醒等待时长"观测不到这种二级饿死。
- **回应**：✅ **接受**。改 D-18：**区分两类 acquire（owner 自身运行 vs owner 派 worker）** —— 方案：**owner 自身运行走预留槽、owner 派 worker 是 reducer 内的 dispatch（产出 pending effect 落库），worker run 的 acquire 在 effects 层异步发生、不阻塞 owner run 完成**（owner run 派完 worker 即结束、释放自己的槽）。即 owner 不在自己 run 内同步等 worker 槽。DEFER-2 判据改为"owner 从唤醒到成功派出全部 worker 的端到端时长 + 是否出现 owner-worker 循环等待"。
- **回补落点**：decisions D-18 改 + DEFER-2 改。

### C11【警告】DEFER-2/3/4 判据"等第7步实测"但单样本不足以校准阈值
- **对象**：DEFER-2/3/4 / D-26⑦
- **回应**：✅ **接受**。改 DEFER 判据为**可单样本证伪的二元形式**（DEFER-2"若 owner 等待 >X 秒或出现循环等待即判预留不足"）；DEFER-3/4 **诚实声明"首版按经验默认上线、靠生产埋点持续校准，第 7 步只验埋点管道通 + 二元异常探测，而非定统计阈值"**。
- **回补落点**：decisions DEFER-2/3/4 改判据。

### C12【警告】多条决策无备选方案字段
- **对象**：D-06 / D-07 / D-08 / D-12 等
- **回应**：✅ **接受（部分）**。补真有两派的：**D-06**（静态对账 vs 强制最小联调）、**D-07**（结构化权威 vs journal 权威）、**D-12**（新 card.action 键 vs 复用入站通道）各补"备选方案 + 否决理由"；其余低风险条目注明"未发现有竞争力替代"。
- **回补落点**：decisions D-06/D-07/D-12 补备选。

### C13【提示】D-22 与 D-04 写工具约束口径不一（hook vs --allowedTools 白名单）
- **对象**：D-22 / D-04
- **回应**：✅ **接受**。对齐：**write 档最终 args = `--add-dir`（声明范围）+ PreToolUse hook（路径硬拦，主约束）+ 写工具集收敛为 `Write Edit NotebookEdit`（去过时 MultiEdit）**；**不再用 `--allowedTools` 白名单作主约束**（hook 管路径、工具集收敛只是清理过时项，两者不重叠）。D-22 的"若用"改为确定结论。
- **回补落点**：decisions D-22 改 + D-04 对齐。

---

## 未发现问题的区域
D-02/D-13/D-14/D-16/D-17/D-21/D-24/D-25 的实证基础经核验真实代码均成立，方向无异议。

## 自评
最少 max(3,26/2)=13，实际 13，达标。4 阻塞均经真实代码交叉核验。**主进程处置：13/13 接受并回补，含新增 D-27/D-29/D-30/D-31 + 改写 8 条 + DEFER 判据收紧。**
