# requirement worktype 设计 · 决策待审

日期：2026-06-18
状态：**✅ 已审核通过**（维护者 2026-06-22 表示"决策都问题不大、可以接受"，全部 31 决策 + 4 DEFER + 对抗审查新增 D-27/D-30 均采纳，设计转可执行）
配套产物：完整设计在 `docs/ai-specs/requirement-worktype/`（qa / codebase-findings / requirements / decisions / design-overview / design-detail / design/ + 对抗审查）

---

## 0. 这轮我干了什么（一句话）

把「实现 requirement worktype（一次到位）」当成一个需求，**跑了完整 spec-design Full 流程**：先用 8 个并行考古员把《实现总纲》的 **41 条 file:line 断言逐条核验**（0 条 refuted，仅 5 处行号/措辞漂移、实质全部成立——总纲与代码近零漂移），再据实证产出全套设计文档 + 决策台账 + 对抗审查 + 细化的交互原型。**全程只设计、不改一行产品代码。**

下面是我替你拍的决策。**先扫第 1 节的高影响表，有异议的看展开；没异议就当默认通过。**

---

## 1. 高影响决策速览（最该你复核的 8 条）

| # | 决策点 | 我拍的 | 你可能想改的方向 | 改了的影响面 |
|---|---|---|---|---|
| D-01 | 拆解维度 | **只做"按仓拆"**，竖切不做但接口不堵死 | 本次就支持同仓竖切 | 大：要 worktree 串行合并，工作量翻倍 |
| D-02 | 灯②两拍怎么落 | **拆 phase**（7 phase，快/慢拍各挂边界） | checkpoint 改独立 id 不绑 phase | 中：换一套 checkpoint 机制 |
| D-04 | Claude 写档强度 | **纵深三层**：--add-dir + PreToolUse hook + worktree（不追求拦死 Bash） | 上 OS 沙箱真拦死 / 或接受更松 | 大：沙箱是 investigation/Codex 的事，写档重做 |
| D-09 | worker 崩溃恢复 | **不照搬 probe**：查 session + worktree 脏否，脏则重置基线再重派 | 简单 redispatch（接受脏 worktree 风险） | 中：影响恢复正确性 |
| D-11 | 修复/返工循环计数 | **独立计数**，不复用 assignment.retries（默认1，全局共用） | 复用现有 retry 预算 | 小：但会与 stall 重试串味 |
| D-13 | HTML 工作台形态 | **轻量 HTTP + 多页拆分 + 多 agent 走查交互** | 单 HTML / 或先不做工作台只用飞书 | 中：交互工程量 |
| D-14 | 开 MR/上线 | **必须人亲手点**，系统只到"分支就绪+MR草稿" | 允许自动开 MR | 高：ai-sentinel 血泪，自动开 MR 误触发飞书研发节点 |
| D-18 | Owner 预留槽 | **改 pool Semaphore** 加优先级（§19，独立于写权限那条） | 不做、接受偶发 owner 饿死 | 中：多 worker 占满槽时 owner 唤不醒 |

> 其余决策（D-03/05/06/07/08/10/12/15/16/17/19~26）多是代码考古实证驱动的"唯一正确解"或低风险默认，详见 `docs/ai-specs/requirement-worktype/decisions.md`。

## 1.5 对抗审查 + UX 走查后新增/加固的待审点

设计产出后我又跑了两轮独立质检，**结论是设计被显著加固、未被推翻**：

**🔴 对抗审查**（独立红队挑 requirements 骨架 + decisions 台账）：**23 条挑战全部接受并回补**，其中 5 条阻塞催生了 2 个新的高影响决策，**也请你复核**：

| # | 决策点 | 我拍的 | 为什么是阻塞级 |
|---|---|---|---|
| D-27 | worktree 生命周期子系统 | **新立一个子系统**（创建/定位/脏检测/重置/回收），不复用 ArtifactStore | 红队发现 D-09/D-20 依赖的"worktree 重置回基线"基建**全仓零代码**，且"重置错一次=工人代码产出被销毁"是改盘高危操作 |
| D-30 | 补 runner onSession 回调 | **补 onSession 让 session id 崩溃前落库**（否则 worker 恢复退化为"重置+全量重派"单分支） | 红队发现 D-09 的 resume 分支依赖的 session id 在崩溃场景**几乎必然没落库**（run-handler.ts:74-77 注释自陈），resume 是死代码除非补 onSession |

其余阻塞已就地加固（写档 fail-closed 探针防静默放飞 / isDecisionStale 数据流前提固化结构指纹 / checkpoint 拦截改 worktype 侧不碰容器 phase / owner 预留槽防二级死锁），详见 `adversarial-review-gate3.md` / `gate5.md`。

**🎨 UX 走查**（6 用户人格走查交互原型）：**53 条 finding（6 阻塞）**，已驱动 v2 多文件原型。最该你知道的：原型 v1 把"破坏性契约大改"渲染成和"传分还是元"一样的轻量卡（会诱导轻率拍板触发返工）、灯②快慢两拍坍塌成一锅烩、飞书侧交互一屏未画、无 /cancel 入口。v2 已逐条修，结论见 `docs/design/prototype/UX-走查结论.md`，原型见 `prototype/`。

---

## 2. 高影响决策展开（带理由 + 我为什么这么选）

### D-01 只做「按仓拆」🔶
- **我选**：一仓一 worker、仓内不再拆；竖切（同仓多 worker）不做，但 `AssignmentSpec`/worktree 接口不堵死。
- **为什么**："踩不到一起"靠各占一仓（物理隔离）是并行最省心的一致性保证；竖切要 worktree 隔离 + 串行合并，是另一个量级。总纲§5/§23① 也定调按仓拆。
- **你若想改**：要本次就支持竖切 → 得设计同仓并发写的 worktree 隔离 + 串行合并，工作量翻倍，建议仍留后续。

### D-02 灯②拆 phase🔶
- **我选**：7 phase = `理解→合同→详设→拆解→并行实现→集成验证→交付/沉淀`，灯②的快审合同/慢审详设各挂一个 phase 边界 checkpoint。
- **为什么**：复用现成 `checkpoints.requiredBefore: string[]`（phase 名列表），不引入"独立 checkpoint id"新概念。总纲§6.2 也倾向拆 phase。
- **你若想改**：用独立 checkpoint id（不绑 phase）→ 更灵活但新增一套机制，复杂度更高。

### D-04 写档纵深三层🔶（这条我最想你看）
- **我选**：write 档 = `--add-dir <worktree>`（软）+ **PreToolUse hook 校验路径**（硬）+ 专属 worktree；**不追求拦死 Bash 的所有越界写**。
- **为什么（关键考古实证）**：① `--add-dir` 是**放宽**可访问目录、**不是收窄写入**，无法限定写到哪；② 现 readonly 靠 `--disallowedTools` 是工具级、拦不住 `Bash('echo>越界')`/curl；③ 唯一能路径级硬拦的是 PreToolUse hook，但**项目当前没有 hook/settings 注入基建**（要新建）；④ write 档**绝不能**退化成 agents 的 `full`（=`--dangerously-skip-permissions` 无限制）。
- **残余风险（诚实说）**：hook 能拦 Write/Edit 的 path 和直白的 `echo>path`，但 Bash 里变量拼接路径（`VAR=x; echo>$VAR`）有绕过面。我标成"尽力拦 + 写明残余 + 验证用例"，没假装拦死。
- **你若想改**：要真拦死 → 得上 OS 沙箱（总纲§28 已把强沙箱判给 investigation/Codex，写档明确不依赖沙箱）；或你能接受更松（只 prompt 自律），那 hook 都可省。**这条取决于你对"worker 写代码的安全边界"有多紧张。**

### D-09 worker 崩溃恢复🔶
- **我选**：worker run 崩溃恢复查 `agentSessionId` 可续 + worktree 是否脏；能续 resume，不能则**先重置/丢弃 worktree 半成品回干净基线再重派**。
- **为什么**：考古发现 probe 的 `canResume:()=>false`（崩溃直接 redispatch）是因为它 readonly 幂等；worker write **已改盘（非幂等）**，盲目 redispatch 会在脏 worktree 上重复改动。
- **你若想改**：接受"脏 worktree 上重跑"的风险换简单实现 → 不推荐，会产生重复/冲突的代码改动。

### D-11 修复循环独立计数🔶
- **我选**：集成验证修复（2 轮）、契约反复改（2-3 次举手）各用独立计数，不复用 `assignment.retries`。
- **为什么**：考古发现 `retryBudget` 默认 1、全局共用于 watchdog 卡死重启。两种"重试"语义不同（活性卡死 vs 语义返工），混用会让一处调参误伤另一处。
- **你若想改**：复用 retries 省一个字段 → 不推荐，串味。

### D-13 工作台多页 + 多 agent 走查🔶（呼应你的补充）
- **我选**：轻量 HTTP（Node 自带、不引框架）+ 原型从单 HTML 扩成多页（看板/工作台/审设计）+ 交互细化阶段**派多个子 agent 对抗式走查找低级/不易用场景**。
- **为什么**：这正是你临走补充的指示。读视图复用现成 SQLite + artifact；多页让每个交互场景独立打磨。
- **状态**：原型细化 + UX 走查我放在产物收尾阶段做（见第 4 节产物清单），走查结论会单独成文给你。

### D-14 开 MR 人点🔶
- **我选**：写码/提交自分支自动；开 MR/上线**人亲手点**，系统只到"分支就绪 + MR 草稿/发布顺序"。
- **为什么**：铁律5 + ai-sentinel 血泪（AI 自主开 MR 会误触发飞书研发任务节点）。
- **你若想改**：基本不建议改，这是项目历史踩过的坑。

### D-18 Owner 预留槽🔶
- **我选**：改 `pool.ts` 的 Semaphore 加优先级/预留槽，让 owner 唤醒不被 worker 占满的槽饿死。
- **为什么（考古实证）**：pool 现在是单一无差别 FIFO 池（WI-C 的 Semaphore），worker 占满槽 → owner 排队尾 → 优先级反转确凿。注意这是总纲§19 的事、**独立于**§14 写权限（§14⑤说的"不用改 pool"只指写权限那条，别混）。
- **你若想改**：不做 → 多 worker 把槽占满时 owner 唤不醒（它恰是解锁池的人），不推荐省。

---

## 3. 还需你/外部确认才能定死的（DEFER，给了判据先往下走）

| # | 悬而未决 | 我先按什么走 | 何时定死 |
|---|---|---|---|
| DEFER-1 | 写档对 Bash 路径的拦截强度 | hook 尽力拦 + 写明残余风险 + 验证用例 | R04 详设给可验证方案；不追求拦死 |
| DEFER-2 | Owner 预留槽大小 | 默认预留 1 槽（owner 单飞理论够），可配 | 第 7 步多 worker 实测 |
| DEFER-3 | 知识层冷启质量/保鲜阈值 | 经验默认（>200 commits / >30 天）可配 | 第 7 步端到端记偏离度校准 |
| DEFER-4 | Owner 重建税（token/判断衰减） | 结构化快照为权威 + 埋点观测 | 第 7 步埋点数据后定增量策略 |

---

## 4. 产物清单（你回来按这个顺序看）

1. **本文档** — 决策速览（你现在在看）。
2. `docs/ai-specs/requirement-worktype/design-overview.md` — **设计大纲**（3 分钟看懂做什么/怎么拆/有什么坑，去编号化说人话）。← 建议第二个看
3. `design-detail.md` — **设计详览**（逐条挑刺的业务设计定稿）。
4. `decisions.md` — 26 条决策 + 4 条 DEFER 全台账。
5. `requirements.md` — 24 个 Requirement（User Story + EARS AC）。
6. `codebase-findings.md` — 代码考古 SSOT（41 断言核验 + 可复用资源精确 file:line）。
7. `qa.md` — 需求理解 + 我替你答的 14 个关键疑问。
8. `design/` — AI 装配（index + internal-apis + domains，给执行 skill 读）。
9. `adversarial-review-*.md` — 对抗审查（独立子 Agent 挑刺 + 我的逐条回应）。
10. `prototype-req-flow-v2/`（或更新后的原型）+ UX 走查结论 — 交互细化产物。

> **如何否决我的某条决策**：直接在本文档对应行批注，或改 `decisions.md` 对应 D-xx；被改的决策会牵动 requirements/design 的哪些条，每条决策的"影响范围"字段已标好，可顺藤回改。
