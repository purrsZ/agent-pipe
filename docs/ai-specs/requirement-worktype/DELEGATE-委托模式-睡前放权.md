# DELEGATE 方案：委托模式——睡前放权，到点自动过灯

> 日期：2026-07-03 ｜ 状态：**已实施**（2026-07-04，落地记要见文末）｜ 读者：**执行本方案的 AI**
> 来源：用户诉求「任务下发后我去睡觉，流程别在停靠站干等我」。现状是结构性"节点必停"：三盏灯 + 病历
> 全部等人，夜间零推进。本方案给出**结构化的、有范围、有时限、可撤销、全程留痕**的预授权机制——
> 参考 ai-sentinel `/auto` 的升级条件分类，但做成内核结构而非 prompt 约定。
> 本方案自包含；行号基线 = overhaul/req-v1 分支 HEAD ≈ ee73b6c。行号漂移以符号名定位。

---

## 0. 执行须知（必读）

- 仓库 `/Users/zwh/agent-pipe`，验证命令 `npm run check`，**每刀提交前全绿**。基线 797 测试 / 98 文件。
- 架构红线沿用 OVERHAUL §0.2：容器层 `src/workitems/` 零业务语义（本方案容器侧只做 opaque 字符串匹配
  与时间比较，与 openWaitReasons enrich / wait_reminder 同级）；worktype 纯核心纯同步；feishu 不 import
  worktypes；**resolveWait 是唯一写口**；`delegation_due` 是容器事件（与 wait_reminder / liveness_stalled
  同类），**不登记** `REQUIREMENT_EVENT_KINDS`，anchor-drift 断言数不变。
- 词汇守卫（`tests/architecture.test.ts`）：feishu/kernel 层注释禁 `workitem|assignment|worktype|phase`
  独立词。
- 桥层可测性先例：`backfillClaimedChats` / `applyCheckpointOpinion` 都是依赖注入式导出函数 + 单测，
  本方案桥层执行器照此办理。
- **不要重开 §1 决策台账**；与代码现状对不上时按意图适配并记入落地记要。

### 建议提交划分

| 刀 | 内容 | 建议 commit |
|---|---|---|
| 1 | 容器地基：delegation 表 + watchdog 扫描 + delegation_due | `feat(workitems): 委托地基——授权表 + 到点中性事件 (DELEGATE D1)` |
| 2 | 业务执行：/delegate 命令 + 白名单 + guard + 桥层自动 resolve | `feat(requirement): 委托模式——睡前放权三灯自动过 (DELEGATE D2)` |
| 3 | 卡片提示 + runbook + 文档收尾 | `feat(requirement): 委托收尾——卡片提示 + 手验项 (DELEGATE D3)` |

---

## 1. 设计决策台账（已拍板，执行时不要重开）

- **D-1 委托 = 人预先拍板，不是 AI 代拍板**。自动 resolve 的 decision 恒为 `approved: true`，operator 记
  `delegation`，reason 记「【委托】+ 授权原文 + 到期时间」——事件流留痕完整，事后可审计"这个灯是谁批的、
  凭什么批的"。**委托只会"通过"，永不"打回"**——打回需要意见，那是人的活。
- **D-2 白名单只含推进型三灯，永不扩到事故类**。可委托 = 灯②（拆解拍板）、灯③（验收）、灯④
  （awaiting_close 关单）。**硬排除**：监工判大（gatekeeper_big，自动放行=监工白判）、一切病历
  （run_failed / reconcile_conflict / integration_unresolved / retry_exhausted / thrash / stalled_no_path /
  steer_escalated，"已处理·继续"意味着人做过处置，自动点=空转）、cancel_confirm（破坏性）、立项 gate
  （料都没收齐，自动过无意义）。白名单由 requirement 纯核心导出常量声明，命令入口只接受白名单，
  容器对语义零感知。
- **D-3 延迟生效（冷静期）**。到点自动过不是秒过：`max(wait 挂起, 授权下达)` 后至少等
  `delegationDelaySec`（默认 600s，env `WORKITEMS_DELEGATION_DELAY_SEC`）才触发——灯卡照发、人在场可
  抢先手动、E5 质检报告有时间先贴出。（审查修复 2026-07-06：原文只锚 wait open 时刻，灯先亮、人后
  /delegate 时冷静期已耗尽会秒过——改锚较晚者，放权后必有完整反悔窗口。）
- **D-4 灯③ 带机器信号 guard，guard 只认机器不认 AI**。灯③ 自动通过的前提 = 最后一条
  integration_check_passed 是**真通过**（payload 无 reason；no_contract / no_claims = 静态对账未生效 →
  guard 不过，等人）。用户说的"参谋建议为通过则自动过"以此保守近似——AI 报告只进人眼（E5 D-1），
  绝不进 guard，三权分立不破。推论：**lite 单仓的灯③ 永不自动过**（恒 no_contract），设计上有意保守，
  落地记要注明；灯② 与灯④ 无 guard（拆解结论有对账 effect 兜底、关单前灯③已人批或真通过）。
- **D-5 授权必须持久化**（ai-sentinel 的教训：等人状态不能只活在内存）。workitems DB 新表，重启存活；
  `/delegate off` 即时撤销；到期自动失效；单元终态顺带清理。**每单最多一条生效授权**（新授权覆盖旧的）。
- **D-6 分层执行**：容器 watchdog 只做机械判定（有生效授权行 ∧ wait.reason ∈ 授权行的 reasons 字符串
  列表 ∧ wait 年龄 ≥ delay）→ enqueue 中性事件 `delegation_due { waitId }`；桥层（kernel-exempt）收到后
  做业务 guard，通过则走 `workitems.api.resolveWait` 唯一写口并在群里发一条自动通过通知。worktype 状态机
  **零改动**——resolve 走既有 onWaitResolved 路由，approved=true 天然推进。
- **明确不做（v2 再议）**：全局/跨单委托（只 per 单）；自动打回；AI 判断条件；灯卡上的"委托"按钮入口
  （v1 只有命令）；lite 灯③ 强制自动过的开关；委托病历类的任何形式。

---

## D1 容器地基（全部中性，零业务语义）

### D1.1 store：`workitem_delegations` 表

- `src/workitems/store.ts` 迁移 `user_version` 递增一版（当前 v5 → v6，沿用既有 guarded 迁移先例）：
  ```sql
  CREATE TABLE IF NOT EXISTS workitem_delegations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workitem_id TEXT NOT NULL,
    reasons TEXT NOT NULL,        -- JSON string[]，容器不解释内容
    grant_note TEXT NOT NULL,     -- 授权原文（用于 resolve reason 留痕与通知文案）
    expires_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  ```
- 方法：`upsertDelegation(workitemId, { reasons, grantNote, expiresAt, createdBy, now })`（先 revoke 该单
  现存生效行再 insert——每单一条生效）；`activeDelegation(workitemId, now)`（未撤销且未到期）；
  `revokeDelegation(workitemId, now)`；`finalizeTerminalState` 顺带 revoke（防僵尸行）。
- 命名全中性（delegation/grant 无业务词）。

### D1.2 config

`src/workitems/config.ts` 新增 `delegationDelaySec`（默认 600，env `WORKITEMS_DELEGATION_DELAY_SEC`），
写法对齐 waitRemindAfterSec。

### D1.3 watchdog：到点发中性事件

`src/workitems/watchdog.ts` human wait 扫描分支（与催办同一循环）追加：

```
const grant = store.activeDelegation(item.id, now);
if (grant && grant.reasons.includes(wait.reason)
    && now >= max(wait.createdAt, grant.createdAt) + cfg.delegationDelaySec * 1000  // 审查修复：锚较晚者
    && !delegationBlocked(wait, grant)) {  // 审查修复：到点深检查，见文末记要
  safeEnqueue(item.id, { kind: 'delegation_due', payload: { waitId: wait.id } });
}
```

- 防重复：桥层 resolve 后 wait 关闭自然停发；resolve 失败/guard 不过时每 tick 会重发——桥层幂等消费
  （见 D2.3），且 guard 不过的场景静默跳过、催办照常，可接受。若要省事件量，可仿 remindedAt 加
  `delegationNotifiedAt` 列节流（可选，做不动就跳过并注明）。
- `delegation_due` 与 wait_reminder 同类容器事件：不登记 REQUIREMENT_EVENT_KINDS。

### D1.4 测试

- store：迁移幂等（老库开两次）；upsert 覆盖旧行；active 过滤（撤销/到期/正常）；终态清理。
- watchdog（假时钟）：匹配授权 + 过 delay → delegation_due；delay 内不发；reason 不在列表不发；
  已撤销/到期不发；wait 已 resolve 不发。全程 reasons 用 opaque 字符串（如 'r-a'），证明容器零语义。

---

## D2 业务执行（worktype 白名单 + 命令 + 桥层执行器）

### D2.1 worktype 白名单声明（requirement 纯核心）

`src/worktypes/requirement/` 导出（建议放 checkpoint.ts 或 phases.ts 旁）：

```ts
export const DELEGABLE_WAIT_REASONS: readonly string[] = [
  checkpoint reason of 灯②（split→implement 的 checkpoint:<boundary>，用既有 helper/常量拼，勿硬编码字符串）,
  checkpoint reason of 灯③（→deliver）,
  'awaiting_close',
];
```

附注释：为什么只有这三个、为什么判大/病历永不进来（引 D-2）。

### D2.2 `/delegate` 命令（模式照抄 WS-10.8 的 /cancel）

- `src/bridge/commands.ts`：构造器加 `onDelegate(msg, args)`（kernel 中性回调），dispatch 加
  `case '/delegate'`；HELP_TEXT 补：`/delegate 8h 开启本单委托（三灯到点自动通过）；/delegate off 撤销`。
- `src/index.ts` 实现 onDelegate：
  1. `resolveManagedItem(msg)` 找单（找不到/终态的文案复用 /cancel 的两条）；
  2. 参数解析：`off` → `revokeDelegation` + 回复「已撤销委托」；时长格式 `Nh`/`Nm`（上限 24h，超出拒绝
     并提示——过夜够用，防"永久放权"）；无参/坏参 → 用法提示；
  3. 写入：`upsertDelegation(item.id, { reasons: DELEGABLE_WAIT_REASONS, grantNote: 原始命令文本,
     expiresAt: now + 时长, createdBy: msg.userId })`；
  4. 回复确认（诚实交代边界）：「已开启委托至 HH:mm——拆解/验收/关单三灯在无人处理 10 分钟后自动通过
     （验收灯需静态对账真通过才放行）；**监工判大与一切病历仍会等你**。随时 /delegate off 撤销。」

### D2.3 桥层执行器（依赖注入式导出，先例 backfillClaimedChats）

- 导出纯 guard：`export function delegationGuardFor(reason: string, events: WorkItemEvent[]): boolean`——
  reason 为灯③ 的 checkpoint → 最后一条 integration_check_passed 无 reason 字段才 true（复用
  deliverGateNote 的扫描姿势）；其余白名单 reason 恒 true；非白名单恒 false（双保险）。
- 导出执行器：`export async function runDelegationDue(deps, ev)`（deps 注入 workitems/sender/logger）：
  1. 取 wait（`payload.waitId`）；已 resolve → return（幂等，watchdog 重发无害）；
  2. 取 `activeDelegation`；无/过期 → return（撤销竞态兜底）；
  3. `delegationGuardFor(wait.reason, api.listEvents(...))` 不过 → return（静默，催办照常，人醒来正常处理）；
  4. `api.resolveWait(waitId, { operator: 'delegation', reason: '【委托】' + grantNote + '（至 HH:mm）',
     decision: { approved: true } })`；
  5. 群内通知（锚点回复）：「⏱ 已按你的委托自动通过「<灯名>」（授权：<grantNote>）。有异议可在群里
     直接说，包工头会处理。」发送失败只 log（resolve 已生效，通知是尽力而为）。
- `postStatus` 加分支：`event.kind === 'delegation_due'` → `runDelegationDue(...)`（接线处与 wait_reminder
  分支并排）。

### D2.4 测试

- 白名单：断言 DELEGABLE_WAIT_REASONS 恰为三灯且不含 gatekeeper_big/病历/cancel_confirm（防未来手滑
  扩列——这是本方案最重要的一条守护断言）。
- guard 纯测：灯③ 真通过 true / no_contract false / no_claims false / 无事件 false；灯②、awaiting_close
  恒 true；gatekeeper_big 恒 false。
- 执行器（假 deps）：正常链路 resolve 参数形状（operator/reason/approved）+ 通知发出；wait 已 resolve
  幂等 return；授权已撤销 return；guard 不过 return 且不 resolve。
- 命令：/delegate 8h 写行 + 确认文案；off 撤销；坏参用法提示；找不到单/终态文案。
- e2e（沙箱，不含桥层）：双仓走到灯② wait → 手写 delegation 行 → 假时钟推过 delay → watchdog tick →
  断言 delegation_due 事件出现；resolve（模拟桥层动作）后推进到下一相位、不再重发。

---

## D3 收尾（可选项 + runbook）

- **卡片提示**（可选，做不动跳过并注明）：`surfaceCheckpoints` 出灯卡/关单卡时若该单有生效授权，note/
  detail 尾部加灰字「⏱ 委托生效中：无人处理将于 HH:mm 前自动通过（/delegate off 可撤销）」。
- OVERHAUL 文档附录 B 追加手验项：`/delegate 5m` + `WORKITEMS_DELEGATION_DELAY_SEC=60` 起服务 → 走到
  灯② 挂着不点 → 1 分钟后自动通过 + 群内通知 + 事件流 operator=delegation 留痕 → 灯③（lite 单）验证
  **不**自动过（guard 拦住）→ `/delegate off` 后灯不再自动过。
- 本文档头部状态改「已实施」+ 落地记要（逐项/出入/跳过项）。

---

## 附：一图流

```
人：/delegate 8h ──► workitem_delegations（持久，每单一条，可撤销，≤24h）
                          │
watchdog 每 tick：有生效授权 ∧ wait.reason ∈ 授权列表 ∧ 距 max(灯挂起, 放权) ≥ 10min（机械匹配，零语义）
                          │  到点深检查（每窗口一次，审查修复）：同单无授权外的 open human wait
                          │  ∧ 授权后人没打回过同名 wait ∧ worktype guard 放行 —— 任一不过则不发事件
                          ▼
                 delegation_due（中性事件，同 wait_reminder 类）
                          ▼
桥层：wait 还开着？授权还活着？（同一套深检查双保险）guard 过吗（灯③需静态对账真通过——机器信号，不认 AI 报告）
                          ▼
        resolveWait(approved=true, operator=delegation, reason=【委托】原文)   ← 唯一写口，全程留痕
                          ▼
        既有 onWaitResolved 路由推进 + 群内「⏱ 已按你的委托自动通过」通知
边界：判大 / 病历 / 取消确认 永不可委托（白名单守护断言钉死）；委托只通过、永不打回；
     人显式打回过的灯，本次授权内不再自动过（人的更晚决定优先）。
```

---

## ✅ 落地记要（2026-07-04）

执行者：Claude Fable 5。基线 797 测试 / 98 文件（ee73b6c）→ 终态 **833 测试 / 101 文件全绿**
（typecheck + biome + vitest + 架构守卫），按 §0 三刀提交，每刀提交前 `npm run check` 全绿：

| 刀 | commit | 一句话 |
|---|---|---|
| 1 | `151e210` | 容器地基：workitem_delegations 表（store v6）+ delegationDelaySec + watchdog 到点扫描 → delegation_due |
| 2 | `a09680b` | 业务执行：DELEGABLE_WAIT_REASONS 白名单 + /delegate 命令 + delegationGuardFor/runDelegationDue + postStatus 接线 |
| 3 | （本刀） | 收尾：灯卡/关单卡委托灰字提示 + OVERHAUL 附录 B 手验项 11 + 本记要 |

### 逐项状态

- **D1.1 store**：✔ 照方案建表（v6，当前 user_version 实为 v5→v6，与方案「v5→v6」一致）；
  `upsertDelegation`（事务内先 revoke 再 insert）/`activeDelegation`/`revokeDelegation`；
  `finalizeTerminalState` 顺带 revoke（计入 terminal_cleanup 计数）。加了未撤销行的部分索引
  `idx_delegations_active`。`revokeDelegation` 不收 `now` 参数、用 store 时钟（对齐 insertParked 等先例）。
- **D1.2 config**：✔ `delegationDelaySec` 默认 600s，env `WORKITEMS_DELEGATION_DELAY_SEC`，写法对齐 waitRemindAfterSec。
- **D1.3 watchdog**：✔ human wait 扫描分支追加机械判定（生效授权 ∧ reason opaque 逐字节命中 ∧ 年龄 ≥ delay），
  与催办互不干扰。**节流做了但换了实现**：方案可选项建议仿 remindedAt 加 `delegationNotifiedAt` 列，
  实际用 watchdog 内存 Map（waitId → 上次 enqueue 时刻，每 delegationDelaySec 重发一次，tick 内清扫已关
  wait 的条目）——省一次 waits 表 schema 变更（Wait 类型/insertWait/makeWait 全链churn），重启丢节流状态
  只是提早重发一次，桥层消费幂等无害。
- **D2.1 白名单**：✔ `DELEGABLE_WAIT_REASONS` 落 `src/worktypes/requirement/index.ts`（AWAITING_CLOSE_REASON
  同文件，单一来源；方案建议 checkpoint.ts/phases.ts「旁」，此处更近）。守护断言
  `tests/workitems/requirement-delegation.test.ts` 钉死恰为三灯 + 判大/病历/取消/**立项 gate** 永不进来。
- **D2.2 /delegate**：✔ commands.ts 中性透传（onDelegate 尾参 + HELP）；index 侧 `runDelegateCommand`
  依赖注入式导出（先例 applyCheckpointOpinion）：off 撤销 / Nh·Nm ≤24h / 坏参用法 / 找不到单·终态复用
  /cancel 两条文案；确认文案按方案诚实交代边界，冷静期分钟数按实际 config 渲染（不写死 10 分钟）。
- **D2.3 桥层执行器**：✔ `delegationGuardFor`（灯③ 最后一条 integration_check_passed 无 reason 才 true，
  扫描姿势同 deliverGateNote；灯②/灯④ 恒 true；非白名单恒 false 双保险）+ `runDelegationDue`（幂等：
  已 resolve/授权已撤/guard 不过 → 静默 return；通过 → resolveWait(operator=delegation,
  reason=【委托】原文+到期时刻) + 锚点通知，通知失败只 log）。postStatus 与 wait_reminder 分支并排接线。
- **D2.4 测试**：✔ 白名单守护断言 / guard 纯测 / 执行器假 deps / 命令 / store 迁移幂等·upsert 覆盖·active
  过滤·终态清理 / watchdog 假时钟（opaque reason 'r-a' 证容器零语义）/ e2e（真容器+真 watchdog+真执行器）。
- **D3 卡片提示**：✔（可选项，做了）`delegationCardHint` 纯函数——灯卡（checkpoint）与关单卡（closure）
  出卡时有生效授权且**真会自动过**才注灰字；比方案多一层诚实判定：guard 会拦的（lite 灯③ no_contract）
  和到点前授权已过期的**不提示**，卡上不承诺不会发生的自动通过。
- **D3 runbook**：✔ OVERHAUL 附录 B 追加手验项 11（含 lite 灯③ 不自动过、off 撤销、超时长拒绝、真机验证点）。

### 与方案的出入（按意图适配，如实记）

1. **灯② wait 当前不存在（重要，白名单含一条“死”entry）**：方案把「灯②（拆解拍板）」定义为
   split→implement 边界的 checkpoint（`checkpointReason(PHASE.implement)`），但 PIVOT 后主线该边界
   **不设 checkpoint**（reconcile_passed 直进并行实现），此 reason 的 wait 生产上不会出现。按方案意图
   仍收进白名单（opaque 匹配不到即惰性无害，属前向保护：灯② 若长回来自动被委托覆盖）；守护断言注释
   特别提醒：立项 gate 的 reason 字符串是 `checkpoint:requirement:拆解`（字面含「拆解」但语义是
   进拆解前的门），与灯②（拆解完成后的门 `checkpoint:requirement:并行实现`）不是一回事，勿混。
2. **e2e 标的换灯**：方案 D2.4 的 e2e 写「双仓走到灯② wait」——因上条，改为灯③（验证 guard 拦
   no_contract 的保守面）+ 灯④ awaiting_close（验证自动过全链路：到点 → delegation_due → 执行器
   resolve → 整单 done → 终态不再重发 → 重放幂等）双标的。
3. **节流实现**（上文 D1.3）：内存 Map 取代可选的 delegationNotifiedAt 列。
4. **手验的「自动通过」示范灯**：方案 runbook 用「走到灯②」演示自动过——改为灯④关单卡（或双仓真对账
   通过的灯③）；lite 单灯③ 用来验证 guard 拦截（与方案 D-4 推论一致）。
5. 其余（决策台账 D-1~D-6、reason 拼法、operator/reason 留痕格式、通知文案）均按方案原样落地，未重开任何决策。

### 留下的 live 半（真机未验，全部走单测/e2e 覆盖）

- 飞书出口未真机验：`/delegate` 确认回复、自动通过的锚点话题通知、灯卡灰字渲染——见 OVERHAUL 附录 B 项 11。
- guard 依赖的 `integration_check_passed` payload 形状按现网事件推断（无 reason 字段=真通过），与
  deliverGateNote 同源；若历史库存在异形 payload，guard 保守面（不放行）兜底。

---

## 🔧 审查修复记要（2026-07-06，对抗审查 10 条）

对 DELEGATE D1~D3 + ENHANCE 收尾 6 提交做 8 角度对抗审查（逐行/删行/跨文件/复用/简化/效率/高度/规范
→ 逐条验证），10 条存活全部修复。基线 896 测试全绿（+18）。

**委托链对「人的在场信号」零感知（一簇 3 条，最严重）**——watchdog `scanDelegation` 到点后加深检查
（`delegationBlocked`，每 delegationDelaySec 窗口一次，不进 1Hz 热路径），`runDelegationDue` 同一套判定
双保险（防扫描间隙竞态，共用 `shared.ts::humanDeclinedSince`）：

1. **自动关单埋掉未决事项**：同单存在授权未覆盖的 open human wait（/cancel 的 cancel_confirm、
   steer_escalated 等病历）时不自动过——原先 awaiting_close 自动 approved → 终态 terminal_cleanup 把
   这些 wait 无差别静默关闭，想终止的单被自动「完成」。
2. **人打回被系统翻案**：授权之后人显式打回过同名 wait（wait_resolved 带 decision.approved=false，
   容器自己写的载荷字段，读回不算解释语义）→ 该 reason 本次授权内不再自动过，重新 /delegate 即重置——
   原先「暂不关单」declined → reRaiseWait 新 wait → 10 分钟后又被自动 done。/delegate 确认文案补一句
   如实交代。
3. **冷静期锚点**：due 锚 `max(wait.createdAt, grant.createdAt)`——原先灯已挂数小时后 /delegate，
   下一 tick 秒过，确认文案承诺的反悔窗口为零（D-3 修订见上文）。

**guard 单一来源化（3 条）**：

4. **白名单与 guard 同址同源 + fail-closed**：新建 `src/worktypes/requirement/delegation.ts`，
   `DELEGABLE_WAIT_REASONS = Object.keys(DELEGATION_GUARDS)`——加白名单必须同时声明机器信号 guard，
   结构上不可能漂移；未声明恒不放行。原先 guard 在桥层 src/index.ts、白名单在 worktype，跨文件仅约定耦合，
   且对非灯③默认 fail-open。
5. **异形 payload 保守面兑现**：`integrationCheckOutcome` 对非对象 payload / null reason / 未知 reason
   一律判「非真通过」——原先 `r === undefined` 三元式把无法解读的事件当真通过放行灯③，与本文档
   「guard 保守面兜底」的承诺相反。
6. **deliverGateNote 与 guard 共用解读**：两处原各自倒扫 integration_check_passed 且语义已分叉
   （null/未知 reason 时卡上 ✅ 而 guard 拦下）；现同吃 `integrationCheckOutcome`，未知/异形走 ⚠️
   人工验收提示。

**空转与可靠性（2 条）**：

7. **永拦的灯不再整夜刷卡**：WorkType 新增可选 `delegationGuard`（先例 liveness()），requirement 接
   `delegationGuardFor`——watchdog 深检查 guard 不过就不 enqueue，原先 lite 单灯③（恒 no_contract）
   每窗口重发 delegation_due → postStatus → updateCard，8h 委托 ≈48 次无意义锚点刷新 + 事件表膨胀。
8. **节流顺序**：enqueue 成功才刷新节流 Map（深检查被拦也刷新——每窗口只深扫一次）；原先先刷后发，
   一次瞬时 DB 错误让自动通过顺延整整一个窗口。

**卡片诚实（2 条）**：

9. **参谋提示事实耦合**：`withAdvisorHint` 增加 advisorInFlight 参数（`advisor.ts::advisorRunInFlight`
   查 inflight run effect 的 stage=advise）——原先只凭 reason 就承诺「参谋正在分析」，declined 重弹病历
   不重派参谋，重弹卡让人空等一份永远不会贴出的建议卡。
10. **委托灰字提示**：时刻锚点与 watchdog 同式（max 锚）；autoAt 已成过去（首发失败数小时后补发）改说
    「即将自动通过」；「将于 HH:mm **前**自动通过」对齐本文档 D3 节（原代码写「后」，有歧义）。
    顺带：surfaceCheckpoints 的全量事件史/在途参谋判定改惰性 memo，每次调用至多各取一次（原循环内
    最多 4 处重复拉全表）。
