---
name: 内部 API 登记表
description: requirement worktype 新增/抽取的所有内部函数签名、接口、跨域共享 utility — 执行 skill 可直接翻译为代码
type: spec-design/internal-apis
---

# Internal APIs Registry — requirement worktype

> **强制约束**（给执行 skill）：实现若需偏离本登记表签名，必须在执行记录标注"与 spec 偏离 + 原因"，不允许静默修改。
> Domain 文档出现的符号（如 `countRunningWorkers` / `ContractDiff` / `worktreeReset`）必须在本文件有对应章节定义；否则 spec 视为不完整。
> **守红线**：kernel 层（`agents/` `feishu/` `pool.ts` 等）的新符号**不得含** `workitem|workitems|assignment|worktype|phase`（用中性命名）；worktypes 层（`requirement/`）可自由用业务词但**禁 async/await/fs/child_process**（纯同步 reducer）。

## 1. 跨域共享 Utility

### 1.1 `repoOf(spec | assignment): string`
- **归属**：`contract-engine` 域（与 R09 providerRepo/consumerRepos 同源）
- **目的**：把"端/任务"统一归一到 repo key —— 合同用 provider/consumer、工人按仓拆、过期判定用 repo，三处共用同一 repo 维度（决策 D-29）
- **定义位置**：`src/worktypes/requirement/contract.ts`
- **调用位置**：`contract-engine`（影响计算）、`container-concurrency`（worker 计数按 role 但归属按 repo）、`worker-runtime`（worktree 按 repo 切分支）
- **Must**：一仓一工人；"一端多仓/一仓多角色"按 repo 展开，禁用业务端名（"后端/前端"）当映射键

### 1.2 `contractStructuralDiff(prev: ContractSnapshot, next: ContractSnapshot): ContractDiff`
- **归属**：`contract-engine` 域
- **目的**：合同结构比对的**唯一实现**——契约变更小改/大改判定（R10）、isDecisionStale（R10/D-05）、集成验证静态对账（R13）三处共用，避免各写脆弱规则
- **定义位置**：`src/worktypes/requirement/contract.ts`
- **调用位置（cross-domain）**：`contract-engine`（变更判定）、`requirement-statemachine`（isDecisionStale 纯同步消费 ContractDiff，见 §4.3）、`worker-runtime`（集成验证对账）
- **Must**：纯函数、纯同步、**不读 fs**（入参是已固化的快照，不是文件路径）；语义等价改动（含义/单位/可空性/排序）**不在结构 diff 范围**，由 `semanticBreaking` 人工标志补（§6.1）

### 1.3 `worktreePathFor(workitemId: string, assignmentId: string, repo: string): string`
- **归属**：`kernel-capabilities` 域（中性命名，对纯桥也有意义）
- **目的**：一个任务一个 worktree 路径的唯一来源——同时喂给 managed task 的 cwd（R05）和写权限档的 writableDirs（R04），二者**同源、同时变更**（决策 Gate3-C07）
- **定义位置**：kernel worktree 中性层（如 `src/agents/worktree.ts`，**不含业务词**）
- **调用位置**：`worker-runtime`（cwd + writableDirs）、`kernel-capabilities`（worktree add 目标）
- **Must**：路径可预测、可回收；redispatch 换 worktree 时 cwd 与 writableDirs 一起更新

## 2. 容器层新增（src/workitems/，守红线·中性命名）

### 2.1 AssignmentSpec 扩展
```ts
// 位置：src/workitems/types.ts（修改 AssignmentSpec :109-118）
interface AssignmentSpec {
  role: 'owner' | 'worker' | 'solo';   // 现有
  repo?: string;                        // 现有
  deadlineTtlSec: number;               // 现有
  wallclockCapSec: number;              // 现有
  replacesAssignmentId?: string;        // 现有
  retries?: number;                     // 现有
  brief?: string;                       // 现有
  payload?: unknown;                    // 现有
  parentAssignmentId?: string;          // 🆕 启用 Owner→Worker 父子链（替换 reducer.ts:616 恒写 null）
}
```

### 2.2 `countRunningWorkers(workitemId: string): number`
```ts
// 位置：src/workitems/store.ts（新增查询）
countRunningWorkers(workitemId: string): number;
// 数 DB 内 status='running' 且 role='worker' 的 assignment（apply 内强一致，避 inflight post-commit 时序）
```
- **行为**：reducer 单飞门按 role 分流时用它判在途工人数 < `maxWorkersPerItem`（决策 Gate3-C01）
- **Must**：同一 transition 批量 dispatch N worker 时，调用方在内存中**逐个累加**已放行数（`countRunningWorkers() + 本批已放行数 < 上限`），不各读同一快照

### 2.3 单飞门改造（reducer.ts:603-610 内）
```ts
// 位置：src/workitems/reducer.ts insertDispatchOrWake（改 :603-610）
// 现状三段与：!spec.replacesAssignmentId && isRunClass('run') && hasInflightRunEffect(item.id)
// 改为 topology 感知：
//   topology==='owner-workers' 时：
//     spec.role==='owner' → 有 owner run 在途才拦（owner 单飞）
//     spec.role==='worker' → countRunningWorkers + 本批已放行 < maxWorkersPerItem 才放，否则 wakePending
//   topology==='solo'（probe/noop）→ 维持原三段与逐字节不变（CI 回归）
```

### 2.4 `releaseWakePending` 改造（reducer.ts:645-649）
```ts
// 位置：src/workitems/reducer.ts releaseWakePending（改 :645-649）
// 现状：清 wakePending + 补一个 defaultDispatchSpec(role:'solo')
// 改为：owner-workers 拓扑下，按排队信息/role 补派对应 worker（不再单条 solo）
```

### 2.5 Owner 批量唤醒窗口
```ts
// 位置：src/workitems/reducer.ts（owner 唤醒组批，复用 store.lastRunEffectSeqBefore + eventsSince）
// 窗口 = (lastOwnerRunEffectSeq, currentOwnerRunEffectSeq]  半开区间（左开右闭，对齐 eventsSince 排他边界）
// owner run 运行期间到达的事件 → 归入下一批（锚到下次 owner run 起点 seq）
```

### 2.6 resolveWait 扩展决策语义
```ts
// 位置：src/workitems/api.ts resolveWait（改 :40-54）
resolveWait(waitId: string, input: {
  operator: string;
  reason: string;
  decision?: { approved: boolean; payload?: unknown };   // 🆕 checkpoint 拍板：一动作 resolve wait + 产出决定
}): ResolveWaitResult;
// enqueue 'wait_resolved' payload 携带 decision；不新增并行 inject 方法
// ⚠️ checkpoint decision 在 reducer 消费前走 isDecisionStale；stale → 拒绝 resolve + 重弹卡（Gate3-C06）
```

## 3. effect 层改造（src/workitems/effects.ts，真并行最大改造）

### 3.1 inflight 键 workitemId → assignmentId
```ts
// 位置：src/workitems/effects.ts（改 :48 Map 定义 + 连锁 6+ 处）
private readonly inflight = new Map<string /*assignmentId*/, { effectId: number; controller: AbortController }>();
// 连锁改：poke 守卫(:66) / drainOne 守卫(:168,175) / executeEffect finally delete(:229) /
//        findInflight 反查(:334) / recoverRun·recoverRunning 早退(:78,94)
```
- **Must**：owner run 仍单飞（靠 reducer 单飞门按 role 分流，不靠 inflight 键）；取消按 assignment 粒度、不误伤同 workitem 其它 worker

### 3.2 per-assignment 崩溃恢复
```ts
// 位置：src/workitems/effects.ts recoverRun/recoverRunning（改 :78,94 早退条件）+ recovery.ts
// 早退条件从 inflight.has(workitemId)（workitem 粒度）改 按本次要恢复的具体 effect 的 assignmentId/effectId 判
// 否则同 workitem 多 worker 崩溃恢复只恢复第一个、其余静默吞掉（Gate5-C09）
```

### 3.3 测试结果门（照 reportRequired 门）
```ts
// 位置：src/workitems/effects.ts（validateRunReport :295 旁新增，或 worktype 侧校验）
// worker 交活前校验跨端契约测试 + 本端单测/类型 结果；不绿判 run_failed
// 区分：断言失败→retry；测试无法执行（命令缺失/环境/编译基础设施）→ 不进 retry 直接举手 + 病历标根因（Gate3-C05）
```

## 4. worktype 接口侧（src/worktypes/requirement/，纯同步·禁 async/fs）

### 4.1 `requirementWorkType` + `registerRequirement`
```ts
// 位置：src/worktypes/requirement/index.ts（新建，仿 probe/index.ts:12-26）
export const requirementWorkType: WorkType = {
  id: 'requirement',
  triggers: { /* /req 命令 + api */ },
  initialPhase: () => 'requirement:理解',
  onEvent: requirementTransition,           // §4.2
  isDecisionStale: isRequirementDecisionStale, // §4.3
  topology: () => 'owner-workers',          // 触发并行分流开关
  permissions: { mode: 'write', repos: [...] }, // workitems 层 write 档（§5.1 映射）
  checkpoints: { requiredBefore: ['requirement:合同', 'requirement:详设', 'requirement:拆解', 'requirement:交付'] },
  artifacts: { reportRequired: true /* + journal 校验，§4.4 */ },
};
export function registerRequirement(registry: { register(type: WorkType): void }): void;
```

### 4.2 `requirementTransition(item, ev): Transition`（7 阶段状态机）
```ts
// 位置：src/worktypes/requirement/index.ts（纯同步，仿 probeTransition）
// 处理 kind：workitem_created / human_message / checkpoint 拍板(wait_resolved 带 decision) /
//   worker_report / contract_frozen / contract_patched / contract_change_* /
//   integration_check_passed/failed / run_completed / run_failed / close_requested
// ⚠️ checkpoint 拦截做在这里：检测到"将越过 requiredBefore 边界且未拍板" → 主动返回 waits:[human] 而非 phase 变更
//   （容器不碰 phase，保 mergeTransitions 不变量，Gate5-C06）
```

### 4.3 `isRequirementDecisionStale(decision, eventsSince): boolean`（纯同步）
```ts
// 位置：src/worktypes/requirement/index.ts（纯函数，禁 fs/await）
// 仅凭 decision.data（固化的 contract 结构指纹）+ eventsSince 判定：
//   decision 基于的 contract 结构指纹 != 当前 / eventsSince 含触及同一 repo 的 contract_change_applied → stale
// 用 contractStructuralDiff（§1.2）；数据流前提见 §6.2（decision.data 固化 + 事件携带指纹）
```

## 5. kernel 新增（守中性，无业务词）

### 5.1 PermissionProfile write 档 + writableDirs
```ts
// 位置：src/agents/types.ts（改 :98-100 + RunOptions :109-112）
interface PermissionProfile { mode: 'full' | 'readonly' | 'write'; }   // 🆕 'write'
interface RunOptions {
  permission?: PermissionProfile;
  mcpServers?: McpServerSpec[];
  writableDirs?: string[];   // 🆕 write 档的可写目录（agents 层只认路径、不认 "repo"，守中性）
}
// runOptionsFingerprint（:119-126）🆕 纳入 writableDirs（否则换目录不重建 runner，写到旧目录）
// 映射（run-handler.ts:147 改）：workitems {mode:'write', repos} → agents {mode:'write', writableDirs:[worktree路径]}
// ⚠️ workitems-write 映射 agents-write（绝不退化成 full=--dangerously-skip-permissions 无限制）
```

### 5.2 buildClaudeArgs write 分支
```ts
// 位置：src/agents/claude/runner.ts（改 :57-61 加第三分支）
// write 档 args = --add-dir <writableDirs...>（声明范围，不带 --dangerously-skip-permissions）
//   + PreToolUse hook（路径硬拦，主约束）+ 写工具集 'Write Edit NotebookEdit'（去过时 MultiEdit）
//   不用 --allowedTools 白名单作主约束
// fail-closed：启动前发探针命令验证 hook 生效，不过则拒绝 write 档启动（降级 readonly 或报人）
```

### 5.3 `onSession` 回调（worker resume 前置，决策 D-30）
```ts
// 位置：src/agents/claude/runner.ts（新增回调，session 创建/首条事件即同步落库）
// ProgressCallbacks 加 onSession?(sessionId: string): void
// run-handler 接它 → ctx.setAgentSessionId(sessionId) 立即落库，让崩溃前 session id 已在 assignment 上
// 不补则 worker 恢复退化为"重置 worktree + 全量 redispatch"单分支
```

### 5.4 worktree 生命周期（kernel 中性层，决策 D-27）
```ts
// 位置：src/agents/worktree.ts（新建，中性命名，无业务词）
worktreeAdd(repoPath: string, worktreePath: string, branch: string, base: string): void;  // git worktree add
worktreeRemove(worktreePath: string): void;                                                // git worktree remove（分支保留）
worktreeIsDirty(worktreePath: string): boolean;                                            // git status --porcelain
worktreeReset(worktreePath: string, base: string, cleanDirs: string[]): void;
//   git reset --hard <base> + git clean -fd 仅 cleanDirs（本任务已知产物目录，不全清以免误伤未跟踪文件）
```
- **Must**：worktreeReset 是改盘操作、错一次=代码产出销毁，必须夹具验证；`git clean` 不全清

### 5.5 card.action 分发（feishu，只透传不解释）
```ts
// 位置：src/feishu/event-router.ts（改 :15 register 加事件键）
// EventDispatcher.register 加 'card.action.trigger'（之类）→ 把 raw action.value 当不透明 payload 透传
// 绝不在此解释 value 里的 workitemId/checkpoint（守红线，CI 拦）；上层 adapter 解释
```

### 5.6 Semaphore 预留槽（pool，决策 D-18）
```ts
// 位置：src/agents/pool.ts（改 Semaphore :22-56 + send :109）
// 加 owner 预留槽/优先级队列：owner 自身运行走预留槽优先 acquire
// send 加中性 priority/role 入参（task.owner_kind 区分不了 owner-vs-worker，都 managed）
// ⚠️ 防二级死锁：owner 派 worker 是 reducer 内 dispatch（产 pending effect 落库），worker acquire 在 effects 层异步发生、不阻塞 owner run 完成（owner 不在自己 run 内同步等 worker 槽，Gate5-C10）
```

## 6. 合同数据契约（contract-engine）

### 6.1 `ContractInterface` / `ContractSnapshot`
```ts
// 位置：src/worktypes/requirement/contract.ts（新建）
interface ContractInterface {
  id: string;                  // 接口标识
  signature: string;           // 方法/字段签名（结构化文本）
  providerRepo: string;        // 🔑 哪个 repo 提供（repo key，非业务端名）
  consumerRepos: string[];     // 🔑 哪些 repo 调用
  fields: Array<{ name: string; type: string; optional: boolean }>;  // 字段级（结构 diff 依据）
  semanticBreaking?: boolean;  // 🚩 人工标志：语义等价但行为变（含义/单位/可空性/排序），结构 diff 抓不到（D-31）
}
interface ContractSnapshot {
  version: string;             // git commit hash 或版本号（"冻结"语义）
  interfaces: ContractInterface[];
  fingerprint: string;         // 结构指纹（固化进 decision.data，供 isDecisionStale 纯同步消费）
}
```

### 6.2 `ContractDiff` + 变更判定
```ts
// 位置：src/worktypes/requirement/contract.ts
interface ContractDiff {
  added: Array<{ interfaceId: string; kind: 'field' | 'interface' | 'optional' }>;     // 纯增
  breaking: Array<{ interfaceId: string; kind: 'removed-field' | 'type-changed' | 'semantic-removed' | 'interface-removed' }>;
  semanticFlagged: string[];   // 人工标 semanticBreaking 的接口 id（结构没变但行为变）
  affectedRepos: string[];     // 受影响 repo 集（据 provider/consumer 算）
}
// 判定：breaking 空 && semanticFlagged 空 → 小改（纯增，自治）；否则大改（回灯②）
// computeImpact(diff): string[] → 受影响 worker（按 affectedRepos 映射，repoOf §1.1）
```

### 6.3 数据流前提（硬接口约定，D-05）
- decision 产出时把所基于的 `ContractSnapshot.fingerprint` **固化进 `decision.data`**
- contract 变更事件（`contract_change_applied`/`contract_patched`）payload 携带变更后 `fingerprint` + 字段级 diff
- 使 `isRequirementDecisionStale` 仅凭 `decision.data` + `eventsSince` 纯同步判定、不读 fs

## 7. 事件 kind 清单（容器不解释，权威清单·R24）
```
checkpoint_reached / checkpoint_decision
contract_frozen / contract_patched / contract_change_proposed / contract_change_approved / contract_change_applied
worker_report
integration_check_passed / integration_check_failed
design_ready
```
- **一致性约束**：每个 kind 必须在 `anchorAction`（feishu/card.ts:179）有显式映射决定（刷新/不刷新）；CI 测试断言本清单与 anchorAction 不漂移（Gate3-C10）

## 8. 执行阶段自查清单
- [ ] §2.3 单飞门改造后 probe/noop（solo）行为逐字节不变（CI 回归绿）
- [ ] §3.1 inflight 键改 assignmentId 后，6+ 处连锁全改（poke/drainOne/finally/findInflight/recover）；无一处残留 workitemId 键
- [ ] §3.2 同 workitem 多 worker 崩溃恢复**全部**恢复（noop 夹具断言，非只第一个）
- [ ] §2.2 在途 worker 数按 DB running+role=worker 计数（非 inflight Map）；批量 dispatch 逐个累加
- [ ] §5.1 workitems-write 映射 agents-write（grep 确认无 write→full）；fingerprint 含 writableDirs
- [ ] §5.2 write 档不带 --dangerously-skip-permissions；fail-closed 探针验证 hook 生效
- [ ] §4.3 isDecisionStale 纯同步、无 fs/await（grep 确认）；仅消费 decision.data + eventsSince
- [ ] §1.2 contractStructuralDiff 单一实现，contract/checkpoint/isDecisionStale/集成验证四处引用同一函数（不重复实现）
- [ ] §5.5 event-router card.action 只透传 value、不出现 workitemId/checkpoint 字面解释（CI 禁词）
- [ ] knowledge 层落地前 architecture.ts:109-114 已加 knowledge/ 分层分支
