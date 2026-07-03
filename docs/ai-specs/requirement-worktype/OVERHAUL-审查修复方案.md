# OVERHAUL 审查修复方案（WS-0~WS-10 三轮对照审查的遗留项）

> 日期：2026-07-03 ｜ 状态：**待实施** ｜ 读者：**执行本方案的 AI**
> 来源：OVERHAUL 全部 11 个 WS 落地后，逐提交对照《OVERHAUL-消息必达-活性自证-自适应.md》做了三轮
> 对抗式审查（WS-0~3 / WS-4~6 / WS-7~10 各一轮，每轮独立 agent 逐条核对 spec）。总体结论：实现高保真，
> 架构红线零违反，738 测试全绿。本文档只收敛**审查确认的遗留缺陷与测试缺口**，每项自包含（问题 / 证据
> file:line / 修法 / 测试要求），按组提交。
> 行号基线：HEAD = a1ed5c7（overhaul/req-v1 分支）。若行号漂移以符号名定位。

---

## 0. 执行须知（必读）

- 仓库 `/Users/zwh/agent-pipe`，TypeScript + Node（ESM，import 带 `.js` 后缀），测试 vitest。
- 验证命令：`npm run check`（typecheck + biome + vitest 全量）。**每组提交前必须全绿**。当前基线 738 测试 / 92 文件。
- 架构红线沿用 OVERHAUL 文档 §0.2（不重抄，要点）：容器层 `src/workitems/` 零业务语义；worktype 纯核心
  （`src/worktypes/requirement/` 非 handler 文件）纯同步无 IO；`src/feishu/` 不 import worktypes；run 结论只出自
  `emitRunConclusion`；新事件 kind 登记 `phases.ts` + 同步 anchor-drift 测试。
- **词汇守卫会逮注释**：`tests/architecture.test.ts` 禁止 feishu/kernel 层出现 `\b(workitem|assignment|worktype|phase)\b`
  独立词（驼峰如 `workitemId` 安全）。WS-9/WS-10 都踩过——写注释用「managed run」「需求侧」等替代词。
- 测试风格对齐同目录既有用例（沙箱容器 + 手造事件 + 合成报告）。e2e 先例：`tests/workitems/requirement-e2e.test.ts`。
- commit message 中文，格式对齐既有风格（如 `fix(requirement): 交付 diffstat 基线修复（审查修复 F1）`）。
- 不要顺手重构无关代码；本方案之外的发现记录在最终报告里，不擅自扩边。

### 建议提交划分与顺序

| 组 | 内容 | 建议 commit |
|---|---|---|
| 第 1 刀 | F1 + T7（同文件同链路） | `fix(requirement): 交付 diffstat 基线修复 + manifest 截断测试` |
| 第 2 刀 | F2 F3 F4 F5 + O1 O2 | `fix(requirement): 审查小修——立项超时提示/灯③契约条数/GC prune/diag-claim 等` |
| 第 3 刀 | T1~T6 + T8 T9 | `test(requirement): 审查长牙——意见回灌/监工返工链/选卡断言/催办与活性用例` |
| 第 4 刀 | D1 D2 | `docs(requirement): 落地记要修正（翻页上限笔误 + 补记两处出入）` |

---

## F 组：产品代码缺陷（4 实质 + 1 微小）

### F1【最重要】交付清单 diffstat 恒为 "(无改动)" —— base 基线错误

**问题**：`deliver_manifest` 生成的交付清单里，每个存活 worktree 的「改动概览」永远是 `(无改动)`，
spec §7.1「交付最后一公里给全 diffstat」的意图完全落空（worktree 已被 GC 时才显示占位串）。

**根因**（证据）：
- `src/worktypes/requirement/deliver.ts:31` `const base = opts.baseRef ?? 'HEAD'`，`:52` 调 `worktreeDiffStat(wt, base)`；
- `src/agents/worktree.ts:66-73` `worktreeDiffStat` 以 **worktree 为 cwd** 执行 `git diff --stat <base>...HEAD`——
  worktree 内 HEAD 即工作分支自身，`HEAD...HEAD` 恒为空；
- `src/index.ts` 注册处只传 `{ worktreesDir }`，`baseRef` 恒 undefined（spec §7.2 的注册示例也没传，坑是 spec 埋的）。

**正确基线是什么**：worktree 分支是从**主仓 HEAD** fork 的（`src/worktypes/requirement/worker-handler.ts:27,33,131`：
`worktreeAdd(assignment.repo, wt, branch, base)`，base 默认 `'HEAD'`，cwd 是主仓 → 解析为建树时主仓 HEAD）。
所以 diffstat 应该取「分支相对主仓当前 HEAD 的三点差异」——`git diff --stat <主仓HEAD>...HEAD`（三点 = 自动取
merge-base），即使主仓在 fork 后又前进过也正确。

**修法**：
1. `src/agents/worktree.ts`：`worktreeDiffStat(worktreePath, base?)` 的 base 改为可选；缺省时解析主仓 HEAD 作基线：
   ```ts
   export function worktreeDiffStat(worktreePath: string, base?: string): string {
     try {
       // 缺省基线 = 主仓当前 HEAD 的 sha；三点语法自动取 merge-base，主仓 fork 后前进也正确
       const resolved = base ?? git(mainRepoOf(worktreePath), ['rev-parse', 'HEAD']).trim();
       const out = git(worktreePath, ['diff', '--stat', `${resolved}...HEAD`]).trim();
       return out || '(无改动)';
     } catch {
       return '(worktree 已清理或不可读)';
     }
   }
   ```
   `mainRepoOf` 已存在（worktree.ts:87-97），复用即可。
2. `src/worktypes/requirement/deliver.ts`：删掉 `:31` 的 `?? 'HEAD'` 回落，`:52` 改为
   `worktreeDiffStat(wt, opts.baseRef)`（undefined 直接透传，走新的自动基线）。
3. `src/index.ts` 注册处不用改（继续不传 baseRef）。

**测试要求**（新文件 `tests/agents/worktree-diffstat.test.ts`，用真实临时 git 仓）：
- 造仓：tmpdir `git init` + 一次初始提交 →（另一 tmpdir 里）`worktreeAdd` 建分支 → worktree 内改文件并 commit；
- 断言 `worktreeDiffStat(wt)`（不传 base）输出**含改动文件名**、非 `(无改动)`；
- 主仓再前进一格 commit → 断言 diffstat 结果不变（三点 merge-base 语义钉死）；
- worktree 目录删掉 → 断言返回 `(worktree 已清理或不可读)`（既有降级语义不回归）。
- 注意 git 全局配置：测试仓需 `git -c user.email=... -c user.name=... commit` 或 env 注入，避免 CI 无 git identity 而挂。

### F2 立项 AI 抽取超时静默——缺 spec 点名的群提示（WS-10.1 唯一未落实子项）

**问题**：spec §WS-10.1 要求超时后「群里发『AI 提取超时，改为逐项收料』」。实现只做了
Promise.race + abort + 回退确定性收料（`src/index.ts:1187` `aiExtractIntake`），**没有群消息**——用户只看到
「🤔 正在提取…」然后莫名跳到逐项收料。且超时路径零测试；race 输掉的 `pool.send` promise 无 catch，若 abort 后
reject 会成 unhandled rejection。

**修法**：
1. `aiExtractIntake` 超时分支（返回 null 前）：`await sender.reply(msg.messageId, 'AI 提取超时，改为逐项收料。')`
   （拿不到 messageId 就 `sendText(chatId, ...)`，与调用方现有出口一致，失败只 log）。
2. race 输家兜底：`sendPromise.catch(() => {})`（在 race 之前挂上，防 unhandled rejection）。
3. 把「带超时的 send」抽成可测的导出 helper（先例：WS-9 的 `assembleAuqAnswers` 就是为可测而抽的）：
   `export async function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'>`，
   `aiExtractIntake` 内部改用它。

**测试要求**：`raceWithTimeout` 纯测两例（按时 resolve / 超时返回 'timeout' 且不抛）；假 pool（send 永不 resolve）
验证 aiExtractIntake 走超时 → abort 被调 → 返回 null（若闭包不易直测，至少覆盖 helper + 在
`tests/workitems/index-wiring.test.ts` 以源码文本断言超时分支存在——该文件有此风格先例）。

### F3 灯③真通过 note 缺契约条数（WS-7.3 字面遗漏）

**问题**：spec §7.3 要求真对账通过时 note 为 `'✅ 静态跨仓对账通过（契约 N 条接口）'`；实现
（`src/index.ts:329-348` `deliverGateNote`）只返回 `'✅ 静态跨仓对账通过'`。

**修法**：
1. `src/worktypes/requirement/integration.ts:62`：真通过分支 `ctx.emit('integration_check_passed', {})` 改为
   `ctx.emit('integration_check_passed', { interfaceCount: frozen.interfaces.length })`。
   （事件是 worktype 自产自销 + bridge 只读，加字段向后兼容；无需登记新 kind。）
2. `deliverGateNote` 真通过分支：从最后一条 integration_check_passed 的 payload 防御式读 `interfaceCount`
   （number 且 >0）→ `✅ 静态跨仓对账通过（契约 ${n} 条接口）`；读不到（历史事件）→ 保持现文案回落。

**测试要求**：`tests/workitems/requirement-integration.test.ts` 补真通过 payload 含 interfaceCount 断言；
`deliverGateNote` 已导出，纯测两例（带条数 / 无条数回落）。

### F4 worktree GC 降级路径缺 `git worktree prune`（WS-7.4 字面遗漏）

**问题**：spec §7.4 明确「worktreeRemove 失败降级 rm + `git worktree prune`」。实现
（`src/worktypes/requirement/worktree-gc.ts:65-70`）失败后只 `purgeDir`（rm），不 prune——主仓
`.git/worktrees/` 残留陈旧注册，同名分支/路径复用时可能碍事。

**修法**：
1. `src/agents/worktree.ts` 新增导出 `worktreePrune(repoPath: string): void`（`git worktree prune`）。
2. `worktree-gc.ts` 处理每个叶子 worktree 时：进 try 前先尝试 `mainRepoOf(wt)` 缓存主仓路径（本身可能抛，包 try）；
   `worktreeRemove` 失败的 catch 分支在 `purgeDir` 后，若主仓路径已知则 `worktreePrune(repo)`（再包 try/log——
   主仓被删的极端情形跳过即可，与 spec「主仓被删直接 rm」一致）。

**测试要求**：`tests/workitems/worktree-gc.test.ts` 若无真 git 仓先例，可与 F1 的真仓测试基建共用：造真 worktree →
手动破坏（删 worktree 目录但留主仓注册）→ 跑 GC → 断言主仓 `git worktree list` 不再含该路径。做不动则在
worktree.ts 层单测 `worktreePrune` 不抛 + GC 层以日志断言兜底，并在报告里注明。

### F5【微小】`/diag-claim` 登记的 claim 不带 chat_id —— 不进 WS-4 补拉枚举

**问题**：`src/bridge/commands.ts:304` `this.store.claimThread(rootId, kind, msg.userId)` 只传 3 参——
手动登记的 managed claim 无 chat_id/chat_type，`listManagedClaimChatIds()` 枚举不到，断线补拉漏掉该会话。
非生产路径（管理员诊断命令），但顺手补齐防未来踩坑。

**修法**：改为 `claimThread(rootId, kind, msg.userId, undefined, msg.chatId, msg.chatType)`（对照
`src/index.ts` runProbe/startIntakeGroup 两处的传参形状适配实际签名）。

**测试要求**：`tests/bridge/` 现有 /diag-claim 用例（若有）补断言存进的 chat_id 非空；没有则加一例。

---

## T 组：测试长牙（spec 点名要求缺失，或守护性断言未长上）

### T1【测试组最高优先】WS-5 意见回灌零覆盖——spec 5.5 点名的顺序断言

**问题**：`handleCheckpointAction` 的整段意见回灌（`src/index.ts:1480,1520-1523`：读 formValue.opinion → trim →
【拍板意见】/【打回意见】前缀 → **injectHumanMessage 先于 resolveWait**（D-E 的 seq 保证）→ reason 回退 →
防双击守卫 `getWait(waitId)?.resolvedAt === null`）没有任何测试。这是 WS-5 的核心行为 + 一段非平凡守卫逻辑。

**修法**（抽 helper 使其可测，先例 `assembleAuqAnswers`）：
1. 从 handleCheckpointAction 抽出导出函数（名字自定，如 `applyCheckpointOpinion`）：入参
   `{ workitems, itemId, waitId, approved, opinion }`，职责=「wait 未 resolve 且 opinion 非空 → injectHumanMessage
   （带前缀）」；handleCheckpointAction 改调它，行为逐字节不变（resolve 仍留在原地，保证注入在 resolve 之前调用）。
2. 若抽取影响面大，备选：不抽函数，直接写沙箱 e2e——用 `tests/workitems/requirement-e2e.test.ts` 的 harness 走到
   灯③ open，然后按 handleCheckpointAction 的顺序手动 `api.injectHumanMessage(...)` + `api.resolveWait(...)`，断言
   注入消息的 seq < resolve 后首个 dispatch effect 的 seq（batch 窗口覆盖性,D-E 的本质）。**优先方案 1**，方案 2 测不到桥层代码本身。

**测试要求**（4 例）：opinion 非空且 wait open → 注入一条带【打回意见】前缀的 human_message；opinion 空 → 不注入；
wait 已 resolved（双击场景）→ 不注入；注入调用发生在 resolveWait 调用之前（用调用记录数组断言顺序）。

### T2 WS-5 监工判大 rework 链缺容器级 e2e

**问题**：`gatekeeper_big resolve(action='rework') → owner reconcile → reconcile_passed(implement) →
gatekeeper_rework → rework_requested → 定向 rework worker` 全链只有 transition/effect 分段单测；
e2e harness（`tests/workitems/requirement-e2e.test.ts:118-126`）**未注册 `createGatekeeperReworkHandler`**，
容器接缝（decision.payload.action 经真实 resolveWait 透传、reconcile_check 在 implement 相位真跑）没验过。

**修法**：harness 注册处补 `effects.registerHandler(createGatekeeperReworkHandler())`（与 :122 的
gatekeeper_review 同批）。新 e2e 用例：满配双仓走到 implement → 合成 worker 报告带 gatekeeper 上报
（interfaceId 非空诱导判大，先例见既有监工用例）→ gatekeeper_big wait open → `api.resolveWait(waitId,
{ approved: true, payload: { reason: '已改图纸', action: 'rework' } })` → 合成 owner reconcile 报告完成 →
断言 rework_requested 事件出现 + 受影响仓出现 stage=rework 的 worker assignment → 跑完 fan-in → 监工 →
assess 收敛（回 integrate 或灯③）。

### T3 选卡分支长牙——把「必须有卡」变成可执行断言（补 WS-10.3 对 spec 10.9 末句的欠账）

**问题**：`surfaceCheckpoints`（`src/index.ts:1909`）对 awaiting_close（:1918）/ cancel_confirm（:1925）/
gatekeeper_big 的专属选卡分支零测试；WS-10.3 的全覆盖断言只写了「cancel_confirm 无 caseFileLabel」+ 注释说
「有专属卡」——**注释不是断言**，未来删掉选卡分支测试照样全绿，「无卡暗仓」防线没长牙。

**修法**：把 surfaceCheckpoints 里「wait.reason → 出哪张卡」的判定抽成导出纯函数（如
`waitCardKindFor(reason: string): 'closure' | 'cancel-confirm' | 'gatekeeper-big' | 'checkpoint' | 'case-file' | null`，
boundary 判定用现有 `checkpointBoundaryOf`），surfaceCheckpoints 改按它分发（行为不变）。
然后在 `tests/feishu/case-file.test.ts` 的全覆盖断言升级：枚举**所有会 raise 的 human wait reason**
（checkpoint:* / reconcile_conflict / gatekeeper_big / run_failed / integration_unresolved / retry_exhausted /
thrash / stalled_no_path / steer_escalated / cancel_confirm / awaiting_close），断言每个 reason 经
`waitCardKindFor` 都返回非 null——新 reason 忘配卡时测试红。

### T4 WS-6 立项 gate 中途 ready 翻 false 的完整序列（spec 6.1 点名钉死项）

**问题**：spec 要求测试钉死「gate wait 已 open 时填第 2 仓 → ready 翻 false（卡片藏按钮）→ 补齐 prd/acceptance →
ready 复真 → **复用同一 open wait 不重弹**」。现状各环节分散有据，无一条串起来的用例。

**修法**：`tests/workitems/requirement-e2e.test.ts` 参照 :277 的「补料 after the gate opened does NOT raise a
duplicate gate」用例新增一例：单仓料齐 → gate wait open（记 waitId）→ intake_field_set 填第 2 仓 → 断言
`isGateReady(state) === false` 且 open wait 仍是同一 waitId（未撤回未重弹）→ 补 prd/acceptance → 断言 ready
复真、waitId 不变 → resolve 后正常推进。卡片按钮隐藏/复现由 `tests/feishu/intake-card.test.ts` 既有
「未料齐不出按钮」用例背书，不必重复。

### T5 WS-3「resolve 后不催」用例空转（spec 3.4 点名用例失去区分力）

**问题**：`tests/workitems/watchdog.test.ts:137`「ignores resolved waits when their deadline arrives later」在
`now = createdAt` 时 tick——新催办公式下（首催 due = createdAt + 4h）此刻**未 resolve 的 wait 也不会催**，
断言空转；删掉 resolved 守卫测试照样绿。

**修法**：该用例（或新增一例）改为：建 human wait → resolve 它 → 假时钟推进 > `waitRemindAfterSec` → tick →
断言无 `wait_reminder` 入队。

### T6 WS-1 活性判定「有 pending/running effect 不报警」分支零覆盖（spec 1.6 点名用例）

**问题**：`scanLiveness`（`src/workitems/watchdog.ts:154`）的 alive 三条件中 `listInflightEffects` 分支无直接
测试（open wait / running assignment 两条都有）。

**修法**：`tests/workitems/liveness.test.ts` 补一例：must-progress 单元清空 assignments/waits，但保留（或手动
insert）一条 pending 状态的 effect 行 → 假时钟推过 grace → tick → 断言无 `liveness_stalled`。

### T7 WS-7 manifest 截断用例缺失（spec 7.6 点名；与 F1 同刀提交）

**修法**：`tests/workitems/requirement-deliver.test.ts` 补一例：造多仓/长路径使 manifest 全文 > 3000 字 →
断言 `manifest_ready.summaryText` 含「（已截断，全文见 delivery/manifest.md）」且 `repos` 数组完整不截断；
`delivery/manifest.md` artifact 为全文。（顺带按 O2 修正截断边界后同步断言总长 ≤ 3000。）

### T8 WS-9 run-handler onAskUser 转发零覆盖（spec 9.4 点名的集成测试之一）

**问题**：`src/worktypes/agent-run/run-handler.ts` callbacks 里的 onAskUser 转发（约 :241-248）无测试；
ProgressCards 侧已测，接缝没测。

**修法**：`tests/workitems/agent-run-handler.test.ts` 有伪 progress sink 先例（:247/:279 附近）——补一例：
fake runner 在 run 中触发 `callbacks.onAskUser(id, { questions })` → 断言 sink 收到
`{ assignmentId, workitemId, title, questions }` 四字段齐全。

### T9 WS-10.2 caseFileDetail 带仓零覆盖

**修法**：`tests/feishu/case-file.test.ts` 补两例（`caseFileDetail` 已导出，`src/index.ts:269`）：
reconcile_conflict 事件 payload 带 `unresolved: [{ repos: ['a','b'] }]` → detail 含「涉及：」与两仓名；
gatekeeper_big 带 `raises: [{ repo: 'x' }]` → detail 含 x。

---

## D 组：文档修正（落地记要如实性）

### D1 落地记要笔误：翻页上限「500 条」实为 2000 条

`docs/ai-specs/requirement-worktype/OVERHAUL-消息必达-活性自证-自适应.md:742`「500 条/单次翻页上限已加告警」
与代码不符——`src/feishu/sender.ts:330` `MAX_PAGES = 40`（×50/页 = 2000 条）。改为「2000 条（40 页×50）/单次
翻页上限已加告警」。

### D2 落地记要补记两处审查确认的出入（诚实性补账）

在落地记要「与方案的出入」小节追加两条：
1. **WS-3 §3.2 可选项未做**：「管控台 resolve 后 patch 旧卡为已处理」跳过（spec 标可选并要求注明，此前漏记）。
2. **WS-1 §1.4 超限日志降级**：spec 写「保留 warn」，实现改为 `logger.info` 并换文案（超限从缺口告警变成
   正常补派流程的一部分，降级有意为之）。

---

## O 组：可选小修（低优先，顺手做，做不动就跳过并注明）

### O1 watchdog `livenessViolations` Map 终态条目不清除

`src/workitems/watchdog.ts:40` 的 Map 只在 item 活着/豁免时 delete（:158,:166）；item 进终态后
`listNonTerminal` 不再遍历到它，条目永久驻留（微量内存，无正确性影响）。修法：`scanLiveness` 开头对 Map keys
做一次「不在本轮 nonTerminal id 集合中 → delete」的清扫。测试可选。

### O2 manifest summaryText 截断后总长略超 3000

`src/worktypes/requirement/deliver.ts:71-74` 先 slice(0,3000) 再追加后缀，总长 > MAX_SUMMARY_CHARS。
修法：slice 预留后缀长度（`MAX_SUMMARY_CHARS - suffix.length`）。与 T7 用例同刀。

---

## 完成定义

- 全部 F/T/D 项落地（O 项可选），`npm run check` 全绿（预期 738 + 新增用例）；
- 每组一次提交（见 §0 提交划分），高风险改动（F1）提交前自查：三点 diff 语义、mainRepoOf 在 worktree 内可用、
  降级占位串不回归；
- 在本文档头部状态改「已实施」，末尾追加简短「✅ 落地记要」：逐项完成状态、与本方案的出入、跳过项及原因；
- 不引入任何 OVERHAUL 文档 §2「明确不做」名单里的东西（自动 MR/push、常驻会话、stdin 注入等）。
