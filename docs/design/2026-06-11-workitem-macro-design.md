# agent-pipe 宏观设计：从飞书桥到「一人扛需求」的工作平台

日期：2026-06-11
状态：v4，架构定稿候选（宏观设计，不含实现细节）
范围：分层架构、WorkItem 容器模型、并发/效果/持久化模型、异常路径与监督、工作类型建模、知识层、集成层、交互形态、演进路线

修订记录：
- v4（2026-06-11）：吸收第三轮评审。新增效果 outbox（workitem_effects，与状态转移同
  事务落库，按效果类型定义恢复策略）；过期决策判定拆为容器机制 + 类型钩子
  isDecisionStale，并加防颠簸上限；wait 到期动作按 kind 区分，不变量改述为「必带到期
  动作且到期必产生事件」；M1 只读档收紧为仅 Codex runner（OS 沙箱含禁网）；补 MCP
  适配器进程的凭证边界说明；M1 拆为 M1a/M1b；M0 增加 noop 测试类型与单实例前提
  （6329d35 双实例事故已核实）；独立 DB 文件；dedupe_key 唯一约束；waits 溯源外键；
  并行上限由假设改为 enforce；主表更名 workitems。
- v3（2026-06-11）：吸收第二轮评审。权限只读档提前 M1（现状两 runner 全开已核实）；
  外层状态 rollup 投影与 workitem_waits；并发与效果执行模型；kernel 能力盘点表；
  assignment 命名与桥任务共存设计；人工取消路径；每工作项 git 仓；状态权威 + 事件审计。
- v2（2026-06-11）：吸收第一轮评审。异常路径与监督；集成层；kernel 准入标准；监督语义；
  事件并发定调；workitem_ 表前缀；artifact git 化；Owner 休眠写回。
- v1（2026-06-11）：初版。

---

## 1. 背景与目标

### 1.1 现状

agent-pipe 目前是一个 Claude Code / Codex ↔ 飞书的轻量桥接器（~3700 行 TS）：
用户在 IM 里创建隔离任务，每个任务独立进程、工作目录、会话。它的核心资产是
干净的抽象——AgentFactory / Runner Pool / SQLite 持久化 / 飞书事件路由。

### 1.2 公司现实

实际工作模式是**一个人端到端承担一整个需求**，且工作不止一种形态：

- **需求开发**：跨 backend / frontend 多个仓库改代码 + 跨项目设计文档
- **缺陷修复**：复现、定位、修复、验证
- **线上反馈调查**：拉日志、分析、给结论（通常不改代码）
- 未来还会有更多类型（技术调研、重构、发布值守……）

### 1.3 目标

让「一个人 + 这套系统」等价于过去的「一个全栈工程师 + 半个 PM」：

1. 人退到决策点（需求确认、方案/契约评审、验收），执行环节系统自治
2. 一个需求可以**需求内并行**（backend / frontend 同时推进）而不牺牲一致性
3. 不同工作类型共享同一套底座和仓库知识，但各有各的流程
4. agent-pipe 的内核保持初心的简单——复杂度被隔离，不是被扩散

### 1.4 核心命题

> 一个人能独立扛需求，靠的是脑子里**一份连续完整的心智模型**。
> 系统设计的本质是：**心智模型唯一且连续（Owner + artifact），执行并行且即抛（Worker）**。

而自治系统的核心难度从来不在正向流程，在异常处理——「人退到决策点」能否成立，
取决于事情不顺利时系统的行为是否仍然可预期（见 §6）。

---

## 2. 设计原则（先于一切结构）

| # | 原则 | 一句话 |
|---|------|--------|
| P1 | 内核极简 | 原 agent-pipe 收敛为 kernel，只接受「通用能力」类变更（见 §3.2） |
| P2 | artifact 优先于记忆 | agent 之间靠文件传递上下文，不靠会话历史 |
| P3 | 状态在服务侧 | 任何流程状态落 SQLite，不依赖模型记忆；义务与上限由代码 enforce，不靠 prompt 自觉或文档假设 |
| P4 | 容器只承诺最小公共语义 | WorkItem 容器不理解任何具体工作类型的流程 |
| P5 | 先具体后抽象 | 工作类型用代码实现，不做 DSL / 工作流引擎 |
| P6 | 渐进交付 | 按「轻 → 重」顺序落地工作类型，每一步都独立有用 |
| P7 | 异常路径与正向流程同等建模 | 回退、失败、变更、取消、监督、崩溃恢复是设计的一部分，不是实现时的补丁 |

---

## 3. 总体分层架构

```
┌─────────────────────────────────────────────────────┐
│  worktypes/        工作类型层（业务复杂度全部在这里）   │
│    requirement/    需求开发（Owner+Worker、契约、多仓） │
│    bugfix/         缺陷修复                           │
│    investigation/  线上反馈调查                        │
│    noop/           退化测试类型（容器回归夹具，M0）      │
├─────────────────────────────────────────────────────┤
│  workitems/        工作项容器层（通用骨架 + 持久化）    │
│    container       生命周期、assignment 树、事件、效果、 │
│    checkpoints     监督；人工确认点的通用机制            │
├──────────────────────────┬──────────────────────────┤
│  knowledge/              │  integrations/            │
│  知识层（repo 级 +        │  集成层（外部系统适配：     │
│  _system 拓扑知识，       │  Sentry、日志平台、监控；   │
│  所有工作类型共享）        │  凭证管理；只读/读写声明）   │
├──────────────────────────┴──────────────────────────┤
│  kernel/           内核层（≈ 现在的 agent-pipe）       │
│    channels/feishu  事件路由、卡片、流式更新            │
│    agents           ClaudeRunner / CodexRunner / Pool  │
│    store / lifecycle SQLite、PID 锁、备份              │
└─────────────────────────────────────────────────────┘
```

### 3.1 依赖规则（架构硬规则）

- 依赖方向严格单向向下：`worktypes → workitems / knowledge / integrations → kernel`
- **kernel 不 import 上面任何一层**。kernel 里不出现 WorkItem、工作类型、
  知识库、外部集成的业务概念
- worktypes 之间互不依赖；公共逻辑下沉到 workitems 层
- knowledge 不依赖 workitems（知识跟着 repo 走，不跟着工作项走）
- integrations 是无状态适配器集合：封装外部系统的认证与调用，
  不持有业务流程状态；worktypes 声明需要哪些工具，由装配层注入

### 3.2 kernel 的变更准入标准与能力盘点

kernel 不是字面冻结——本设计自身就需要它长出若干新能力。准入标准是：

- ✅ **接受「通用能力」类变更**：对「纯飞书桥」用户也有意义的能力
- ❌ **拒绝「业务概念」类变更**：WorkItem、phase、工作类型分支判断、
  契约、知识库——任何这些词出现在 kernel 代码里都是违规

按此标准盘点本设计需要的 kernel 通用能力（含现状核对）：

| 能力 | 现状 | 需要时间点 |
|---|---|---|
| 流式心跳回调 | **已具备**（ProgressCallbacks/onText，仅需多路复用给监督者） | M0 |
| 单实例保证（PID 锁） | **已具备但有过事故**（6329d35 修复双实例分流竞态）——单实例是 reducer 模型成立的前提（§4.3），列为 M0 验证点 | M0 |
| 交互卡片原语（按钮回调→分发） | 缺失 | M2 |
| thread 级路由与认领注册表（§9.2） | 缺失（现有 root_id→task 是 task 中心的） | M1a |
| runner 权限模式接口（permission profile） | **缺失且现状全开**：claude/runner.ts:161 `--dangerously-skip-permissions`、codex/runner.ts:122 `--dangerously-bypass-approvals-and-sandbox`。从全开翻转到受控是实质工作量 | **M1a（只读档，仅 Codex）**、M2（写档 + Claude） |
| per-run MCP/工具注入 | 缺失（runner 启动参数无任何 --mcp-config 类能力），集成层的硬依赖 | M1a |
| 运行调度/排队 | 缺失。现有 Pool 是热进程 LRU 驱逐（驱逐 idle runner，忙时无排队、可超 cap），不是并发调度器 | M1a 最小排队；M3 优先级 + Owner 预留槽（防优先级反转：池被 Worker 占满时 Owner 唤不醒，而 Owner 是解锁池的人） |
| 工作区供给（分支检出 / worktree 管理与回收） | 缺失（现有 workdir 仅 sandbox/project 两种模式） | M2 最小（分支检出）；M3 完整（worktree 并行隔离） |
| cron 触发器 | 缺失 | M4 |

### 3.3 反模式（明确不做）

- ❌ 在 kernel 的 event-router / commands 里写工作类型分支判断
- ❌ 在飞书卡片 value 里携带业务状态（只放 workitem_id + decision）
- ❌ 把对话历史当作 Owner / Worker 之间的接口
- ❌ 做配置驱动的通用工作流引擎 / DSL（见 P5）
- ❌ 拆成两个进程/项目（进程边界的接口税在单人项目不可接受；
  模块边界已保留未来抽出「纯桥」的选择权）
- ❌ worktypes 直接拿外部系统凭证裸调 API（必须经 integrations 适配器）
- ❌ 在代码里出现第二个叫 task 的概念（工作项子任务统一命名 assignment，§9.2）
- ❌ 用 `deadline = '2099-01-01'` 之类的值绕过等待约束（§4.4 的不变量是
  「必带到期动作」，不是「必带一个日期」）

---

## 4. WorkItem 容器模型（本文档核心）

> 回答关键疑虑：**一个容器 + 一套 SQLite 状态机，兼容得了这么多工作类型吗？**
> 答案是：能——前提是容器只做「双层状态机的外层」，内层完全让渡给工作类型。

### 4.1 双层状态机：容器管生死，类型管流程

**外层（容器拥有，对所有类型统一）**——它描述的不是「工作怎么做」，
而是「一件事存在的方式」：

```
open ──→ active ⇄ waiting(human | agent | timer) ──→ done | failed | cancelled
```

**status 是投影（rollup），不是权威值。** 并发场景会同时存在多种状态
（契约评审等人 + 未受影响的 Worker 继续跑）。权威状态分布在
assignment 状态和 open waits（§4.2）里，`status` 按固定优先级聚合出单值，
仅用于展示与查询，**不反向钳制执行**（等人评审不暂停无关 Worker）：

```
waiting(human) > active > waiting(agent) > waiting(timer)
（人是瓶颈，人的等待永远最显眼）
```

任何一种「工作」都满足这五条公共语义：

1. 它会被创建（有来源、有标题、有类型）
2. 它会推进（active）
3. 它可能停下来等什么（等待是显式对象，必带到期动作，§4.4）
4. 它会结束（成功 / 失败 / 取消）
5. 它会留下文件产物

**内层（工作类型拥有，容器只存不解释）**——`phase` 对容器是一个不透明字符串：

```
requirement:    理解 → 设计/契约 → 拆解 → 并行实现 → 集成验证 → 交付 → 沉淀
bugfix:         复现 → 定位 → 修复 → 验证 → 提交PR
investigation:  取证 → 分析 → 结论
```

容器永远不写 `if (type === 'requirement')`。**容器对 phase 的两条显式承诺**：
不假设单调前进（回退是普通转移，事件记 `phase_changed {from, to, reason}`）；
不解释 phase 含义（存、查、随事件更新，仅此而已）。

这就是兼容性的来源：**容器的承诺越少，能装的类型越多。**
容器只承诺：外层生命周期投影 + 事件日志 + assignment 树 + 显式等待 +
效果 outbox + artifact 索引 + 活性监督。这七样对任何工作形态都成立。

### 4.2 数据模型（SQLite，宏观 schema）

**独立 DB 文件**（`workitems.sqlite`），不与 kernel 的库共文件：两套
migration 体系不共管一个文件；跨层事务不需要（§9.2 决定了 assignment
不复用桥 task，两库之间没有需要原子性的写）。备份同时覆盖两个库（§10）。

```sql
workitems(                        -- 主表（避免 workitem_items 的口吃命名）
  id, type, title, status,        -- status = rollup 投影（§4.1）
  phase,                          -- 内层阶段，容器不解释
  source_json,                    -- 来源：飞书消息 / PRD / Sentry issue / 衍生
  dedupe_key,                     -- 外部触发幂等键，UNIQUE(type, dedupe_key)
  repos_json, context_json,
  created_at, updated_at
)

-- 子任务树（代码概念名 assignment，避免与 kernel task 同名，§9.2）
workitem_assignments(
  id, workitem_id, parent_id,
  repo, role,                     -- role: owner | worker | solo
  status, agent_session_id,       -- 复用 kernel 现有 resume 机制
  replaces_assignment_id,         -- superseded/重派链可导航（§6.2/§6.4）
  deadline_at, wallclock_cap_sec, retries,   -- 监督语义（§4.4）
  based_on_seq,                   -- 派发时的事件序号（过期决策防错，§4.3）
  brief_path, report_path
)

-- 显式等待对象：到期动作按 kind 区分（§4.4）
workitem_waits(
  id, workitem_id, kind,          -- human | agent | timer
  origin_assignment_id,           -- 可空：stalled 升级出的等待可溯源到源头
  reason, deadline_at, renewed_count, resolved_at
)

-- 效果 outbox：与状态转移同一事务落库（§4.3 规则 4）
workitem_effects(
  id, workitem_id, seq,           -- 由哪次转移声明
  kind, payload_json,             -- dispatch_assignment / request_checkpoint / ...
  status,                         -- pending | running | done | aborted
  created_at, updated_at
)

-- 事件日志：append-only。定调：**状态权威 + 事件作审计**，
-- 不做事件溯源——恢复读状态表 + outbox，事件用于审计与诊断
workitem_events(
  id, workitem_id, seq, kind, payload_json, created_at
)
```

**artifact 不进数据库，每个工作项一个独立 git 仓**（不是全局单仓：
避免多工作项并发提交争抢 index.lock；归档/删除一个工作项 = 移走一个目录）。
每次写 artifact 提交一次，契约这类「冻结」语义的文件免费获得版本历史和审计。

```
$DATA_DIR/workitems/<id>/        # 独立 git 仓
  brief.md            # 需求/缺陷/反馈的规范化描述
  journal.md          # Owner 休眠前写回：当前状态 / 下一步 / 未决问题（§5.3）
  decisions.md        # 过程中的关键决策（人确认过的）
  contract/           # （requirement 专用）接口契约，git 历史即版本
  assignments/<id>/   # 每个 assignment 的任务卡 + 报告
  report.md           # 最终交付摘要 / 调查结论
```

DB 只存索引和状态，文件系统存内容。人可以直接打开看；Owner 被唤醒时从
journal.md 入口重建心智模型；类型新增 artifact 不动 schema。

### 4.3 并发、效果与持久化模型（M0 实现约束）

**前提：单实例。** 单 reducer 的串行保证依赖单进程——双实例在本项目是
真实发生过的事故（6329d35：pid 锁竞态导致双实例分流）。PID 锁的正确性
是容器并发模型的地基，列为 M0 验证点，不是「应该没问题」。

四条规则：

1. **reducer 只做纯转移**。每个 workitem 一个单线程 reducer，事件按到达
   顺序逐个 apply，`seq` 单调分配。`onEvent` 返回「状态转移 + 效果声明」
   （派发 assignment、请求确认、设置等待），**效果由容器运行时在 reducer
   之外异步执行**——reducer 里永远没有 await agent
2. **agent 运行本身是效果，结论以新事件回流**。同一 workitem 同时最多
   **一个 Owner 运行**（单飞）；运行期间到达的事件排队，下次唤醒**批量带入**
   ——三个 Worker 先后完成，唤醒 Owner 一次而不是三次。这既是一致性保证，
   也是重建税的省钱点
3. **过期决策防错——机制归容器，判定归类型**。效果携带它基于的
   `based_on_seq`。结论回流时：
   - **容器做结构检查**（不涉语义）：决策引用的 assignment 是否已被
     supersede / 已终态、引用的 wait 是否已 resolve——结构性失效直接作废
   - **语义判定交给类型钩子** `isDecisionStale(decision, eventsSince)`：
     契约是否已变更、影响范围是否重叠，只有类型懂（P4：容器不解释语义）。
     seq 前进是常态，前进 ≠ 过期
   - **防颠簸**：丢弃-重唤醒连续 2 次后不再自动重试，创建 human wait
     升级给人——与 §6.1「连拒 2 次让位给对话」同一设计基因。被作废的
     只是「决定」，Worker 的代码产物（报告、分支）不丢
4. **效果与状态同事务落库（transactional outbox）**。reducer 提交状态
   转移时，声明的效果以 `pending` 写入 workitem_effects，**同一个 SQLite
   事务**。容器运行时从 outbox 取效果执行（pending → running → done）。
   崩溃恢复时从 outbox 重建在途效果，按效果类型执行恢复策略：
   - 幂等效果（更新卡片、发通知）：直接重跑
   - agent run 类（贵且不幂等）：`running` 的先查 agent_session_id 能否
     resume，能则续、不能则作废并重派**新 assignment**（replaces 链），
     不盲目重跑
   - 没有这张表，「状态权威 + 不可重放事件」在崩溃窗口下就是丢效果 /
     双跑效果二选一

### 4.4 容器的监督语义（watchdog 与等待）

Owner 不常驻，必须有人盯着「正在跑的东西」。监督分两层，**容器只承诺第一层**：

- **活性监督（容器承诺）**：
  - 真正的不变量：**没有无人过问的等待**——任何 wait 必带**到期动作**，
    且到期动作必然产生事件。按 kind 区分：
    - `human`：到期 → 提醒（锚点卡片置顶一次）+ **显式续期**
      （renewed_count + 事件留痕，续期是有记录的决定，不是默默延长）
    - `agent`：到期 → 走 stalled 流程（重试预算 → 升级）
    - `timer`：到期 → 触发即 resolve（这就是它存在的目的）
  - assignment 必须带 deadline_at **和 wallclock_cap_sec**——流式心跳
    只能发现「不动了」，发现不了「活着但空转烧 token 一整夜」，
    墙钟硬上限是最便宜的兜底，进 M0
  - 运行中的 assignment 以 runner 流式输出为心跳（kernel ProgressCallbacks
    已具备，多路复用即可）；超时未动 → `assignment_stalled` 事件，
    按重试预算（默认 1 次）重启或标记失败
  - 重试耗尽 → 创建 human wait（origin_assignment_id 溯源），飞书通知
- **语义监督（类型承诺，容器不做）**：Worker「跑偏」不是容器能判断的。
  语义校验发生在类型定义的验收点：报告提交时 Owner 校验、集成验证、
  人工 checkpoint。容器只保证「验收点会被到达」，不保证「内容正确」

**义务的代码化校验（P3 的延伸）**：Owner 的 journal.md 写回、Worker 的
结构化报告，不是 prompt 约定——类型代码在 assignment 收尾时校验文件
存在且非空，缺失即判该 assignment 失败。

### 4.5 WorkType 接口（代码实现，不是配置）

```ts
interface WorkType {
  id: string                              // 'requirement' | 'bugfix' | 'investigation' | 'noop'
  triggers: TriggerSpec                   // 斜杠命令 / 消息意图 / 外部事件(带幂等键) / 衍生
  initialPhase(item: WorkItem): string
  onEvent(item: WorkItem, ev: Event): Transition   // 纯转移 + 效果声明（§4.3）
  isDecisionStale(decision: Decision, eventsSince: Event[]): boolean  // 语义过期判定（§4.3 规则 3）
  topology(item: WorkItem): AgentTopology          // solo | owner-workers
  permissions: PermissionProfile          // readonly | write(repos)，由 kernel enforce（§3.2）
  checkpoints: CheckpointPolicy           // 哪些转移必须等人
  artifacts: ArtifactSpec                 // brief/report 模板与必备项（代码校验）
}
```

新增一个工作类型 = 新增一个实现此接口的目录，零改动容器和内核。
**noop 类型**（M0）：不跑真 agent 的退化实现，效果是可控延时与可注入
失败——专门用来打 §4.3/§4.4 的并发、outbox 恢复与监督路径，也是
此后容器改动的回归测试夹具。

### 4.6 兼容性压力测试

用三个已知类型 + 三个假想未来类型验证容器假设是否成立：

| 工作类型 | 外层生命周期 | 内层 phase | assignment 树 | artifact | 结论 |
|---|---|---|---|---|---|
| 需求开发 | ✓（human wait 用于契约评审，不钳制并行 Worker） | 7 阶段，可回退 | Owner + N Worker | 契约/PR 列表 | ✓ 最重，容器够用 |
| 缺陷修复 | ✓（human wait 用于方案确认） | 5 阶段 | solo（可升级） | 根因 + PR | ✓ |
| 线上调查 | ✓（无人工确认点） | 3 阶段 | solo 只读 | 调查报告 | ✓ |
| 技术调研（假想） | ✓ | 自定义 | solo 或并行多方案 | 调研报告 | ✓ phase 不透明，天然兼容 |
| 大型重构（假想） | ✓ | 自定义 | Owner + Worker | 迁移计划 + N PR | ✓ 同 requirement 拓扑 |
| 发布值守（假想） | ⚠ 无限期、周期性 | — | — | — | **不硬塞**：见 4.7 |

### 4.7 容器明确不覆盖什么（诚实的边界）

「无限期值守 / 周期巡检」类工作**不是 WorkItem**——它没有终态。处理方式：
kernel cron 触发器在每次触发时**创建一个有终态的 WorkItem 实例**（带幂等键），
如「6/11 早巡检」是一个 investigation 工作项。周期性是触发器的属性。

同理不覆盖：多租户、跨公司隔离、工作项之间的依赖编排。工作项之间唯一
支持的关系是「衍生」（investigation → bugfix，记在 source_json），
它是溯源信息，不是编排依赖。

---

## 5. 三种工作类型的宏观定义

### 5.1 investigation（线上反馈调查）—— 最先落地

- **触发**：`/probe <描述>`、转发一条线上反馈、（后续）Sentry webhook
- **流程**：取证（经 integrations 适配器拉日志/监控 + 代码只读检索）→ 分析 → 结论
- **拓扑与权限**：solo agent；`permissions: readonly`，**M1 只允许 Codex
  runner**（`--sandbox read-only` 是 OS 级沙箱且默认禁网——只读的威胁面
  不止文件系统：带生产凭证 + Bash + 网络的 agent，文件只读拦不住 curl
  外传数据或改外部系统状态）。Claude 路径（配置级 deny，强度较弱）
  推迟到 M2 与写权限档一起设计，届时权限面整体重做
- **产出**：`report.md`（现象、根因假设、证据、建议），回贴飞书
- **价值**：零风险先跑通「容器 + 知识层 + 集成层 + 权限 enforce + 飞书交互」整条骨架

### 5.2 bugfix（缺陷修复）

- **触发**：`/bug <描述>`，或由一次 investigation 的结论衍生而来
- **流程**：复现 → 定位 → **[checkpoint: 修复方案确认]** → 修复 → 验证 → PR
- **拓扑**：solo；跨仓缺陷升级为 1 Owner + 2 Worker；`permissions: write(repos)`
  （M2 档：kernel 工作区供给做分支检出，写权限限定仓库目录）
- **产出**：根因记录 + PR 链接

### 5.3 requirement（需求开发）—— 最重，最后落地

- **触发**：`/req <PRD 链接或描述>`
- **流程**：理解 → **[checkpoint: 需求确认]** → 设计/契约 →
  **[checkpoint: 契约评审]** → 拆解 → 并行实现 → 集成验证 →
  **[checkpoint: 验收]** → 交付 → 沉淀
  （checkpoint 被拒的回退见 §6.1，契约变更见 §6.4，取消见 §6.5）
- **拓扑**：1 Owner + N Worker
  - **Owner**：持有需求全貌，产出契约和任务卡，验收 Worker 报告，基本不写代码。
    事件驱动按需唤醒（单飞 + 批量带入事件，§4.3），从 journal.md 入口重建
    心智模型。**休眠写回义务由代码校验**（§4.4）：journal.md 记进行时，
    decisions.md 只记决策
  - **Worker**：单仓单 assignment 无状态。输入 = 任务卡 + 契约 + 该 repo 知识；
    输出 = 结构化报告（代码校验必备项）+ 代码分支。用完即弃
- **一致性机制**：**契约先行**。Owner 先冻结接口定义，backend / frontend
  Worker 各自对契约实现，集成验证校验两端符合契约。冻结 ≠ 不可变：
  变更走 §6.4 的一等流程
- **产出**：契约 + 设计决策 + N 个 PR（含发布顺序说明）+ 沉淀文档

---

## 6. 异常路径与监督（与正向流程同等重要）

### 6.1 checkpoint 被拒

拒绝不是异常，是评审的正常输出之一：

- 拒绝必须携带理由（卡片输入框或 thread 文本），写入事件和 decisions.md
- 类型的 onEvent 决定回退到哪个 phase（契约评审被拒 → 回「设计/契约」；
  验收被拒 → 回「集成验证」并派修复 assignment）。对容器只是一次普通
  `phase_changed`
- 同一 checkpoint 连续被拒 2 次 → 创建 human wait，系统不再自动重试
  ——反复被拒说明问题不在执行层，自治应让位给对话

### 6.2 Worker 失败 / 卡死 / 跑偏

按 §4.4 两层监督分工：

- **卡死/空转（活性）**：容器 watchdog。心跳超时或墙钟超限 →
  `assignment_stalled` → 按重试预算重启（新 assignment + 原任务卡 +
  失败摘要，`replaces_assignment_id` 链起来）→ 耗尽创建 human wait
- **失败（自报）**：Worker 报告声明失败及原因 → 唤醒 Owner 判断：
  换思路重派 / 拆小 / 升级给人。重派是**新 assignment 节点**，旧节点保留
  终态——assignment 树是 append-only 的事实记录
- **跑偏（语义）**：容器不判断。捕获点是类型验收点。设计立场：与其让系统
  猜「Worker 是否在做正确的事」，不如把任务卡写小写清楚，让跑偏在下一个
  验收点暴露——缩短任务粒度是对抗跑偏的主要手段，不是加监控

### 6.3 集成验证失败

requirement 最高频的非正常路径：

- 集成验证产出**差异报告**（哪端不符合契约 / 哪两端互不兼容）
- Owner 据此派**修复 assignment**（新 Worker + 差异报告 + 原任务卡），
  不复活原 Worker
- 修复循环上限 2 轮，超过创建 human wait——连续集成失败说明契约或拆解
  有问题，该人看了

### 6.4 契约变更（一等事件，不是例外）

契约冻结后发现错误是常态：

```
任何角色发现契约问题（Worker 报告 / 集成验证 / 人）
  → Owner 唤醒做影响分析：哪些 assignment 受影响、改动是否破坏性
  → 非破坏性（加字段、补说明）：契约新版本提交（git 即版本）。
    对进行中的受影响 Worker：runner 是单轮 spawn 模型，不存在运行中注入——
    真实机制是「本轮结束后带增量说明 resume」或「abort 后重派」，
    由 Owner 按该 assignment 的进度二选一
  → 破坏性（改语义、删接口）：重走 [checkpoint: 契约评审]，
    受影响 assignment 标记 superseded（replaces 链）、派新任务卡
  → 全程事件：contract_change_proposed / approved / applied
```

设计立场：契约的价值不在「一次就对」，在「任何时刻只有一个权威版本，
且变更有显式流程」。

### 6.5 人工取消（到达 cancelled 终态的路径）

外层状态机有 cancelled，必须有人能走到它：

- `/cancel`（在工作项 thread 内）→ 确认卡片（防误触）→ 容器执行收尾序列：
  abort 所有运行中 assignment（kernel 会话句柄）→ 回收工作区
  （分支保留、worktree 删除）→ Owner 最后唤醒一次写收尾 journal
  （已完成什么、半成品在哪个分支）→ `cancelled` 终态事件 → 锚点卡片更新
- 取消不删 artifact 仓——半途成果（已合的契约、已建的分支）是资产，
  收尾 journal 让未来「重启这个需求」有入口

---

## 7. 知识层（所有工作类型的公共地基）

### 7.1 为什么是独立一层

三种工作打的是同两个仓库。repo 的架构地图、分层约定、构建/测试命令、
常见坑——这些知识跟着 **repo** 走而不是跟着工作项走。没有这层，
每个工作项都要重新「读懂」仓库一遍。

### 7.2 形态（宏观）

```
$DATA_DIR/knowledge/            # 整体 git 化（回写审计与契约同理）
  _system/                      # 跨 repo 的系统拓扑知识：
    topology.md                 #   哪个前端调哪个后端、服务↔日志索引映射、
    conventions.md              #   契约存放约定——investigation 第一天就需要
  <repo_key>/
    meta.json                   # 生成时的 commit hash、时间（保鲜锚点）
    map.md                      # 架构地图：模块、分层、关键流程入口
    conventions.md              # 工程约定
    runbook.md                  # 怎么跑、怎么测、怎么发
    pitfalls.md                 # 踩过的坑（沉淀阶段回写）
```

- **建立**：每 repo 一次性索引任务生成初版；`_system/` 初版由人 + agent
  访谈式整理（它在任何单一 repo 里都挖不出来）
- **保鲜**：知识文件锚定生成时 commit hash；消费时检查 HEAD 偏离度，
  超阈值标记 stale 并触发重建任务
- **维护**：requirement / bugfix 沉淀阶段允许 Owner 回写（人在验收
  checkpoint 顺带审阅 diff，git 历史留审计）
- **消费**：任务卡组装时**选择性注入**——按 assignment 关联的 repo 和模块
  取相关片段，注入量有上限

---

## 8. 集成层（外部系统适配）

investigation 要拉日志和 Sentry——外部系统接入是 **M1 的阻塞项**：

- **职责**：封装外部系统的认证、调用、限流；把原始数据整形为 agent
  易消费的格式（日志查询结果 → 结构化摘要文件）
- **形态**：无状态适配器集合（`integrations/sentry/`、`integrations/logs/`…），
  每个适配器声明只读还是读写
- **消费方式**：worktype 声明需要的工具 → 经 kernel 的 per-run 工具注入
  能力（§3.2，MCP 或 CLI 形式）挂进 assignment 运行环境
- **凭证纪律与边界**：凭证只存在适配器配置里，不进 prompt、不进任务卡，
  **且适配器配置路径必须进 runner 沙箱的 deny 列表**——否则 agent 一条
  cat 就能读走。边界说明：适配器以 MCP server 进程形态运行时，**它本身
  在沙箱外持有凭证**——deny 列表防的是 agent 直读凭证文件，不防（也不
  需要防）适配器进程自己；agent 能通过适配器工具做什么，由适配器的
  只读/读写声明约束。这不是漏洞，是边界，写明以免验收时自我怀疑
- **M1 范围**：日志平台 + Sentry 的只读适配器，两个就够

---

## 9. 飞书交互形态

1. **一个工作项 = 一个飞书话题（消息 thread）**。创建时回一张「锚点卡片」，
   进度、checkpoint、结果都挂在 thread 下。thread 级路由按 §3.2 在 kernel
   新增认领注册表，不假设复用现有 task 路由
2. **checkpoint = 交互卡片**：卡片只带 `workitem_id + decision`，状态机在
   服务侧；按钮回调 3 秒内 toast，真实动作异步。拒绝必须可附理由。
   文本回复兜底
3. **进度可查**：`/status` 列出本人 open 工作项及 phase（M1b：锚点卡片
   会被群消息淹没，哪怕 3 个并行工作项也需要一眼总览，且它只是查一张表）
4. **人工介入通道**：任何时刻在 thread 里 @机器人发话，消息进入该工作项
   Owner（或 solo agent）的下一轮上下文

### 9.1 人的带宽（enforce 的约束，不是文档假设）

**单人串行决策是这个系统的吞吐瓶颈**：

- M3 前：**并行 open 工作项上限 3，由代码 enforce**（P3：第 4 个 `/req`
  直接拒绝并提示先收尾或排队，可配置）——写成「运行假设」迟早被违反
- 同一工作项的多个待决事项聚合为一张卡片，不连发多张
- human wait 到期 → 锚点卡片置顶提醒一次 + 显式续期留痕（§4.4），不轰炸
- 更精细的优先级/聚合策略推迟到真实痛点出现（开放问题 3）

### 9.2 与桥任务的共存（M1 上线即需要）

agent-pipe 现有的桥任务（task）继续原样服务「轻量直连」场景，
与工作项**并存且互不吞噬**：

- **概念隔离**：工作项的子任务在代码与 schema 中命名 **assignment**，
  一个代码库里不出现两个 task 概念
- **运行通道**：assignment 不复用桥 task，直接经 kernel 会话句柄驱动
  Runner Pool；流式卡片、resume 走 kernel 原语，不挂在桥 task 上
- **路由认领**：消息路由先查 kernel 的 thread 认领注册表——root 是工作项
  锚点的 thread 归 workitems 层；桥的四层 fallback（root_msg → 消息链 →
  current_task → 最近活跃任务，index.ts:392-425）**后两层不得认领已被
  工作项认领的 thread 消息**，反向同理
- **命令命名空间**：`/list /stop /rm` 只作用于桥任务；工作项用
  `/status /cancel /probe /bug /req`。两边互不可见，避免 `/rm` 误删
  半个需求

---

## 10. 恢复、可观测性与资源

- **状态权威性**：状态表 + 效果 outbox 是权威，事件是审计（§4.2/§4.3 定调，
  与 P3 一致，reducer 不背「必须可重放」的包袱）
- **重启恢复**：单实例锁确认 → 从 `workitems(status != 终态)` +
  assignment/waits 表重建待办 → **从 workitem_effects 重建在途效果**
  （按 §4.3 规则 4 的恢复策略处理 pending/running）→
  **事件 ↔ artifact 提交对账**：DB 与 git 是两个存储，崩溃可产生尾部
  不一致，以状态表为准、对 artifact 仓做一次校验提交
- **备份**：kernel 现有 backup 只备桥的 SQLite（已核实），扩展纳入
  `workitems.sqlite`、`workitems/` 与 `knowledge/`（git 仓直接打包或远端推送）
- **审计**：每工作项的事件序列回答「它经历了什么」；artifact git 历史
  回答「内容怎么变的」
- **资源与成本**：assignment 并发受 kernel 调度器全局上限 + 每工作项
  并发上限（默认 2）双重约束；Owner 运行走预留槽防优先级反转（§3.2）。
  token 预算暂不建模，事件里记录每 assignment 用量供观察（开放问题 4），
  但墙钟硬上限 M0 就有（§4.4）

---

## 11. 演进路线（每步独立有用，随时可停）

| 里程碑 | 交付 | 验证什么 |
|---|---|---|
| M0 | workitems 容器全套语义：workitem_* 表 + 单 reducer + 效果 outbox（同事务、崩溃恢复策略）+ 外层投影 + 按 kind 的等待到期动作 + watchdog（心跳 + 墙钟上限）+ 每工作项 git 仓 + **noop 测试类型**打穿以上全部路径 + PID 锁单实例验证 | 容器并发/效果/持久化语义，可被回归测试锁定 |
| M1a | kernel 通用能力：thread 认领路由 + per-run 工具注入 + 最小排队 + **只读权限档（Codex sandbox）**——桥用户可独立感知验证（注入工具、thread 路由对纯桥也有用） | kernel 四项新能力各自独立可验 |
| M1b | knowledge 初版（两 repo + _system）+ integrations 只读适配器（日志/Sentry，凭证路径入 deny）+ investigation 类型 + `/status` + 共存路由 | 端到端最轻类型；权限/工具/知识三条接缝真实有效 |
| M2 | kernel：卡片回调原语 + 写权限档（含 Claude 路径重新设计）+ 分支检出；bugfix 类型 + checkpoint 机制（含拒绝/回退）+ investigation→bugfix 衍生 | 人工确认点与异常路径；写代码的安全闭环 |
| M3 | kernel：调度优先级 + Owner 预留槽 + worktree 并行；requirement 类型：Owner/Worker 拓扑 + 契约 artifact + 契约变更流程 + isDecisionStale 实战 + 集成验证修复循环 + 取消收尾 | 「一人扛需求」核心命题（含 §6 全部异常路径） |
| M4 | 沉淀回写知识层 + 知识保鲜重建 + cron 触发器 + （可选）Sentry 触发器 | 飞轮：干活越多知识越厚 |

刻意排序：M0 用 noop 类型把容器语义打实，M1 只读零风险（且只读是被
enforce 的，不是被声称的），M2 引入写代码但单仓，M3 才上多仓并行。
每个里程碑结束都是可日常使用的系统。

---

## 12. 关键决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 集成 or 分开 | 单仓单进程，模块分层 | 进程边界接口税单人项目付不起；知识层必须共享；保留抽离「纯桥」期权 |
| 状态机形态 | 双层：容器管生死、类型管流程 | 容器最小承诺才能兼容异质类型；phase 不透明且不假设单调 |
| status 语义 | rollup 投影 + 固定优先级，不钳制执行 | 并发场景必然多状态共存；权威状态在 assignment/waits |
| 并发模型 | 单实例前提 + 每 workitem 单 reducer + 效果在外执行 + Owner 单飞批量唤醒 | 「单 reducer」只定事件不定效果会名存实亡；双实例是已发生过的事故（6329d35） |
| 效果持久化 | transactional outbox（workitem_effects 与转移同事务），按效果类型定恢复策略 | 否则崩溃窗口下丢效果或双跑 agent run 二选一；dedupe_key 只管外部触发管不了内部效果 |
| 过期决策判定 | 机制归容器（based_on_seq + 结构检查），语义归类型（isDecisionStale 钩子）；丢弃-重唤醒连续 2 次升级给人 | seq 前进是常态，语义兼容性只有类型懂（P4）；防活锁与 §6.1 同基因 |
| 等待到期 | 不变量 =「必带到期动作且到期必产生事件」，按 kind 区分（human 提醒+显式续期 / agent stalled / timer 触发） | 「必带 deadline」会教代码用 2099 撒谎；真正要的是没有无人过问的等待 |
| 事件日志定位 | 状态权威 + 事件审计，非事件溯源 | 省掉 reducer 可重放包袱，与 P3 一致 |
| kernel 治理 | 变更准入标准 + 能力盘点表（含现状核对） | 「对纯桥用户也有意义→进 kernel」可执行；与现状的距离显式化 |
| 权限 | worktype 声明 profile，kernel enforce；**M1 只读档仅 Codex**（OS 沙箱含禁网），Claude 推迟 M2 | 只读威胁面含网络出口，文件 deny 拦不住 curl 外传；配置级只读不对等就不混用 |
| 子任务命名 | assignment（表 workitem_assignments）；主表 workitems | 一个代码库两个 task 概念是长期税；workitem_items 口吃 |
| 存储布局 | 独立 workitems.sqlite；每工作项独立 git 仓；knowledge/ git 化 | 两套 migration 不共管一个文件；跨层无事务需求（§9.2）；免 index.lock 争抢 |
| 与桥任务关系 | 并存不复用；thread 认领注册表隔离路由；命令命名空间分离 | 桥的 fallback 后两层会吞工作项消息（已核实 index.ts:392-425） |
| Owner 形态 | 事件驱动唤醒 + journal.md 写回（代码校验） + 单飞批量 | journal 控制重建税；义务靠校验不靠自觉（P3） |
| 监督归属 | 容器管活性（到期动作/心跳/重试/墙钟上限），类型管语义 | 容器无法评判质量；墙钟上限兜住「活着但空转」 |
| 并行上限 | open 工作项 ≤ 3 由代码 enforce，可配置 | 「运行假设」迟早被违反；enforce 是一行代码（P3） |
| 周期性工作 | 触发器创建实例（UNIQUE(type, dedupe_key) 幂等），不做长寿工作项 | 保住「必有终态」语义；防重复建项 |
| 交互单位 | 一工作项一话题（thread），不建群 | 群不爆炸；thread 认领是 kernel 新通用能力 |

---

## 13. 开放问题

1. **拆解维度 × 分支策略（M3 前定，必须一起定）**：按 repo 拆则各 Worker
   各占一仓无冲突；按功能竖切则同仓多 Worker 并发写，必然要求 worktree
   隔离 + 串行合并。两者互相牵制，不能独立决策。M3 用 2-3 个真实需求
   实测后定，接口上两者都允许
2. **知识层冷启动质量与保鲜阈值（M2 前定）**：初版索引 agent 生成的
   map.md 质量是否够用；stale 阈值需实测校准
3. **checkpoint 人因策略（M3 前定）**：并行工作项上限放宽后的优先级、
   聚合、打扰节奏——真实痛点出现后再设计，之前维持 §9.1 的 enforce 上限
4. **token 预算模型（M3 后看）**：是否需要 workitem 级配额与熔断，
   先靠事件日志用量数据说话（墙钟上限已在 M0 兜底）
5. **多人扩展（远期）**：workitems 加 owner_user_id 即可起步，
   但 checkpoint 通知策略要重想
6. **集成验证的执行形态（M3 前定，与问题 1 同期）**：静态契约符合性校验
   （schema/类型/契约测试）还是真把两端跑起来联调？工作量差一个数量级。
   倾向 M3 先做静态符合性 + 契约测试，真实联调列为 M3 的可选增量
