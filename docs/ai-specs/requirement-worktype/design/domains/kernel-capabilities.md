# Domain: kernel-capabilities

> 层：**kernel**（`src/agents/` `src/feishu/` `src/agents/pool.ts` 等）。**守红线：本域所有新符号禁出现 `workitem|workitems|assignment|worktype|phase`（/i），用中性命名。** 业务语义（repo→worktree 映射、role→priority 映射、value→checkpoint 解释）都在上层（worktypes / workitems adapter）发生，本域只提供"对纯桥也有意义"的中性能力。
> 本文引用现有代码资源用 [`../codebase-findings.md`](../codebase-findings.md) 锚点；引用新增符号给 [`internal-apis.md`](../internal-apis.md) 章节号，不就地写签名。

## 领域职责（负责什么 / 不负责什么）

**负责（4 件 kernel 中性能力 + 1 个 resume 前置回调）**：
1. **写权限档**（R04）：agents 层 `PermissionProfile` 加 `'write'` 档 + `RunOptions.writableDirs`；`buildClaudeArgs` 加 write 分支（`--add-dir` + PreToolUse hook + 写工具集，**不带** `--dangerously-skip-permissions`）；fingerprint 纳入目录；fail-closed 探针验证。
2. **worktree 生命周期供给**（R05）：kernel 中性层（`src/agents/worktree.ts`）提供 `worktreeAdd/Remove/IsDirty/Reset` + `worktreePathFor`，供 worker run 当 cwd 与 writableDirs 同源。
3. **onSession 回调**（D-30，R11 resume 前置）：runner 在 session 创建即同步回调，让上层立刻落库 session id。
4. **card.action 分发**（R06 分发侧）：`EventDispatcher` 加事件键，把 raw action.value 当不透明 payload 透传，**不解释**。
5. **Owner 预留槽**（R07）：`pool.ts` 的 `Semaphore` 加预留/优先级，`send()` 加中性 `priority/role` 入参，防优先级反转 + 防二级死锁。

**不负责（属上层）**：
- 不把 workitems 层 `{mode:'write', repos}` 映射成 `{mode:'write', writableDirs}` —— 映射发生在 worker-runtime 的 run-handler（本域只提供 write 档这个**目标形态**与 fingerprint 正确性）。
- 不解释 card.action value 里的 `workitemId/checkpoint/decision`（workitems adapter 解释，见 workbench 域）。
- 不决定哪个 run 是 owner、哪个 worker（上层用中性 `priority/role` 入参告知 pool；pool 不读 `task.owner_kind` 区分业务角色）。
- 不分配/回收某个具体 worker 的 worktree 路径策略（路径生成函数 `worktreePathFor` 在 contract/worker 域按 repo 调用，本域只给纯函数 + git 操作原语）。
- 不做 checkpoint stale 校验、不消费 decision（checkpoint-gate / contract-engine 域）。

## 核心概念（本域特有）

- **write 档纵深三层**（D-04）：① `--add-dir <worktree>` 声明可写范围（软约束、放宽不收紧）；② PreToolUse hook 校验 Bash/Write/Edit 目标路径在 worktree 内、否则 deny（**硬约束·主约束**）；③ worker 跑专属 worktree、凭证不进 prompt、适配器配置路径进 deny。
- **fail-closed 探针**（R04 AC7 / D-04 增补）：write 档启动前发一条"已知应被 deny 的探针命令"实测 hook 生效，不过则拒绝以 write 档启动（不静默退化成无限制写）。
- **worktree ≠ artifact 仓**（D-20）：本域只管 worker 目标仓的 worktree（代码改动 cwd）；artifact 仓（报告/合同）由 ArtifactStore 管，两套路径严格分离。worktree 是**全新子系统**，不复用 ArtifactStore。
- **中性 priority/role 入参**（D-18）：pool 不靠 `task.owner_kind` 区分 owner-vs-worker（都是 managed），上层在 `send()` 时显式传中性 priority；pool 只认 priority 高低，不认业务角色名。
- **预留槽 ≠ 派 worker 的槽**（D-18 增补，防二级死锁）：owner 自身运行走预留槽优先 acquire；owner 派 worker 不在自己 run 内同步等 worker 槽（worker 的 acquire 在 effects 层异步发生）。

## 数据契约

新增/改造符号签名详见 [`internal-apis.md`](../internal-apis.md)，本域引用以下章节（不就地重复签名）：

- **写权限档**：`PermissionProfile` 加 `'write'` + `RunOptions.writableDirs` + `runOptionsFingerprint` 纳目录 —— 详见 internal-apis.md **§5.1**。
- **buildClaudeArgs write 分支**：详见 internal-apis.md **§5.2**。
- **onSession 回调**：`ProgressCallbacks.onSession?(sessionId)` —— 详见 internal-apis.md **§5.3**。
- **worktree 生命周期**：`worktreeAdd/worktreeRemove/worktreeIsDirty/worktreeReset` —— 详见 internal-apis.md **§5.4**。
- **worktree 路径生成**（跨域共享 utility，本域只定义、不重复）：`worktreePathFor(workitemId, assignmentId, repo)` —— 详见 internal-apis.md **§1.3**（归属本域、kernel 中性层）。
- **card.action 分发**：详见 internal-apis.md **§5.5**。
- **Semaphore 预留槽**：详见 internal-apis.md **§5.6**。

> ⚠️ `worktreePathFor`（§1.3）虽逻辑跨多域（cwd + writableDirs + worktree add 目标），但**归属本域 kernel 中性层、只定义一处**；worker-runtime / contract-engine 只调用不重定义。

## 涵盖的 AC

**R04 写权限档（全部 7 条，含回补 AC7）**
- R04.AC-1：workitems `{mode:'write', repos}` → agents `RunOptions{mode:'write', writableDirs:[...]}`（agents 层只认路径不认 repo）。〔注：映射动作在 worker-runtime 域执行，本域提供 agents-write 的目标形态 + fingerprint 正确性〕
- R04.AC-2：启动 write 档 Claude runner 生成 `--add-dir <worktree>` + **不带** `--dangerously-skip-permissions` + 写工具集 + PreToolUse hook 校验路径。
- R04.AC-3：write 档 writableDirs 变化触发 runner 重建（`runOptionsFingerprint` 纳入 writableDirs）。
- R04.AC-4：agent 试图用 Bash/Write/Edit 写 worktree 外路径 → PreToolUse hook deny（硬约束）。
- R04.AC-5：写工具集收敛为 `Write Edit NotebookEdit`（MultiEdit 已合并进 Edit）。
- R04.AC-6：workitems `write` 误映射成 agents `full` 视为缺陷（full = `--dangerously-skip-permissions` 丢目录限定）—— 映射必须 write→write，不退化 full。
- R04.AC-7（回补·fail-closed）：write 档启动前发"已知应被 deny 的探针命令"实测确认 PreToolUse hook 生效；验证不过则**拒绝以 write 档启动该 worker**（降级 readonly 或报人），绝不静默退化成无限制写。

**R05 worktree 工作区供给（全部 8 条，含回补 AC7/AC8）**
- R05.AC-1：用 kernel 通用能力 `git worktree add <path> <branch>`（从需求基线切 feature 分支）准备工作区。
- R05.AC-2：worker run 启动时把该 worker 的 managed task `cwd` 指向其 worktree 路径（一 assignment 一 managed task 一 cwd）。〔注：cwd 落点在 worker-runtime 经 upsertTask，本域提供 worktreePathFor + worktreeAdd〕
- R05.AC-3：worktree 不再需要时 `git worktree remove` 回收（**分支保留**，worktree 删除）。
- R05.AC-4：区分 artifact 仓（`$DATA_DIR/workitems/<id>/`）与 worktree（cwd），两套路径不混用（本域只负责 worktree 一侧，守 D-20）。
- R05.AC-5：崩溃恢复发现 worktree 有未提交脏改动时，在 redispatch 前重置/丢弃半成品回干净基线（本域提供 `worktreeIsDirty` + `worktreeReset` 原语，调用编排在 worker-runtime）。
- R05.AC-6：worktree add 失败（基线缺失/路径冲突）→ 判该 worker 派发失败并举手，不在错误工作区跑 agent（本域 `worktreeAdd` 失败抛错，由调用方接住举手）。
- R05.AC-7（回补）：该 worker 的 `writableDirs`（R04）与 managed task `cwd` **同源于该 assignment 的 worktree 路径**，二者同时确定/同时变更（redispatch 换 worktree 时一起更新）—— 本域用**单一 `worktreePathFor`** 保证同源。
- R05.AC-8（回补·worktree 生命周期，D-27）：提供脏检测（`git status --porcelain`）与重置（`git reset --hard <feature 基线>` + `git clean -fd` **仅清本 assignment 已知产物目录、不全清**以免误伤未跟踪文件）。

**R06 卡片按钮回调原语（分发侧 4 条：AC1/AC2/AC4/AC6；消费侧 AC3/AC5 归 workbench）**
- R06.AC-1：飞书卡片按钮被点击 → 经 `EventDispatcher` 新增的 `card.action` 事件键（走 ws，不起 HTTP）分发该回调。
- R06.AC-2：kernel/feishu 层处理 card action 时把 `value` 当**不透明 payload 透传**，**不解释**里面的 `workitemId/checkpoint`。
- R06.AC-4：按钮点击 3 秒内回 toast，真实动作异步执行（分发层负责 ack/toast 时机，业务动作交上层异步）。
- R06.AC-6：文本回复兜底仍支持 thread 文本 + injectHumanMessage 路径（按钮缺失时可用）—— 本域不破坏现有 `im.message.receive_v1` 入站通道，新增事件键与之并存。

**R07 Owner 预留槽（全部 4 条，含回补 AC2 入参）**
- R07.AC-1：pool 并发槽被 worker 占满 AND owner run 需唤醒时，让 owner run 通过**预留槽/优先级队列**优先获得执行（不 FIFO 排队尾）。
- R07.AC-2：`send()` 接收优先级/role 信号（`task.owner_kind` 区分不了 owner-vs-worker，新增中性入参）。
- R07.AC-3：evictLRU 选驱逐对象时（可选）优先保护 owner runner。
- R07.AC-4：无空闲槽可驱逐时保持现有"hot 数暂超 + log"语义不崩。

## 设计细节

### 1. 写权限档（R04）

**1.1 agents 层加 write 档 + writableDirs（§5.1）**
- `PermissionProfile.mode` 现 `'full' | 'readonly'`（[res-runoptions](../codebase-findings.md#res-runoptions) `types.ts:98-100`，注释自承 `'write' lands in M2`），本次加第三值 `'write'`。
- `RunOptions` 加 `writableDirs?: string[]`（[res-runoptions](../codebase-findings.md#res-runoptions) `types.ts:109-112`）。**agents 层只认路径不认 "repo"**——这是守 kernel 中性的关键：上层把 repo→worktree 路径解析完再传进来，本域看到的只是 `string[]` 目录。
- **R04.AC-3 / D-21**：`runOptionsFingerprint`（`types.ts:119-126`）现仅取 `permission.mode + mcpServers`，**必须纳入 writableDirs**。否则同一 managed task 换 repo 集时 fingerprint 不变 → pool 不 dispose 重建 runner → 旧 `--add-dir` 指旧目录（写到错目录的隐藏缺口）。注意保持"`full && 0 servers && 无 writableDirs → ''`"的零回归塌缩（probe/桥默认路径 fingerprint 仍空）。

**1.2 buildClaudeArgs 加 write 分支（§5.2）**
- 现 `buildClaudeArgs`（[res-buildclaudeargs](../codebase-findings.md#res-buildclaudeargs) `claude/runner.ts:36-65`）权限分支二选一互斥：`readonly→--disallowedTools` / `full→--dangerously-skip-permissions`（`:57-61`）。加第三分支 `write`：
  - args = `--add-dir <writableDirs...>`（声明范围）+ **不带** `--dangerously-skip-permissions`（带了=无限制丢目录限定，即 R04.AC-6 缺陷）。
  - **主约束 = PreToolUse hook**（路径硬拦），不用 `--allowedTools` 白名单作主约束（D-04/D-22 对齐：hook 管路径、白名单不重叠）。
  - 写工具集收敛 `Write Edit NotebookEdit`（R04.AC-5 / D-22，MultiEdit 已合并进 Edit）；readonly 分支的 deny 列表里 MultiEdit 留着无害（deny 不存在工具不报错）。
- **R04.AC-4 / DEFER-1**：PreToolUse hook 校验 Bash/Write/Edit 目标路径在 worktree 内、否则 deny。能拦 Write/Edit 的 path 与直白的 `echo > 越界路径`；Bash 变量拼接路径（`VAR=路径; echo>$VAR`）有绕过面 → 标"已知残余"，**不追求 100% 拦死**（强沙箱明确不在本次范围）。

**1.3 hook 注入基建（从 0 到 1）**
- grep 实证：`PreToolUse/hooks/--settings` 在 src **零命中**（[res-buildclaudeargs](../codebase-findings.md#res-buildclaudeargs) 关联 / D-04 坑），基建当前不存在，要新建。
- 实现侧：写 settings/hook 配置 + 把 hook 脚本路径传给 Claude CLI。配置文件级实现属本域 kernel（中性命名，文件里描述"可写目录校验"而非业务词）。

**1.4 fail-closed 探针验证（R04.AC-7 / D-04 增补）**
- write 档启动前发一条"已知应被 deny 的探针命令"（如试图写 worktree 外的固定路径），实测确认 PreToolUse hook 真生效。
- 验证不通过（settings 写失败/Claude 不认 hook/hook 崩溃）→ **拒绝以 write 档启动该 worker**：降级 readonly 或报人。把"hook 在不在"从隐含前提变成启动时显式断言。
- ⚠️ 这是本域对 worker-runtime 的硬接口承诺：worker-runtime 只要拿到"write 档已就绪"的肯定信号才往下跑，拿不到则按 R04.AC-7 处置。

### 2. worktree 生命周期供给（R05，D-27）

**2.1 全新子系统、kernel 中性层（§5.4 + §1.3）**
- 落在 `src/agents/worktree.ts`（中性命名、无业务词；R05.AC-1 的"中性命名对纯桥也有意义"）。**不复用 ArtifactStore**（[res-artifactstore](../codebase-findings.md#res-artifactstore) 只操作 artifact 仓，D-20 已定二者严格分离）。
- 提供 4 个 git 操作原语（§5.4）+ 1 个路径生成纯函数（§1.3）：
  - `worktreeAdd(repoPath, worktreePath, branch, base)`：`git worktree add`（R05.AC-1，从需求基线 base 切 feature 分支）。失败抛错（R05.AC-6 基线缺失/路径冲突由调用方接住举手）。
  - `worktreeRemove(worktreePath)`：`git worktree remove`（R05.AC-3，**分支保留**，worktree 删除）。
  - `worktreeIsDirty(worktreePath)`：`git status --porcelain`（R05.AC-5/AC-8 脏检测）。
  - `worktreeReset(worktreePath, base, cleanDirs)`：`git reset --hard <base>` + `git clean -fd` **仅 cleanDirs**（R05.AC-8 仅清本 assignment 已知产物目录、不全清）。
  - `worktreePathFor(workitemId, assignmentId, repo)`：路径生成纯函数（§1.3）—— **R05.AC-7 同源的唯一来源**，cwd 与 writableDirs 都从它取，redispatch 换 worktree 时一起变。

**2.2 重置策略风险（D-27 / 设计详览 §6 worktree 重置策略）**
- `worktreeReset` 是**改盘操作**，错一次 = worker 真实代码产出被销毁。`git clean -fd` **不全清**（只清 cleanDirs），以免误伤未跟踪有用文件。
- 必须 noop 夹具验证（"重置后回到干净基线、未跟踪非产物文件不被误删"）。这是本域最危险的一处。

**2.3 与 R04 的同源耦合（R05.AC-7 / Gate3-C07）**
- worker 的 `writableDirs`（R04）与 managed task `cwd`（R05）**同源于 `worktreePathFor` 的同一返回值**。二者同时确定、同时变更：redispatch 换 worktree 时若只换 cwd 不换 writableDirs，hook 会用旧 writableDirs deny 掉对新 worktree 的合法写。本域用"单一路径生成函数"从根上保证同源，不靠两处各自计算。

### 3. onSession 回调（D-30，R11 resume 前置）

- `ProgressCallbacks` 加 `onSession?(sessionId)`（§5.3）。runner 在 session 创建/首条事件即触发（`AgentEvent` 已有 `{type:'session', sessionId}`，[res-runoptions](../codebase-findings.md#res-runoptions) 关联 `types.ts:41-42`，现未对外暴露回调）。
- 上层（worker-runtime run-handler）接它 → `ctx.setAgentSessionId(sessionId)` 立即落库，让崩溃前 session id 已在 assignment 上、resume 分支可达。
- **kernel 通用收益**：对 probe 多轮 resume 也有益（不止 worker）。命名中性（onSession 无业务词）。
- ⚠️ 若执行 skill 因故不补此回调：worker 恢复诚实退化为"重置 worktree + 全量 redispatch"单分支（worker-runtime 域处理），本域不留永不可达死代码。

### 4. card.action 分发（R06 分发侧）

**4.1 加事件键（§5.5）**
- 现 `EventDispatcher.register` 只注册 `im.message.receive_v1`（[res-eventrouter](../codebase-findings.md#res-eventrouter) `event-router.ts:15-16`），飞书纯 ws 无 HTTP 端点。加 `card.action.trigger`（之类）事件键（R06.AC-1 **走 ws、不起 HTTP**，D-12）。
- **R06.AC-2 守红线**：本域只把 `raw action.value` 当不透明 payload 透传，**绝不在此解释 value 里的 `workitemId/checkpoint`**（CI 禁词拦）。上层 workitems adapter 解释（消费侧 AC3/AC5 归 workbench 域）。
- **R06.AC-4**：分发层负责 3 秒内回 toast/ack（飞书要求），真实业务动作交上层异步执行。
- **R06.AC-6**：新增事件键与现有 `im.message.receive_v1` 入站通道并存，文本回复 + injectHumanMessage 兜底不破坏。

**4.2 不在本域做的（边界）**
- 卡片 value schema 的定义（`{workitemId, checkpoint, decision}`）、卡片 button 构造、value 的解释与走 inject 门面，全在 workbench 域（R06.AC-3/AC-5）。本域只保证"raw action 能从 ws 流到上层"。

### 5. Owner 预留槽（R07，D-18）

**5.1 Semaphore 加预留/优先级（§5.6）**
- 现 `Semaphore`（[res-pool](../codebase-findings.md#res-pool) `pool.ts:22-56`）单一无差别池 FIFO，`cap=min(maxConcurrent??maxHot, maxHot)`。worker 占满槽 → owner FIFO 排队尾饿死（优先级反转确凿）。
- 改点：① Semaphore 加预留槽/优先级队列，owner 自身运行走预留槽优先 acquire（R07.AC-1，不 FIFO 排队尾）。
- ② `send()`（`pool.ts:109-167`）新增中性 `priority`/`role` 入参（R07.AC-2）——`task.owner_kind` 区分不了 owner-vs-worker（都是 managed），必须新增入参。**中性**：pool 只认 priority 高低，上层把"owner"映射成高 priority 传进来，pool 不读业务角色名。
- ③ evictLRU（`pool.ts:196-216`）可选优先保护 owner runner（R07.AC-3）；无空闲槽可驱逐时保持现有"hot 数暂超 + log"语义不崩（R07.AC-4）。

**5.2 防二级死锁（D-18 增补 / DEFER-2）**
- 仅预留槽解决"排队公平"，但 owner 派 N worker 时**派 worker 本身也要槽**，若 owner 在自己 run 内同步等 worker 槽 → owner 回队尾等 worker 释放、worker 又等 owner 指令 → **循环依赖卡死**。
- 处置（本域约束）：区分两类 acquire —— **owner 自身运行走预留槽**；**owner 派 worker 是上层 reducer 内 dispatch（产 pending effect 落库），worker run 的 acquire 在 effects 层异步发生、不阻塞 owner run 完成**（owner run 派完即结束、释放自己的槽，不在自己 run 内同步等 worker 槽）。
- 这条对本域是"send 的 acquire 语义不引入同步等待链"的约束；具体"owner 派 worker 落 pending effect"的编排在 container-concurrency / requirement-statemachine 域。

## 与其他领域的交互（调用方向）

- **worker-runtime → kernel-capabilities**（最主要）：worker run handler 调本域 —— 把 workitems `{mode:'write', repos}` 映射成 agents `{mode:'write', writableDirs}`（映射在 worker-runtime，目标形态由本域 §5.1 定义）；调 `worktreePathFor`（§1.3）取 cwd + writableDirs（同源）；调 `worktreeAdd/IsDirty/Reset/Remove`（§5.4）准备/检测/重置/回收工作区；接 `onSession`（§5.3）落库 session id；启动前接本域 fail-closed 探针的肯定信号才往下跑。
- **container-concurrency → kernel-capabilities**：owner 派 worker 的 dispatch 落 pending effect（不在 owner run 内同步等 worker 槽，配合本域 §5.6 防二级死锁约束）；effects 层异步对 worker run acquire 走 pool。
- **workbench → kernel-capabilities**：workbench 域（飞书灯卡 / 工作台）消费本域 §5.5 透传的 raw card.action，自己解释 value、走 inject 门面（R06.AC-3/AC-5）；定义卡片 value schema + button 构造（本域不碰）。
- **requirement-statemachine → kernel-capabilities**：取消收尾（R21）调本域 `worktreeRemove` 回收 worktree（分支保留）；owner run 经 pool 预留槽优先唤醒。

## 相关决策

- **D-04** 🔶 Claude 写权限档 = 纵深三层（`--add-dir` + PreToolUse hook + worktree）+ fail-closed 探针 + 最终 args 拍死（不用白名单作主约束）—— §1 全节。
- **D-21** 写档 fingerprint 纳入 writableDirs（堵换 repo 不重建 runner 的隐藏缺口）—— §1.1。
- **D-22** 写工具集收敛 `Write Edit NotebookEdit`（MultiEdit 过时），与 D-04 对齐不用白名单作主约束 —— §1.2。
- **D-27** 🔶 worktree 生命周期管理子系统（从 0 到 1，不复用 ArtifactStore，重置策略 git clean 不全清）—— §2 全节。
- **D-20** artifact 仓 ≠ worktree 双路径严格分离 —— §2.1。
- **D-30** 🔶 补 runner onSession 回调（worker resume 前置）—— §3。
- **D-12** 卡片回调走 ws 不起 HTTP；kernel 不解释 value —— §4。
- **D-18** 🔶 Owner 预留槽改 pool Semaphore（§19 独立于 §14 写权限）+ 防二级死锁 —— §5。
- **D-17** 命名安全 + 分层红线（kernel 中性、判定下沉纯函数）—— 全域守红线前提。

## 引用的内部 API

- internal-apis.md **§1.3** `worktreePathFor`（跨域共享 utility，归属本域 kernel 中性层、只定义一处）
- internal-apis.md **§5.1** PermissionProfile write 档 + writableDirs + fingerprint 纳目录
- internal-apis.md **§5.2** buildClaudeArgs write 分支
- internal-apis.md **§5.3** onSession 回调
- internal-apis.md **§5.4** worktree 生命周期（worktreeAdd/Remove/IsDirty/Reset）
- internal-apis.md **§5.5** card.action 分发（只透传不解释）
- internal-apis.md **§5.6** Semaphore 预留槽

## 边界约束

### Must
- agents 层加 `'write'` 档 + `writableDirs`；fingerprint **必须**纳入 writableDirs（堵换目录不重建缺口）。
- write 档最终 args = `--add-dir` + PreToolUse hook（路径硬拦·**主约束**）+ 写工具集 `Write Edit NotebookEdit`；**不用 `--allowedTools` 白名单作主约束**；**不带** `--dangerously-skip-permissions`。
- write 档启动前 fail-closed 探针验证 hook 生效，不过则拒绝以 write 档启动（降级 readonly 或报人）。
- worktree 供给是 kernel 通用能力，**中性命名**（对纯桥也有意义）；`worktreeReset` 的 `git clean -fd` **仅清 cleanDirs、不全清**（改盘操作必须夹具验证）。
- worker 的 `writableDirs` 与 managed task `cwd` 同源于**同一个 `worktreePathFor` 返回值**，同时确定/同时变更。
- card.action 走 ws EventDispatcher，**不起 HTTP**；feishu/kernel 层只分发 raw action 不解释业务。
- Owner 预留槽改 `pool.ts` Semaphore；`send()` 加**中性** priority/role 入参；owner 派 worker 的 acquire 不在 owner run 内同步等待（防二级死锁）。
- 本域所有新符号**命名中性**：worktree/onSession/card.action/priority 等不出现 `workitem|workitems|assignment|worktype|phase`（/i，CI 禁词拦）。

### Never
- 不把 workitems `write` 映射成 agents `full`（full = `--dangerously-skip-permissions` 无限制，会丢目录限定）。
- 不指望 `--add-dir` 收窄写入（它**放宽不收紧**）；不依赖 OS 沙箱（那是 investigation/Codex 的，write 档明确不依赖）。
- 不在 hook 注入失败时静默退化成无限制写（必须 fail-closed）。
- worktree 层不出现 worktype/assignment 业务词；不复用 ArtifactStore 管 worktree；不在 artifact 仓里改代码。
- `worktreeReset` 不全清 worktree（`git clean` 不带全清，只清本任务已知产物目录）。
- event-router/card 分发层不出现 `workitemId/checkpoint` 业务词解释（CI 拦）；卡片 value 不在 kernel 层被消费/解释。
- 不把 owner/worker 业务语义塞进 kernel pool（用中性 priority）；owner 不在自己 run 内同步等 worker 槽。
- 不用 `task.owner_kind` 区分 owner-vs-worker 来排优先级（区分不了，都是 managed，靠中性入参）。

## 可能的实现提示（可选）

- **fingerprint 零回归校验**：改完 `runOptionsFingerprint` 后，断言"`full && 0 servers && 无 writableDirs → ''`"仍成立，确保 probe/桥默认路径不触发 runner 重建（参 §8 自查清单"§5.1 fingerprint 含 writableDirs"）。
- **write 分支字节级回归**：`buildClaudeArgs` 的 readonly/full 两分支输出**逐字节不变**（只新增 write 分支），用现有 args builder 测试守。
- **探针命令选型**：fail-closed 探针选一条确定性的越界写（如 `echo x > <worktree父目录的固定哨兵路径>`），断言 hook 返回 deny；探针本身不污染 worktree。
- **worktree git 操作的 base 选取**：`worktreeAdd` 的 base 应是"需求基线"（feature 分支的起点），由上层（worker-runtime 据合同/分支策略）传入，本域不决定 base 是什么。
- **预留槽大小**（DEFER-2）：因 D-18 已把"派 worker"移出 owner 同步 acquire，预留槽主要保 owner 自身运行，默认预留 1；第 7 步若出现"owner 唤醒到执行等待 >30s"或"owner-worker 循环等待"再调（可单样本证伪，不靠分布校准）。
- **hook 脚本与 settings 写入位置**：项目当前零基建，需新建；注意 settings 写入路径与 Claude CLI `--settings`/hook 约定对齐（实现时核对 Claude CLI 当前版本的 hook 配置格式）。
