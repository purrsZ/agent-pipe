# INTAKE 方案：立项智能收料——仓库登记表 + 勘探 run + 仓内收料

> 日期：2026-07-03 ｜ 状态：**已实施**（2026-07-06，L0+L1+L2 全落地，878 测试绿）｜ 读者：**执行本方案的 AI**
> 来源：真机截图暴露的能力墙——用户说「就在 alaeatposapp 项目里，本地有俩项目，你找一下确定一下」，
> 而现有立项 AI 只是**无工具的文本抽取器**（`aiExtractIntake`，pool.send 一次性抽取），读得懂仓名但
> 解析不了路径、分辨不了歧义、进不了仓。用户方向拍板：**过程中多让 AI 介入**。参考 ai-sentinel 的
> 三个思路：company.md 代码项目登记（→L0）、带工具的立项对话（→L1，但我们做批式非常驻）、
> /flow init 准入检查姿态（→L2）。
> 本方案自包含；行号基线 = overhaul/req-v1 分支 HEAD（DELEGATE 方案若已实施则以其 HEAD 为准）。
> 行号漂移以符号名定位。

---

## 0. 执行须知（必读）

- 仓库 `/Users/zwh/agent-pipe`，验证 `npm run check`，**每刀提交前全绿**（基线 ≥797 测试）。
- 架构红线沿用 OVERHAUL §0.2。本方案新增事件 kind：**`scout_result`（登记 `REQUIREMENT_EVENT_KINDS`，
  anchor-drift 断言 +1）**；`repo_registry` 表放 kernel store（`src/store.ts`，跨单知识，与 inbox_messages
  同级，命名中性）。
- 词汇守卫：feishu/kernel 层注释禁 `workitem|assignment|worktype|phase` 独立词。
- 既有基建复用清单（执行前先认路）：AUQ 表单卡与回灌（WS-9：`buildWorkitemQuestionCard` /
  `AUQ_WORKITEM_ACTION_KIND` / `assembleAuqAnswers`）；worktype 消费 `/` 前缀 human_message 的先例
  （WS-10.8 `/cancel`）；effect 读报告→emit 事件的先例（`steer_apply`）；桥层消费业务事件的先例
  （`manifest_ready` → postStatus）；R1 修复后 afterRun 对带 stage 的非 reconcile/assess run 天然免疫。
- **不要重开 §1 决策台账**；与代码现状对不上时（抽取输出格式、repo 校验 helper 名、intake 卡刷新链路）
  按意图适配并记入落地记要。

### 建议提交划分

| 刀 | 内容 | 建议 commit |
|---|---|---|
| 1 | L0 仓库登记表（免 AI 快路径） | `feat(requirement): 立项仓库登记表——仓名秒解析绝对路径 (INTAKE L0)` |
| 2 | L1 勘探 run（找仓/验仓/歧义问人） | `feat(requirement): 立项勘探——AI 找仓、AUQ 卡问歧义 (INTAKE L1)` |
| 3 | L2 仓内收料（可选） | `feat(requirement): 勘探进仓收料——设计文档候选自动挂料 (INTAKE L2)` |
| 4 | 文档收尾 + runbook | `docs(requirement): INTAKE 落地记要 + 手验项` |

---

## 1. 设计决策台账（已拍板，执行时不要重开）

- **D-1 AI 找料，人验料**。勘探只读、只产候选；一切候选入表**必须过既有的当场校验**（真实 git 仓）；
  必填清单与立项 gate（人点「立项完成」）一寸不动。这与 OVERHAUL 否决的「AI 判料够不够」划清界限：
  否决的是 AI 当验收员，没否决 AI 当跑腿。
- **D-2 三层递进，先便宜后贵**。L0 查表（机器事实，秒级零 token）→ L1 勘探（表兜不住才派，分钟级）→
  L2 进仓收料（勘探顺路做，只填候选带来源标记）。触发克制：不是每条消息都派 run。
- **D-3 勘探 = workitem run，不是 bridge 任务**。stage=`scout`，owner 槽、readonly、流式卡出群、事件流
  留痕、single-flight 管并发——不走 pool.send 旁路（无审计无产物）。崩了重来，批式非常驻（D-A 不破）。
- **D-4 搜索根自举，不全盘扫**。勘探可读目录 = 登记表里已知仓的**父目录去重** ∪ env
  `INTAKE_SCOUT_ROOTS`（冒号分隔）。两者皆空 → 勘探不可用（自动触发跳过；手动 /scout 回复提示配置）。
- **D-5 歧义走现成 AUQ 卡**。「找到两个 alaeatposapp，用哪个？」以 auq-wi 表单卡问人，答案经既有回灌
  通道进下一轮抽取。不发明新交互。
- **D-6 勘探产出经 `scout_result` 事件由桥层消费**（先例 manifest_ready）：桥层对每个候选路径跑既有
  校验后 `api.injectIntakeField` 入表（与人工输入同一写口同一校验），并回写登记表。
- **D-7 触发与防抖**。自动触发条件 = repos 仍缺失 ∧ 抽取给出了未能被登记表解析的 `repoHints`；桥层
  自动触发前查事件流，**每单自动派勘探 ≤ 2 次**（防循环烧 token）；群里手动 `/scout <线索>` 不限次。
- **明确不做**：常驻立项会话；AI 自判"料够了"绕过 gate；自动生成 PRD 正文（L2 只挂"路径+摘要"候选）；
  无根目录约束的全盘搜索；勘探写任何东西（含登记表——登记表只由桥层在校验通过后写）。

---

## L0 仓库登记表（免 AI，解决 80% 场景）

### L0.1 kernel store 新表（`src/store.ts`，guarded 迁移）

```sql
CREATE TABLE IF NOT EXISTS repo_registry (
  path TEXT PRIMARY KEY,          -- 绝对路径
  name TEXT NOT NULL,             -- basename，小写化用于匹配
  last_used_at INTEGER NOT NULL,
  source TEXT NOT NULL            -- 'unit' | 'scout' | 'backfill'
);
```

方法：`upsertRepoRegistry(path, name, now, source)`、`listRepoRegistry(limit)`（last_used_at 降序）、
`matchRepoRegistry(hint)`（name 小写包含匹配，返回全部命中——歧义交上层）。

### L0.2 写入三处（全在桥层，写前不校验——登记来源本身已是校验过的事实）

1. **启动回填**：main() 一次性遍历 workitems store 全部单元的 repos（需给 workitems store 补一个
   `listAllRepos(): string[]` 小方法，DISTINCT 展开 repos JSON 列）→ upsert（source='backfill'）。
2. **repos_set 事件**：postStatus 加分支——repos 提升时逐仓 upsert（source='unit'，刷 last_used_at）。
3. **勘探结果**（L1 落地后）：桥层校验通过的候选 upsert（source='scout'）。

### L0.3 抽取器接上登记表

`aiExtractIntake` 的 prompt 追加「已知仓库登记（名字 → 绝对路径，按最近使用排序，最多 20 条）」小节 +
指令：「用户提到的仓名/项目名命中登记表 → 直接输出该绝对路径；未命中 → 放入 `repoHints`（原词照录，
不要猜路径）」。抽取输出结构增加可选 `repoHints: string[]`（按现有输出格式适配）。抽取给出的路径照走
既有当场校验，不豁免。

### L0.4 测试

store 三方法（含大小写匹配/多命中）；回填幂等；抽取 prompt 含登记表小节（源码文本断言或纯函数抽取后
断言，按 aiExtractIntake 现状可测性适配）；postStatus repos_set 分支 upsert（DI 式，先例 backfill.test.ts）。

---

## L1 勘探 run（AI 介入的主体）

### L1.1 触发（双入口，共用 worktype 消费）

- **自动**：`handleIntakeMessage` 在抽取返回后——repos 仍缺 ∧ `repoHints` 非空 ∧ `matchRepoRegistry`
  对每个 hint 均未命中或多命中（歧义也交勘探裁量/问人）∧ 事件流中 stage=scout 的 run 结论 < 2 ∧
  搜索根非空 → `workitems.api.injectHumanMessage(item.id, { text: '/scout ' + hints.join(' ') })` +
  群内回执「🔍 没认出这个仓，我去本地找找，稍等」。
- **手动**：群里发 `/scout <线索>` ——`src/bridge/commands.ts` 加 case（照抄 /cancel 的 onCancelUnit
  模式：kernel 中性回调 → resolveManagedItem → injectHumanMessage 透传原文；HELP_TEXT 补行）。
- **worktype 消费**（`onHumanMessage` intake 分支，先例 /cancel）：`text.startsWith('/scout')` ∧
  phase===intake ∧ `runningOwnersOf(ev.payload) === 0` → `{ dispatch: [scoutSpec(item, text 去前缀)] }`；
  owner 忙 → `{}`（桥层回执已发，用户重发即可；不做队列）。非 intake 相位收到 /scout → `{}`。

### L1.2 派发与权限

- `STAGE` 加 `scout`；`scoutSpec(item, hints)` = ownerSpec spread + `payload: { stage: 'scout', hints }`
  （先例 adviseSpec）。
- `createRequirementRunStrategy` 新增 opt `scoutRoots: () => string[]`（index.ts 接线：登记表父目录去重 ∪
  env `INTAKE_SCOUT_ROOTS` 拆分）。worker-handler `runOptions`：stage=scout → readonly +
  `readableDirs = scoutRoots()`（intake 相位 repos 为空，全仓可读无意义）。
- `resolveCwd`：scout 落 defaultCwd 即可（它靠 readableDirs 干活）。

### L1.3 勘探 prompt（新纯核心文件 `src/worktypes/requirement/intake-scout.ts`）

`composeScoutPrompt({ title, hints, roots, registrySnapshot, summary? })`：

- 角色：「你是立项勘探员。用户提到了仓库线索但没给绝对路径，你的任务：在给定搜索根内找到候选仓、
  验证它是 git 仓、拿证据帮用户确认。你只读浏览，不改任何东西。」
- 织入：需求标题与一句话摘要（帮它判断哪个仓更相关）→ 线索（hints）→ 登记表快照（先查表再搜盘）→
  搜索根清单 → 方法提示（`ls`/`git -C <p> log -1 --format=%ci` 看最近活跃；同名多候选比较最近提交、
  远端、README 与需求的相关性）。
- 产出：①报告主体 = 给用户的中文说明（找到了什么、凭什么判断）；②末尾唯一 ```` ```scout ```` 块：

```
{ "repos": ["确定无歧义的仓绝对路径"],
  "ambiguities": [{ "question": "找到两个 alaeatposapp，用哪个？",
                     "options": ["/a/alaeatposapp（3 天前有提交）", "/b/alaeatposapp（半年未动）"] }],
  "notFound": ["实在找不到的线索原词"] }
```

- 规则：确定 = 唯一命中或证据压倒性；拿不准一律进 ambiguities 问人（疑则问，与监工同姿态）；
  绝不编造路径。
- `parseScoutResult(report)` 纯函数（永不抛，fenced 扫描先例 gatekeeper/steer；坏块 → 全空）。

### L1.4 收尾链路（steer_apply 同构）

- `onRunCompleted` stage=scout → `withPendingSteer(item, ev, { effects: [{ kind: 'scout_apply',
  payload: { reportPath } }] })`；`onRunFailed` 特判扩为 steer/advise/inspect/scout → `{}`（勘探挂了
  收料继续走人工，不弹病历）。
- **effect `scout_apply`**（intake-scout.ts，recovery:'rerun'）：读报告 → parse → emit
  `scout_result { repos, ambiguities, notFound }`（空结果也 emit，审计留痕）。幂等：重跑重 emit 同一
  结果，下游桥层消费幂等（见下）。
- **`scout_result` 登记** `REQUIREMENT_EVENT_KINDS`（13→14），anchor-drift 测试同步。
- **桥层消费**（postStatus 新分支，导出 DI 式 `runScoutResult(deps, ev)`）：
  1. `repos[]`：逐条跑**既有 repo 当场校验**（复用 handleIntakeMessage 校验 helper，名字按现场找）→
     通过的与现有 repos 字段**合并去重**后 `api.injectIntakeField(itemId, { key: 'repos', value: 合并结果 })`
     + upsert 登记表（幂等：重复注入同值由 fold 语义天然吸收）；校验失败的降级为群内说明。
  2. `ambiguities[]`：每条出一张 AUQ 表单卡（`buildWorkitemQuestionCard`，routing 带 workitemId）——
     人点选后答案走既有 auq-wi 回灌 → 下一轮抽取命中登记表/原路径。防重贴：以事件流中「本 scout_result
     之后是否已有对应提问卡记录」判断成本高——**接受 rerun 极端场景重贴一张卡**（recovery 重跑仅崩溃后
     发生，记入注释）。
  3. `notFound[]`：群内如实说「没找到 xxx，请给绝对路径或补充线索后 /scout 重试」。
  4. 清单卡刷新走既有 intake_field_set 链路，无需额外处理（执行时验证一下）。

### L1.5 测试

- 纯核心：composeScoutPrompt 织入（hints/roots/登记快照/「绝不编造路径」）；parseScoutResult 四型
  （正常/坏 JSON/无块/取最后块）。
- 状态机：intake 相位 '/scout x' → dispatch scoutSpec（owner 忙 → {}；非 intake → {}）；scout 收尾 →
  scout_apply effect + unconsumed 补派 steer；scout run_failed → {}。
- effect：scout_apply 读报告 emit scout_result；空报告 emit 全空。
- 桥层（DI）：runScoutResult——合法仓注入+登记、非法仓不注入、歧义出 auq-wi 卡（断言卡 value 形状）、
  notFound 出文案。
- 触发防抖：桥层 helper（数事件流 scout 结论 ≥2 → 不自动触发）纯测。
- e2e：intake 相位注入 '/scout hint' → scout assignment 出现 → 合成带 ```scout 块报告收尾 →
  scout_result 事件出现（桥层动作在 DI 单测覆盖，沙箱不装配桥层——先例 delegation/backfill 的切法）。
- anchor-drift：14。

---

## L2 仓内收料（可选刀，做不动跳过并注明）

- 勘探 prompt 增补：确定仓后**顺路进仓找立项材料**——设计文档/PRD/README 里的验收标准与范围描述。
  ```scout 块增加可选 `materials: { prd?: {path, summary}, acceptance?: {path, summary},
  background?: {summary} }`（summary ≤200 字，path 为仓内相对路径）。
- 桥层消费：对应 intake 字段**为空时**才注入，值格式 `【AI 从 <path> 提取，立项卡上请确认】<summary>`
  ——来源标记醒目，人不认可直接在群里重说即覆盖（fold 取最新）。已有值绝不覆盖。
- 测试：materials 解析；空字段才注入/已有值不覆盖；标记文案在场。
- 诚实边界（写进落地记要）：L2 只是把「料在哪」递到人眼前，**gate 必填语义不变**——lite 单三项硬必填
  里 L2 只可能帮到 summary，价值主要在满配单的 PRD/验收标准。

---

## 收尾（第 4 刀）

- OVERHAUL 附录 B 追加手验项：新群立项只说「就在 alaeatposapp 里」→ L0 命中（若登记有）秒填并校验；
  改用登记表没有的仓名 → 勘探流式卡出现 → 找到唯一仓自动入表 / 双候选出选择卡 → 点选后入表 →
  清单卡打勾 → 正常走 gate。`/scout` 手动触发同验。
- 本文档头部状态改「已实施」+ 落地记要（逐项/出入/跳过项，L2 是否做、防抖阈值实际取值）。

---

## 附：一图流

```
用户:「就在 alaeatposapp 里，你找一下」
   │
   ▼
抽取(带登记表) ──命中──► 直接填 repos(过当场校验) ✅ 秒级          ← L0
   │未命中/歧义(repoHints)
   ▼
桥层防抖(每单自动≤2次) → injectHumanMessage('/scout alaeatposapp')
   ▼
勘探 run(readonly,readableDirs=登记父目录∪SCOUT_ROOTS,流式卡可见)   ← L1
   ▼ 报告 + ```scout 块
scout_apply effect → scout_result 事件(登记 kinds)
   ▼ 桥层消费
确定仓 → 当场校验 → injectIntakeField + 回写登记表
歧义   → AUQ 选择卡 → 人点选 → 回灌 → 下轮抽取命中
顺路   → 仓内设计文档 → 空字段候选(带来源标记,人可覆盖)            ← L2
   ▼
清单卡打勾 → 人点「立项完成」(gate 与硬校验一寸不动)
```

---

## ✅ 落地记要（2026-07-06，L0+L1+L2 全落地）

执行者：claude-opus-4-8[1m]。基线 833 测试 → **878 测试绿 / 104 文件**（typecheck + biome + vitest 全过）。
四刀提交，每刀 `npm run check` 全绿：

| 刀 | commit | 内容 |
|---|---|---|
| L0 | `8af3f29` | 仓库登记表（kernel store 新表 + 回填 + 抽取快路径） |
| L1 | `283a8c9` | 勘探 run（STAGE.scout / scoutSpec / scout_apply effect / scout_result / 桥层消费 + AUQ 歧义卡 + /scout 命令 + 自动防抖） |
| L2 | `5325e51` | 仓内收料（materials 解析 + 空字段带标记注入） |
| 收尾 | 本次 | 文档状态 + OVERHAUL 附录 B 手验项 12~16 |

### 逐项落地（对齐决策台账）

- **D-1（AI 找料·人验料）不破**：勘探只读只产候选；`runScoutResult` 里一切 `repos[]` 候选逐条过既有
  `isGitRepo`（绝对路径 + 是 git 仓 + 有 HEAD）才 `injectIntakeField`，与人工输入同一写口。gate（人点
  「立项完成」）与必填清单一寸未动。
- **D-3（勘探=workitem run）**：stage=`scout`，owner 槽、readonly、`readableDirs=scoutRoots()`、走 effect
  流事件流留痕；不走 pool.send 旁路。
- **D-4（搜索根自举）**：`scoutRootsFrom(登记父目录, env INTAKE_SCOUT_ROOTS)`，冒号分隔，去重；两者皆空 →
  `[]`（自动触发跳过、手动 /scout 回「勘探不可用」）。
- **D-5（歧义走 AUQ）**：`buildWorkitemQuestionCard`（routing 带 workitemId，header『仓库选择』，选项=带证据
  的候选路径）。
- **D-6（scout_result 桥层消费）**：`scout_apply` effect emit → `postStatus` 的 `scout_result` 分支
  （`runScoutResult` DI）。
- **D-7（防抖）**：`scoutConclusionCount(events) < 2` 才自动派；实测阈值 = **每单自动派勘探 ≤ 2 次**；手动
  `/scout` 不受限。
- **新事件 kind**：仅 `scout_result`（`REQUIREMENT_EVENT_KINDS` 13→14），anchor-drift 断言同步 14；board
  投影补 icon/label。

### 与方案的出入（按意图适配，记要如下）

1. **postStatus 早退顺序**：方案说桥层消费 scout_result，但 `postStatus` 开头对立项相位早退
   （`if (isIntakePhase) return`），而 scout_result 正是在**立项相位** emit。适配：把 scout_result 分支放在
   该早退**之前**，消费完 `return`，不走下方锚点刷新（立项清单卡由 bridge 收料路径维护）。
2. **歧义回灌落点**：方案说「答案走既有 auq-wi 回灌 → 下一轮抽取」。但既有 auq-wi 回调走
   `injectHumanMessage`（→ worktype human_message），而立项相位 `onHumanMessage` 对普通消息返回 `{}` 会把
   答案吞掉。适配：auq-wi 回调**按相位分流**——立项相位改走 `handleIntakeMessage`（合成一条群消息喂抽取路径，
   thread_root=群 chatId），非立项相位维持原 injectHumanMessage。
3. **repos_set 登记（L0.2 item 2）**：作为 `postStatus` 的一个 3 行内联分支（在 intake 早退之后，此时 phase
   已是 split），未像 `runDelegationDue` 那样抽 DI 函数——因逻辑极简（读 payload.repos 逐仓 upsert），store 层
   upsert 已有单测覆盖。
4. **hints 类型**：`scoutSpec(item, hints: string)`，payload 带字符串 hints（自动触发 `hints.join(' ')`、手动
   `/scout` 去前缀原文）；`composeScoutPrompt` 收 string。
5. **抽取 prompt 快路径**：`composeIntakeExtractPrompt` 加第 4 参 `registry`（`{name,path}[]`，缺省 `[]`），
   命中登记 → AI 直接输出绝对路径进 repos；未命中 → 进新增可选输出 `repoHints`（原词照录）。

### 留下的 live 半（真机验证点，见 OVERHAUL 附录 B 手验 12~16）

- 勘探 run 是真 AI 活：磁盘找仓 / 判活跃度 / 出证据 / 写 ```scout 块——沙箱用 stub run + 合成报告覆盖，真机
  需确认 AI 确实只读、只在搜索根内活动、产出块格式合规。
- L0 抽取快路径命中登记表、L1 歧义 AUQ 回灌进下一轮抽取、L2 仓内材料草稿——桥层动作在 DI 单测覆盖，真机验
  端到端。

### 非显然结论（memory 交接）

- **postStatus 立项早退是 scout_result 的坑**：任何在立项相位 emit 的新事件若要桥层消费，必须放在
  `isIntakePhase` 早退之前。
- **立项相位的两条消息路径**：飞书群文本 → `handleIntakeMessage`（抽取）；`injectHumanMessage` → worktype
  `onHumanMessage`（立项相位对非 `/scout` 普通消息返回 `{}`）。二者不通——auq-wi 回灌要进抽取必须显式走前者。
