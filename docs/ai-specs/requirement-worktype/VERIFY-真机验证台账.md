# VERIFY-真机验证台账

> /req 真机验证陪跑排查台账。陪跑员记账，验证节奏由验证者控制。
> 分级：阻塞（流程走不下去/服务崩/卡死）> 功能（结果不对但流程能走）> 体验（文案/别扭/慢/卡片难看）。
> 状态：受理中 / 排查中 / 已定位 / 已知预期内 / 待修 / 已修 / 搁置。

## 已知问题清单（命中直接标「已知/预期内」，不复查）

- **R5**：多轮返工后交付分支缺失前轮改动（worktree 每轮从 HEAD 新开）——**已修（VERIFY V1，d3c83af）**：血统续接（prepareWorkspace 以上一轮 worker 分支为 base）+ #5 兜底提交同根共治。
- **lite 单仓灯③不受委托自动过**：no_contract 被 guard 拦，设计如此。
- **勘探歧义卡选项带证据后缀，下轮抽取需剥离路径**：已判定可回避，验证观察项。
- **三大真机未知数**（各有回落方案）：
  1. 飞书 form 双 submit 按钮 value 是否各自到达（不行→ WS-5.1 回落）；
  2. `im.message.list` 返回字段形状（尤其 create_time 单位 ms/s、p2p chat_type）；
  3. headless CLI 的 AskUserQuestion 行为（是否自动关 tool 跑完本轮）。

## 问题台账

| #编号 | 时间 | 现象（原话） | 分级 | 状态 | 排查结论 | 修法建议 |
|---|---|---|---|---|---|---|
| #1 | 18:00 | 初报「好像卡死了？」→ 用户复判：「看起来确实不是卡死了 只不过飞书上的卡片上的时间和内容都不再更新了 这个体验有点不太好」（pax退款退回原卡 worker 流式卡停在「处理中… 33 tools」，停在 "Let me read the onRefundSuccess ... precisely (around :147)"） | 非阻塞·体验（初判阻塞，用户复判降级） | **已修（VERIFY V3，c968d83）** | **非卡死**：worker（as-e21914d2，claude PID 8442）进程仍活、仍持连接。根因=worker 卡在等模型 API 的**流式 SSE 响应**：经本地代理 verge-mihomo(127.0.0.1:7897) 连接仍 ESTABLISHED 但流中途不再来数据（CPU 10s 仅涨 0.05s，阻塞在 read）→**没有新 stream 事件推给卡片→卡片时间与内容双双定格**。`runner.ts` 只有 ready 30s 超时，对「跑动中的流」**无空闲超时**；watchdog wallclock cap=1800s 会在 18:42:56 兜底 reap+redispatch。体验落差：卡片停更时用户无从判断「还在跑/流断了/真死了」，且即便底层最终推进这张卡也不再刷新。**二次咬人**（07-07 09:1x）：as-a3e88851 卡片停在「1:40·5 tools」，用户判「又卡住了」，实测 worker 09:20 已重建完成全部文件、CPU 持续累加——**卡片停更让用户连续两次误判卡死**，是本次验证体验最突出问题（用户原话「卡片交互确实有待优化」）。 | 体验修（验证后批量）：①流式卡加「最后活动时刻/心跳」或 stale 标记（N 秒无更新显示「⏳ 等待模型响应…」而非静默定格）；②根治仍是 runner 流空闲超时——流断即 abort→run_failed→WS-8 重试，卡片同步转「重试中」。 |
| #2 | 18:00 | 陪跑员自查：requirement worker 子进程加载了**全套用户 MCP**（firecrawl-mcp / lark-mcp / n8n-mcp / mobile-mcp） | 体验/隐患 | **已修（VERIFY V4，本刀）** | worker run 继承了用户默认 MCP 工具集，与「照合同写码」职责无关，增噪+扩大攻击面，也拖慢冷启。**佐证**：同单 owner run（as-186d8980）日志 `mcpServers:[]` 是空的——**owner 收窄了 MCP，worker 没收窄**，是明确的不一致。与 #1 无因果。 | 给 managed **worker** run 也传 `mcpServers:[]`（对齐 owner），或 `--strict-mcp-config`。验证后修。 |
| #3 | 07-07 09:xx | 排查 #1 昨晚续跑衍生：「点继续时突然出现两个并行飞书卡片」（Image#3 owner「调查报告」+ Image#4 worker 流式卡） | 功能·体验 | **已修（VERIFY V2，5c1f03f）** | run_failed 病历卡（wt-9947003）在 23:44:03 被你带内容点继续 → **单条 human_message 同时派了两个 run**：`as-e3771c9e`(owner steer，23:44:03 spawn) + `as-8d4408de`(worker rerun，23:44:05 spawn)。owner steer 23:45:21 才出 steer_directive，此时 worker 已在跑=**冗余竞态**。两个都以「调查报告」标题出现→用户困惑。根因：resolve run_failed 病历既走「重派失败相位 worker(rerun)」又把消息当 steer directive 起 owner run，二者对同一意图并发。 | 病历卡带内容 resolve 时二选一：要么只重派 worker（内容作为 rerun 附加指令），要么先起 owner steer 判、由它决定是否重派——避免同时双起。验证后修。 |
| #4 | 07-07 09:xx | 「凌晨12:04突然发来三个一样的灯③卡 + 一个交付清单卡」（Image#5 ×3 + Image#6） | 功能 | **已修（VERIFY V2，5c1f03f）** | DB 里灯③只有**一条 wait**（wt-88ca19a，checkpoint:requirement:交付，00:04:34），却发了 **3 张相同灯③卡** → **卡片重复发送 bug**。`card_msg_id` 只持久化了最后一张（om_x100b6b896ffa40），前两张成**孤卡**（点它们仍按同 workitemId+wait 路由到 resolveWait，但语义混乱）。触发点：00:04:34 worker done 后 reducer 级联 gatekeeper_passed→integration_check_passed→manifest_ready 一次性落，疑似灯③发卡动作在级联中被触发多次（INFO 日志无发卡记录，需 debug 级/读 reducer 定位「为何恰好 3 次」）。 | ①发灯③卡前查 wait 是否已有 card_msg_id，有则 patch 不再新发（幂等发卡）。②定位级联中重复 emit 发卡 action 的点。验证后修，需补 debug 日志或读 event-reducer。 |
| R5 | 07-07 09:14~09:20 | 真机实锤（runbook 第4项专盯）：多轮返工丢前轮改动 | 已知·**已实锤** | **已修（VERIFY V1，d3c83af）** | 新 worker `as-a3e88851`（09:14:43 起，由 09:13 steer 触发）开局拿到**空 worktree**——昨晚 `as-8d4408de` 的未提交改动**未带过来**（worktree 每轮从 HEAD 新开，R5 确认）。本轮**幸存**仅因用户此前用 codex 把实现提交到了 `codex/pax-refund-original-card-implementation`（07-03 老分支，4 commit/909 行），worker 挖到它当底本 09:20 前重建完成。若无该 codex 分支，这轮产出即丢。**与 #5 叠加**：#5（改动未提交）+ R5（新轮不继承）= 未提交产出在换轮时双重暴露。 | 见 R5 立案修法（worker 每轮基于上一轮分支而非 HEAD 新开）；叠加 #5 的「完成即在分支 commit」可一并根治。 |
| #5 | 07-07 09:xx | 「交付清单显示（无改动），我去仓库里没找到任何改动代码，非常诡异」（Image#6） | 功能·**高**（差点丢真实产出） | **已修（VERIFY V1，d3c83af）** | **假象，worker 其实做了实活。** as-8d4408de 报告明写「按你的规则改完不自动 commit/push、等确认分支，**本次未提交**」→ 改动全在 worktree **未提交**（`git status`：4 改 types.ts/OrderRefundModal/2个Listener + 新增 __tests__/2套件 + refund-original-card/ 模块 + design-gaps.md）。但 `deliver_manifest` 只读**已提交** diff（`base..branch` 零提交）→ 报「(无改动)」。你在**主仓**找不到，因为：改动在 `~/.agent-pipe/worktrees/.../as-8d4408de/` 未提交，且分支 `req/...-8d4408de` 已被 linked worktree 占用→**manifest 给的接手命令 `git switch req/...` 在主仓会直接失败**（branch already checked out）。**风险**：终态 7 天后 worktree-GC 会连未提交改动一起删→真实产出丢失。 | ①**契约冲突是根**：worker 被要求「不自动 commit 等确认」与 manifest「读已提交 diff」互斥。二选一：worker 完成即在自己分支 commit（未推送，交付/关单前不 push），manifest 就能读到；或 manifest 改读「worktree 未提交 diff」。②接手命令对 linked worktree 分支应给 worktree 路径而非主仓 `git switch`。③GC 前对未提交 worktree 兜底（提交到分支或警示）。验证后修，**优先级最高**。 |
