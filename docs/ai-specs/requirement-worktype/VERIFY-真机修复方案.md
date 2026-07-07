# VERIFY 真机修复方案：首轮真机验证暴露的 6 个问题（含 R5 根治）

> 日期：2026-07-07 ｜ 状态：**已实施**（V1 d3c83af / V2 5c1f03f / V3 c968d83 / V4 本刀）｜ 读者：**执行本方案的 AI**
> 来源：首轮真机验证台账 `VERIFY-真机验证台账.md`（#1~#5 + R5 实锤）。本方案由独立复核产出——
> **台账的现象与排查结论可信，但修法有四处被改判**（见各节「与台账修法的分歧」），以本方案为准。
> 行号基线 = overhaul/req-v1 分支 HEAD（878 测试全绿）。行号漂移以符号名定位。

---

## 0. 执行须知（必读）

- 仓库 `/Users/zwh/agent-pipe`，验证 `npm run check`，**每刀提交前全绿**。
- 架构红线沿用 OVERHAUL §0.2：容器层零业务语义；worktype 纯核心纯同步（worker-handler / deliver /
  worktree-gc 属 handler/任务侧，允许 IO，有先例）；feishu 不 import worktypes；resolveWait / emitRunConclusion
  唯一写口不变；**本方案零新增事件 kind**（anchor-drift 断言数不变）。
- 词汇守卫照旧。桥层改动走 DI 式导出可测（先例 runDelegationDue / applyCheckpointOpinion）。
- 修复期间**不要顺手做台账之外的优化**；新发现记报告，不扩边。

### 提交划分（按优先级排刀）

| 刀 | 问题 | 建议 commit |
|---|---|---|
| 1 | #5 + R5（交付完整性，P0） | `fix(requirement): 交付完整性——worker 必提交 + 血统续接 + 清单接手命令 + GC 兜底 (VERIFY V1)` |
| 2 | #4 + #3（发卡竞态 + 意见双派，P1） | `fix(requirement): 发卡竞态守卫 + 卡片意见静默注入与 note 透传 (VERIFY V2)` |
| 3 | #1（流空闲超时 + 卡片停更提示，P1） | `fix(agents): 流空闲超时自愈 + 流式卡停更如实标注 (VERIFY V3)` |
| 4 | #2（worker MCP 收窄）+ 台账回写 + 收尾 | `fix(requirement): managed run MCP 严格空配置 + 验证收尾 (VERIFY V4)` |

---

## V1【P0】#5 + R5：交付完整性——「未提交产出隐形且会被 GC 删掉」+「换轮丢前轮改动」

### 现象与根因（台账排查正确，两问题同根共治）

- **#5**：worker 遵循 CLI 默认纪律「不主动 commit」→ 改动全留在 worktree 未提交 → `deliver_manifest`
  只读已提交 diff → 交付清单报「(无改动)」；接手命令 `git switch <branch>` 在主仓失败（分支被 linked
  worktree 占用）；**终态 7 天后 worktree-GC 会连未提交产出一起删除**。经核实 `composeWorkerPrompt`
  确实没有任何 commit 指令——这是系统性契约缺口：整条交付链假设 worker 会提交，但没人告诉它。
- **R5**（实锤）：每轮 worker 的 worktree 都从主仓 HEAD 新开分支（`prepareWorkspace` →
  `worktreeAdd(..., base)`，base 恒 'HEAD'），上一轮改动不在新 worktree——本轮真机全靠一条恰好存在的
  旧 codex 分支才没丢产出。

### 与台账修法的分歧

台账给了「或 manifest 改读未提交 diff」的备选——**否决**：未提交状态随 worktree GC 消亡，读它只是把
谎话说圆；提交到分支才是持久解。采「必提交」方向并加双兜底。

### 修法（四件套，彼此闭环）

1. **worker prompt 明确提交契约**（`src/worktypes/requirement/worker.ts` composeWorkerPrompt 产出要求）：
   「完成后必须把全部改动 `git commit` 到当前分支（可多次小提交；**禁止 push、禁止建 MR**）——你的
   分支就是唯一交付物，未提交的改动会在交付清单里隐形并最终被清理丢弃。」
2. **afterRun 兜底自动提交**（`worker-handler.ts` afterRun，仅 role==='worker'）：run 成功收尾时若
   worktree 存在且 `worktreeIsDirty` → `git add -A && git commit -m "chore: run 收尾兜底提交（自动）"`
   （execFileSync，worker-handler 本就是 IO 文件；包 try/catch 只 log——兜底失败不拖垮收尾）。
   结构性保证 manifest 有真 diff、GC 不再吞产出。注意与 canResume 的 dirty 判定无冲突（那是给
   崩溃恢复用的，成功收尾后本就该 clean）。
3. **R5 血统续接**（`prepareWorkspace` 换基线）：
   - `run-handler.ts` 给 `RunStrategy.prepareWorkspace` 输入对象补 `events?: WorkItemEvent[]`
     （E2/E5 同款中性透传，传 runAgent 开头已取的 `allEvents` 快照）；
   - worker-handler 新纯 helper `lastWorkerBranch(events, workitem, repo, excludeAssignmentId)`：
     byRepo 扫最后一条该仓 `role==='worker'` 的 run_completed（排除自己；先例 lastWorkerWorktrees），
     返回 `branchFor(workitem, {id, repo})`；
   - `prepareWorkspace` 建新 worktree 时：`base = lastWorkerBranch(...)` 且经
     `git -C <repo> rev-parse --verify <branch>` 确认存在 → 用它；否则回落 `opts.baseRef ?? 'HEAD'`。
     一处修改覆盖**所有换轮类型**（rework / fix / retry / stall 重派），无需在各 dispatch 点穿传。
     注：分支在 worktreeAdd 时即创建，即使那轮崩了分支也在——血统链对崩溃也成立（未提交部分本就
     该由重试轮重做）。
4. **交付清单与 GC 收尾**（`deliver.ts` + `worktree-gc.ts`）：
   - manifest 每仓渲染改为：worktree 目录仍存在 → 「工作副本：`cd <worktreePath>`（分支在此签出）」+
     「主仓接手：`git worktree remove <worktreePath>` 后 `git switch <branch>`（或等自动清理后直接
     switch）」；已清理 → 保持现有 `git switch` 命令。fs.existsSync 判断（effect handler 允许 IO）。
   - worktree-gc 删除前：`worktreeIsDirty` → 先 `git add -A && git commit -m "chore: GC 前兜底提交（自动）"`
     再 remove（try/catch，提交失败则跳过该 worktree 不删并 warn——宁留勿丢）。

### 测试

- worker prompt 含提交契约文案（含「禁止 push」）；
- afterRun 兜底：真临时 git 仓 worktree 留未提交改动 → afterRun 后 `git status` clean 且 log 出现兜底
  提交；已 clean 时不产生空提交；
- lastWorkerBranch 纯测（两轮取最后/排除自己/无历史 undefined）；prepareWorkspace 血统：真仓两轮——
  第一轮 worktree 提交改动后，第二轮新 worktree 的文件里**含第一轮改动**（R5 回归钉死）；分支不存在
  回落 HEAD；
- manifest：worktree 存在时输出 `cd <worktreePath>` 与 worktree remove 提示；不存在时回落现状；
- GC：dirty worktree → 先提交后删、分支上能看到兜底提交；提交失败路径 → 不删 + warn。

---

## V2【P1】#4 + #3：发卡竞态 + 意见注入双派

### #4 灯③卡 ×3 —— 改判根因：并发 TOCTOU，不是缺判断

台账修法①「发卡前查 card_msg_id，有则不发」——**该判断早已存在**（surfaceCheckpoints 对
`w.cardMsgId !== null` continue）。真正根因：worker done 后的级联（gatekeeper_passed →
integration_check_passed → manifest_ready → inspect 派发…）让 postStatus 在 1~2 秒内被连续调用多次，
每次都 async 走到 `replyCard`（网络级慢）——**三次调用都在第一张卡回执落库前读到 cardMsgId=null**
→ 三张全发。「为何恰好 3」= 首张卡在飞行窗口内到达的级联事件数，机制已明，台账修法②的
「补 debug 日志定位」不必做。

**修法**：`surfaceCheckpoints` 加模块级 in-flight 守卫 `Map<waitId, Promise<void>>`（或 Set）：
进入发卡分支前先查，在册 → skip；发送 await 前登记、finally 注销。重启丢守卫最坏重发一张
（与 cardMsgId 持久化互补），可接受。**测试**：假 sender（reply 延迟 resolve）+ 并发调三次
surfaceCheckpoints → 断言只发一张;（若 surfaceCheckpoints 不易直测，抽守卫为可测小件或以
DI 导出，先例 runScoutResult）。

### #3 病历带意见点「继续」→ steer + worker 双 run —— 改判根因与修法

台账修法「二选一：只重派 worker 或先起 steer 判」——**两个都不采**。真正根因是 WS-5 的 D-E 意见
注入与 WS-2 的 onHumanMessage 自动派 steer 的**组合效应**：`applyCheckpointOpinion` 先注入
human_message → onHumanMessage 见 owner 空闲 → 派 steer；随后 resolve 路由又派 worker 重跑——
一次点击两个 run。**且这不是 run_failed 专属**：灯③打回带意见同样会「注入触发 steer + redoPhase
再派 steer」双 steer 串行空烧（台账未发现）。「先起 steer 判」会让重试多等一轮、多烧一个 run，否决。

**修法（两件）**：

1. **意见注入带静默标记**：`api.injectHumanMessage` payload 加可选 `silent?: boolean`（容器只搬运，
   中性）；`applyCheckpointOpinion` 注入时带 `silent: true`；`onHumanMessage` 开头：
   `silentOf(ev.payload) === true → return {}`（新增防御式 helper）。意见仍在批窗口内，由 resolve
   路由派出的 **owner** run（steer/reconcile/assess）作为 followups 正常读到——消息必达语义不变，
   只是不再额外自派 steer。
2. **意见以 note 透传进 worker 重派**（补齐 worker 读不到 followups 的缺口）：
   - `handleCheckpointAction` 把 opinion 放进 resolve 的 `decision.payload.note`；
   - `onWaitResolved` 的 run_failed / retry_exhausted / stalled_no_path 分支：approved →
     `retryCurrentPhase(item, noteFromDecision(ev))`；
   - `retryCurrentPhase(item, note?)` / `workerDispatches(item, parent, reposOverride?, note?)`
     增加可选 note，落 `payload.note` → 既有 `noteFromPayload` → worker prompt 的「定向施工指令」
     （E6 标题，链路现成）。owner 分支（split 对账）无需 note——意见走 followups。

**测试**：silent 注入 → onHumanMessage 返回 {}（非 silent 照旧派 steer，回归）；opinion → decision
payload note → retryCurrentPhase 派出的 worker spec 带 note；灯③打回带意见 → 只派一个 steer
（redoPhase 的那个）；e2e：run_failed 病历带意见点继续 → **恰一个** worker 重派（带 note）、零 steer。

---

## V3【P1】#1：流空闲超时 + 卡片停更如实标注

台账两个方向都对，细化两点（吸取 ai-sentinel「假活心跳」事故教训）：**卡片提示必须由真实的
最后事件时刻驱动，绝不做独立于真实进度的心跳**；空闲阈值必须大于长工具执行的静默窗口。

1. **runner 流空闲超时**（`src/agents/claude/runner.ts` 流读取处）：每收到一条 stream 事件重置
   计时器；连续 `AGENT_STREAM_IDLE_TIMEOUT_MS`（默认 300_000，env 可调，0=禁用）无任何事件 →
   kill 子进程，run 以 error `stream idle timeout (300s, 最后事件 HH:mm:ss)` 失败 → managed 路径走
   WS-8 首败自动重试（错误串勿含 'write-guard fail-closed'）；bridge 会话同样适用（同一失败模式）。
   注意长工具（跑测试/装依赖）期间 CLI 事件间隙可达分钟级——300s 起步，勿激进。
2. **流式卡 stale 标注**（`src/feishu/progress-cards.ts`）：RunEntry 记 `lastEventAt`（真实事件驱动）；
   组件内一个轻量 interval（组件生命周期内，dispose 清理）扫描 running 条目：
   `now - lastEventAt > 90s` → patch 一次追加「⏳ 已 N 分钟无新输出（最后活动 HH:mm:ss）——等待
   模型响应中，超时将自动重试」；恢复事件到来后由正常刷新覆盖；同一 stale 期只 patch 一次 +
   之后每 5 分钟至多刷一次（防飞书 API 刷屏）。文案不许假装「处理中」。

**测试**：runner——假流（可控事件间隔 + 假时钟/可注入 timeout）：事件持续则不超时；静默超阈值 →
进程被 kill + 错误串含 'stream idle timeout'；progress-cards——lastEventAt 更新、stale patch 恰一次、
恢复后不再带 stale 文案（假 sender 断言 patch 内容与次数）。

---

## V4【P2】#2：managed run MCP 严格收窄 + 收尾

**根因核实**：`runner.ts:248` `if (!options?.mcpServers?.length) return null` ——空数组与 undefined
同样**不写 mcp-config、不带 `--strict-mcp-config`** → 子进程继承用户全局 MCP（firecrawl/lark/n8n/
mobile 全套）。台账观察到的 owner/worker 差异不影响修法：**语义应当三分**——undefined = 继承
（bridge 普通会话保持现状），显式 `[]` = 严格空（managed run 全部走这里），非空 = 严格指定集。

**修法**：
1. runner：`options.mcpServers === undefined → null`（继承不变）；否则（含空数组）写 config
   （空集则 `{"mcpServers":{}}`）并带 `--strict-mcp-config`；
2. managed run 统一显式传 `mcpServers: []`：在 `agent-run/run-handler.ts` 的 runAgent 组装 options 处
   兜底（worktype runOptions 未指定时补 `[]`）——worker/owner/probe 一处收口，防再漏；
3. 顺带在日志里保留实际生效模式（strict-empty/inherit/strict-set），便于下次真机核对。

**收尾**：台账 #1~#5、R5 状态改「已修（VERIFY V1~V4，commit 哈希）」；本文档状态改「已实施」+
落地记要；OVERHAUL 附录 B 追加复验项：⑰ 交付清单出真实 diffstat + 接手命令可执行；⑱ 二轮返工
新 worktree 含首轮改动；⑲ 病历带意见点继续只起一个 worker 且 note 进 prompt；⑳ 灯③级联只出一张卡；
㉑ 拔网线 5 分钟流式卡出「⏳ 无新输出」标注、恢复或超时自动重试；㉒ worker 子进程无用户 MCP。

**测试**：runner 三分语义各一例（undefined 无 --strict-mcp-config / [] 有且 config 空 / 非空照旧）；
run-handler 兜底注入 `[]` 断言。

---

## 完成定义

- V1~V4 全落地，`npm run check` 全绿；零新增事件 kind；容器层除 `injectHumanMessage` payload 透传
  外零改动；
- **V1 提交前自查**（本方案最高风险刀）：血统续接对 stall 重派 / gatekeeper rework / integration fix /
  retryCurrentPhase 四条换轮路径全部生效（真仓测试至少覆盖两条）；兜底提交绝不 push；
- 台账与本文档收尾（见 V4）；汇报最终测试数与逐项状态。

---

## 落地记要（实施后补）

> 实施日期：2026-07-07 ｜ 基线 878 → 最终 **934 测试全绿**（本轮 +56，含四刀新增用例）。
> 提交序列：`e3cf0f2`(DELEGATE checkpoint，见下) → V1 `d3c83af` → V2 `5c1f03f` → V3 `c968d83` → V4 本刀。

### 前置：工作树里有一批未提交的 DELEGATE 在途工作

执行前工作树已带一批与 VERIFY 无关的 **DELEGATE 委托模式在途改动**（`delegation.ts` 新文件、`watchdog.ts`、
`src/index.ts`、`requirement/index.ts` 等，896 测试全绿 = 878 + DELEGATE 18）。因 V2 必改 `src/index.ts` /
`requirement/index.ts`（与 DELEGATE 同文件），为保证每刀 VERIFY 提交不混入无关改动，先把这批 DELEGATE 改动
原样落一个独立 checkpoint `e3cf0f2`（`chore(delegation): …`），VERIFY 四刀叠在其上。**这批 DELEGATE 工作非
VERIFY 范畴**，作者可自行 reorder / squash / `git reset --soft` 还原。

### V1（#5 + R5，交付完整性）落地点

- 新增 kernel 原语 `agents/worktree.ts::worktreeCommitAll`（add -A && commit）、`branchExists`（rev-parse --verify）。
- worker-handler：`afterRun` 加 worker 分支（成功收尾 dirty → 兜底提交）；`prepareWorkspace` 换基线走新纯函数
  `lastWorkerBranch`（run_completed 血统，排除自己）+ `branchExists` 确认存在则以它为 base；run-handler 的
  `RunStrategy.prepareWorkspace` 接口 + 调用点补 `events` 透传。
- **四条换轮路径核实**：stall 重派 / gatekeeper rework / integration fix / retryCurrentPhase 全部经
  `retryCurrentPhase`/`redoPhase` 汇入 `workerDispatches`（或 owner reconcile 再转 workerDispatches），每次都
  生成**新 assignment → 新 worktree 路径 → prepareWorkspace 全新执行**，故一处血统逻辑统一覆盖四条。真仓测试
  打在这条共享机制上（血统续接 + 分支不存在回落 HEAD + afterRun 兜底 + GC 删前兜底/失败宁留），覆盖 ≥2 条。
- GC：删除前对 dirty worktree 兜底提交，提交失败**宁留勿丢**（跳过整目录删除、warn、下次再试）——这是 worker
  从没成功收尾过（崩溃/中断，afterRun 没跑到）时的最后一道防线。
- 非显然坑：`worktree-gc-prune.test.ts` mock 了整个 `worktree.js` 模块，缺我新增的 `worktreeIsDirty`/
  `worktreeCommitAll` → 新调用抛错走进「宁留勿丢」跳过删除 → 该测试红。补齐 mock（返回 clean）修复。

### V2（#4 + #3，发卡竞态 + 意见双派）落地点

- #4：`withInFlightGuard`（导出可测）+ closure 级 `cardsInFlight` Set，surfaceCheckpoints 发卡经它收口。
- #3：容器 `injectHumanMessage` payload 加可选 `silent`（唯一容器改动，中性搬运）；`applyCheckpointOpinion`
  注入带 `silent:true`；worktype `onHumanMessage` 见 `silentOf` 短路；`handleCheckpointAction` 把 opinion 落进
  `decision.payload.note`（有 action 或有 opinion → 走 resolveWait 单写口，否则保持 workbenchAdapter 不变，
  二者底层同一 `api.resolveWait`）；`onWaitResolved` 三条病历分支 approved → `retryCurrentPhase(noteFromDecision)`
  → `workerDispatches(…, note)` → composeWorkerPrompt 定向施工指令。
- 与方案的适配：#3 的 e2e 因容器 e2e 脚手架较重，落在 **transition 层**驱动「一次点击产生的两个事件（silent
  human_message + 带 note 的 wait_resolved）」的组合，忠实复现并证伪双派（一个 worker、零 steer；灯③ 一个 steer）。

### V3（#1，流空闲超时 + 卡片停更）落地点

- runner：`StreamIdleWatchdog`（可测）+ `streamIdleTimeoutMs`（env，0=禁用）+ `streamIdleTimeoutError`（错误串
  不含 'write-guard fail-closed'）；每条 stream 事件 kick、turn 起点也 kick、done/close/error/dispose/abort stop；
  超时 → SIGKILL 卡死子进程 + reject（→ run_failed → WS-8 首败重试）。bridge 会话共用同一 ClaudeRunner，自动适用。
- 卡片：`StreamingCard` 记真实最后事件时刻（onText/onToolUse，**不含**时钟心跳），复用 5s 心跳兼 stale 巡检；
  `buildStreamingCard` 加可选 `staleNote`。文案「⏳ 已 N 分钟无新输出…超时将自动重试」，恢复事件即清空。
- 适配：因 formatClock 显秒，5s 心跳本就每拍 PATCH（elapsed 走秒），stale 标注随之附着；`staleNotedAt` 门控让
  stale 文案（N 分钟）至多每 5 分钟重算，不额外增负载。runner 无 mock-spawn 集成脚手架，故 kill+reject 的接线由
  typecheck + 评审保证，看门狗/纯函数以假时钟直测（覆盖「事件持续不超时 / 静默触发 / 0 禁用 / 错误串」）。

### V4（#2，managed run MCP 严格收窄）落地点

- runner：`resolveMcpConfig`/`mcpModeOf`（可测）三分语义——**undefined=继承**（无 config → 无 --strict-mcp-config，
  bridge 普通会话现状不变）；**显式 []=严格空**（写 `{"mcpServers":{}}` + --strict-mcp-config）；**非空=严格指定集**。
  spawn 日志加 `mcpMode`。
- run-handler：managed run 兜底 `mcpServers: strategyOptions.mcpServers ?? []` 一处收口（worker/owner/probe 全覆盖），
  worktype 显式指定则原样透传。
- 非显然点：`runOptionsFingerprint` 把 undefined 与 [] 都归空（不区分继承/严格空），但 managed run 恒传 []、bridge
  恒 undefined，同一 runner 不混用 → 池的进程重建判据无碍，未改 fingerprint。
