# Domain: data-model

> 层：workitems（容器层，守红线·不解释业务）。这是整个 requirement 落地的**基础依赖**（表/事件/config/查询），其它 9 个域都从这里取砖。先落本域，再落 container-concurrency / checkpoint-gate / contract-engine。
> 给执行 skill 消费。引用现有代码资源用 `../codebase-findings.md#res-xxx` 锚点；引用新增符号给 `internal-apis.md §x.y` 章节号，不就地写签名。

## 领域职责（负责什么 / 不负责什么）

**负责**：
- **复用五表**承载 requirement 全部新语义，零新建库/表——新事件 kind 写进 `workitem_events.kind`（容器不解释、DB 无 CHECK），新列走 `user_version<3` 迁移段。
- **启用既有死列**：`workitem_assignments.role`（'owner'/'worker'）与 `parent_id`（self-ref FK）从「schema 有列、reducer 恒写 null/从不读」变成「投入写入与消费」。
- **数据增量声明**：`AssignmentSpec.parentAssignmentId`（internal-apis §2.1）、config 新增 `maxWorkersPerItem`（默认 2）+ env（res-config）。
- **artifact 仓布局约定**：`brief / journal（校验）/ decisions / contract / contract-tests / design / assignments/<id>/{brief,report} / report`——worktype 约定，ArtifactStore 不强制（res-artifactstore）。
- **per-assignment 并发恢复查询**（internal-apis §2.2 / §3.1）：列出某 workitem 全部 running effect 并**按 assignment 逐个恢复**的查询砖 + 必要索引——支撑 R23 的「同 workitem 多 worker 全部恢复」。
- **新持久化挂 BackupJob**：若 requirement 引入新持久化文件/库（如 knowledge 库），纳入日备份。
- **一致性约束的数据真相源**：新事件 kind 清单是 `anchorAction` 映射的**唯一权威**，CI 断言两份清单不漂移。

**不负责**（划清边界，避免越权到其它域）：
- 不负责单飞门按 role 分流的转移逻辑 / inflight 键改造的执行（那是 [container-concurrency]，本域只提供它消费的查询砖 `countRunningWorkers` 与 per-assignment 恢复查询）。
- 不负责事件 kind 的**语义解释**（在 worktype `onEvent` switch 里，本域只保证 DB 能存、容器不解释）。
- 不负责 `anchorAction` 映射本身的实现（那是 [workbench]/feishu，本域只声明权威清单 + CI 不漂移断言）。
- 不负责合同/契约的结构定义（`ContractSnapshot` 等是 [contract-engine]，本域不碰）。

## 核心概念（本域特有）

- **五表复用**：`workitems / workitem_assignments / workitem_waits / workitem_effects / workitem_events`（res-five-tables）。requirement 的 7 phase / 4 灯 / Owner+Worker / 合同 / 集成验证全部用这五表 + 增量字段承载，**不重起炉灶**。
- **DB 无 CHECK 的事件 kind**：`workitem_events.kind` 是裸 `TEXT NOT NULL`（无 CHECK 约束），新事件 kind 直接写、容器不解释——append-only 触发器（`no_update`/`no_delete`）让 checkpoint/contract 决策天然有审计性。
- **死列复活**：`role` 列有 CHECK `IN ('owner','worker','solo')` 但此前只用 'solo'；`parent_id` 有 self-ref FK 但 reducer 恒写 null（res-five-tables / D-19）。本次让两列**投入使用**。
- **迁移版本递增**：当前最高 `user_version = 2`（v1 建表 + v2 watchdog `idx_assignments_running` 索引）。R24 新列/新索引走 `version < 3` 新迁移段（store.ts 既有 `version < N` 模式，res-five-tables）。
- **per-assignment 恢复视图**：现有 `listInflightEffects` 是 workitem 粒度的「全部在途 effect」列表；本域提供/扩展为「按 assignment 分组、逐个恢复」的消费视图，配 effect 上 assignment 维度索引。

## 数据契约（TypeScript 接口，引用 internal-apis 不重复写签名）

| 符号 | 章节 | 一句话 |
|------|------|--------|
| `AssignmentSpec.parentAssignmentId?` | internal-apis §2.1 | 启用 Owner→Worker 父子链，替换 reducer.ts:616 恒写 null |
| `countRunningWorkers(workitemId): number` | internal-apis §2.2 | 数 DB 内 `status='running' && role='worker'` 的 assignment（apply 内强一致） |
| per-assignment 恢复查询（inflight 键 assignmentId + 早退降粒度） | internal-apis §3.1 / §3.2 | 列某 workitem 全部 running effect 按 assignment 逐个恢复 |
| 事件 kind 权威清单（`RequirementEventKind`） | internal-apis §7 | 11 个新 kind，anchorAction 映射的唯一权威 |
| config `maxWorkersPerItem`（默认 2）+ `WORKITEMS_MAX_WORKERS_PER_ITEM` | 见下「设计细节 §config」（config.ts 新增字段，无独立 internal-apis 章节） | worker 并发上限 |

> `ContractSnapshot` / `ContractDiff` / `repoOf` 等属 [contract-engine]，本域只在「父子链消费」处引用 repo 维度概念，不在此定义（internal-apis §1.1/§6）。

## 涵盖的 AC

> 这是 Sensor2 校验依据。R24 全部 7 条 AC（含回补 AC6/AC7）+ 支撑 R23 的并发恢复查询。

**R24 数据模型增量 + config**：
- **R24.AC-1**：新增事件 kind（`checkpoint_reached/checkpoint_decision/contract_frozen/contract_patched/contract_change_proposed/approved/applied/worker_report/integration_check_passed/failed/design_ready`）写进 `workitem_events.kind`，容器不解释、DB 无 CHECK。
- **R24.AC-2**：assignment 投入使用 `role='owner'/'worker'` + `parent_id`（现 schema 有列，启用写入消费）。
- **R24.AC-3**：artifact 仓布局按 `brief.md / journal.md（校验）/ decisions.md / contract/ / design/ / assignments/<id>/{brief,report}.md / report.md` 组织（worktype 约定，ArtifactStore 不强制）。
- **R24.AC-4**：新增列/config 走 `user_version<3` 迁移 + 新增 `maxWorkersPerItem`（默认 2）+ env。
- **R24.AC-5**：引入新持久化文件/库则挂 BackupJob 纳入日备份。
- **R24.AC-6（回补·并发恢复查询）**：提供 per-assignment 并发恢复所需查询（「列出某 workitem 全部 running effect 并按 assignment 逐个恢复」，复用/新增 `listInflightEffects` 的 per-assignment 视图 + 必要索引）。〔Gate3-C08〕
- **R24.AC-7（回补·一致性）**：R24 新事件 kind 清单为 anchorAction 映射的**唯一权威**；每个 kind 必须有显式映射决定，CI 测试断言不漂移。〔Gate3-C10〕

**支撑 R23（并发恢复查询，本域提供数据砖，恢复逻辑在 container-concurrency）**：
- **R23.AC-2（支撑）**：replacement 与多 worker 同时在途时，`startupRecovery` 重建在途 effect、按 assignment 恢复——本域提供其依赖的「按 assignment 逐个恢复」查询（R24.AC-6 的前提）。
- **R23.AC-4（支撑）**：`recoverRun/recoverRunning` 早退从 workitem 粒度改 assignmentId/effectId 粒度，依赖本域 per-assignment 恢复查询不再漏吞第二个 worker（Boundaries 增补：per-assignment 并发恢复以 R24 的「列某 workitem 全部 running effect 按 assignment 逐个恢复」查询为前提）。

> R23 的恢复**执行逻辑**（inflight 键改造、early-return 降粒度、noop 夹具断言）归 [container-concurrency]；本域只对这两条 AC 提供数据查询砖，不重复列入「我覆盖」的执行职责。

## 设计细节（按功能点分节，写思路不写实现代码）

### §1 新事件 kind 写入（R24.AC-1）
- `workitem_events.kind` 是裸 `TEXT NOT NULL`、无 CHECK（res-five-tables：v1 建表段 `workitem_events`）。11 个新 kind 直接经 `store.appendEvent(workitemId, seq, kind, payload)` 写入，**无需改 schema**。
- 容器层（reducer）**不解释**这些 kind 名——只 worktype `onEvent` switch 据 kind 推进 phase（守红线：workitems 层禁 `switch(...phase...)` 与 `phase==/===`，事件 kind 解释下沉 worktype）。本域只保证「能存、可追加、不可改删」。
- append-only 触发器（`workitem_events_no_update` / `no_delete`，res-five-tables）天然给 checkpoint/contract 决策审计性，**不破坏**（Never）。
- ⚠️ 一致性硬约束：这 11 个 kind 的**权威清单**固化在 internal-apis §7（`RequirementEventKind`），是 §6 的 CI 断言对账基准。

### §2 启用 role + parent_id（R24.AC-2）
- **role 投入使用**：`workitem_assignments.role` 已有 CHECK `IN ('owner','worker','solo')`（res-five-tables）。requirement 的 Owner dispatch 写 `role='owner'`、Worker dispatch 写 `role='worker'`，不再只用 'solo'。这是 [container-concurrency] 单飞门按 role 分流（`countRunningWorkers` 按 `role='worker'` 计数，internal-apis §2.2）与 [checkpoint-gate] 的数据前提。
- **parent_id 启用**（D-19）：`AssignmentSpec` 增 `parentAssignmentId?`（internal-apis §2.1）；reducer 的 [insertDispatchOrWake](../codebase-findings.md#res-insertdispatchorwake) 把它写入 `assignment.parent_id`，**替换 reducer.ts:616 恒写 null**。消费端（批次归属 / 级联 abort）由 [container-concurrency]/[requirement-statemachine] 读 `parent_id`。本域负责：确认 schema 列就位（已有 self-ref FK，无需加列）+ 声明写入/消费两端非「免费拿」（res-five-tables 注：parent_id 是死列）。
- **关键**：schema 有列 ≠ 逻辑就绪——本次补完整「写入 + 消费」两端（Never：不复活 v1「父子链免费拿」的乐观假设）。

### §3 artifact 仓布局（R24.AC-3）
- 复用 [ArtifactStore](../codebase-findings.md#res-artifactstore)（每 workitemId 一个 `$DATA_DIR/workitems/<id>/` git 仓，`writeFile` 写即 commit）。布局是**worktype 约定**，ArtifactStore 不硬编码（res-artifactstore：不硬编码布局）。
- requirement 目标布局：
  ```
  brief.md                       需求 brief（理解 phase 产出）
  journal.md                     Owner 收尾叙事（校验存在，非真相源，见 R02 / requirement-statemachine）
  decisions.md                   决策台账（含"系统替我做的"小改留痕，R10）
  contract/                      对接合同 git 化（冻结=版本史，R09 / contract-engine）
  contract/tests/                跨端契约测试（机械生成为主，独立于实现 worker，R12 / worker-runtime）
  design/                        spec-design design 产物（按端拆，R15 / design-phase）
  assignments/<id>/brief.md      每 worker 任务卡
  assignments/<id>/report.md     每 worker 结构化报告
  report.md                      需求级汇总报告
  ```
- ⚠️ 双路径严格分离（D-20）：artifact 仓（writeFile 写处）≠ worktree（worker cwd，代码改动）。本域只约定 **artifact 仓内**布局；worktree 路径由 [kernel-capabilities] 的 `worktreePathFor`（internal-apis §1.3）管，两套不混用（Never：不在 artifact 仓里改代码）。
- `contract/` 子目录布局细节 + git 化「冻结」语义归 [contract-engine]，本域只在布局表登记其位置。

### §4 config 新增 maxWorkersPerItem（R24.AC-4）
- 现状：`WorkitemsConfig`（res-config）有 7 字段，**无** `maxWorkersPerItem` / `WORKITEMS_MAX_WORKERS_PER_ITEM`（全仓零命中，config.ts:1-60 核验）。
- 改动：照现有 `maxOpen`（默认 3，env `WORKITEMS_MAX_OPEN`）/ `retryBudget` 范式，在 `WorkitemsConfig` 接口 + `DEFAULTS` + `loadWorkitemsConfig` 各加一项 `maxWorkersPerItem`（默认 2，env `WORKITEMS_MAX_WORKERS_PER_ITEM`），复用 `positiveInt` 校验。
- 注入路径：`cfg` 经 [ReducerRuntimeDeps](../codebase-findings.md#res-reducerdeps) 注入 reducer，[container-concurrency] 单飞门据 `cfg.maxWorkersPerItem` 判 worker 上限（internal-apis §2.3）。
- 本域只负责「字段加上、env 可覆盖、默认值正确」；**消费**（上限判定）在 [container-concurrency]。

### §5 user_version<3 迁移（R24.AC-4）
- 现状：`migrate()` 最高 `user_version = 2`（v1 建表，v2 加 `idx_assignments_running` watchdog 索引，store.ts:334-345 核验）。
- 新增 `if (version < 3) { ... PRAGMA user_version = 3; }` 段，承载本次**所有**结构增量：
  - per-assignment 恢复所需的 effect 索引（§6）。
  - 若 §2 父子链消费/查询需要 `parent_id` 上的索引（按需，避免父子链反查全表 SCAN）。
  - role 列已有、`parent_id` 列已有、`agent_session_id` 列已有（onSession 落库写它，D-30/kernel）、`workitem_events.kind` 无需改——这些**不进迁移**，迁移只加索引/真正缺的列。
- ⚠️ 迁移幂等：用 `CREATE INDEX IF NOT EXISTS`（照 v2 范式）；不破坏 append-only 触发器、不改既有列定义。

### §6 per-assignment 并发恢复查询（R24.AC-6，支撑 R23.AC-2/AC-4）
- **问题**：现有 `listInflightEffects`（store.ts:580 附近，按 workitem 列出 `status IN ('pending','running')` effect）是 workitem 粒度；`recoverRun/recoverRunning` 早退 `inflight.has(workitemId)`（res-startuprecovery / res-inflight：effects.ts:78,94）在多 worker 并发恢复下**只恢复第一个、其余静默吞掉**（Gate5-C09）。
- **本域提供**：per-assignment 恢复消费视图——「列出某 workitem 全部 running effect，并能按各 effect 的 `payload.assignmentId` 逐个恢复」。两种落法（执行 skill 择一，记录偏离）：
  1. 复用 `listInflightEffects(workitemId)` 列全部在途，恢复侧（effects.ts）逐条按 `payload.assignmentId` 分别处理（不早退在 workitem 粒度）——查询不变、改恢复循环；或
  2. 新增 per-assignment 视图查询（如按 assignmentId 反查在途 effect，复用 [findInflightRunEffectForAssignment](../codebase-findings.md#res-isrunclass) 已有的 `payload.assignmentId` 精确匹配范式）。
- **必要索引**（§5 迁移内）：现 `idx_effects_inflight ON workitem_effects(workitem_id, status, seq, id)`（res-five-tables）以 workitem_id 领衔；per-assignment 恢复若需按 assignment 维度过滤，评估在 v3 加覆盖 `payload.assignmentId` 的辅助手段。注意 `payload_json` 是 JSON 文本，无法直接建普通索引——若需索引，方案是恢复时全列在途 effect 后内存分组（推荐，避免 JSON 表达式索引复杂度），查询砖保持「列全部在途」即可，索引沿用 `idx_effects_inflight`。
- internal-apis §3.1（inflight 键 workitemId→assignmentId）/ §3.2（早退降 assignmentId/effectId 粒度）是本查询的消费方；本域确保**查询能列全、不漏第二个 worker**，恢复执行逻辑归 [container-concurrency]。

### §7 新持久化挂 BackupJob（R24.AC-5）
- 现 `BackupJob`（res-commandhandler：backup.ts:26-29、scheduleDailyBackup :147-184、注入 index.ts:162）做日备份。
- 若 requirement 引入新持久化文件/库——主要是 [knowledge-layer] 的 `$DATA_DIR/knowledge/`（git 化）、以及 artifact 仓已在备份范围内则无需重复——则在 BackupJob 的备份清单纳入新路径。
- 本域只声明「新持久化必挂备份」这条数据纪律 + 指向 BackupJob 接入点；knowledge 库的具体路径/git 化由 [knowledge-layer] 定。worktree 是**临时工作区、可回收、分支才是资产**（D-20/D-27），**不进**日备份（备份 worktree 无意义且体积大）。

### §8 事件 kind ↔ anchorAction 一致性约束（R24.AC-7）
- internal-apis §7 的 11 个 `RequirementEventKind` 是 anchorAction 映射的**唯一权威**清单。
- [workbench]/feishu 的 `anchorAction`（res-cards：card.ts:179，纯映射函数）必须为**每个** kind 有显式映射决定（刷新锚点 / 不刷新），否则新事件静默不刷锚点（Gate3-C10）。
- **本域负责的 CI 断言**：新增测试断言「internal-apis §7 清单 == anchorAction 覆盖的 kind 集」不漂移——任一侧加/漏 kind 即 CI 红。这把「漏挂导致锚点静默」从隐患变成构建期硬门。断言的两个数据源：(a) 权威 kind 清单（建议在 worktype 侧导出 `RequirementEventKind` 常量数组供测试引用）、(b) anchorAction 实际处理的 kind 集。
- 注意红线：清单常量数组若放 worktypes 层可含业务词；anchorAction 在 feishu/kernel 层**禁业务词**（守 res-redlines），故 anchorAction 内不得出现 `phase` 等词，映射用 kind 字符串字面量 + 中性 `{reply, update}` 返回（res-cards 已是此范式）。

## 与其他领域的交互（调用方向）

- **本域 → [container-concurrency]**：提供 `countRunningWorkers`（§2.2 计数砖）+ per-assignment 恢复查询（§6）+ `cfg.maxWorkersPerItem`（§4）+ `parentAssignmentId` 写入字段（§2.1）。container-concurrency 消费这些做单飞门分流、批量唤醒、崩溃恢复。
- **本域 → [requirement-statemachine]**：提供 artifact 布局约定（§3，journal/brief/decisions/report 落点）+ 父子链消费数据（parent_id）。statemachine 据布局读写 artifact、据 parent_id 做批次归属。
- **本域 → [contract-engine]**：提供 `contract/` + `contract/tests/` 在 artifact 仓的位置（§3）。contract-engine 把 `ContractSnapshot` 落这里、git 化拿冻结版本史。
- **本域 → [workbench]/feishu**：提供新事件 kind 权威清单（§7/§8）。workbench 的 anchorAction 据此映射；本域 CI 断言锁两份清单不漂移。
- **本域 → [knowledge-layer]**：声明「knowledge 新持久化挂 BackupJob」纪律（§7）。
- **[kernel-capabilities] → 本域**：onSession（D-30）落 `agent_session_id` 列（已存在列，本域确认无需加列）；worktree 路径不进本域备份（§7）。
- **依赖方向**：本域是**最底层基础依赖**，不依赖其它 requirement 域（只依赖既有 store/config/artifacts/backup 基建）。index.md 依赖图：`data-model → {container-concurrency, checkpoint-gate, contract-engine}`。

## 相关决策（从 decisions 挑影响本域的）

- **D-19**：父子链 `parent_id` 启用写入 + 消费（非「免费拿」）——`AssignmentSpec` 增 `parentAssignmentId`，写入替换 reducer.ts:616 恒 null，补消费端。【§2】
- **D-20**：artifact 仓 ≠ worktree，双路径严格分离——本域 artifact 布局只管 artifact 仓，worktree 不进布局、不进备份。【§3/§7】
- **D-10**（增补 Gate5-C09）：inflight 键 assignmentId + 恢复早退升 per-assignment 粒度——本域提供其依赖的「列全部在途 effect 逐个恢复」查询。【§6】
- **D-30**：补 runner onSession 回调（session 创建即 `setAgentSessionId` 同步落库）——落 `agent_session_id` 列（已有列），本域确认 schema 无需加列。【§5 关联】
- **D-11**：修复/返工循环用独立计数，不复用 `assignment.retries`——若计数存 `context_json` 或专用事件，本域确认 `workitems.context_json` 列可承载（res-five-tables 有该列）、专用事件 kind 走 §1 不解释机制。【§1/§2 关联】
- **D-27**：worktree 生命周期是全新子系统、不复用 ArtifactStore——印证 §3 双路径分离：artifact 仓布局是本域职责，worktree 由 kernel-capabilities 管。【§3 边界】

## 引用的内部 API

- **internal-apis §2.1**：`AssignmentSpec.parentAssignmentId?`（父子链启用字段）。
- **internal-apis §2.2**：`countRunningWorkers(workitemId): number`（DB `status='running' && role='worker'` 计数，apply 内强一致，逐个累加判入门）。
- **internal-apis §3.1**：inflight 键 workitemId→assignmentId（本域 §6 恢复查询的消费方）。
- **internal-apis §3.2**：per-assignment 崩溃恢复（早退降 assignmentId/effectId 粒度，依赖本域查询不漏吞）。
- **internal-apis §7**：事件 kind 权威清单（11 个 `RequirementEventKind`，anchorAction 映射唯一权威 + CI 不漂移断言）。
- （引用但不在此定义）internal-apis §1.1 `repoOf` / §6 `ContractSnapshot` 属 contract-engine；§1.3 `worktreePathFor` 属 kernel-capabilities——本域只引用 repo/worktree 概念以界定边界，不重新定义。

## 边界约束（Must / Never）

**Must**：
- 复用五表，不新建库/表承载 requirement 语义。
- 新事件 kind 容器不解释——只写 `workitem_events.kind`，解释下沉 worktype `onEvent`；DB 无 CHECK。
- `role='owner'/'worker'` 与 `parent_id` 投入使用（写入 + 消费两端补全）。
- 新列/新索引走 `user_version<3` 新迁移段；`CREATE INDEX IF NOT EXISTS` 幂等。
- `maxWorkersPerItem`（默认 2）+ env `WORKITEMS_MAX_WORKERS_PER_ITEM` 加进 config 三处（接口 / DEFAULTS / loadWorkitemsConfig）。
- per-assignment 并发恢复查询能**列全**某 workitem 全部 running effect，按 assignment 逐个恢复（不漏第二个 worker）。
- 新持久化文件/库挂 BackupJob 纳入日备份。
- 新事件 kind 清单（internal-apis §7）是 anchorAction 映射唯一权威；CI 断言两份清单不漂移。
- artifact 仓布局按 §3 约定（worktype 层约定，ArtifactStore 不强制硬编码）。

**Never**：
- 不破坏 `workitem_events` append-only 触发器（no_update/no_delete）。
- 不在 reducer / 容器层解释新 kind 名（只 worktype onEvent switch；守 workitems 层禁 phase 比较红线）。
- 不复活 v1「父子链免费拿」乐观假设（写入 + 消费必须各自补全）。
- 不在 artifact 仓里改代码 / 不把 worktree 路径混进 artifact 布局或日备份。
- 不给 `workitem_events.kind` 加 CHECK 约束（容器不解释的前提是无白名单）。
- 迁移段不改既有列定义、不降 user_version、不在 v3 段重复 v1/v2 已建对象（除非 IF NOT EXISTS）。
- anchorAction 一侧（feishu/kernel 层）的清单常量/映射不得含业务词（`phase` 等），守 res-redlines。

## 可能的实现提示（可选）

- **事件 kind 常量数组**：在 worktype 侧（`src/worktypes/requirement/`，可含业务词）导出 `REQUIREMENT_EVENT_KINDS: readonly string[]`（与 internal-apis §7 逐字对齐），供 §8 CI 断言与 anchorAction 测试引用同一份，避免「权威清单」散落多处。
- **per-assignment 恢复**：优先选 §6 落法 1（查询列全 + 恢复循环逐个处理），改动面小、避免 JSON 表达式索引；noop 夹具（res-noop-fixture）专锁「同 workitem 多 worker 全部恢复」断言由 container-concurrency 写，本域只保证查询不漏。
- **迁移段对照**：照 store.ts:334-345（v2）的 `if (version < 2)` 范式写 `if (version < 3)`，索引用 `CREATE INDEX IF NOT EXISTS`、末尾 `PRAGMA user_version = 3`。
- **config 对照**：照 config.ts 现有 `maxOpen` 的三处（interface 字段 / DEFAULTS 项 / loadWorkitemsConfig 里 `positiveInt(env, 'WORKITEMS_MAX_WORKERS_PER_ITEM', DEFAULTS.maxWorkersPerItem)`）。
- **CI 断言落点**：anchorAction 不漂移断言可放 feishu 卡片测试或新建 `tests/workitems/event-kinds-anchor.test.ts`，断言 `REQUIREMENT_EVENT_KINDS` 集合 == anchorAction 处理的 kind 集合（两侧任一加/漏即红）。
