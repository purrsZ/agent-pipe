# 交接：M-I2 / M-I3 立项 live 接线

> 给下一个接手的 AI。本文档由一个**全新、未退化**的会话核实当前代码树后写成（不是凭记忆）。
> 凡标「✅ 实测」的，都是我刚跑过命令确认的；凡是判断/建议，会标「建议」。
> **全程简体中文。代码/命令/路径/变量名保持原文。**

---

## 0. 一句话现状

引擎（M-I1 立项骨架 + 沙箱内核）**已提交、已验证、全绿、没坏**。
剩下的是**纯飞书 live 串接**（建群 + 群内引导式收料），它有硬前置（`im:chat` scope + 真机），
所以一直没写完——`index.ts` 的 `runRequirement` 还是旧实现，新的接线只导入了依赖、加了两个 helper，**主流程没改**。

**重要纠正**（上一个会话因格式退化做了几条错误判断，别被误导）：

- ✅ 实测 `npx tsc --noEmit` → **exit 0，编译通过**。不存在「编译坏在半截」。
- ✅ 实测改动涉及的 3 个测试文件 **42 passed**（`commands-req` 4 + `card` 33 + `card-action` 5）。
- ✅ 已提交的 8 个提交全在，**没有任何代码丢失**。

---

## 1. 背景（这块在干嘛）

- 项目：`agent-pipe`，Feishu × Claude CLI 的桥，正向「个人助理」重定位。
- 当前里程碑：**requirement worktype 的「立项」前门**。真机首跑暴露：引擎（7 phase + 4 灯 + 真考古）是好的，
  但**前门太薄**——一行 `/req` 就硬考古，没有 PRD/UI/验收，AI 只能反过来「请把描述发我」，体感像随口追问。
- 立项要把前门重做成：**`/req` → 问群名 → 建专属飞书群 → 群内引导者逐项收齐前置料 → 立项 gate 放行 → 落结构化立项书 → 进「理解」phase**。
- 设计契约全文见同目录 **`design/domains/intake-phase.md`**（本次新增，**必读**，立项清单 v1 / 路由改造 / 新能力都在里面）。

---

## 2. 代码树真实状态（核实过）

### 2.1 已提交的绿色基线（安全，别动）

```
c7225a6 feat(feishu,bridge): 建群能力 + /req 等群名待答态 + 引导式收料填槽（M-I2/3 沙箱内核）  ← 当前 HEAD
ef90185 feat(requirement): 立项收尾 effect——gate 通过自动落立项书 + 提升 repos（M-I3 头号坑）
2923fa8 / a1298b1 / e4ec286  立项 gate 边界 & 幂等 & 驳回（adversarial review 修复）
636b121 / 93bd67a  M-I1 立项清单卡 + 立项骨架（事件溯源清单 + 前插立项 phase + 立项书喂 spec-design）
```

**沙箱内核已就绪、可直接被 live 接线调用的零件**（✅ 已核实存在）：

| 零件 | 位置 | 作用 |
|---|---|---|
| `Sender.createGroup(name, members)` | `src/feishu/sender.ts:329` | 建专属群（**依赖 `im:chat` scope**，失败会 log 提示） |
| `PendingIntakeStore` | `src/bridge/pending-intake.ts` | `/req` 后「等群名」内存待答态，带 TTL；方法：`set/has/take/clear`（时间由调用方注入，不碰 `Date.now`） |
| `createIntakeFinalizeHandler()` | `src/worktypes/requirement/intake-finalize.ts:11` | 立项 gate 通过 → 落立项书 + 提升 repos 的 effect handler |
| `intake.ts` 纯核心 | `src/worktypes/requirement/intake.ts` | `foldIntake / INTAKE_CHECKLIST / initialIntakeState / isFieldSatisfied / isGateReady / nextRequiredToFill / requiredMissing / requiredProgress` |
| `buildIntakeChecklistCard` + `IntakeChecklistView` | `src/feishu/intake-card.ts` | 立项清单卡（feishu 层只认 view，不 import worktypes） |
| `isIntakePhase(phase)` | `src/worktypes/requirement/phases.ts`（未提交，见下） | 给 index/bridge 分流用，避免裸写 `phase === …` 被 wiring 红线扫到 |

### 2.2 未提交改动 = **两条独立的线混在 9 个文件里**（关键！提交前必须分开）

⚠️ 这是最容易踩的坑：`index.ts` 同时被两条线改了，**别把两条线的改动搅在一个提交里**。

**🟦 Line A —「AskUserQuestion 表单卡」（并行线，不是本次立项任务）**
> 这是另一条工作（Claude 提问 → 飞书按钮/表单卡 → 多题答案一次回灌），与立项无关。
> 本次**不要动它的逻辑**；提交时让它独立成提交，或确认由并行线负责人提交。

- `src/feishu/card.ts`（+90，新增 `buildQuestionFormCard`）
- `src/feishu/event-router.ts`（+20，`formValue` 路由）
- `src/feishu/types.ts`（+6，`formValue` 类型）
- `tests/card.test.ts`（+53）、`tests/feishu/card-action.test.ts`（+24）
- `src/index.ts` **3 处**属于这条线：
  - line 19：import `buildQuestionCard` → `buildQuestionFormCard`
  - line ~421：`buildQuestionFormCard(...)` 调用
  - line ~829–894：auq 表单提交处理（`formValue` / `q{i}_custom` / `q{i}_pick` / `brief.join` 回灌）

**🟩 Line B —「立项 live 接线」（本次任务）**

- `src/bridge/commands.ts`（`/req` 去掉 `--repo`，描述可空；`onRequirement` 签名 `{repos?, description}` → `{description}`）✅ 完成、隔离
- `src/worktypes/requirement/phases.ts`（新增 `isIntakePhase()`）✅ 完成、隔离
- `tests/bridge/commands-req.test.ts`（配套 /req 改造）✅ 完成、绿
- `src/index.ts` **2 处**属于这条线：
  - line 52–65：intake 相关 import（`PendingIntakeStore` / `buildIntakeChecklistCard` / `foldIntake` 等）——**大部分还没被用上**（=「declared but never read」警告的来源；因 `noUnusedLocals` 没开，不报错）
  - line 121–153：helper `foldIntakeState()` + `buildIntakeView()`（事件流 → 清单卡 view，kernel-exempt）

### 2.3 还**没写**的（Line B 的核心，真正的剩余工作）

- `src/index.ts` 的 `runRequirement`（约 line 713）**还是旧实现**：直接发锚点卡 + `createWorkItem(repos=...)`。
  它仍声明 `opts: {repos?, description}`，读 `opts.repos`——因 `repos` 可选，类型上兼容新签名，所以 typecheck 才过；但**立项流程一行没接**。
- `pendingIntake` 实例声明（上一个会话试了好几次都因格式错误没落进去）。

### 2.4 新增的未跟踪文件

- ✅ `docs/ai-specs/requirement-worktype/design/domains/intake-phase.md` — **立项设计契约，必读**。
- ✅ `docs/ai-specs/requirement-worktype/STAGE7-MANUAL-TEST.md` — 真机手验流程（含 DATA_DIR 落盘速查 / sqlite 观察命令）。
- `.obsidian/` — 编辑器目录，**忽略/别提交**（建议加进 `.gitignore`）。

---

## 3. 关键决策（已拍板，照做）

1. **`/req` 重塑**：去掉 `--repo`；尾随文字是「一句话需求」且**可空**（不带也放行，建群后逐项引导填）。兼容旧习惯：仍带 `--repo` 则剥离并忽略其值。
2. **立项主流程**：`/req` →（原会话）问群名 → 用户下一条普通消息当群名 → `createGroup` 建专属群 + 拉发起人 → 在群内建单(立项 phase) + 发**立项清单卡**（不是锚点卡）→ 逐项收料 → 必填齐弹**立项 gate** → 人确认 → `createIntakeFinalizeHandler` 落立项书 + 提升 repos → 进「理解」phase。
3. **路由改造**：`claimThread` 的 key 从「话题 thread」改成「**群 chatId**」；群内后续所有交互（清单/灯卡/流式 run/追问）回贴该群。
4. **群内消息分流**：用 `isIntakePhase(phase)` 判断——立项阶段的普通消息当**收料**（写 `intake_field_set` 事件 + 刷新清单卡），非立项阶段才走普通追问。
5. **kernel 中性**：`bridge/commands.ts`、`bridge/pending-intake.ts` 不 import 上层、不含业务词；`feishu` 层不 fold、不 import worktypes；只有 `index.ts`(kernel-exempt) 能 import worktypes 的 intake 纯核心把领域状态压成 feishu view。
6. **沙箱 vs live 的边界**：能在沙箱测的内核（建群能力签名 / 待答态 / 清单 fold / gate / 收尾 effect）**已全部做完并测过**；剩下的纯属飞书 live 串接，**硬前置 = `im:chat` scope + 真机**，本就该等这两样齐了再接。

---

## 4. 后续要干的事（TODO，按依赖排序）

> 这些大多**沙箱测不了**（建群/群路由/卡回调/读 PRD 都要真机 + `im:chat`）。写的是「基于 SDK 假设」的代码，**真机跑通才算数**——见 §6。

- [ ] **B1**　`index.ts` 加 `pendingIntake = new PendingIntakeStore()` 实例（放在 `runningTasks` 那批声明旁）。
- [ ] **B2**　改 `/req` 入口：`onRequirement` 回调里**不再直接建单**，而是 `pendingIntake.set(...)` + 在原会话回「请给这个需求起个群名」。
- [ ] **B3**　普通消息入口加分流：若 `pendingIntake.has(user, chat)` → 把这条消息当**群名** → `createGroup` → 建单（立项 phase）→ 发立项清单卡（用 `buildIntakeView` + `buildIntakeChecklistCard`）。
- [ ] **B4**　群内消息：`isIntakePhase` 为真 → 收料（写 `intake_field_set`，AI 读 PRD 飞书文档预填候选字段）→ 重刷清单卡；必填齐 → 弹立项 gate。
- [ ] **B5**　出站卡分流 + `surfaceCheckpoints` 接立项 gate；注册 `createIntakeFinalizeHandler()` 到 effect handlers。
- [ ] **B6**　重写/删除旧 `runRequirement` 里 `opts.repos` 那段（repos 改由立项收尾提升，不再从 `/req` 来）。
- [ ] **B7**　`index-wiring` 测试是 **source-string 断言**（很脆），每改一处 import/注册都要同步它。
- [ ] **B8**　全套验证 → 提交（**Line A / Line B 分开**）→ 更新记忆 `req-worktype-impl.md`。

---

## 5. 快速验证命令（✅ 这些我都跑过）

```bash
npx tsc --noEmit                      # 编译；现状 exit 0
npx vitest run                        # 全量测试
npx vitest run tests/bridge/commands-req.test.ts tests/card.test.ts tests/feishu/card-action.test.ts   # 改动相关，现状 42 passed
git status --short                    # 看两条线混在哪些文件
git diff src/index.ts                 # 区分 Line A / Line B（对照 §2.2）

# 真机观察（DATA_DIR 默认 ~/.agent-pipe）
sqlite3 ~/.agent-pipe/workitems.sqlite "select id,type,phase,status from workitems order by created_at desc limit 5;"
git -C ~/.agent-pipe/workitems/<id> log --oneline
```

---

## 6. 坑与风险（顶住，别重蹈覆辙）

1. **提交隔离**：`index.ts` 两条线混着，提交 Line B 时**不能带上 Line A 的 3 处**（line 19 / ~421 / ~829–894），反之亦然。建议 `git add -p` 逐块挑，或先和并行线负责人确认 Line A 谁提交。
2. **不可验证性**：建群 / 群消息路由 / 卡回调 / 读 PRD，**沙箱全测不了**，必须真机 + `im:chat` scope。没这两样别声称「接好了」。
3. **wiring 测试脆**：`index-wiring` 是源码字符串断言，改 import/注册必同步。
4. **`runRequirement` 旧体的迷惑性**：它现在 typecheck 能过 ≠ 立项接好了。别看到「绿」就以为完成——它还是旧的直接建单逻辑。
5. **给 AI 自己的提醒（很重要）**：上一个会话「一直卡住/自动中断」的真因是**它把工具调用写坏了**——写成裸 `<invoke>` / `<parameter>`（少了 `antml:` 前缀），开头还多打了 `court` 这种 token，解析器整条丢弃，看着像被打断。**正确格式必须是 `antml:invoke` / `antml:parameter`，开头不加任何多余字符。** 若你发现自己连续几次「调用没生效」，先停下检查输出格式，或直接开新会话——这通常是上下文过长后的格式退化，靠「下次注意」修不好。
