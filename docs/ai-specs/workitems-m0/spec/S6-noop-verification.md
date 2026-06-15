# S6: noop 类型与单实例全路径验证

> Scope: noop 退化工作类型实现 + 端到端打穿容器全部路径 + PID 锁单实例验证 + kernel 装配触点与架构规则校验
> AC: AC-6.1~6.12

---

## 需求（Step 1 产出）

### 概述

本组是 M0 的端到端汇聚点：实现 §4.5 的 noop 退化工作类型（实现 WorkType 接口、不经 AgentPool、不跑真 agent，效果为可控延时 + 可注入失败），用它打穿 G2-G5 各组机制组合后的全路径（正常、失败、SIGKILL 崩溃恢复、并发多 workitem）；验证 kernel PID 锁的单实例语义（§4.3 前提，6329d35 回归，只测不改）；并作为唯一触碰 kernel 触点的组，定义 index.ts 装配 / config.ts 路径的需求与「依赖单向 worktypes→workitems→kernel、kernel 无业务概念」的架构校验（§3.1/§3.2）。**本组不重复定义容器各机制的行为 AC（G2-G5 已有），只断言「组合后端到端走通」与「架构规则被守住」。**

### AC 列表

#### AC-6.1: noop 实现 WorkType 接口全签名

**GIVEN** §4.5 的 WorkType 接口已在容器层定义（M0 仅接口全签名 + noop 退化实现，EX-8）
**WHEN** 向容器的 WorkType 注册表注册 noop 类型并通过编程 API 创建 noop workitem
**THEN** noop 提供接口全部成员的可调用实现：`id='noop'`、triggers（仅编程 API）、`initialPhase`、`onEvent`（纯转移 + 效果声明，函数体内无 await / IO）、`isDecisionStale`（退化恒 false）、`topology`（solo）、`permissions`（readonly 声明，M0 无 enforce 面）、`checkpoints`（空策略）、`artifacts`（最小 brief/report 模板）；注册与创建过程不修改容器与 kernel 任何代码

#### AC-6.2: noop 效果可控延时且不经 AgentPool

**GIVEN** 创建 noop workitem 时传入参数 `delayMs`
**WHEN** 容器运行时从 outbox 取出并执行 noop 声明的效果
**THEN** 效果执行时长由 `delayMs` 控制（假时钟下可压缩）；全程不调用 kernel 的 AgentPool / Runner，不 spawn 任何 agent 进程（测试以桩或调用计数断言为零）

#### AC-6.3: noop 失败可注入且参数化

**GIVEN** 创建 noop workitem 时传入参数 `failAt`（失败点位）与 `failCount`（失败次数）
**WHEN** 效果执行到达指定点位
**THEN** 前 `failCount` 次执行在该点位产生失败并落失败事件；超过 `failCount` 后执行成功；`failCount` 配置为无限时持续失败，由容器既有监督/重试机制（G4/G5 行为）兜底直至 failed

#### AC-6.4: 正常全路径端到端走通

**GIVEN** 干净环境（真实 SQLite 文件 + 真实 git 仓，临时目录）完成容器装配
**WHEN** 创建一个 noop workitem 并推进完整旅程：创建 → active → 效果执行 → 设置 timer wait → 到期 → done
**THEN** workitem 到达 done 终态；事件序列 seq 单调连续且含各次转移、outbox 各效果终态为 done、wait 已 resolve、status 投影与权威状态一致、artifact git 仓存在且至少一次提交——五者交叉一致可查

#### AC-6.5: 失败全路径端到端到达 failed

**GIVEN** noop workitem 注入持续失败（`failCount` 无限）
**WHEN** 容器按 G4/G5 既有重试与监督机制处理
**THEN** workitem 最终到达 failed 终态；失败原因与重试链可完整从事件日志审计（机制细节不在本组重复断言，仅断言组合后 failed 可达且可审计）

#### AC-6.6: SIGKILL 崩溃恢复端到端

**GIVEN** 容器以子进程方式运行，noop 以大 `delayMs` 拉开效果在途窗口
**WHEN** 分别在效果处于 pending 与 running 窗口对子进程 SIGKILL，随后重启容器进程
**THEN** 重启后从 outbox 重建在途效果并按 G4 恢复策略处置；workitem 最终到达终态；同一效果不产生重复副作用（不双跑）也不丢失（不停滞在无人推进的中间态）；恢复后事件 seq 续写不回退

#### AC-6.7: 并发多 workitem 互不串扰

**GIVEN** 同一容器实例并发创建 ≥3 个 noop workitem（延时与失败注入参数混合）
**WHEN** 它们同时推进
**THEN** 每个 workitem 的事件 seq 各自单调连续（reducer 串行，无交叉污染）；A 的失败/延时不影响 B 的推进；全部独立到达各自终态

#### AC-6.8: PID 锁双进程竞争——后启者拒绝启动

**GIVEN** 第一个真实进程已启动并持有 pid 锁（spawn 真实进程，非进程内模拟）
**WHEN** spawn 第二个真实进程竞争同一锁文件
**THEN** 后启进程拒绝继续启动（退出且日志含明确拒绝原因，退出码契约见 G-6.6）；先启进程不受影响持续运行；竞争全程锁文件内容保持为存活实例的 pid

#### AC-6.9: 退出只删自己的锁（6329d35 回归）

**GIVEN** 锁文件内容已被另一实例改写为新 pid（模拟 takeover 窗口）
**WHEN** 旧实例执行退出清理（`removeOwnPidFile` 语义）
**THEN** 清理返回 false，锁文件保留且内容仍为新实例 pid；仅当锁文件内容等于自身 pid 时才删除并返回 true

#### AC-6.10: index.ts 装配——启动恢复与优雅关闭挂钩

**GIVEN** index.ts 作为 composition root 装配容器运行时
**WHEN** 进程启动 / 收到关闭信号 / 触发 crash guard
**THEN** 启动时执行容器恢复：非终态 workitem + waits 重建待办（waits 重建复用 G5 机制）、outbox 重建在途效果（复用 G4 机制）、事件↔artifact 对账——以状态表为准对 artifact 仓做校验提交且对账后 git 仓工作区干净（复用 G4 机制，AC-4.10）；优雅关闭时容器运行时挂入既有 shutdown 序列（停止取新效果、停 watchdog 定时器、DB 写入一致后退出，running 效果处置语义见 G-6.4）；crash guard 的 cleanup 同样释放容器资源；装配代码仅做接线，不含业务分支判断

#### AC-6.11: config.ts 新增 workitems 路径配置

**GIVEN** config.ts 新增 workitems 相关配置项
**WHEN** 加载配置
**THEN** `workitems.sqlite` 文件路径与 `$DATA_DIR/workitems/` artifact 根目录均可配置且有合理默认值（缺省落于 DATA_DIR 下）；配置项仅为路径声明，kernel 不因此出现任何解释 workitem 语义的逻辑

#### AC-6.12: 架构依赖单向校验可执行

**GIVEN** 依赖检查工具/脚本已接入（选型见 G-6.2）
**WHEN** 对 src/ 全量执行依赖检查（本地命令与 CI 均可一键运行）
**THEN** 规则断言全部通过：kernel 模块（src/workitems/、src/worktypes/ 之外的现有 src 代码）不 import 这两层（composition root index.ts 的装配 import 与 config.ts 路径声明为唯一豁免）；src/workitems/ 不 import src/worktypes/；src/worktypes/ 仅向下依赖；豁免点之外的 kernel 源码不出现 workitem/assignment/phase 等业务标识符；任一违规即检查失败

### Flow AC

#### FLOW-6.1: noop 正常全生命周期
- **路径**: 创建 workitem → reducer 转移 active → outbox 效果执行（延时）→ timer wait → 到期动作 → done → artifact 提交
- **涉及 AC**: AC-6.1 → AC-6.2 → AC-6.4
- **验证点**: 每步落事件且 seq 连续；效果 pending→running→done；wait 到期即 resolve 并产生事件；status 投影随转移变化；git 仓提交数 ≥1
- **跨组**: Group 2-5（机制行为 AC 归属各组，本 Flow 仅验组合）

#### FLOW-6.2: 崩溃恢复旅程
- **路径**: noop 推进中 → SIGKILL → 进程重启 → 启动恢复扫描（index.ts 装配）→ 在途效果处置 → 事件↔artifact 对账 → 终态
- **涉及 AC**: AC-6.6 → AC-6.10
- **验证点**: 重启后在途效果可见且被按策略处置；恢复后 seq 续写不回退；最终终态与崩溃前推进意图一致；无双跑副作用；崩溃后 DB 与 git 尾部不一致被对账收敛（以状态表为准的校验提交存在、对账后 git 仓工作区干净）
- **跨组**: Group 4（outbox 与恢复及对账机制归属组）、Group 5（waits 重建）

#### FLOW-6.3: 双实例竞争与退出清理
- **路径**: 实例 A 启动持锁 → 实例 B 启动被拒 → takeover 窗口下 A 退出 → 锁文件完整性保持
- **涉及 AC**: AC-6.8 → AC-6.9
- **验证点**: 全程任意时刻最多一个存活容器实例；锁文件内容始终与存活实例 pid 一致；A 退出不删除 B 的锁
- **跨组**: 无（kernel lifecycle 既有能力，只验不改）

### Gaps

| 级别 | 编号 | 描述 | 影响 / 候选方案 |
|---|---|---|---|
| YELLOW | G-6.1 | PID 锁「后启拒绝 vs takeover 接管」语义需核定：lifecycle.ts 注释描述「新实例杀旧实例并改写锁」的 takeover 路径，与 AC-6.8「后启进程拒绝启动」可能是两种并存的启动模式 | Step 2 对照 index.ts 锁获取逻辑确认实际语义，必要时调整 AC-6.8 断言形态（拒绝 / 接管 / 按启动参数二选一） |
| YELLOW | G-6.4 | 优雅关闭对 running 效果的处置语义 PRD 未细化：等待执行完成，还是立即截断留 running 标记交给重启恢复 | 影响 AC-6.10 的可测断言；Step 2 定义（倾向截断 + 交恢复路径，与 SIGKILL 路径共用语义） |
| YELLOW | G-6.6 | 「后启进程拒绝」的退出码契约未定义：lifecycle.ts 约定 0=有意停止（不重启）/ 非 0=崩溃（supervisor 重启），被拒实例若非 0 退出会被 run-forever.sh 循环拉起 | AC-6.8 的退出码断言需与 supervisor 契约一并核定（倾向被拒视为有意停止，退出码 0 + 明确日志） |
| WHITE | G-6.2 | 依赖单向校验工具选型：biome 无 import 边界规则 | 候选：dependency-cruiser / 自写 AST 或 import-graph 脚本挂进 vitest；需能表达 index.ts/config.ts 的装配豁免 |
| WHITE | G-6.3 | SIGKILL 崩溃测试的窗口命中手段未定 | 候选：大 delayMs 拉宽窗口 + 轮询 DB 观察效果进入目标状态后 kill；或文件信号同步。决定崩溃用例的稳定性 |
| WHITE | G-6.5 | noop 失败点位（failAt）枚举未定义：reducer 是纯函数不宜注入失败 | 候选点位限定在效果执行器路径内（执行开始前 / 执行中 / 完成落库前），Step 2 定义点位常量集 |

### PRD 覆盖对照

| PRD 节 | 要点 | 覆盖 |
|---|---|---|
| §4.5 | WorkType 接口全签名；noop 退化实现（可控延时、可注入失败、回归夹具） | AC-6.1~6.3 |
| §4.3 前提 | 单实例是 reducer 模型地基，列为 M0 验证点而非假设 | AC-6.8、AC-6.9、FLOW-6.3 |
| §3.1 | 依赖严格单向；kernel 不 import 上层；worktypes 互不依赖（M0 仅 noop 一型，规则先立） | AC-6.12 |
| §3.2 | kernel 准入：仅通用能力，业务词汇出现即违规；PID 锁列 M0 验证点 | AC-6.10~6.12、AC-6.8 |
| §11 M0 行 | noop 打穿并发/效果/持久化/监督全部路径 + PID 锁单实例验证 | AC-6.4~6.7、FLOW-6.1~6.2 |

### UI 需求

不适用（has_ui=否，M0 无任何飞书交互与前端节点）。

---

## 设计（Step 2 追加）

### 对外接口

```ts
// src/worktypes/noop/index.ts
export const noopType: WorkType;                       // 九成员全实现（→ AC-6.1）
export function registerNoop(c: WorkitemsContainer): void;   // registry.register + registerHandler（装配点调用）
// noop 参数（建项时经 CreateInput.context 注入，类型内自行解析）
export interface NoopParams {
  delayMs: number;                                     // 模拟运行时长（→ AC-6.2）
  failAt?: 'before-run' | 'during-run' | 'before-report';   // (→ G-6.5)
  failCount?: number;                                  // Infinity 持续失败（→ AC-6.3）
  simulateResumable?: boolean;                         // resume 判定注入（→ G-4.3）
  heartbeatMode?: 'normal' | 'silent' | 'beat-no-finish';   // 驱动 FLOW-5.1/5.2
  heartbeatIntervalMs?: number;                        // 心跳上报间隔（默认 1000；与 cfg.heartbeatTimeoutSec 联动驱动心跳监督测试）
  timerWaitSec?: number;                               // 运行完成后的 timer wait 时长（默认 1）
  noopMaxRetries?: number;                             // 自报失败重派容忍（默认 1）
}
// src/workitems/container.ts —— index.ts 的唯一接入面（→ AC-6.10）
export function createWorkitemsContainer(deps: {
  dbPath: string; artifactsDir: string; logger: Logger; clock?: Clock;
}): WorkitemsContainer;
export interface WorkitemsContainer {
  api: WorkitemsApi; registry: WorkTypeRegistry; effects: EffectRuntime;
  start(): void;        // startupRecovery（S4 序列）→ executor + watchdog 启动
  stop(): void;         // 停 watchdog → 执行器停取新单 → abort 在途（效果留 running）→ store.close（→ G-6.4）
  backupJob(backupsDir: string): BackupJob;
}
```

### 内部结构

#### 1. noop WorkType（→ AC-6.1；纯转移状态机）

```
id='noop'; triggers={api:true}; topology=()=>'solo'; isDecisionStale=()=>false
permissions={mode:'readonly'}; checkpoints={requiredBefore:[]}
artifacts={briefTemplate:'noop assignment', reportRequired:true}
initialPhase = () => 'noop:idle'
onEvent(item, ev): switch ev.kind:                     // 函数体无 await/IO（tsc 非 async + 架构扫描）
  workitem_created → { phase:{to:'noop:running'}, dispatch:[solo assignment（deadline/cap 从 params）] }
  run_completed    → { phase:{to:'noop:waiting'}, waits:[{kind:'timer', deadlineTtlSec: timerWaitSec}] }
  timer_fired      → { phase:{to:'noop:done'}, terminal:'done' }
  run_failed       → ev.payload.assignmentRetries < noopMaxRetries     // 纯函数仅读 payload，零查库
                       ? { dispatch:[{replacesAssignmentId, retries+1, ...}] }   // 自报失败重派
                       : { phase:{to:'noop:failed'}, terminal:'failed' }         // (→ AC-6.5 失败可达 failed)
                     // assignmentRetries 由效果执行器 emit 时携带（=assignment.retries，replaces 链深度 → S3 ADR-9）
  其余（stalled/aborted/提醒/升级等容器机制事件）→ {}      // 容器机制层已处置，类型不动作
```

#### 2. noop run handler（src/worktypes/noop/run-handler.ts，→ AC-6.2, 6.3；G-4.3/6.5）

```
{ kind:'run', recovery:'resume-or-redispatch',
  canResume: (payload, a) => params.simulateResumable === true && a?.agent_session_id != null,
  run(ctx):
    ctx.setAgentSessionId(`noop:${assignmentId}`)
    ctx.writeArtifact(`assignments/${id}/brief.md`, ...)             // 任务卡落 git
    failsLeft = (params.failCount ?? 0) - assignment.retries          // 链上持久计数（→ G-6.5）
    if (failAt=='before-run' && failsLeft>0) throw NoopInjectedFailure
    循环: 每 params.heartbeatIntervalMs（默认 1000；heartbeatMode!='silent' 时）ctx.heartbeat()，
          直至 delayMs 耗尽或 ctx.signal aborted（beat-no-finish: 永不耗尽，等墙钟掐）
    if (failAt=='during-run' && failsLeft>0) throw NoopInjectedFailure
    if (failAt=='before-report' && failsLeft>0) return               // 不写 report → 收尾校验判失败 (→ AC-5.12)
    ctx.writeArtifact(`assignments/${id}/report.md`, 结论(含 eventsSince(ctx.batchFromSeq) 条数 → S3 ADR-6 批量窗口))
    // emit run_completed 由 EffectRuntime 收尾钩子在校验后统一发出
  resume(ctx): 同 run 主体但跳过 setAgentSessionId/brief（续跑不重置） }
```

全程零 AgentPool/Runner 引用（noop 只 import src/workitems/types——测试对 AgentPool spawn 计数断言为零，→ AC-6.2）。

#### 3. kernel 触点（→ AC-6.10, 6.11；ADR-2）

- **config.ts**：`workitemsDbPath: path.join(dataDir,'workitems.sqlite')`、`workitemsDir: path.join(dataDir,'workitems')`，可经 `WORKITEMS_DB_PATH`/`WORKITEMS_DIR` 覆盖——纯路径声明，零语义解释（→ AC-6.11）。容器调参在 src/workitems/config.ts 自管，不进 kernel。
- **index.ts**（仅接线，无业务分支）：`ensureSingleInstance`（不变，恢复序列第一步的「锁确认」即此调用先于 container.start()）→ `const container = createWorkitemsContainer({...config, logger})` → `registerNoop(container)` → `container.start()`；`releaseResources` 内加 `container.stop()`（crash guard 与优雅关闭共用）；`scheduleDailyBackup(store, dir, logger, [container.backupJob(dir)])`。
- **lifecycle.ts / store.ts**：零改动，只测。

#### 4. PID 锁断言形态核定（→ AC-6.8, 6.9；G-6.1/6.6，ADR-2）

实勘 `ensureSingleInstance`：读旧 pid → SIGTERM 杀旧 → 写自身 pid —— **takeover 语义**。AC-6.8 断言核定为（替代「后启拒绝」字面）：

```
GIVEN 真实进程 A 已启动持锁（spawn tests/fixtures/workitems-app.ts）
WHEN  spawn 进程 B 竞争同一锁文件
THEN  A 收到 SIGTERM 优雅退出且退出码 0（有意停止，supervisor 不拉起 → G-6.6）；
      B 持锁正常运行；接管完成后锁文件内容 == B.pid；
      全程任意时刻最多一个存活容器实例（轮询断言两 pid 不同时存活）
```

AC-6.9 原样保留：takeover 窗口下 A 退出走 `removeOwnPidFile` → 返回 false、锁内容仍为 B.pid（6329d35 回归，复用 tests/lifecycle.test.ts 既有形态 + 进程级复验）。

#### 5. 架构校验（→ AC-6.12；G-6.2）

tests/architecture.test.ts：`fs.readdirSync 递归 src/**/*.ts` → 正则提取 `import ... from '...'` → 解析相对路径，断言：(1) kernel 文件（src/ 除 workitems/、worktypes/、index.ts、config.ts）不指向 workitems|worktypes；(2) src/workitems/** 不指向 worktypes；(3) src/worktypes/** 只指向 worktypes 自身/workitems/kernel；(4) kernel 源码（豁免 index.ts/config.ts）无 `/\b(workitem|assignment|worktype|phase)\b/i` 标识符（grep 已实勘当前 kernel 干净，规则可即刻启用）；(5) src/workitems/** 内 `phase` 标识符仅出现于赋值/读取（属性访问、对象字面量、解构），不出现于比较运算符（==/===/!=/!==）或 switch 判别——「phase 只读写不比较」的静态可审查面（→ S2 AC-2.12，归属本清单，S2 设计节交叉引用此条）。`npm test` 即一键执行（本地与 CI 同命令）。

#### 6. SIGKILL 窗口命中（→ AC-6.6；G-6.3）

tests/fixtures/workitems-app.ts：最小装配（loadConfig 用环境变量注入临时 DATA_DIR）+ 创建 noop（参数经 `NOOP_PARAMS` JSON 环境变量）+ 真时钟运行。测试父进程：spawn → 轮询打开同一 workitems.sqlite（WAL 跨进程可读）等 `workitem_effects.status` 进入目标态（pending 窗口：kill 于 poke 前注入延迟；running 窗口：delayMs=30s 拉宽）→ SIGKILL → 重新 spawn → 轮询断言终态、seq 续写不回退、效果零双跑（事件计数）（→ AC-6.6）。

### 依赖关系

noop → workitems(types/container) → kernel(logger/backup 类型)；单向。被依赖：无（顶层叶子）。装配依赖注入点：registry.register(noopType) + effects.registerHandler(noopRunHandler) 均发生在 index.ts / 测试装配。

### 数据契约

NoopParams（上方接口段）经 `context_json.params` 持久化——崩溃重启后 handler 仍可读到注入参数（恢复测试的前提）。noop 事件不新增容器机制 kind 之外的事件（S3 清单封闭）。

### 测试策略

- 集成（进程内，FakeClock）：AC-6.4 正常全路径五面交叉断言（终态 done / seq 连续 / 效果全 done / wait resolved / 投影一致 / git log ≥1）；AC-6.5 failCount=Infinity → noopMaxRetries 耗尽 → failed，事件日志可审计重派链；AC-6.7 并发 ≥3 个混合参数 noop，各自 seq 连续、终态独立（A 失败不阻 B）；AC-6.1/6.2/6.3 接口与注入参数面。
- 优雅关闭与 crash guard（→ AC-6.10，G-6.4 截断语义）：长延时效果 running 时 container.stop() → 断言 watchdog 已停（推进 FakeClock 无新事件）、执行器不再取新单、在途效果保持 running 留库且 handler 收到 AbortSignal；同进程重新 start() → 该效果按恢复路径处置（resume/重派）；crash guard 路径调用 releaseResources → 断言 container.stop() 被调、DB 句柄关闭。「装配代码仅接线无业务分支」的验证手段：code review + 架构测试规则 (4)（kernel 业务词汇扫描豁免面收窄到 import/路径声明）兜底——fixture 为最小装配，不替代对真 index.ts 的此面审查。
- config 路径（→ AC-6.11）：单测断言缺省时 workitemsDbPath/workitemsDir 落 DATA_DIR 下；设 WORKITEMS_DB_PATH/WORKITEMS_DIR 环境变量后覆盖生效；config.ts 对两值仅做路径拼接零语义解释（架构测试规则 (4) 豁免面联动）。
- 进程级（spawn fixture）：AC-6.6 双窗口 SIGKILL（pending/running）；FLOW-6.3 takeover 双实例（断言形态见内部结构 4，→ AC-6.8/6.9）。
- 架构：tests/architecture.test.ts（→ AC-6.12）。
- Mock 边界：进程级测试零 mock（真 DB/真 git/真信号）；进程内测试仅 FakeClock 与 NoopParams 注入，不 mock 容器组件。

| 场景 | 类型 | 输入 | 期望 |
|---|---|---|---|
| 正常旅程 | Happy | delayMs=100, timerWaitSec=1 | open→active→waiting(timer)→done，五面一致 (→ AC-6.4) |
| 持续失败 | Error | failCount=∞ | failed 终态 + replaces 链完整可审计 (→ AC-6.5) |
| running 窗口 SIGKILL + 可 resume | Edge | simulateResumable=true | 原 assignment 续跑至 done，无新行 (→ AC-6.6/4.8) |
| takeover 竞争 | Edge | spawn A 后 spawn B | A exit 0、B 持锁、锁=B.pid、无双实例窗口违例 (→ AC-6.8) |
