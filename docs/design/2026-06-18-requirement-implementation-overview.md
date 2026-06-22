# requirement worktype 实现总纲 —— 「一人扛起整个跨端需求」

日期：2026-06-18
状态：实现总纲（v1.1，已吸收一轮项目主审查——竖切优先 / 契约测试独立 / 契约变更结构化闸 / Owner 结构化重建 / 并发一致性专节 / 两处事实修正；供下一个 AI 细化为可执行计划）
配套：宏观设计 `docs/design/2026-06-11-workitem-macro-design.md`（v4 定稿）｜交互原型 `docs/design/prototype-req-flow.html`（「需求批阅台」）｜设计审方法论 `~/.claude/skills/spec-design/`

---

## 0. 本文档定位

这是 **requirement（需求开发）worktype 一次性落地**的总纲。读者是**下一个负责把它细化成可执行计划并实现的 AI**。本文给出：要做什么（WHAT）、为什么这么定（WHY，已与项目主拍板）、**现在代码里有什么/缺什么/改哪里**（对接现状，精确到文件:行）、以及**必须守的红线**。不写到代码级——那是细化阶段的事。

**一句话目标**：让 agent-pipe 长出「**一个人 + 这套系统 = 一个全栈工程师 + 半个 PM**」的能力——人退到 4 个决策点（灯），一个跨多端多服务的完整需求，从理解到交付由系统自治推进。

> **路径/行号约定**：本文行号基于 2026-06-18 调研快照，会随代码漂移，细化/执行时以**实际为准**；文件路径一律给全（`src/...`）。

---

## 1. 范围

### 1.1 一次到位做的（本总纲全部覆盖）
完整的 requirement 单需求闭环：**4 灯 + 中间自治**的流程；**Owner + N Worker** 多工人**真并行**；**对接合同**（契约先行 + 变更/返工）；**集成验证**（代码层 AI 兜底）；**写代码 + worktree 工作区**；**仓库知识层**；**HTML 工作台 + 飞书灯卡**及其与系统的**双向集成**。

### 1.2 明确不做（范围边界，但不堵死）
- **多需求并行**：本次只保证**单需求**端到端跑通。但准入上限 `maxOpen`（默认 3，`src/workitems/config.ts`）保留，单进程多 workitem 的容器能力不删——不堵死后续放开。
- **其他 worktype**：bugfix / investigation 不在本次实现；但**容器改造必须向后兼容** probe/noop，且不能把 requirement 专有逻辑漏进容器层（见 §22 红线）。
- **Codex runner**：继续只用 Claude（现状 Codex 未接入，见 MEMORY）。写权限、集成等都按 Claude 路径设计。
- **强只读 OS 沙箱**：那是 investigation 的需求；requirement 用**写权限档**，不依赖 Codex sandbox。

---

## 2. 设计原则（拍板过的，细化时不得违背）

沿用宏观设计 P1–P7（内核极简 / artifact 优先于记忆 / 状态在服务侧 / 容器只承诺最小公共语义 / 先具体后抽象 / 渐进交付 / 异常路径与正向流程同等建模），叠加本轮聊定的**五条铁律**：

1. **设计必审，不论大小**：任何任务，对齐需求后、开工前，**必产出详细设计 + 人审**，绝不因任务小而跳过。流程可伸缩的是文档厚薄/对抗轮数，"设计→人审"内核雷打不动。
2. **系统真卡住，不靠叮嘱**：该等人拍板处，用**状态机 enforce**（human wait + checkpoint gate），不靠 prompt 提醒模型停下。ai-sentinel 最大痛点就是"LLM 自圆其说滑过流程"。
3. **合同是双向标尺**：对接合同既是开工的发令枪，也是收工时各端**各自验收的尺子**——这让"各端并行还能拼起来"成立。
4. **代码层 AI 兜、真交互人上**：代码层正确性（契约符合 + 本端单测/类型 + 跨端静态对账）由 AI 保障至少一层、**绿了才放行**；真实交互/UI 体验测试由人来。
5. **最危险那一下留给人**：写代码、提交到自己分支可自动；**开 MR / 上线必须人亲手点**（ai-sentinel 血泪：AI 自主开 MR 会误触发飞书研发任务节点）。

---

## 3. 全景：复用 / 改造 / 新建（导航总表）

| 能力 | 现状 | 判定 | 落点 |
|---|---|---|---|
| WorkType 接口 / Transition / Decision / 注册 | 齐全（`src/workitems/types.ts`、`registry.ts`） | ✅ 复用 | 新建 `src/worktypes/requirement/` |
| probe 范本（phase/onEvent/effect/artifacts/idle→close） | 完整（`src/worktypes/probe/index.ts`） | ✅ 照搬模式放大 | — |
| `/probe` 全链路 + thread_claims + injectHumanMessage | 完整（`index.ts:498/566`、`store.ts`） | ✅ 复用 | 加 `/req` 照 `runProbe` |
| 运行中流式卡 + 收尾报告（M2） | 落地（`progress-cards.ts`/`stream-card.ts`） | ✅ 复用 | 每 worker 一张卡 |
| 每工作项独立 git 仓（契约/journal/decisions） | 落地（`src/workitems/artifacts.ts`） | ✅ 复用 | 契约"冻结"免费拿 git 史 |
| outbox 崩溃恢复 / watchdog / wait+到期动作 | 落地（`reducer.ts`/`effects.ts`/`watchdog.ts`） | ✅ 复用 | 需验多 worker 并发恢复 |
| per-run MCP 注入 | 落地（`RunOptions.mcpServers`、`--mcp-config`） | ✅ 复用 | 集成层工具经此注入 |
| **多工人并行调度** | reducer **单飞门**硬编码（`reducer.ts:603`），`topology()` 不消费 | ❌ **改造容器（最大）** | §6.1 |
| **4 灯 checkpoint gate** | `checkpoints.requiredBefore` **声明未消费** | ❌ **新增容器机制 + 类型流程** | §6.2 |
| **isDecisionStale 语义** | 容器机制在，probe 返 false | ⚠️ **requirement 首个真实现** | §6.3 |
| **对接合同（契约先行 + 变更流程）** | 无 | ❌ **新建（worktypes 层）** | §8 |
| **集成验证（契约测试/静态对账）** | 无 | ❌ **新建 effect + handler** | §10 |
| **写权限档（限定仓库目录）** | 仅 readonly/full，`'write'` 未实现 | ❌ **新增 kernel 能力** | §14 |
| **git worktree 工作区供给** | 零雏形，cwd 仅 sandbox/project | ❌ **新增 kernel 能力** | §9 |
| **仓库知识层** | 无 | ❌ **新建一层** | §15 |
| **HTML 工作台 + 事件回流 API** | 静态原型，零对接 | ❌ **新建前端 + 后端 API** | §16/§17 |
| **卡片按钮回调原语** | event-router 只处理 `im.message.receive_v1` | ❌ **新增 kernel 能力** | §16 |
| **人工取消 /cancel + 收尾 journal** | 有 cancelled 态，无命令/收尾流程 | ⚠️ **半成品需补** | §13 |
| **owner journal 写回校验** | ArtifactStore 能写，无校验门 | ❌ **新增类型层校验** | §5 |

> **总纲心法**：requirement = 「probe 范本放大」+「容器补三件」+「kernel 补三件」+「全新两层」。schema 与流式卡地基已就位，**reducer 单飞模型是改造焦点**。

---

## 4. 需求生命周期：7 phase + 4 灯 + 中间自治

phase（内层，容器不解释，requirement 自有）：
```
requirement:理解 → 合同 → 详设 → 拆解 → 并行实现 → 集成验证 → 交付 → 沉淀
```
（「设计契约」拆成 `合同`+`详设` 两个 phase 边界，让灯②的快审/慢审两个 gate 各挂一处——见 §6.2。）
4 灯（人出场的 checkpoint，其余系统自治）：

| 灯 | 位置 | 人做什么 | 机制 |
|---|---|---|---|
| 🟢灯① 对齐需求 | 理解后 | 确认"要做啥" + **兼定流程档位**（AI 建议 Lite/Full，人拍，防偷工） | checkpoint gate → human wait |
| 🟢灯② 审详细设计 | 设计契约后 | **快慢两拍**：先快速过对接合同/接口清单（=并行发令枪），各端详设做完再细审 | 见 §7 |
| 🟢灯③ 验收 | 集成验证后 | 通过 / 打回（带理由） | checkpoint gate |
| 🟢灯④ 提交 | 交付时 | 写码/提交自分支自动；**开 MR/上线必须人点** | 见 §11 |

中间自治段（⚙️，不烦人）：拆解、各端并行实现、集成验证自动跑、接口小改自动处理（留痕）、worker 失败自动 retry。**出岔子救场**：系统先自治重试，反复搞不定才举手；给"病历"（卡哪/试过啥/为啥不行）不甩报错；轻救场（多为一句话/一个选项）。

**流程伸缩**：用 spec-design 的 Lite/Full 轨道。伸缩对抗轮数/文档厚薄/环节，"设计→人审"内核不动。

---

## 5. 角色与拓扑：Owner + Worker

- **Owner（包工头）**：持需求全貌，产契约 + 任务卡，验收 worker 报告，基本不写代码。事件驱动按需唤醒（**单飞 + 批量带入事件**，复用 reducer 现有 wakePending 机制）。**⚠️ Owner 状态以结构化为权威、journal 为辅（采纳审查④：冷重建是正确性问题，非仅成本）**：每次唤醒，系统给 Owner 一份**从结构化状态（events/assignments/contract/open waits）机械生成的「现状快照」当权威输入**；`journal.md` 降为人类可读的叙事补充，**不是权威真相源**。两套真相冲突 → **结构化优先**（与 P3「状态在服务侧」一致），journal 过时即重生成。**休眠写回校验**：照 `reportRequired` 门（`effects.ts:295`），owner 收尾校验 `journal.md` 存在——但权威判断不押在它上。
- **Worker（工人）**：单仓单 assignment、无状态、用完即弃。输入=任务卡+契约+该 repo 知识；输出=结构化报告（代码校验必备）+ 代码分支。
- **拆分 = 按代码仓库拆**：一个仓一个 worker，仓内默认不再拆、扛不动才单独开口子。"对得上"靠对接合同（逻辑一致）、"踩不到一起"靠各占一仓（物理隔离）。**不按功能竖切**（同仓并发写要 worktree 隔离+串行合并，本次不做）。
- ⚠️ **schema 有列 ≠ 逻辑就绪（修正 v1 过度乐观的措辞）**：`workitem_assignments` 有 `parent_id`（自引用）+ `role` 列，但 `parent_id` 在 `reducer.ts:616` **恒为 null、从未赋值也从未被读**；`role` 写入了、retry 透传了，但**无人据它分流**。要建 Owner→Worker 父子链，得补**完整的写入 + 消费逻辑**，不是「免费拿」——见 §6.1。

---

## 6. 容器层改造（三件，落在 `src/workitems/`）

> 红线：改造必须保持 probe/noop 行为不变（CI 回归），且容器**不得 `phase ===`/`switch(phase)`**（`architecture.test.ts` 强制）。所有 requirement 语义留在 worktypes 层。

### 6.1 多工人并行调度（最大改动——是**三层协同**，不止 reducer）
⚠️ **采纳审查：多 worker 并行不是改 reducer 一处，至少三层都得动，少一处都无法真并行：**
1. **reducer 单飞门**（`src/workitems/reducer.ts:603-610`）：判定是**三段与** `!spec.replacesAssignmentId && isRunClass('run') && hasInflightRunEffect`——即**返工(replacement) assignment 本就绕过单飞门**，加上有 run 在途时后续 dispatch 全转 `wakePending`（**无视 role**）。改成：`topology()==='owner-workers'` 时 **owner run 仍单飞、worker run 可并行**（按 `AssignmentSpec.role` 分流，受每项并发上限 `WORKITEMS_MAX_WORKERS_PER_ITEM` 约束，默认 2）。
2. **EffectRuntime 多 inflight**（`src/workitems/effects.ts:48`）：现按 `workitemId` 维护**单个 inflight**，`poke` 时**阻止同一 workitem 的第二个 effect**（`effects.ts:65`）。即使 reducer 放行多 worker，**effect 层仍会串行/互相覆盖 abort controller**。改成**按 assignment 维护多 inflight**——允许同一 workitem 多个 run effect 并发执行。
3. **abort controller 粒度**：从 **per-workitem 降到 per-assignment**——否则取消/超时一个 worker 会误伤其它在跑的 worker。
**注意两条非单飞路径并存**：worker 并行后系统里有 **replacement** 与 **worker** 两条「非单飞」路径，它们在 outbox 崩溃恢复、wakePending、abort 上的交互必须论证（见 §6.4），别假设互不影响。
**防优先级反转**：池被 worker 占满、owner 唤不醒——宏观设计 §3.2 的「Owner 预留槽」是本次**必要保障**（kernel pool 现状无优先级，见 §19）。

### 6.2 4 灯 checkpoint gate
**现状**：`checkpoints.requiredBefore: string[]` 声明但**完全未消费**（`reducer.ts:368` 注释“M1 checkpoint planned”），类型是 **phase 名列表**（`src/workitems/types.ts:92`）。
**单轨事件模型（采纳审查：避免 wait/decision 双轨）**：checkpoint **就是 human wait 的一种用法**，不另起 `checkpoint_decision` 双轨——
- ① 容器机制：phase 转移到 `requiredBefore` 所列边界前，**自动插一个 human wait** 拦截，未 resolve 不得越过；
- ② **拍板 = `resolveWait` 扩展携带 `{approved, reason}`**（一个动作同时 resolve wait + 产出决定），reducer apply 后由 worktype onEvent 据决定推进/回退 phase——**不会出现“wait resolved 但 phase 没动”或“decision 绕过 wait”**；
- ③ 打回回退由类型逻辑定（灯②打回→回设计、灯③打回→回集成验证派修复）；**连拒 2 次升级对话**（复用 `discard_streak`）；
- **API**：扩展 `resolveWait` 携带 decision 语义（**不新增并行的 inject 方法**），保持单一注入口。
**⚠️ 灯②是一个 phase 里两个 gate（快审合同 / 慢审详设），`requiredBefore: string[]` 一个 phase 边界只挂一个 gate 不够**（采纳审查）。两个落法、**倾向前者**：(a) **拆 phase**——把“设计契约”拆成 `requirement:合同` 与 `requirement:详设` 两个边界各挂一 checkpoint（§4 phase 序列照此调）；(b) checkpoint 改为**独立 id**（不绑 phase 边界）。细化阶段定。

### 6.3 isDecisionStale 语义
**现状**：容器机制（结构检查 based_on_seq + 钩子调用）已接，probe 返 `false`。requirement 是**首个真用它的类型**。
**要做**：实现 `isDecisionStale(decision, eventsSince)`——判断"自决策做出后，契约是否已变更 / 影响范围是否重叠"。**坑（已识别）**：这本质是语义判断，纯函数易退化成脆弱规则。细化阶段决策：以**契约文件版本/受影响 repo 集合的结构化比对**为主（contract 版本号变了、或 eventsSince 含触及同一 repo 的 `contract_change_applied` 即判 stale），避免在 reducer 里调 LLM。若必须语义判断，下沉为一个 effect（异步）而非同步纯函数。**与 §8 的契约变更判定共用同一套 contract 结构 diff**（一石二鸟，避免各自实现脆弱规则）。

### 6.4 并发一致性论证（新增专节，采纳审查）

reducer 是「per-item FIFO 串行 apply + 纯转移」——**事件逐个有序 apply 是既有地基**。但 requirement 是它**第一次遇真并发**，加上 §6.1 的 effect 层多 inflight，必须单独论证（别埋在 §6.1 一句「按 role 分流」里）：
- **批次完整性 + 幂等**：N 个 worker 并发完成 → 各自 enqueue `run_completed` → 串行 apply → 触发 Owner 唤醒时 `wakePending` 批量带入「自上次 Owner run 以来的全部事件」——须证明这批次**不漏不重**（worker 在 Owner 运行期间完成的事件如何归入下一批）。
- **两条非单飞路径 × effect 多 inflight 的崩溃恢复**（接 §6.1）：replacement 与多个 worker run 同时在途时，`startupRecovery` 重建在途 effect、按 assignment 恢复 abort，要覆盖这些组合。
- 建议：细化阶段用 noop 级夹具（`src/worktypes/noop/index.ts` 的失败/静默注入）专打这些并发路径，像 M0 打 outbox 那样回归锁定。

---

## 7. 灯②：设计审 = 复用 spec-design + 跨端一刀

**内核直接复用用户自有 skill** `~/.claude/skills/spec-design/`：6 步（理解→**代码考古**→Requirement(User Story)规划→详设(EARS AC)→决策台账→AI 装配按 domain 切）+ 三层质量保证（🤖Sensor 机械验 / 👤人审 Gate / 🔴Adversarial 独立子 Agent 对抗审）+ 给人审两视图（design-overview 大纲 / design-detail 详览）。它本就是项目自研用的方法论（`docs/ai-specs/` 即其产物），现内化为 requirement 的"设计阶段"标准动作。

**跨端一刀（agent-pipe 在 spec-design 之上加的）**：
- (a) `internal-apis.md`（spec-design 里的单库内部 API 契约）**升格为"前后端对接合同"** = 灯②前半拍（快拍）的快速确认对象、并行发令枪。
- (b) `design/`（spec-design 按 domain 切、单执行者顺序消费）**扩成"按端/仓库再切、各端 worker 并行领走"**。

**快慢两拍**：快拍——Owner 先产**接口清单**，人花两三分钟扫一眼"够不够用、有没有漏"，认了→合同冻结=发令枪；慢拍——各端据冻结的合同并行做详设，详设回到工作台让人逐块细审（大纲走系统精排投影视图、详览走 MD 就地渲染，见 §16）。

**落地**：spec-design 是独立 skill，requirement 的"设计契约" phase 通过 effect 调起一个跑 spec-design 流程的 agent（managed run），产物落进该 workitem 的 artifact 仓 `contract/` + `design/`。

---

## 8. 对接合同（契约先行 + 变更/返工）

- **形态**：存 artifact 仓 `contract/`（git 化，"冻结"语义免费拿版本史）。每条接口字段含 `提供方 / 调用方`（**这是影响计算的依据**，原型 `prototype-req-flow.html` 接口清单已体现）。
- **变更分两路——按 contract 结构 diff 机械判定，不靠 Owner 语义自裁**（采纳审查：把“小改还是大改”交给 AI 自由裁量，等于在灯①防死的“AI 自我宽容偷工”在这里又开口）：
  - **纯增 = 小改**：仅“加字段 / 加接口 / 加可选项”等单调扩展、不动任何已有签名——Owner 可自治即改，**不惊动人**但**完整留痕**（活动流标“自治·接口小改” + 决策台账归类“系统替我做的”，供事后批量审查、可退回纠正）。事件 `contract_patched`。
  - **减字段 / 改类型 / 改语义 / 删接口 = 大改（破坏性），强制回灯②**：一律不许自治，系统给“接口要改”卡（谁发现/为何改/影响哪几端/哪些活返工），人拍准改/不改/再想。事件 `contract_change_proposed/approved/applied`（宏观设计 §6.4 一等流程）。
  - 判据由 contract 的结构化 diff 产出（增量 vs 破坏性），**与 §6.3 的 isDecisionStale 共用同一套合同 diff**。
- **影响计算**：改一条接口，系统据 `提供方/调用方` 精准算出受影响的 worker；受影响的返工、**其他端照跑不停**。
- **返工不白丢**：受影响 worker 带"原活+接口改了哪+为何"重做（新 assignment，`replaces_assignment_id` 链），分支保留。
- **反复改就举手**：同接口改 2–3 次仍不定 → 不再自动转，举手"设计本身可能有问题"（复用连拒升级基因）。
- **预防**：灯②的 Adversarial（唱反调 AI）专挑接口的刺（上限/边界/字段缺失），尽量开工前挑净。

---

## 9. 各端并行执行 + 工作区供给

- **worker 领活**：任务卡（brief）+ 冻结的对接合同 + 该 repo 的知识（§15）。组 prompt 照 `src/worktypes/agent-run/run-handler.ts:84` 的模式（`composeProbePrompt` 换成 `composeWorkerPrompt`）。
- **写权限档**：见 §14。run-handler `:147` 硬编码 `readonly` 改为由 `worktype.permissions` + assignment 驱动。
- **git worktree 工作区供给（kernel 新增，零雏形）**：worker 在“某仓某分支的 worktree”里写代码、跑测试。kernel 新增通用能力 `git worktree add <path> <branch>`（从需求基线切 feature 分支）→ 用完 `git worktree remove` 回收。⚠️ **cwd 落点精确（采纳审查）**：cwd 是 **Task 字段**（`src/store.ts:13`），不是 `RunOptions`；现 agent-run handler 经 **managed shadow task** 决定 cwd（`src/worktypes/agent-run/run-handler.ts:101` upsertTask）。所以 worker worktree = **一 assignment 一个 managed task、其 cwd = 该 worker 的 worktree 路径**，**不是只改 `pool.send` 的 options**（呼应 §6.1：每 worker 独立 task / cwd / abort）。**注意区分**：artifact 仓（`$DATA_DIR/workitems/<id>/`，存契约/报告）≠ worker 写代码的目标仓 worktree。
- **各端自测（代码层硬门，铁律 4）**：worker 交活前必须跑绿 ① **跨端契约测试** ② 本端单测 + 类型/编译。**绿了才能交活**（不绿判 run_failed，照 `reportRequired` 门新增“测试结果门”）。⚠️ **契约测试必须独立于实现 worker**（采纳审查）：实现 worker 自己写“我符合合同”的测试 = 同一个 AI 按同一种可能错误的理解既写实现又写验证、会一致地错还照绿——“绿”只证自洽不证对合同理解对。**分工**：本端单测（验自己逻辑）worker 自己写没问题；**跨端契约测试从冻结合同机械生成、或由独立角色（质检员）产出，worker 不许碰**（与 spec-design「Adversarial 用独立子 Agent」同源，独立性是“绿”有意义的前提）。

---

## 10. 集成验证

- **谁验**：一个"质检员"角色（可为 Owner 的一个 phase 动作，或专门 assignment），拿冻结合同当标尺。
- **代码层（AI 兜，绿了才放行）**：① 各端的**契约测试**结果汇总；② **跨端静态对账**——把各端实现 vs 合同逐条核（后端真实现了这些接口？字段类型对？前端真按合同调？）。新增 effect kind `integration_check` + handler。产出**差异报告** → 对不上接 §8 返工流程。
- **真交互（人上）**：静态+契约覆盖不到的端到端/时序敏感流程，系统用临时 worktree 把各端分支拉一起、按各仓 `runbook`（§15）起服务，**交给人点**。**该上才上，非每需求标配**。
- **收口**：代码层绿 + （如需）人过真交互 → 进灯③验收。

---

## 11. 提交 / 交付

- 写代码、提交到**自己的 feature 分支**：自动。
- **开 MR / 上线**：**必须人亲手点**（灯④）。MR description 等平台纪律参考 ai-sentinel `company-branch` skill（feature 基于 prod、`pull --ff-only`、MR 首行 `rd:<id>` 等）——细化阶段决定多少写进 prompt 自律、多少代码兜（ai-sentinel 经验：极少数高危拦截 + 大量 prompt 自律 + 写明 why）。
- 交付产物：契约 + 设计决策 + N 个 PR（含发布顺序）+ 沉淀文档（写回知识层）。

---

## 12. 前端 UI 特殊处理

前端 worker 的“完成”定义 ≠ 后端：AI 只搭到“用户能本地一键跑起来看”（结构 + 数据对接，可自验），**UI 精修由人主导**（小改人自己改、大改甩回 AI）。UI 像素不进对接合同。
⚠️ **“人调满意 = 前端过”只指 UI 体验/视觉那一层不另设 gate；代码层硬门照旧**（采纳审查：§12 与 §4/§10 的语义衔接）——**人手改完 UI，该端的契约测试 + 类型/编译要重跑绿**（防人改破坏了对接）。前端**汇入灯③总验收的条件 = 代码层硬门绿 ∧ 人对 UI 满意**（∧ 如需的真交互），两者都满足才算这一端过。

---

## 13. 异常与监督（与正向同等建模，宏观设计 §6）

- **checkpoint 被拒 / 回退**：见 §6.2。连拒 2 次升级对话。
- **worker 失败 / 卡死 / 空转**：复用 watchdog（心跳 + 墙钟 + deadline，`watchdog.ts`）→ `assignment_stalled` → retry 预算 → 耗尽建 human wait。**已就位，多 worker 各自被监督**。
- **集成验证失败**：差异报告 → 派修复 assignment（新 worker，不复活旧），修复循环上限 2 轮，超则 human wait。
- **契约变更**：见 §8（一等事件）。
- **人工取消（半成品需补）**：现有 cancelled 态 + `finalizeTerminalState`（abort run + resolve wait），但**缺 `/cancel` 命令 + 确认卡 + 收尾序列**。补：`/cancel`（thread 内）→ 确认卡防误触 → abort 所有 running assignment → **回收 worktree** → Owner 最后唤醒写收尾 `journal.md`（半成品在哪个分支）→ cancelled 终态。不删 artifact 仓。

---

## 14. 权限与安全（kernel 新增写权限档）

**现状**（`src/agents/types.ts:98`）：`PermissionProfile { mode:'full'|'readonly' }`，`'write'` 注释"lands in M2"未实现。Claude readonly = `--disallowedTools 'Write Edit MultiEdit NotebookEdit'`（弱档，拦不住 Bash/curl），full = `--dangerously-skip-permissions`。
**⚠️ 现状是两层分叉（采纳审查）**：`workitems` 层 `PermissionProfile` 已是 `readonly | write`（`src/workitems/types.ts:88`），但 `agents` 层还是 `full | readonly`（`src/agents/types.ts:98`）——两层不一致。
**要做（含两层对齐）**：① **`repos: string[]` 在 workitems 层声明**（business 意图，放 `permissions` 或 assignment）；② agent-run handler 把 workitems 的 `{mode:'write', repos}` **映射成 agents 层 `RunOptions`**（repos → 可写目录列表）——**agents 层只认路径、不认“repo”概念**（守 kernel 中性）；③ `src/agents/types.ts` 加 `'write'` 档；④ `buildClaudeArgs`（`src/agents/claude/runner.ts:36`）消费成 `--add-dir` + `--allowedTools` / settings / PreToolUse hook（**Claude 无原生“限定写入目录”参数，写档强度是真问题**，宏观设计 §5.2，细化阶段重点解）；⑤ `runOptionsFingerprint` 已含 permission，新档自动触发 runner 重建，**不用改 pool**；⑥ run-handler `:147` 改由 worktype 驱动。
**凭证边界**：worker 在 worktree 里跑，凭证（如 git 推送 token）不进 prompt/任务卡；适配器配置路径进 deny 列表（宏观设计 §8）。

---

## 15. 仓库知识层（新建一层 `src/knowledge/` + `$DATA_DIR/knowledge/`）

各端 worker 要懂各自仓库（架构、约定、构建/测试命令、坑）。
- **形态**（宏观设计 §7）：`$DATA_DIR/knowledge/<repo_key>/{map.md, conventions.md, runbook.md, pitfalls.md}` + `_system/topology.md`（跨 repo 拓扑）。整体 git 化。
- **建立**：每 repo 一次性索引任务生成初版；`_system/` 人+agent 访谈式整理。**与 spec-design 的"代码考古"(Step 2)对接/复用**——考古产出可喂知识层。
- **保鲜**：知识文件锚定生成时 commit hash，消费时检查 HEAD 偏离，超阈值标 stale 触发重建。
- **消费**：任务卡组装时按 assignment 关联的 repo **选择性注入**（有上限），不全塞。
- 依赖规则：`knowledge` 不依赖 `workitems`（知识跟 repo 走，不跟工作项走）。

---

## 16. 人机交互：工作台 + 灯卡（飞书）

- **一需求一话题（thread）+ 锚点卡**：复用 thread_claims（`store.ts`）+ `buildAnchorCard`（`feishu/card.ts:59`）。
- **灯 = 飞书交互卡**：⚠️ **卡片按钮回调原语缺失**——`event-router`（`src/feishu/event-router.ts:15`）现只处理 `im.message.receive_v1`。**kernel 新增 `card.action` 分发，但守红线（采纳审查）**：kernel/feishu 层**只分发 raw card action（value 当不透明 payload 透传），绝不解释里面的 `workitemId/checkpoint`**——否则在 event-router 里出现这些业务词就踩了 §22 红线（CI 会拦）。由**上层 workitems adapter 解释 payload** → 走事件回流（§17）。卡片 value 带 `{workitemId, checkpoint, decision}` 但只有 workitems 层认得。按钮回调 3 秒内 toast、真实动作异步。文本回复兜底（现状 checkpoint 靠 thread 文本 + injectHumanMessage，可先用着）。
- **新增卡片构造器**：现锚点卡只有"进度/状态"两字段。requirement 的"4 灯 rail / 各端工人 1/4 / 决策台账"需新建卡片（守 kernel 中性命名：用 `stage/status`，**不出现 `phase` 等业务词**）。
- **HTML 工作台**：原型 `prototype-req-flow.html` 是蓝本——单需求工作台为主（活动流 + 各端工人面板 + 决策台账 + 产物文档 + "该你了"焦点卡 + @包工头介入条），看板退成轻入口；视觉走"决策者批阅台"纸张朱批风。**MD 文档（大纲/详览/各端详设）一律在 HTML 内就地渲染**（marked.js 或后端），不本地打开。

---

## 17. 工作台的工程集成（读视图 + 事件回流）

**核心**：HTML 工作台 = workitems 现有状态的"**读视图**" + 把人的操作转成事件喂回的"**写 API**"。复用现成 SQLite + artifact，不另起炉灶。

- **读路径**：agent-pipe 常驻进程内挂**轻量 HTTP 服务**（Node 自带 http，**不引前端框架**），路由 `/workitem/<id>` 服务端渲染。数据源：
  - 活动流 ← `workitem_events`（append-only，`api.listEvents` 已有读侧）
  - 各端工人 ← `workitem_assignments`（role/status/进度）
  - "该你了"焦点卡 ← open `workitem_waits`（kind=human）
  - 决策台账 / 大纲 / 详览 / 对接合同 ← 该 workitem 的 git artifact 仓 `.md`
- **写路径（事件回流）**：页面按钮（通过/打回/裁决/@包工头）→ 本地 API → 转事件 → 走 **workitems 既有 inject 门面**（`resolveWait` / `injectHumanMessage` / 新增 `injectCheckpointDecision`）→ reducer → 推进。**agent 只按既有机制改状态/写文件、不碰页面**（同 ai-sentinel "单写入口、页面只读投影"）。
- **送达 + 刷新**：飞书锚点卡挂链接点开；公司外访问走内网穿透（ai-sentinel 用 cloudflare）；刷新第一版**前端轮询版本号变了整页/局部刷**（抄 ai-sentinel，零框架），agent-pipe 是事件驱动的，后续可升级 SSE。
- **安全**：本地服务做鉴权（仅本人可操作），参考 ai-sentinel owner 校验。

---

## 18. 数据模型（复用五表 + 增量）

复用 `workitems/assignments/waits/effects/events` 五表（字段见调研，`store.ts` migration）。requirement 增量：
- **新事件 kind**（写进 `workitem_events.kind`，容器不解释）：`checkpoint_reached/checkpoint_decision`、`contract_frozen/contract_patched/contract_change_proposed/approved/applied`、`worker_report`、`integration_check_passed/failed`、`design_ready` 等。
- **assignment**：`role='owner'/'worker'` 投入使用（现 schema 有，reducer 未消费）。
- **artifact 仓布局**（每 workitem 一个 git 仓）：`brief.md / journal.md（owner 写回，校验）/ decisions.md / contract/（接口合同，含提供方调用方）/ design/（spec-design 产物，按端切）/ assignments/<id>/{brief,report}.md / report.md`。

---

## 19. kernel 新增能力清单（守内核中性，宏观设计 §3.2）

| 能力 | 现状 | 要做 | 文件 |
|---|---|---|---|
| 写权限档 | 仅 readonly/full | 加 `'write'`+repos + Claude 写档分支 | `agents/types.ts`、`claude/runner.ts:36` |
| git worktree 工作区供给 | 零雏形 | add/remove + 回收，作 cwd | 新建（kernel 通用层） |
| 卡片按钮回调原语 | 只处理 im.message | 加 `card.action` 分发 | `feishu/event-router.ts` |
| 调度优先级 / Owner 预留槽 | pool 无优先级（`pool.ts`） | 防优先级反转（owner 唤不醒） | `agents/pool.ts` |

> 红线：kernel 新增能力必须"对纯飞书桥用户也有意义"（通用），**不得出现** `workitem/assignment/worktype/phase` 业务词（CI 强制，`tests/architecture.test.ts`）。

---

## 20. 对接现有代码的接缝（细化阶段操作指南）

1. **新建 worktype**：`src/worktypes/requirement/index.ts` 实现 `WorkType` + 导出 `registerRequirement`；在 `src/index.ts createWorkitemsRuntime()`（:807）注册（照 `registerProbe` :871）。
2. **新 effect**：checkpoint / 集成验证 / worker run 各自的 handler，`workitems.effects.registerHandler(...)`（照 :872）。worker run 复用 `createAgentRunHandler` 模式（`agent-run/run-handler.ts`），换 prompt 组装 + 权限 + cwd（worktree）。
3. **命令**：`/req` 加进 `CommandHandler`（`bridge/commands.ts`）+ `index.ts` 入口（照 `runProbe` :498 / `runDone` :566）。
4. **出站桥**：`postStatus`（`index.ts:841`，订阅 `onCommitted`）扩展刷新新卡片。
5. **HTTP 工作台**：新模块，读 `workitems.api` + artifact 仓，写经 inject 门面。

---

## 21. 实现切分建议（一次到位，但内部有依赖序）

虽一次交付，内部按依赖推进最稳（每段可测）：
1. **地基改造**：reducer 多工人并行（§6.1）+ checkpoint gate（§6.2）+ noop 级夹具回归（照 `noop/index.ts` 注入多 worker/checkpoint 路径）。
2. **kernel 能力**：写权限档 + worktree 供给 + 卡片回调（§19）。
3. **requirement worktype 骨架**：7 phase + onEvent + 4 灯 + artifacts（§4/§5），先用 noop 级 run handler 跑通流程（不接真 agent）。
4. **接真 agent**：worker run handler（§9）+ 集成验证（§10）+ 对接合同（§8）+ isDecisionStale（§6.3）。
5. **知识层**（§15）+ **设计审接 spec-design**（§7）。
6. **HTML 工作台 + 事件回流**（§16/§17）。
7. 端到端：用一个**真的双端需求**（1 Owner + 后端 worker + 前端 worker）跑通全程，验证"几个 AI 照合同并行还能拼起来"——这是 ai-sentinel 没趟过、本项目要立住的核心命题。

---

## 22. 必须守的红线（CI 强制 + 设计承诺）

- **分层依赖单向**：`worktypes → workitems/knowledge → kernel`，kernel 不 import 上层（`tests/architecture.test.ts`）。
- **容器不解释 phase**：`workitems/` 禁 `phase ===`/`switch(phase)`；requirement 所有业务逻辑在 `src/worktypes/requirement/`。
- **kernel 无业务词**：kernel 层（`src/` 根 + `feishu/` + `agents/`，除 index.ts/config.ts）禁 `workitem|assignment|worktype|phase`。
- **probe/noop 不回归**：容器改造后 probe/noop 行为不变，测试绿。
- **reducer 纯转移**：IO 在事务外，effect 经 outbox；不在 reducer 里 await agent。
- 反模式（宏观设计 §3.3）：飞书卡 value 不带业务状态、对话历史不当 Owner/Worker 接口、不做 DSL 工作流引擎、不出现第二个叫 task 的概念（子任务统一 assignment）。

---

## 23. 开放问题（留给细化阶段决策，不得静默跳过）

1. **拆解维度 × 分支策略**（宏观设计开放问题 1）：本总纲定"按仓拆"，但同仓多 worker（若未来放开竖切）的 worktree 隔离 + 串行合并未设计——本次按"一仓一 worker"实现，接口上不堵死。
2. **isDecisionStale 的具体实现**（§6.3）：结构化比对的判据需细化，避免脆弱或误下沉 LLM。
3. **Claude 写档强度**（§14）：`--add-dir`/hook 能否真限定写入目录，拦不住 Bash 写盘怎么办——细化阶段须给出可验证方案。
4. **集成验证形态**（§10）：契约测试框架选型、静态对账怎么做（读各端代码 vs 读接口声明）。
5. **Owner 重建税**（已识别风险）：Owner 每次唤醒从 journal 冷重建，大需求下 token 成本与判断衰减未实测——建议第 7 步端到端时埋点观测。
6. **知识层冷启质量 / 保鲜阈值**（宏观设计开放问题 2）。

---

## 24. 关键文件索引

- 接口：`src/workitems/types.ts`｜注册 `registry.ts`、`index.ts:807`
- 范本：`src/worktypes/probe/index.ts`、`noop/index.ts`、`agent-run/run-handler.ts`
- 改造焦点：`src/workitems/reducer.ts`（单飞门 :603、容器事件 :368）、`effects.ts`（run 收尾 :196/:295）
- kernel：`src/agents/types.ts`（权限 :98）、`claude/runner.ts`（:36）、`pool.ts`、`src/store.ts`（thread_claims/managed task）
- 飞书：`src/feishu/card.ts`（:59/:179）、`progress-cards.ts`、`stream-card.ts`、`event-router.ts`
- 设计/原型：`docs/design/2026-06-11-workitem-macro-design.md`、`docs/design/prototype-req-flow.html`
- 方法论：`~/.claude/skills/spec-design/`
- 红线：`tests/architecture.test.ts`、`tests/helpers/architecture.ts`
