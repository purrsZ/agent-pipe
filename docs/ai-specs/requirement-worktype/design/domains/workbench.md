# Domain: workbench

> HTML 工作台读视图（多页 SSR）+ 事件回流写 API + 飞书灯卡 + 一需求一话题。覆盖 **R17 全部 AC（含回补 AC7 空态）+ R18 全部 AC + R19 全部 AC + R06 的消费侧 AC（AC3/AC5）**。
> 层：kernel + 新 HTTP 模块（`src/workbench/`）+ feishu 卡片构造器。
> 📖 复用资源锚点见 [../codebase-findings.md](../codebase-findings.md) Part B；新增 API 见 [internal-apis.md](internal-apis.md)。

---

## 领域职责

**负责什么**：
- **HTML 工作台读视图**：常驻进程内挂轻量 HTTP（Node 自带 `http`、不引框架），SSR 多页渲染（看板 `/` / 工作台 `/workitem/<id>` / 审设计 `/workitem/<id>/review`）；读视图复用现成 SQLite + artifact，零另起炉灶。
- **工作台事件回流写 API**：页面按钮（通过/打回/裁决/@包工头）→ 既有 inject 门面（resolveWait/injectHumanMessage/扩展 checkpoint decision）→ reducer → 推进；单写入口、页面只读投影、本人鉴权。
- **飞书灯卡 + 一需求一话题**：复用 `claimThread`（managed）认领话题 + 锚点卡；4 灯交互卡（按钮回调 value 带 `{workitemId, checkpoint, decision}`）；requirement 专用卡片构造器（4 灯 rail / 各端工人 / 决策台账，标题去"调查"化）；每 worker 一张 M2 流式卡（按 assignmentId 分流、title 带 role/repo 区分）；新事件 kind 在 `anchorAction` 加映射决定是否刷锚点。
- **R06 消费侧**：workitems adapter 解释 kernel 透传的 raw card.action value、走 inject 门面（R06.AC-3/AC-5）；定义卡片 value schema + button 构造（kernel 分发侧不碰）。

**不负责什么**：
- 不负责 card.action 的 **ws 分发原语本身**（R06.AC-1/AC-2 在 kernel-capabilities 域，本域只消费它透传的 raw action）。
- 不负责 phase 状态机 / checkpoint 拦截逻辑（requirement-statemachine + checkpoint-gate 域）；本域只把页面/卡片按钮翻成 inject 门面调用，**不解释 phase**。
- 不负责 worker 流式卡的内部生命周期与节流（M2 `StreamingCard`/`RunProgressSink` 既有，直接复用、不调参）。
- 不负责 inject 门面内部的 stale 校验（checkpoint-gate 域，本域只调用扩展后的 `resolveWait` 带 decision）。

---

## 核心概念（本域特有）

- **工作台（Workbench）**：进程内轻量 HTTP 服务，"需求批阅台"。视觉走纸张朱批风（原型 [`prototype-req-flow.html`](../../../design/prototype-req-flow.html) 为蓝本），单需求工作台为主、看板退成轻入口。
- **读视图（read projection）**：纯只读投影，从 SQLite 五表 + artifact git 仓机械生成 HTML，agent 不碰页面。
- **写入口（inject 门面）**：所有页面/卡片写操作的唯一通道 = workitems `WorkitemsApi`（resolveWait/injectHumanMessage/injectClose），不新建写路径。
- **锚点卡（anchor card）**：一需求一张常驻卡，承载 4 灯 rail + 进度 + 状态，事件驱动刷新（`anchorAction` 决定刷不刷）。
- **灯交互卡（checkpoint card）**：拍板用的按钮卡，value 携带 `{workitemId, checkpoint, decision}`（**只有 workitems 层认得**）。
- **流式卡（streaming card）**：每 worker 一张，按 assignmentId 天然分流（M2 既有），requirement 下 title 带 role/repo 区分。
- **card.action 消费侧 adapter**：workitems 层组件，接 kernel 透传的 raw `action.value`，解释 `workitemId/checkpoint/decision` 并调 inject 门面（守红线——解释只在 workitems 层）。

---

## 数据契约（TypeScript 接口）

> 引用 internal-apis 的不重复写签名，给章节锚点。

- **resolveWait 扩展决策语义**：`resolveWait(waitId, {operator, reason, decision?})` —— 详见 internal-apis.md **§2.6**（checkpoint 拍板：一动作 resolve wait + 产出 decision；不新增并行 inject 方法）。本域页面按钮/灯卡回调都汇到这个签名。
- **card.action 透传分发**：详见 internal-apis.md **§5.5**（kernel 分发侧，本域消费它的输出）。
- **事件 kind 权威清单**：详见 internal-apis.md **§7**（`anchorAction` 映射的唯一权威，本域负责给每个 kind 加显式刷新决定）。

**本域新增的卡片 value schema（feishu 卡片构造器侧，定义在 feishu/card 层但 value 内容只 workitems 层解释）**：
```ts
// 卡片按钮 value（不透明 payload，kernel/feishu 只透传，workitems adapter 才解释）
interface CardActionValue {
  workitemId: string;          // 哪个需求
  checkpoint: string;          // 哪盏灯（如 'requirement:合同'，即 requiredBefore 边界名）
  decision?: { approved: boolean; payload?: unknown };  // 拍板决定（通过/打回 + 理由载荷）
}
// ⚠️ 这个 schema 的字段语义只在 workitems adapter 被解释；feishu/card.ts 构造时只当不透明 object 塞进 button.value
```

**工作台读视图的数据源映射（只读，全部复用现成）**：
| 区块 | 数据源 | 复用资源 |
|------|--------|----------|
| 活动流 | `workitem_events`（listEvents） | [res-workitemsapi](../codebase-findings.md#res-workitemsapi) |
| 各端工人面板 | `workitem_assignments`（role/status/repo/进度） | [res-five-tables](../codebase-findings.md#res-five-tables) |
| "该你了"焦点卡 | open `workitem_waits`(human) | [res-projection](../codebase-findings.md#res-projection) computeRollup |
| 决策台账 / 大纲 / 详览 / 合同 | artifact 仓 `.md`（readFile） | [res-artifactstore](../codebase-findings.md#res-artifactstore) |

---

## 涵盖的 AC

> Sensor2 校验依据，逐条列全。

### R17 HTML 工作台读视图
- **R17.AC-1**：访问工作台 → 常驻进程内挂轻量 HTTP 服务（Node 自带 `http`、不引前端框架）SSR 渲染。
- **R17.AC-2**：渲染单需求工作台 → 活动流←`workitem_events`、各端工人←`workitem_assignments`、"该你了"焦点卡←open `workitem_waits`(human)、决策台账/大纲/详览/合同←artifact 仓 `.md`。
- **R17.AC-3**：展示 MD 文档（大纲/详览/各端详设）→ 在 HTML 内**就地渲染**（marked.js 或后端），不本地打开。
- **R17.AC-4**：页面按视图/路由拆多页（看板 `/`、工作台 `/workitem/<id>`、审设计 `/workitem/<id>/review`），共享样式/脚本。
- **R17.AC-5**：状态更新 → 第一版前端轮询版本号变了整页/局部刷（零框架，后续可升 SSE）。
- **R17.AC-6**：公司外访问 → 走内网穿透（如 cloudflare）。
- **R17.AC-7（回补·空态）**：活动流/工人/合同/台账任一区块为空（刚创建、artifact 仓只有 brief.md）→ **空态渲染（不抛、显占位），不返 500**。

### R18 工作台事件回流写 API
- **R18.AC-1**：页面按钮触发 → 转事件经 workitems 既有 inject 门面（resolveWait / injectHumanMessage / 扩展的 checkpoint decision）→ reducer → 推进。
- **R18.AC-2**：写路径执行 → 保持"单写入口、页面只读投影"（agent 只按既有机制改状态/写文件、不碰页面）。
- **R18.AC-3**：打回 → 带理由写进决策台账，包工头据此回去改这一处、不重走整套。
- **R18.AC-4**：非本人操作 → 本地服务鉴权拒绝（仅本人可操作，参考 ai-sentinel owner 校验）。

### R19 飞书灯卡 + 一需求一话题
- **R19.AC-1**：创建 requirement → 复用 `claimThread`（managed）+ 锚点卡，一需求一话题。
- **R19.AC-2**：灯需要拍板 → 用飞书交互卡（按钮回调 R06），value 带 `{workitemId, checkpoint, decision}`。
- **R19.AC-3**：新增 requirement 卡片 → 新建"4 灯 rail / 各端工人 1/4 / 决策台账"卡片，守 kernel 中性命名（stage/status，不出现 phase 等业务词）。
- **R19.AC-4**：复用现有卡片构造器 → 把标题前缀"调查 ·"参数化/新建专用构造器（否则显示"调查"误导）。
- **R19.AC-5（覆盖·一致性）**：新事件 kind（design_ready/checkpoint_*）→ 在 `anchorAction` 加映射决定是否刷锚点；**R24 新事件 kind 清单为 anchorAction 映射的唯一权威**，二者同步，加测试断言两份清单不漂移（防漏挂导致锚点静默）。
- **R19.AC-6**：拿不到 threadRoot → 回落 chatId（同 postReport），updateCard 无回落则 log。

### R06 卡片按钮回调原语（消费侧）
- **R06.AC-3**：上层 workitems adapter 收到 raw card action → **解释 payload** 并走 inject 门面（resolveWait 等）。
- **R06.AC-5**：卡片构造 → 给卡片元素加 `tag:'button'` 并约定 value schema（携带 `{workitemId, checkpoint, decision}`，**只有 workitems 层认得**）。

---

## 设计细节（按功能点分节）

### 1. 轻量 HTTP 工作台服务（R17.AC-1/AC-4）

- 新建 `src/workbench/` 模块，进程内挂 Node 自带 `http.createServer`（**不引 express/fastify 等框架**，R17 Never）。服务随常驻进程起停，复用现成 SQLite 句柄 + ArtifactStore，**不另起独立进程**（design-detail §3 "不新建独立进程"）。
- **路由按视图拆多页**（R17.AC-4）：
  - `/` 看板（轻入口，列所有 workitem 概览）。
  - `/workitem/<id>` 单需求工作台（主页面：活动流 + 各端工人面板 + 决策台账 + 产物文档 + "该你了"焦点卡 + @包工头介入条）。
  - `/workitem/<id>/review` 审设计页（逐块细审各端详设）。
  - 共享样式/脚本（独立 `.css`/`.js` 静态资源或内联模板片段），不必挤单 HTML（D-13 多页拆分）。
- **SSR**：服务端拼 HTML 字符串返回；视觉走原型 [`prototype-req-flow.html`](../../../design/prototype-req-flow.html) 的纸张朱批风（朱砂色焦点卡 / 流程 rail / 活动流时间线 / 工人面板进度条）。
- **kernel 中性约束**：`src/workbench/` 落 kernel 层（非 workitems/worktypes），受 [res-redlines](../codebase-findings.md#res-redlines) 禁词检测（`workitem|workitems|assignment|worktype|phase` /i）。本域 HTTP 框架层符号必须中性；**对 workitem/assignment 的解释下沉到 workitems adapter**（见 §4），HTTP 路由层只搬运 id 字符串 + 调 workitems api，不在 kernel 文件里出现业务词字面量。路由路径 `/workitem/<id>` 是 URL 字面量（字符串常量），需确认是否触发禁词——若触发则用中性路由名（如 `/item/<id>`）或把路由表移出 kernel 守门文件。

### 2. 读视图（R17.AC-2/AC-3/AC-7）

- **数据源映射**（全部只读复用，见上表）：
  - 活动流 ← `listEvents(id)`（[res-workitemsapi](../codebase-findings.md#res-workitemsapi)）渲染成时间线。
  - 各端工人面板 ← 查 `workitem_assignments`（role/status/repo），进度条 + 当前动作（当前动作可读流式卡的最新 onText 快照或 events 末条）。
  - "该你了"焦点卡 ← open human `workitem_waits`（[res-projection](../codebase-findings.md#res-projection) computeRollup 已把 open human wait 投成 `waiting/human`，即便有 worker 在跑也盖住 active）；焦点卡渲染"该你拍一下 + 选项"。
  - 决策台账 / 大纲 / 详览 / 合同 ← ArtifactStore `readFile`（[res-artifactstore](../codebase-findings.md#res-artifactstore)），读 `decisions.md` / `brief.md` / `journal.md` / `contract/` / `design/` 下的 `.md`。
- **MD 就地渲染**（R17.AC-3）：marked.js 前端渲染或后端 markdown→HTML，**不本地打开**。原型已引 `marked.min.js` CDN，沿用。
- **空态渲染不抛**（R17.AC-7，回补·Gate3-C04）：任一区块为空（刚创建、artifact 仓只有 brief.md、无 events、无 assignment、`contract/` 目录不存在）→ **显占位文案、不抛、不返 500**。具体：
  - `readFile` 返 `undefined`（文件不存在）→ 渲染"暂无"占位，不报错（ArtifactStore.readFile 本就返 `string|undefined`，[res-artifactstore](../codebase-findings.md#res-artifactstore)）。
  - listEvents 空数组 / 无 assignment / 无 open wait → 各区块独立空态，互不连坐。
  - 与 contract-engine 域"读合同返空不抛"（R09.AC-7）协同：`contract/` 不存在时合同区块空态。

### 3. 事件回流写 API（R18 全部）

- **单写入口经 inject 门面**（R18.AC-1/AC-2）：页面按钮（通过/打回/裁决/@包工头）POST 到 workbench 的写端点 → workbench 调 workitems `WorkitemsApi`：
  - 通过/打回/裁决（灯拍板）→ `resolveWait(waitId, {operator, reason, decision:{approved, payload?}})`（扩展后签名，internal-apis **§2.6**）。
  - @包工头介入（不打断在跑工人）→ `injectHumanMessage(workitemId, {text})`（[res-workitemsapi](../codebase-findings.md#res-workitemsapi)）。
  - **不新建写路径**：所有写都汇到既有 inject 门面 → reducer.enqueue，保"单写入口、页面只读投影"（agent 只按既有机制改状态/写文件、不碰页面，R18 Never）。
- **打回带理由进台账**（R18.AC-3）：打回时 `reason` 字段带理由，`decision:{approved:false, payload:{reason}}`；reducer apply 后该理由随 `wait_resolved`/`checkpoint_decision` 事件落库，决策台账（读 events/decisions.md）可展开看。包工头据此回去改这一处、不重走整套（由 requirement-statemachine 的回退逻辑承接，本域只负责把理由传进去）。
- **本地服务鉴权**（R18.AC-4，Never 非本人不可操作）：写端点做本人校验（参考 ai-sentinel owner 校验范式）——仅本人可操作，非本人拒绝。`resolveWait` 的 `operator` 字段填鉴权确认的本人标识。读视图可不鉴权或弱鉴权（只读投影无害），写端点必须鉴权。
- **与飞书等价**（R18 Should）：页面通过/打回/裁决 与飞书灯卡回调最终汇到同一个 `resolveWait` 扩展签名，两端等价。

### 4. card.action 消费侧 adapter（R06.AC-3/AC-5）

- **R06.AC-5 卡片 value schema + button 构造**：requirement 灯卡用 `tag:'button'` 元素，button.value 携带 `CardActionValue{workitemId, checkpoint, decision}`（见数据契约）。构造在 feishu/card 层（卡片构造器），但 **value 内容只是不透明 object**——feishu 层只塞不解释（守红线，R19 Never "飞书卡 value 不在 kernel 层被解释"）。
- **R06.AC-3 adapter 解释 + 走门面**：kernel-capabilities 域的 card.action 分发（internal-apis **§5.5**）把 raw `action.value` 当不透明 payload 透传上来；**本域在 workitems 层新建 card.action adapter** 接它，解释 `workitemId/checkpoint/decision`，按 checkpoint 找到对应 open wait 的 waitId，调 `resolveWait(waitId, {operator, reason, decision})`（internal-apis **§2.6**）。
  - 解释逻辑只在 workitems 层（不在 feishu/event-router/card kernel 文件，CI 禁词拦）。
  - adapter 把 checkpoint（如 `requirement:合同`）映射到当前 open 的 checkpoint human wait —— 这是 workitems 层逻辑（与 checkpoint-gate 域协同：checkpoint-gate 负责拦截产 wait，本域负责把卡片拍板翻成 resolveWait 解 wait）。
- **文本兜底**（R06.AC-6 在 kernel 域，本域协同）：按钮缺失时 thread 文本 + injectHumanMessage 路径仍可用（[res-claimthread](../codebase-findings.md#res-claimthread) 入站追问路由 index.ts:643-677 已通用、零改动复用）。

### 5. 飞书灯卡 + 一需求一话题（R19 全部）

- **一需求一话题**（R19.AC-1）：仿 runProbe 写 runRequirement 闭包时，复用 `claimThread(claimKey, 'managed', item.id, anchorMsgId)`（[res-claimthread](../codebase-findings.md#res-claimthread)）——一需求一话题，managed 影子，入站追问路由零改动复用。发锚点占位卡 → createWorkItem → claimThread → 补全卡（runProbe 范式，[res-createworkitemsruntime](../codebase-findings.md#res-createworkitemsruntime)）。
- **requirement 专用卡片构造器**（R19.AC-3/AC-4）：
  - 现 `buildAnchorCard`/`buildReportCard` 等标题硬编码"调查 · / 调查报告 · / 调查失败 ·"（[res-cards](../codebase-findings.md#res-cards) card.ts:78-81）。**标题前缀参数化或新建 requirement 专用构造器**（R19.AC-4，否则显示"调查"误导）。
  - 新建"4 灯 rail / 各端工人 1/4 / 决策台账"卡片（R19.AC-3）：4 灯 rail 用 `stage/status` 中性字段表达 4 个决策灯进度；各端工人区列 N 个 worker；决策台账列已做决策。
  - **守 kernel 中性命名**（R19.AC-3 + Never）：card.ts 落 kernel，禁 `phase` 等业务词；用 `stage/status` 表达进度，判定下沉 `anchorAction`/`isTerminalStatus` 纯函数（避 `status===`，[res-redlines](../codebase-findings.md#res-redlines)）。
- **灯交互卡 value**（R19.AC-2）：灯需要拍板时发交互卡（按钮回调 R06），value 带 `{workitemId, checkpoint, decision}`（消费见 §4）。
- **每 worker 一张流式卡**（R19 UI 交互）：复用 M2 `ProgressCards`/`RunProgressSink`（[res-progresscards](../codebase-findings.md#res-progresscards)）——sink 按 assignmentId 天然分流，N worker = N 卡，**接口无需改**。requirement 下 `onRunStart` 的 `title` 带 role/repo 区分（如"后端 worker · repo-x"）。流式卡内部节流/生命周期不调（直接复用）。
- **anchorAction 新事件映射**（R19.AC-5，Gate3-C10）：`anchorAction(kind, isTerminal)` 是纯映射函数（[res-cards](../codebase-findings.md#res-cards) card.ts:179）。R24 声明的每个新事件 kind（`checkpoint_reached`/`checkpoint_decision`/`contract_frozen`/`contract_patched`/`contract_change_*`/`worker_report`/`integration_check_passed`/`integration_check_failed`/`design_ready`，internal-apis **§7**）都要在 `anchorAction` 加**显式映射决定**（刷新/不刷新），否则锚点静默。**R24 清单为唯一权威**，加 CI 测试断言两份清单不漂移。
- **threadRoot 回落**（R19.AC-6）：拿不到 threadRoot → 回落 chatId（同 postReport 范式）；updateCard 无回落则 log。复用 `getThreadRootByOwner`/`getThreadAnchorByOwner`（[res-claimthread](../codebase-findings.md#res-claimthread)）出站刷锚点；飞书 IO fire-and-forget + try/catch，失败不拖垮 run（[res-progresscards](../codebase-findings.md#res-progresscards) 范式）。

### 6. 轮询刷新（R17.AC-5）

- 第一版前端轮询"版本号"（如 workitem 最新 event seq 或 updated_at）变了整页/局部刷，**零框架**。版本号来源 = 读视图查最新 event seq；前端定时 fetch 比对。后续可升 SSE（Should，不在本次硬范围）。

### 7. 内网穿透（R17.AC-6）

- 公司外访问 → 走内网穿透（如 cloudflare tunnel）。这是**部署/运维侧外部契约**（design-detail §8 外部前提），不满足则仅内网可用，**非设计缺口**。本域不实现穿透，只保证 HTTP 服务监听可被穿透代理转发（绑定地址/端口可配）。

---

## 与其他领域的交互（调用方向）

- **workbench → checkpoint-gate**：页面/灯卡拍板调扩展后的 `resolveWait` 带 decision（internal-apis §2.6）；checkpoint-gate 域负责 inject 门面内的 stale 校验（R03.AC-7 stale → 拒绝 resolve 重弹卡）。本域只发起调用、不做 stale 判定。
- **workbench → requirement-statemachine**：页面/灯卡的写最终触发 reducer → worktype onEvent；打回理由由 statemachine 的回退逻辑承接（回设计/回集成验证）。本域只把理由经 inject 门面传进去。
- **kernel-capabilities → workbench**：kernel-capabilities 域 §5.5 card.action 分发把 raw action.value 透传给本域消费侧 adapter（R06 分发→消费交接）。
- **workbench ← contract-engine**：读视图渲染合同区块时读 ArtifactStore `contract/` 的 md；空态与 contract-engine 的"读合同返空不抛"（R09.AC-7）协同。
- **workbench ← requirement-statemachine（驱动）**：worktype 推进产新事件 kind → 经出站锚点刷新（anchorAction 决定刷不刷）。index.md 依赖图标 `RS -.驱动.-> WB`。
- **workbench 复用 M2（流式卡）**：`ProgressCards`/`RunProgressSink`/`StreamingCard` 既有，零改动复用。

---

## 相关决策

- **D-12** 卡片回调走 ws、不起 HTTP；kernel 不解释 value —— 本域消费侧 adapter 在 workitems 层解释（分发侧在 kernel-capabilities）。
- **D-13** HTML 工作台 = 轻量 HTTP（Node 自带 http、不引框架）+ 多页拆分（看板/工作台/审设计）+ 多 agent UX 走查 —— 本域 §1/§2 落地；交互细化 + 多 agent 走查在后续阶段（task #8）。
- **D-03** checkpoint 单轨 = 扩展 resolveWait 携带 decision —— 本域写路径汇到这个扩展签名（不新增并行 inject 方法）。
- **D-17** 命名安全：kernel 侧（feishu 卡片回调、index 接线）只搬运不解释，判定下沉 `isTerminalStatus`/`anchorAction` 纯函数 —— 本域 card.ts/HTTP 路由层守此红线。

---

## 引用的内部 API

> 给 internal-apis.md §x.y 锚点，不就地写签名。

- **§2.6** resolveWait 扩展决策语义（页面按钮 / 灯卡拍板都汇到此）。
- **§5.5** card.action 分发（kernel 分发侧；本域消费它透传的 raw action.value）。
- **§7** 事件 kind 权威清单（本域负责给每个 kind 在 `anchorAction` 加显式刷新决定，CI 断言不漂移）。

**复用资源锚点**：
- [res-workitemsapi](../codebase-findings.md#res-workitemsapi) — inject 门面（resolveWait/injectHumanMessage/listEvents），写入口 + 活动流读。
- [res-claimthread](../codebase-findings.md#res-claimthread) — claimThread 话题认领 + 入站追问路由 + getThreadAnchorByOwner 出站刷锚点。
- [res-cards](../codebase-findings.md#res-cards) — buildAnchorCard 等卡片构造器 + anchorAction 纯映射函数（去"调查"化 + 新事件映射）。
- [res-progresscards](../codebase-findings.md#res-progresscards) — ProgressCards/RunProgressSink 每 worker 一张流式卡（按 assignmentId 分流，零改动复用）。
- [res-eventrouter](../codebase-findings.md#res-eventrouter) — event-router（card.action 分发在 kernel 域，本域消费）。
- [res-artifactstore](../codebase-findings.md#res-artifactstore) — readFile 读 md 文档（合同/台账/详览），空态返 undefined 不抛。
- [res-projection](../codebase-findings.md#res-projection) — computeRollup（open human wait 投成 waiting/human，焦点卡据此）。
- [res-five-tables](../codebase-findings.md#res-five-tables) — workitem_assignments（工人面板）/ workitem_events（活动流）/ workitem_waits（焦点卡）。
- [res-createworkitemsruntime](../codebase-findings.md#res-createworkitemsruntime) — runProbe 范式（runRequirement 闭包发锚点占位卡 → createWorkItem → claimThread → 补全卡）。
- [res-redlines](../codebase-findings.md#res-redlines) — kernel 禁词 / index-wiring 守门（card.ts + workbench HTTP 层守中性命名）。

---

## 边界约束（Must / Never）

### Must
- 读视图复用现成 SQLite + artifact，**不另起炉灶**；MD 就地渲染；轻量 HTTP（Node 自带 http、不引框架）。
- 写经 inject 门面（**不新建写路径**）；**单写入口、页面只读投影**；写端点**本地服务鉴权**（仅本人可操作）。
- 一需求一话题复用 `claimThread`；灯卡守 kernel 中性命名（stage/status，不出现 phase 等业务词）；新事件 kind 同步扩 `anchorAction`（R24 清单为唯一权威，CI 断言不漂移）。
- 卡片 value schema 携带 `{workitemId, checkpoint, decision}`，解释**只在 workitems adapter**（feishu/kernel 层只透传不解释）。
- 任一区块为空时**空态渲染、不抛、不返 500**（R17.AC-7）。
- 打回带理由进决策台账；操作与飞书灯卡等价。

### Never
- 不引前端框架；不起独立进程；不做 DSL 工作流引擎。
- agent 不碰页面（页面只读投影）；页面不直接改 DB；非本人不可操作。
- card.action value 不在 kernel/feishu 层被解释（业务词 `workitemId/checkpoint` 不进 feishu 层，CI 禁词拦）；卡片 value 不在 kernel 层被消费。
- HTTP 路由/card 构造的 kernel 文件不出现 `workitem|workitems|assignment|worktype|phase`（/i）；判定下沉纯函数。
- 不调 M2 流式卡的节流参数/生命周期（直接复用）；不在工作台里替代 phase 状态机做业务判断。

---

## 可能的实现提示

- **HTTP 模块落点**：`src/workbench/`（kernel 层）。HTTP server 起停挂在常驻进程装配处（仿 BackupJob 注入 `index.ts:162` 范式）。若 `src/workbench/` 因模板/路由字面量触发禁词，优先把业务词解释移到 workitems adapter、HTTP 层只传 id 字符串；URL 路由若用 `/workitem/<id>` 触禁词，改中性路由名（如 `/item/<id>`）。
- **card.action adapter 落点**：workitems 层（如 `src/workitems/` 下新文件或接到现有 adapter），解释 value 后调 `workitems.api.resolveWait`。kernel-capabilities 域的 §5.5 分发只把 raw action 喂给它。
- **anchorAction 漂移测试**：加测试断言 internal-apis §7 的 kind 清单 ⊆ anchorAction 的 case 集（每个 kind 有显式映射），防漏挂。清单以 R24（data-model 域）为准。
- **鉴权范式**：参考 ai-sentinel owner 校验；本人标识可来自部署侧配置（单用户场景），写端点校验、读端点放宽。
- **多页共享样式**：原型 `prototype-req-flow.html` 是单文件 mock（含 4 灯 rail / 焦点卡 / 工人面板 / 活动流 / 决策台账完整视觉），拆多页时抽公共 CSS/JS。
- **runRequirement 闭包**：仿 runProbe（[res-createworkitemsruntime](../codebase-findings.md#res-createworkitemsruntime) index.ts:498），发锚点占位卡 → createWorkItem → claimThread → 用 requirement 专用构造器补全卡（4 灯 rail）。
