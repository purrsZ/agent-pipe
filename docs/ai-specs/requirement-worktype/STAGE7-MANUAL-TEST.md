# Stage 7 — requirement worktype 真机手验流程

> 沙箱测不了的 live 环节集中在这里。**按风险与依赖排序**：先证明桥本身活着（冒烟），
> 再盯刚做的 A2（合同 phase spec-design run），然后单端跑通全生命周期，最后才上「写档
> fail-closed 探针」和「双端核心命题」这两块最凶险/最关键的。每节给：**命令 → 看哪里 →
> 通过判据 → 典型失败落在哪一环**。勾选框照做即可。
>
> 落盘速查（`DATA_DIR` 默认 `~/.agent-pipe`）：
> | 东西 | 路径 |
> |---|---|
> | workitems DB | `~/.agent-pipe/workitems.sqlite` |
> | 某需求的产物仓（每单一个 git repo） | `~/.agent-pipe/workitems/<workitemId>/` |
> | ├ spec-design 升格合同 | `…/<id>/contract/contract.json` |
> | ├ 各 run 的 prompt / 报告 | `…/<id>/assignments/<assignmentId>/brief.md` · `report.md` |
> | ├ 详设切片 | `…/<id>/design/` |
> | └ 集成对账报告 | `…/<id>/contract/integration-report.md` |
> | worker worktree | `~/.agent-pipe/worktrees/<workitemId>/<repo>/<assignmentId>/` |
> | 仓知识 | `~/.agent-pipe/knowledge/` |
> | 工作台 | http://127.0.0.1:7080 |
>
> 三个万能观察手段：
> - 日志：跑 `npm run dev` 的终端（`LOG_LEVEL=debug` 看细节）。
> - DB：`sqlite3 ~/.agent-pipe/workitems.sqlite "select id,type,phase,status from workitems order by created_at desc limit 5;"`
> - 产物仓是 git：`git -C ~/.agent-pipe/workitems/<id> log --oneline`（每次 writeArtifact 一条提交，能看到合同/报告何时落地）。

---

## 0. 前置准备

- [ ] `.env`（照 `.env.example`）至少配齐：
  - `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
  - `ALLOWED_OPEN_IDS`=你自己的 open_id
  - `ALLOWED_CWD_PREFIXES`=**测试 repo 的父目录**（`/req` 不带 `--repo` 时默认取第一个；带 `--repo` 的路径也要在白名单前缀下）
  - `CLAUDE_PATH` / `CLAUDE_MODEL`（确认 `claude` CLI 能跑）
  - `WORKBENCH_TOKEN`=随便设一个非空串（第 6 节浏览器写回要用）
- [ ] 测试 repo 准备：
  - 单端冒烟：1 个 git repo，**有至少一个 commit**（worker worktree 从 `HEAD` 切分支，空仓会失败）。
  - 双端命题：2 个独立 git repo（如 `backend` / `frontend`），各有 commit。
- [ ] 启动 `npm run dev`，确认日志里 WS 长连接建立、bot 上线；飞书里能 @ 到它。

---

## 1. 冒烟基线（先证明 feishu 收发 + run + 卡片都活）

- [ ] 私聊或群里发 `/probe 这个项目有几个 runner`（或 `/probe --repo <repoA> …`）。
- **看**：先出占位锚点卡 → 流式卡边跑边刷 → 收尾成报告卡。
- **判据**：报告卡正常出现、内容是只读调查结论。
- **失败落点**：完全没反应 → feishu 凭证/`ALLOWED_OPEN_IDS`/WS 连接；有卡但 run 报错 → `CLAUDE_PATH`/模型/网络。**这一关不过，后面都别测。**

---

## 2. ⭐ A2 焦点：合同 phase 的 spec-design run（本次新做的）

> 这是 A2 唯一的 live 风险点：真 agent 是否真按「报告末尾输出一个 ```json 合同块」的约定产出，
> `parseInternalApis` 能不能吃下并升格成 `contract.json`。**先单端、小需求，盯死这一步。**

- [ ] 发 `/req --repo <repoA> 加一个查询订单状态的接口`（单端先）。
- [ ] 锚点卡出现 → 理解 phase owner run（流式卡）跑完 → 弹 **灯①卡**（理解→合同）。
- [ ] 灯①点「通过」。→ 进合同 phase，起 **spec-design run**（又一张流式卡）。
- **核对 prompt**：`cat ~/.agent-pipe/workitems/<id>/assignments/<owner-aid>/brief.md` —— 应是 spec-design 指令（含「spec-design 方法论」「在报告最末尾输出且仅输出一个 ```json 代码块」「providerRepo」等），**不是**「只读代码调查助手」那套。
- **核对升格产物**（A2 关键判据）：run 收尾后
  - [ ] `cat ~/.agent-pipe/workitems/<id>/contract/contract.json` —— `interfaces` 非空、每条有 `id/signature/providerRepo`，`fingerprint` 有值。
  - [ ] 若 `interfaces: []` 空 → **A2 的头号 live 断点**：打开 `assignments/<owner-aid>/report.md` 看 agent 实际末尾产出。多半是没按 ```json 块格式（或块里字段名不符）。处置：要么调 `composeSpecDesignPrompt` 的措辞让格式更硬，要么放宽 `parseInternalApis`。空合同会被灯②人审兜底，不会崩流程。
- [ ] 紧接着应弹 **灯②快卡**（合同→详设）。
  - 注意机制：我们**不发 `design_ready`**，靠 `run_completed`(owner) 推进——所以 spec-design run 一完成就该见灯②快，别去日志里等 `design_ready` 事件。
- **失败落点**：合同块格式不符→空合同（见上）；agent 越权写了文件→说明 readonly 档没拦住（owner 设计 run 应是 readonly，写不该发生）。

---

## 3. 单端全生命周期（4 灯 + worker 写码）

接第 2 节继续把这一单走到底：

- [ ] 灯②快「通过」→ 详设 phase owner run → 弹 **灯②慢卡**（详设→拆解）。
- [ ] 灯②慢「通过」→ 拆解 → **并行实现**：起 1 个 worker（write 档 + 独立 worktree）。
- **验 worker worktree**：
  - [ ] `ls ~/.agent-pipe/worktrees/<id>/<repo>/<aid>/` —— 真 checkout 了；`git -C 该路径 branch` 有 `req/<…>` 分支。
  - [ ] worker 报告（`assignments/<worker-aid>/report.md`）写明：改了什么 / 依据合同哪几条 / 自测结果。
  - [ ] worktree 里真有改动（`git -C 该路径 status`）。
- [ ] worker 完成 → owner fan-in → 进集成验证 → `contract/integration-report.md` 生成 → 弹 **灯③卡**。
- [ ] 灯③「通过」→ 交付 phase（停在非终态，不自动 MR/上线）。
- [ ] 在该话题发 `/done`（或灯④）→ 单元收尾 done。
- **每个灯通用判据**：飞书点「通过/打回」后 → 锚点卡灯轨刷新 / 状态推进；「打回」应回退重走对应 phase。

---

## 4. ⚠️ write 档 fail-closed 探针（最凶险的内核件，单列）

> worker 在写档下的唯一真约束是 PreToolUse 路径守卫（`src/agents/claude/write-guard.ts`），
> `--add-dir` 只放宽不收窄。必须实证这个 hook 真生效。

- [ ] worker 跑起来时，确认 runner 物化了 `--settings`（PreToolUse hook 脚本，matcher=`Write|Edit|NotebookEdit|Bash`），且**没带** `--dangerously-skip-permissions`（看 run 的实际命令行 / 日志）。
- [ ] 诱发越界写：构造一个需求让 worker 试图写 worktree **外**的绝对路径（或临时观察日志里是否出现 deny）→ 期望 `permissionDecision: deny`，理由「outside the writable worktree」。
- [ ] DEFER-1（如实记录、不算 fail）：间接 bash 重定向 `VAR=/etc/x; echo y > $VAR` **不**被拦——这是已知残留，写档不依赖 OS 沙箱。
- **判据**：直接越界写被拒；正常 worktree 内写放行。**不过则该 worker 不应以写档启动。**

---

## 5. ⭐ 核心命题：双端照合同并行（项目存在的理由）

- [ ] 发 `/req --repo <backend> --repo <frontend> <一个真要两端配合的需求>`。
- [ ] 走到合同冻结（第 2 节那套）→ 进实现：**应同时**起 backend + frontend 两个 worker，各自 worktree、并行写码。
- [ ] owner fan-in（T4）：**两个 worker 都完成**才进集成验证（中途某端慢，不会提前推进）。
- [ ] 集成对账：两端各自的 `contract/impl-claims.json` 对照冻结合同；`integration-report.md` 给差异。
- **核心判据**：合同真把两端对齐了吗——前端按合同调的接口、后端按合同提供的接口，拼起来能对上。
- **cap 注意**：双端 `WORKITEMS_MAX_WORKERS_PER_ITEM`(默认 2) 正好覆盖；**≥3 仓**需调大该 env，否则第 3 仓被 park（日志有 `over cap → parked` warn，这是 B 项未做的补派开口）。

---

## 6. 工作台浏览器走查

- [ ] 开 http://127.0.0.1:7080 —— 看板列当前需求 / phase / 灯状态 / 详设切片就地渲染（只读开放）。
- [ ] 写操作（通过/打回/留言）：带 `Authorization: Bearer <WORKBENCH_TOKEN>`（或给浏览器设 `wb_token` cookie）。空 token = 看板只读。
- [ ] 灯②慢的逐块详设细审走一遍；确认台账「通过/打回」与飞书灯卡走**同一** resolveWait 单写路径（不会双写/冲突）。

---

## 7. 崩溃恢复（可选，跑过一轮后再测）

- [ ] run 进行中 `kill` 掉 `npm run dev` 进程 → 重启。
- **期望**：owner readonly run 直接 redispatch；worker（写档非幂等）按「有 session + worktree 干净」→ resume，否则 reset worktree + redispatch；不丢单、不重复推进。

---

## 附：测试时心里要有数的「已知缺口」

- **不发 `design_ready`**：合同/详设推进靠 `run_completed`(owner)。别在日志里等 `design_ready` 事件（它保留在清单+anchorAction 映射，是未来 bare-effect 路径的预留）。
- **`contract.json` 在灯②前就写好**：spec-design run 一收尾就直接写（非 draft）。灯②快是 gate（人审才放行进详设），不是 freeze；「draft→approval 冻结 + fingerprint 固化不可变」是 contract-engine 域后续。
- **over-cap 不补派**：≥3 仓时超出 cap 的仓被 park（warn surface），workaround 是调大 `WORKITEMS_MAX_WORKERS_PER_ITEM`。完整补派是 B 项。
- **灯卡终态 patch 依赖 `action.messageId`**：来自用户并行的 AskUserQuestion/event-router 改动（工作区未提交）。缺它则灯卡终态 patch 跳过，但 `resolveWait` 仍生效（推进不受影响）。真机测灯卡前确认那套改动在位。
