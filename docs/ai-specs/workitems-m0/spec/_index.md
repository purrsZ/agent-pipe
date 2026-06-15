# workitems-m0 — 需求索引（Step 1c）

> M0 目标：建立 workitems 容器层（独立存储、生命周期投影、reducer 并发模型、同事务 outbox、等待监督），以 noop 退化类型打穿全部路径并验证单实例地基。

## 分组目录

| # | 名称 | AC 范围 | AC 数 | Flow | RED | YELLOW | WHITE | 文件 |
|---|------|---------|-------|------|-----|--------|-------|------|
| 1 | 存储与数据基座 | AC-1.1~1.14 | 14 | 1 | 0 | 3 | 4 | S1-storage-foundation.md |
| 2 | 容器生命周期与状态投影 | AC-2.1~2.13 | 13 | 2 | 0 | 4 | 2 | S2-lifecycle-projection.md |
| 3 | reducer 运行时与决策防错 | AC-3.1~3.12 | 12 | 2 | 0 | 4 | 3 | S3-reducer-concurrency.md |
| 4 | 效果 outbox 与崩溃恢复 | AC-4.1~4.12 | 12 | 2 | 0 | 4 | 2 | S4-effects-outbox.md |
| 5 | 等待与活性监督 | AC-5.1~5.13 | 13 | 3 | 0 | 4 | 2 | S5-waits-watchdog.md |
| 6 | noop 类型与单实例全路径验证 | AC-6.1~6.12 | 12 | 3 | 0 | 3 | 3 | S6-noop-verification.md |

## AC 总览

| AC | 一句话 | 组 | Flow |
|---|---|---|---|
| AC-1.1 | 独立 workitems.sqlite 初始化（WAL+FK，五表建出，不碰 kernel 库） | G1 | F1.1 |
| AC-1.2 | 独立 migration 体系，与 kernel 互不感知 | G1 | — |
| AC-1.3 | workitems 主表 schema（§4.2 全字段，phase 不校验） | G1 | F1.1 |
| AC-1.4 | UNIQUE(type, dedupe_key) 幂等约束（NULL 不受限） | G1 | — |
| AC-1.5 | assignments 表 schema 与 replaces 链（无第二个 task 概念） | G1 | — |
| AC-1.6 | waits 表与 origin_assignment_id 溯源外键 | G1 | — |
| AC-1.7 | effects 表 schema（status 限 pending/running/done/aborted） | G1 | — |
| AC-1.8 | events append-only + UNIQUE(workitem_id, seq) | G1 | F1.1 |
| AC-1.9 | 每工作项独立 git 仓初始化与布局约定 | G1 | F1.1 |
| AC-1.10 | 每次写 artifact 提交一次，历史可取回 | G1 | F1.1 |
| AC-1.11 | DB 只存路径索引与状态，正文在文件系统 | G1 | — |
| AC-1.12 | backup 覆盖 workitems.sqlite（WAL 折叠单文件副本） | G1 | F1.1 |
| AC-1.13 | backup 覆盖 workitems/ 目录（含 .git 历史） | G1 | F1.1 |
| AC-1.14 | backup 失败隔离，不连坐 kernel 备份 | G1 | — |
| AC-2.1 | 编程创建 API：open + initialPhase + 创建事件 | G2 | F2.1 |
| AC-2.2 | 未注册类型创建被拒 | G2 | — |
| AC-2.3 | dedupe_key 幂等创建 | G2 | F2.2 |
| AC-2.4 | 无 dedupe_key 不参与幂等 | G2 | — |
| AC-2.5 | open 工作项 ≤3 代码 enforce | G2 | F2.2 |
| AC-2.6 | 上限可配置且终态不计数 | G2 | F2.2 |
| AC-2.7 | 外层生命周期合法流转 open→active⇄waiting→done | G2 | F2.1 |
| AC-2.8 | rollup 投影固定优先级 human>active>agent>timer | G2 | F2.1 |
| AC-2.9 | 投影不反向钳制执行 | G2 | — |
| AC-2.10 | 终态不可逆，投影冻结 | G2 | F2.1 |
| AC-2.11 | phase 不假设单调，回退是普通转移 + phase_changed | G2 | — |
| AC-2.12 | phase 不解释，任意字符串原样存查 | G2 | — |
| AC-2.13 | WorkType 接口九成员全签名与注册表（重复注册被拒） | G2 | — |
| AC-3.1 | 同 workitem 事件串行 apply，顺序与到达一致 | G3 | F3.1 |
| AC-3.2 | seq 单调分配无重复 | G3 | F3.1 |
| AC-3.3 | 跨 workitem 互不阻塞，seq 序列独立 | G3 | — |
| AC-3.4 | onEvent 纯转移，效果不在 reducer 内执行 | G3 | — |
| AC-3.5 | 运行是效果，结论以事件回流再转移 | G3 | F3.1 |
| AC-3.6 | Owner 单飞：同 workitem 执行中运行 ≤1 | G3 | F3.1 |
| AC-3.7 | 排队事件批量带入，一次唤醒 | G3 | F3.1 |
| AC-3.8 | 效果携带 based_on_seq（载体与 G1 对齐，见 G-3.6） | G3 | F3.2 |
| AC-3.9 | 结构检查：assignment 已 supersede/终态则作废，产物不删 | G3 | F3.2 |
| AC-3.10 | 结构检查：wait 已 resolve 则作废 | G3 | — |
| AC-3.11 | isDecisionStale 调用时机，noop 恒 false | G3 | — |
| AC-3.12 | 防颠簸：连续 2 次丢弃后升级 human wait | G3 | F3.2 |
| AC-4.1 | 效果与状态转移同一 SQLite 事务落库 | G4 | F4.1 |
| AC-4.2 | 同事务原子回滚，无中间态 | G4 | — |
| AC-4.3 | 效果在 reducer 之外异步执行，不阻塞新事件 | G4 | F4.1 |
| AC-4.4 | 效果终态化（done/aborted）后不再被拾取 | G4 | F4.1 |
| AC-4.5 | 崩溃恢复固定序列：锁确认→状态表重建→outbox 重建 | G4 | F4.2 |
| AC-4.6 | pending 效果恢复后重新入队，不丢不重插 | G4 | F4.2 |
| AC-4.7 | 幂等效果 running 中断后直接重跑 | G4 | F4.2 |
| AC-4.8 | run 类效果可 resume 则原 assignment 续跑 | G4 | F4.2 |
| AC-4.9 | 不可 resume 则作废 + replaces 链重派，不盲目重跑 | G4 | F4.2 |
| AC-4.10 | 事件↔artifact 对账：以状态表为准做校验提交 | G4 | F4.2 |
| AC-4.11 | 恢复不依赖事件回放（状态权威 + 事件审计） | G4 | — |
| AC-4.12 | running 效果中止通道：置 aborted + 中止事件，不再产出结论回流（触发归 G5，重派衔接 AC-4.9，Step 1.5 补） | G4 | — |
| AC-5.1 | wait 创建必带到期动作（防 2099 反模式） | G5 | F5.3 |
| AC-5.2 | 到期必产生事件，resolve 后免疫 | G5 | F5.3 |
| AC-5.3 | human 到期提醒降级日志+事件，同到期仅提醒一次 | G5 | F5.1 |
| AC-5.4 | human 显式续期留痕（renewed_count，唯一改期入口） | G5 | F5.1 |
| AC-5.5 | agent 到期走 stalled 流程 | G5 | — |
| AC-5.6 | timer 到期触发即 resolve | G5 | F5.3 |
| AC-5.7 | assignment 派发必带 deadline_at 与 wallclock_cap_sec | G5 | — |
| AC-5.8 | 心跳静默超时 → assignment_stalled 事件 | G5 | F5.1 |
| AC-5.9 | 预算内重启：旧节点终态保留 + replaces 链 | G5 | F5.1, F5.2 |
| AC-5.10 | 预算耗尽升级 human wait（origin 可溯源） | G5 | F5.1, F5.2 |
| AC-5.11 | 墙钟硬上限：独立于心跳的第二道防线 | G5 | F5.2 |
| AC-5.12 | 收尾 artifact 校验代码 enforce（缺失即失败） | G5 | — |
| AC-5.13 | human/agent wait 主动 resolve 入口（operator+reason，重复 resolve 幂等拒绝；timer 不开放，Step 1.5 补） | G5 | — |
| AC-6.1 | noop 实现 WorkType 接口全签名（solo/恒 false/纯转移） | G6 | F6.1 |
| AC-6.2 | noop 效果可控延时且不经 AgentPool | G6 | F6.1 |
| AC-6.3 | noop 失败可注入参数化（failAt/failCount） | G6 | — |
| AC-6.4 | 正常全路径端到端：五面交叉一致到 done | G6 | F6.1 |
| AC-6.5 | 持续失败全路径到达 failed 且可审计 | G6 | — |
| AC-6.6 | SIGKILL 崩溃恢复端到端：不双跑不停滞 | G6 | F6.2 |
| AC-6.7 | 并发多 workitem 互不串扰 | G6 | — |
| AC-6.8 | PID 锁双进程竞争，后启者拒绝启动 | G6 | F6.3 |
| AC-6.9 | 退出只删自己的锁（6329d35 回归） | G6 | F6.3 |
| AC-6.10 | index.ts 装配：启动恢复 + 优雅关闭挂钩，仅接线 | G6 | F6.2 |
| AC-6.11 | config.ts 新增 workitems 路径配置，kernel 不解释语义 | G6 | — |
| AC-6.12 | 架构依赖单向校验可执行（kernel 无业务词汇） | G6 | — |

## Flow AC 总览

| Flow | 要旨 | 跨组 |
|---|---|---|
| FLOW-1.1 | 存储全链路：建项→写产物→记事件→备份 | 无 |
| FLOW-2.1 | 工作项完整生命周期 open→…→done | G3（转移）、G5（wait 消解） |
| FLOW-2.2 | 幂等创建与上限计数协同 | 无 |
| FLOW-3.1 | 单飞-排队-批量唤醒-回流闭环 | G4（效果落库与执行） |
| FLOW-3.2 | 过期决策作废-防颠簸升级 | G4（效果执行）、G5（human wait） |
| FLOW-4.1 | 效果正常流水线 pending→running→done | G3（转移提交语义） |
| FLOW-4.2 | 崩溃恢复端到端：三策略分流 + 对账 | G6（单实例锁机制） |
| FLOW-5.1 | 卡死升级全链路：心跳→重试→升级→续期 | G3、G4、G6 |
| FLOW-5.2 | 空转防线：墙钟独立于心跳 | G4、G6 |
| FLOW-5.3 | timer 等待生命周期 | G3 |
| FLOW-6.1 | noop 正常全生命周期（组合验证） | G2-G5 |
| FLOW-6.2 | 崩溃恢复旅程（装配 + 恢复扫描 + 对账） | G4（outbox 恢复与对账）、G5（waits 重建）〔原 G3/G5 标注已修正，见跨组检查①〕 |
| FLOW-6.3 | 双实例竞争与退出清理 | 无 |

## Gaps 汇总

**RED**：无。

**YELLOW（22 条，均为 Step 2 必解项）**：
- G-1.5: workitems.sqlite 备份命名与 backup.ts BACKUP_NAME_RE 耦合，需新前缀 + 修剪分流（S1，触碰 kernel）
- G-1.6: 「写文件成功但 commit 失败」脏区约定——G4 对账的抓手（S1↔S4 配对解决）
- G-1.7: assignments/<id>/ 内文件命名与 brief_path/report_path 对齐（S1）
- G-2.1: open ≤3 计数口径：仅 open 还是全部非终态（S2）
- G-2.2: open 能否不经 active 直达终态（S2）
- G-2.3: dedupe 冲突时 API 返回语义（S2）
- G-2.4: 无活动且未终态时的投影值未定义（S2）
- G-3.1: 「排队」与「即时 apply」解读确认，影响 seq 分配时点（S3）
- G-3.2: 防颠簸计数作用域与清零条件（S3）
- G-3.3: 单飞约束对象：所有运行类效果 vs 仅 owner（S3，关联 noop topology=solo）
- G-3.7: eventsSince 边界——isDecisionStale 入参契约（S3）
- G-4.2: 幂等契约归属：效果自证 vs 容器去重（S4）
- G-4.3: noop resume 注入形态与 agent_session_id 约定（S4↔S6 配对解决）
- G-4.5: 效果失败是否带重试预算再 aborted（S4）
- G-4.6: aborted 后回流事件与重派通道（S4）
- G-5.1: stalled 旧 assignment 终态取值 failed vs superseded（S5，影响 S3 AC-3.9 与 S2 投影输入）
- G-5.2: deadline_at / 心跳阈值 / wallclock_cap_sec 三套超时分工（S5）
- G-5.3: agent wait 与目标 assignment 关联方式 + 多超时源并发去重（S5）
- G-5.4: 自动创建的 human wait 的 deadline_at 默认值（S5；同样适用 S3 AC-3.12 防颠簸来源，见跨组检查④）
- G-6.1: PID 锁「后启拒绝 vs takeover」语义核定（S6；S4 AC-4.5 第一步引用之）
- G-6.4: 优雅关闭对 running 效果的处置语义（S6）
- G-6.6: 被拒实例退出码与 supervisor 重启契约（S6）

**WHITE（16 条，已有候选方案，Step 2 顺带落定）**：
- G-1.1 列类型/FK/索引细化；G-1.2 workitems/ 备份形态；G-1.3 append-only trigger 强度；G-1.4 git 仓初始化与提交身份（S1）
- G-2.5 waiting 子类表示形态；G-2.6 投影重算时机（S2）
- G-3.4 串行队列实现形态；G-3.5 作废/升级事件 kind 与 payload；**G-3.6 based_on_seq 字段载体——跨组 G1/G3/G4 对齐，Step 2 必解**（S3）
- G-4.1 执行器并发度与取单顺序；G-4.4 对账校验提交形态（S4）
- G-5.5 watchdog 实现形态；G-5.6 心跳上报接口（需与 G4 协调）（S5）
- G-6.2 依赖校验工具选型；G-6.3 SIGKILL 窗口命中手段；G-6.5 failAt 点位枚举（与 G-4.3 对齐）（S6）

**校验报告 YELLOW（Step 1.5a，v1-S6，2 条）——均已修正（Step 1.5）**：
- ① S6 outbox 恢复归属笔误（G5 → G4）：AC-6.10 与 FLOW-6.2 已更正（AC-6.6 复检已为 G4），见跨组检查①修正标注
- ② 启动恢复枚举缺「事件↔artifact 对账」：AC-6.10 恢复枚举与 FLOW-6.2 路径/验证点已补对账断言（以状态表为准的校验提交、对账后 git 仓工作区干净）

## 跨组一致性检查

**① 引用归属错误（S6 → 应为 G4）**：S6 AC-6.6「按 G5 恢复策略处置」、AC-6.10「复用 G5 机制」、FLOW-6.2 跨组标注「Group 3/5（outbox 与恢复机制归属组）」——outbox 恢复策略与启动恢复序列的所有权在 G4（S4 AC-4.5~4.9），G5 仅管 wait/watchdog。建议 Step 2 将 S6 三处引用更正为 G4（本步不改文件）。
**〔已修正 · Step 1.5〕**：AC-6.10 改为「waits 重建复用 G5 / outbox 重建复用 G4」分别标注；FLOW-6.2 跨组改为「Group 4（outbox 与恢复及对账机制归属组）、Group 5（waits 重建）」；AC-6.6 复检时已为「按 G4 恢复策略处置」，无需再改。同时按 v1-S6 校验 YELLOW#2，AC-6.10 恢复枚举与 FLOW-6.2 路径/验证点补上 §10 第四步「事件↔artifact 对账」断言（以状态表为准的校验提交存在、对账后 git 仓工作区干净，复用 G4 AC-4.10）。

**② 引用悬空（wait 主动 resolve 入口无归属）**：S2 AC-2.7/2.8 与 FLOW-2.1 依赖「等待消解」，S3 AC-3.10 消费 resolved 状态，但除 timer 到期自动 resolve（AC-5.6）外，human/agent wait 的主动 resolve API/机制无任何组 AC 定义（S1 AC-1.6 仅承载 resolved_at 字段）。按「wait 对象归 G5」约定，建议 Step 2 在 G5 补 resolve 入口设计。
**〔已修正 · Step 1.5〕**：S5 新增 AC-5.13 定义 human/agent wait 的主动 resolve 编程入口（带 operator 与 reason；置 resolved_at + wait_resolved 事件回流；退出 rollup 投影与到期扫描；重复 resolve 幂等拒绝；timer 不开放——其 resolve 即到期触发，AC-5.6 已锁）。

**③ 引用悬空（弱）**：S5 AC-5.11「中止运行的执行机制属 G4」——S4 无「中止一个 running 运行」的操作类 AC（S4 的 aborted 指效果自身状态，非中止动作）。建议 Step 2 在 G4 设计中明确中止通道。
**〔已修正 · Step 1.5〕**：S4 新增 AC-4.12 定义对 running 运行类效果的中止通道（收到中止指令——触发条件归 G5，如墙钟超限——后效果置 aborted、产生中止事件、不再产出结论回流；中止后是否重派由 reducer 决策归 G3，与 AC-4.9 作废重派衔接）。

**④ 跨组 Gap 归位确认**：
- G-3.6（based_on_seq 载体）：S1 AC-1.7 的 seq（由哪次转移声明）、S3 AC-3.8 的 based_on_seq、S4 AC-4.1 的「声明转移的 seq」指向同一载体，候选复用一字段——字段定义归 G1，G3/G4 复用语义；虽标 WHITE 但属 Step 2 必解对齐项。✓ 已归位
- G-1.5（备份命名分流）：所有权纯属 G1，但改动落在 kernel backup.ts，Step 2 必解。✓ 已归位
- G-6.1（PID 锁语义）：所有权归 G6（端到端与 PID 锁约定），S4 AC-4.5 仅引用「锁确认为恢复第一步」；其结论会改 AC-6.8/FLOW-6.3 断言形态。✓ 已归位
- 配对项：G-1.6↔AC-4.10（对账抓手）、G-4.3↔G-6.5（noop 注入点）、G-5.6↔G4（心跳接口）需在 Step 2 同回合设计；G-5.4 建议扩展覆盖 S3 AC-3.12 防颠簸创建的 human wait（同样无人给 deadline）。

**⑤ 术语漂移**：S3「Owner 单飞」 vs noop topology='solo'（M0 无 Owner/Worker 拓扑）——G-3.3 已捕获，按其候选「每 workitem ≤1 执行中运行类效果」统一表述；S3 AC-3.9 的「supersede」是否为 assignment status 取值需与 G-5.1（failed vs superseded）同一决议。其余核心术语（assignment/effect 四态/终态三值/append-only/rollup）六组一致。

**⑥ 所有权冲突与编号冲突**：未发现。五条所有权约定（表结构 G1、WorkType 接口 G2、同事务 outbox G4、wait 对象 G5、端到端与 PID 锁 G6）均被遵守；AC-2.13 定义接口契约、AC-6.1 为 noop 实例化，不构成重复定义。AC/Gap 编号无跨组重复。

## 统计

总 AC 76 | Flow AC 13 | 分组 6 | RED 0 | YELLOW 22 | WHITE 16 | 跨组问题 3（①②③，已于 Step 1.5 修正：S6 归属更正 + 对账补全、S5 新增 AC-5.13、S4 新增 AC-4.12）+ 归位确认 4 + 术语统一 2
