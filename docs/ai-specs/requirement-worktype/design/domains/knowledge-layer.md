# Domain: knowledge-layer

> 仓库知识层 —— 新建 `src/knowledge/` 独立一层，让各端 worker「懂各自仓库」（架构 / 约定 / 构建测试命令 / 坑），不必每个工作项重新读懂仓库一遍。覆盖 **R16 全部 AC（5 条）**。
>
> 本域是本次唯一需要**前置改架构红线**的域：落地前必须先在 `tests/helpers/architecture.ts:109-114` 的 `layerFor` 加 `knowledge/` 分层分支（决策 D-16），否则 `src/knowledge/` 落 kernel 触发禁词检测、CI 直接红。

## 领域职责（负责什么 / 不负责什么）

**负责**：
- 维护「**每仓一份**」的知识库：`$DATA_DIR/knowledge/<repo_key>/{map,conventions,runbook,pitfalls}.md` + `_system/topology.md`，整体 git 化。
- **冷启索引**：每 repo 一次性索引任务生成知识初版，与 spec-design「代码考古」产物对接复用。
- **`_system/` 访谈式整理**：拓扑/跨仓关系由人 + agent 访谈式产出（非纯代码扫描）。
- **保鲜（staleness）**：知识文件锚定生成时 commit hash；消费时若仓库 HEAD 偏离超阈值，标 stale 触发重建。阈值经验默认（>200 commits 或 >30 天）可配，第 7 步校准。
- **选择性注入**：按 assignment 关联 repo 选出该 worker 需要的知识片段（**有上限**），喂给 `worker-runtime` 组装任务卡 prompt。

**不负责**：
- **不负责** worker run 的执行 / prompt 最终拼装 —— 本域只提供「按 repo 选片段 + 标 stale」的查询，prompt 落地在 `worker-runtime`（见交互章）。
- **不负责** worker 自测的实际执行 —— 本域只产出 runbook 文本（构建/测试命令来源），跑命令是 `worker-runtime` 的事；runbook 缺失/过期时由 `worker-runtime` 判「测试无法执行」降级举手。
- **不负责** workitem 生命周期 / phase 状态机 —— 知识**跟 repo 走、不跟工作项走**，本层**不依赖 workitems**（硬约束）。
- **不负责** 合同 / 契约结构 diff —— 那是 `contract-engine`；本域保鲜的 diff 是「仓库 git 历史偏离」维度，与合同结构 diff 是两回事（见核心概念）。
- **不负责** 真相裁决 / 决策台账 —— 知识是「过时即重建」的缓存性资产，非真相源。

## 核心概念（本域特有）

- **repo_key（仓库键）**：知识库的唯一组织维度。与合同 `providerRepo/consumerRepos`、worktree 切分、isDecisionStale 用的 **同一套 repo 维度**（决策 D-29）。归一函数复用 `contract-engine` 域的 `repoOf`（internal-apis §1.1），本域**只引用、不重新定义**。
- **四件知识文档**（每 repo 一份）：
  - `map.md` —— 仓库架构地图（模块/目录/关键入口/数据流），冷启索引主产物，与 spec-design 代码考古产物对接。
  - `conventions.md` —— 编码约定/命名/分层规则/PR 纪律。
  - `runbook.md` —— 构建/测试/起服务命令（**worker 自测命令的权威来源**，R11 自测硬门依赖它）。
  - `pitfalls.md` —— 已知坑/历史踩坑/反模式。
- **`_system/topology.md`**：跨仓拓扑（哪些仓组成一个系统、调用关系），**人 + agent 访谈式**产出，不是机械扫单仓能得到的。
- **freshness anchor（保鲜锚）**：每个 repo 知识库记录「生成时的 commit hash」。消费时取仓库当前 HEAD，算偏离（commits 数 / 天数），超阈值标 `stale`。
- **staleness 不等于合同 diff**：保鲜判 stale 看的是「**目标仓库 git 历史偏离**」（HEAD vs 生成时 hash），是纯天数/commit 数计量，**不**调用 `contractStructuralDiff`（那个比的是合同结构，跑在纯同步 reducer 域）。两者维度正交，不可混用。
- **选择性注入 + 上限（injection budget）**：组任务卡时不全塞知识，按 assignment 关联 repo 选片段、受一个上限约束（避免 prompt 膨胀 / 重建税）。

## 数据契约（TypeScript 接口）

> ⚠️ internal-apis.md 未为 knowledge 层单列章节（它独立于 workitems/worktypes/kernel 的改造清单）。本域特有契约在此定义；跨域共享 utility `repoOf` 引用 internal-apis §1.1，**不重复签名**。

```ts
// 位置：src/knowledge/types.ts（新建，独立层）
// 知识库索引清单（每 repo 一份，整体随 _system 一起 git 化）
interface RepoKnowledge {
  repoKey: string;                 // repo 维度键（复用 repoOf 归一，internal-apis §1.1）
  generatedAtCommit: string;       // 🔑 保鲜锚：生成知识时仓库的 commit hash
  generatedAt: number;             // 生成时间戳（保鲜按天数/commit 双维度算偏离）
  docs: {
    map: string;                   // map.md 相对路径
    conventions: string;
    runbook: string;               // worker 自测命令权威来源（R11 依赖）
    pitfalls: string;
  };
}

// 保鲜判定结果
interface FreshnessVerdict {
  repoKey: string;
  fresh: boolean;                  // false → 标 stale 触发重建
  commitsBehind: number;           // HEAD 相对 generatedAtCommit 的偏离
  daysSince: number;
  reason?: 'commits-exceeded' | 'days-exceeded' | 'missing' | 'never-indexed';
}

// 保鲜阈值（经验默认可配，第 7 步校准 —— DEFER-3）
interface FreshnessPolicy {
  maxCommitsBehind: number;        // 默认 200，可配（env）
  maxDaysSince: number;            // 默认 30，可配（env）
}

// 选择性注入：按 assignment 关联 repo 选片段，有上限
interface KnowledgeInjection {
  repoKey: string;
  sections: Array<{ doc: 'map' | 'conventions' | 'runbook' | 'pitfalls'; content: string }>;
  stale: boolean;                  // 注入时若 stale，片段照注 + 打 stale 标（让 worker/owner 知情）
  truncatedByBudget: boolean;      // 命中注入上限被截断
}
```

```ts
// 位置：src/knowledge/store.ts（新建，独立 git 仓 —— 与 ArtifactStore 同源「写即 commit」思路，但不同仓不同实例）
// 知识库整体 git 化：$DATA_DIR/knowledge/ 一个 git 仓，<repo_key>/ + _system/ 为子目录
interface KnowledgeStore {
  ensureRepo(): void;                                  // git init -b main（首次）
  writeDoc(repoKey: string, doc: string, content: string, message: string): void;  // 写即 commit
  readDoc(repoKey: string, doc: string): string | undefined;
  readManifest(repoKey: string): RepoKnowledge | undefined;
  listIndexedRepos(): string[];
  currentHeadOf(repoPath: string): string;            // 读目标仓 HEAD（child_process git，仅本层异步路径用）
}
```

> 保鲜判定 / 选择性注入是**纯计算**（给定 manifest + 当前 HEAD + policy），可做成纯函数 `assessFreshness(manifest, headInfo, policy): FreshnessVerdict` / `selectInjection(knowledge, budget): KnowledgeInjection`，便于单测。git/fs 副作用收敛在 `KnowledgeStore`。

## 涵盖的 AC

> R16 共 5 条 AC，全部归本域。逐条列为 Sensor2 校验依据。

- **R16.AC-1**：知识层建立时，在 `$DATA_DIR/knowledge/<repo_key>/{map,conventions,runbook,pitfalls}.md` + `_system/topology.md` **整体 git 化** —— 见「设计细节 §1 目录布局与 git 化」。
- **R16.AC-2**：worker 任务卡组装时，按 assignment 关联 repo **选择性注入**知识（有上限），不全塞 —— 见「设计细节 §4 选择性注入」+「与其他领域交互（→ worker-runtime）」。
- **R16.AC-3**：建立知识时，每 repo **一次性索引任务**生成初版（与 spec-design「代码考古」产物对接复用），`_system/` **人 + agent 访谈式**整理 —— 见「设计细节 §2 冷启索引」+「§3 _system 访谈式」。
- **R16.AC-4**（Edge）：知识文件**锚定生成时 commit hash**；消费时 HEAD **偏离超阈值** → 标 **stale 触发重建**（阈值经验默认可配，第 7 步校准）—— 见「设计细节 §5 保鲜」。
- **R16.AC-5**（Error / 前置硬约束）：IF `src/knowledge/` 含业务词 THEN **先在 `architecture.ts:109-114` 加 `knowledge/` 层分支**（否则落 kernel 触发禁词，R16 前置改动）—— 见「设计细节 §0 前置改动」+「边界约束」。

## 设计细节（按功能点分节）

### §0 前置改动：architecture.ts 加 knowledge/ 分层分支（硬前置，最先做）
- 现状：[layerFor / 红线词表](../codebase-findings.md#res-redlines) 的 `layerFor`（`architecture.ts:109-114`）只识别 `workitems/`→workitems、`worktypes/`→worktypes、根 `index.ts`/`config.ts`→kernel-exempt，**其它全判 kernel**。`src/knowledge/` 没有分支 → 落 kernel 分支 → 受 kernel 禁词（`workitem|workitems|assignment|worktype|phase`）约束。
- knowledge 代码**大概率含业务词**（map/conventions 描述仓库、可能出现 phase/worktype 等词），不加分支会被判 kernel 触发禁词，CI 红。
- 改动：在 `layerFor` 加一行 `if (relPath.startsWith('knowledge/')) return 'knowledge';`，并在 `Layer` 类型与红线断言里把 `knowledge` 当作「不查 kernel 禁词、但应有自己的纯度约束」的层处理。
- **必须先于任何 `src/knowledge/*.ts` 落地**（决策 D-16 / R16.AC-5）。

### §1 目录布局与整体 git 化（R16.AC-1）
- 布局：
  ```
  $DATA_DIR/knowledge/                ← 一个独立 git 仓（git init -b main）
    <repo_key>/
      map.md  conventions.md  runbook.md  pitfalls.md
    <repo_key2>/ ...
    _system/
      topology.md
  ```
- git 化思路与 [ArtifactStore](../codebase-findings.md#res-artifactstore) 同源（写即 `git add -A && git commit`，"版本史免费拿"），但**是另一个 git 仓、另一个 store 实例**：ArtifactStore 是「每 workitem 一仓」、本域是「knowledge 全局一仓」。**不复用 ArtifactStore 实例**（它锚定 workitemId，本域跟 repo 走、不跟 workitem 走）。
- 整体一仓的好处：`_system/topology.md` 跨仓、HEAD/版本史统一；知识重建产生有意义的 diff 历史。

### §2 冷启索引：一次性索引任务生成初版（R16.AC-3）
- 每 repo 一个**一次性索引任务**（managed run），产出 map/conventions/runbook/pitfalls 初版。
- **与 spec-design「代码考古」产物对接复用**：spec-design 流程（R15 / design-phase 域）会对涉及仓库做代码考古，产出 `codebase-findings.md` 类的精确 file:line + 模块梳理。本域索引任务**优先消费这份考古产物**作为 map.md 初版骨架（避免重复读懂仓库），考古缺失才独立扫。
- 索引任务记录 `generatedAtCommit`（当时仓库 HEAD）作为保鲜锚（§5）。
- 索引是异步任务（git/fs/run），落 `src/knowledge/` 的**异步路径**（本层非纯同步 worktype，可用 child_process/fs —— 见边界约束的纯度说明）。

### §3 _system 访谈式整理（R16.AC-3）
- `_system/topology.md`（跨仓拓扑）**不是单仓机械扫能得到**，需 **人 + agent 访谈式**：agent 提问（这几个仓怎么组成一个系统、谁调谁、部署关系），人补关键事实，沉淀成 topology.md。
- 与单仓四件文档分流：四件可由索引任务自动初版；`_system/` 需访谈交互，可挂工作台/飞书的一次性对话（非每需求标配，repo 级一次性）。

### §4 选择性注入（有上限）（R16.AC-2）
- 入口：`worker-runtime` 组 `composeWorkerPrompt` 时，按该 assignment 关联的 repo（`repoOf`，§1.1）向本域要知识片段。
- 本域返回 `KnowledgeInjection`：按 repo 选片段、受 **injection budget 上限**约束（截断时 `truncatedByBudget:true`），**不全塞**。
- 注入优先级建议：runbook（自测命令刚需）> pitfalls（避坑）> conventions > map（map 通常大，按预算截断）。
- 若该 repo 知识 stale（§5），片段照注但打 `stale` 标，让 worker/owner 知情（知识可能过时）。

### §5 保鲜：锚 commit hash + HEAD 偏离阈值 → stale 重建（R16.AC-4）
- 锚：每 repo manifest 记 `generatedAtCommit` + `generatedAt`。
- 判定（消费时）：读目标仓当前 HEAD，算 `commitsBehind`（HEAD 相对锚 commit 的提交数）+ `daysSince`；任一超 `FreshnessPolicy` 阈值 → `fresh:false`。
- 阈值：经验默认 `maxCommitsBehind=200` / `maxDaysSince=30`，**可配**（env，如 `KNOWLEDGE_STALE_MAX_COMMITS` / `KNOWLEDGE_STALE_MAX_DAYS`）。
- stale 处置：触发**重建**（重跑索引任务，更新四件文档 + 刷新 `generatedAtCommit`）；重建期间注入仍可用旧知识 + stale 标（不阻塞 worker）。
- **DEFER-3（诚实声明，决策 DEFER-3）**：单样本无法校准统计阈值。首版按经验默认上线、靠生产埋点持续校准；第 7 步只验**二元**目标：① 保鲜埋点管道通 ② map.md 初版能让 worker 跑通一个 repo 的活。**不假装一次端到端能定阈值**。

## 与其他领域的交互（调用方向）

| 方向 | 对端域 | 交互内容 |
|------|--------|---------|
| 被调用 | **worker-runtime** | `worker-runtime` 组 `composeWorkerPrompt` 时调本域选择性注入（§4）拿该 repo 知识片段；worker 自测命令来源于本域 `runbook.md`（R11 自测硬门 / 测试无法执行降级依赖它）。 |
| 引用（不调用） | **contract-engine** | 复用其 `repoOf`（internal-apis §1.1）做 repo_key 归一。保鲜 diff 与合同 `contractStructuralDiff` 是不同维度，**不调用**后者。 |
| 对接复用 | **design-phase（spec-design）** | 冷启索引（§2）优先消费 spec-design 代码考古产物作 map.md 初版骨架。 |
| 不依赖 | **container-concurrency / data-model / checkpoint-gate** | 本层**不依赖 workitems**（知识跟 repo 走，不跟工作项走）。索引/保鲜的触发可由 worktype/工作台编排，但本层 API 不引用 workitem 概念。 |

> 依赖图（design/index.md）：`knowledge-layer → worker-runtime`（单向被消费）。本域是叶子层，无下游业务依赖。

## 相关决策

- **D-08 知识层一次性索引 + 保鲜阈值经验默认可配**：本域主决策 —— 每 repo 一次性索引（对接 spec-design 考古）、`_system/` 访谈式、保鲜锚 commit hash + 超阈值重建、阈值可配第 7 步校准、选择性注入有上限。
- **D-16 知识层前置改 architecture.ts 加 knowledge/ 分支**：硬前置（§0 / R16.AC-5）—— 不加分支 knowledge 落 kernel 触发禁词；knowledge 不依赖 workitems。
- **D-29 合同接口登记 providerRepo/consumerRepos（统一 repo 维度）**：本域 repo_key 与合同/worktree/stale 同一 repo 维度，复用 `repoOf`。
- **DEFER-3（R16）知识层冷启质量 / 保鲜阈值**：诚实声明阈值靠生产埋点校准，第 7 步只验二元（埋点通 + map 初版可用），不靠单样本定阈值。

## 引用的内部 API

- **跨域共享 utility `repoOf(spec | assignment): string`** —— 详见 internal-apis.md §1.1（归属 contract-engine 域，本域只引用做 repo_key 归一，不重定义）。
- 本域**未在 internal-apis.md 单列章节**（独立于 workitems/worktypes/kernel 三层改造清单）；本域特有契约（`RepoKnowledge` / `FreshnessVerdict` / `FreshnessPolicy` / `KnowledgeInjection` / `KnowledgeStore`）在本文件「数据契约」章定义，执行 skill 以此为准。
- 前置改动点 `layerFor`（`architecture.ts:109-114`）见 [红线词表 / layerFor](../codebase-findings.md#res-redlines)。
- git 化「写即 commit」参照思路见 [ArtifactStore](../codebase-findings.md#res-artifactstore)（**仅参照思路，不复用其实例**）。

## 边界约束（Must / Never）

**Must**：
- knowledge **独立一层**、**不依赖 workitems**（知识跟 repo 走，不跟工作项走）。
- 落地前**先**在 `architecture.ts:109-114` 的 `layerFor` 加 `knowledge/` 分层分支（决策 D-16，硬前置）。
- 选择性注入**有上限**（injection budget），不全塞。
- 保鲜**锚定生成时 commit hash**，消费时 HEAD 偏离超阈值标 stale 触发重建；阈值经验默认**可配**。
- repo_key 用与合同/worktree/stale **同一套 repo 维度**（复用 `repoOf`，internal-apis §1.1）。
- 整体 git 化（四件文档 + `_system/topology.md` 一个独立 git 仓）。
- 若本层任何代码进入「纯同步约束」范围（理论上本层是异步层、不受 worktype 纯度约束），git/fs/child_process 副作用须收敛在 store/索引任务，保鲜/注入的纯计算部分独立可单测。

**Never**：
- **不全塞**知识（违背选择性注入上限）。
- **不让 knowledge 依赖 workitems**（不 import workitems 概念、不引用 workitemId/assignment 当组织维度）。
- **不**在加 `knowledge/` 分层分支前落 `src/knowledge/` 业务代码（会触 kernel 禁词，CI 红）。
- **不**复用 ArtifactStore 实例（它锚 workitemId，本域锚 repo_key）。
- **不**把保鲜的「git 历史偏离」与合同 `contractStructuralDiff`「结构 diff」混用（两个不同维度）。
- **不**把 knowledge 当真相源 —— 它是「过时即重建」的缓存性资产。
- 用业务端名（"后端/前端"）当 repo 维度键（统一用 repo_key，D-29）。

## 可能的实现提示（可选）

- 本层是**异步层**（不是纯同步 worktype）：索引任务跑 child_process（git clone/扫码/起 run）、保鲜读 git HEAD、注入读 md 文件，都是允许的副作用 —— 与 `worktypes/*/index.ts` 的纯同步禁令**不冲突**（那约束只管 worktype 层）。但 `architecture.ts` 加 `knowledge/` 分支时，建议给本层一个**自己的纯度约束**（如禁直接 import workitems，固化「不依赖 workitems」）。
- 索引任务可复用 [createAgentRunHandler / runAgent](../codebase-findings.md#res-createagentrunhandler) 的 run 骨架跑一个 readonly 考古 run（索引是只读理解，不写代码），cwd 指目标仓，prompt 喂「产出 map/conventions/runbook/pitfalls」+ spec-design 考古产物。
- 若新增持久化（knowledge git 仓）需纳入日备份：挂 [BackupJob](../codebase-findings.md#res-commandhandler)（R24.AC-5「引入新持久化文件/库挂 BackupJob」对齐）。
- `_system/topology.md` 访谈式可借工作台一次性对话或飞书 thread，repo 级一次性、非每需求标配。
- 保鲜阈值埋点：每次注入记录 `commitsBehind/daysSince/是否触发重建`，作为 DEFER-3 生产校准的数据源。
