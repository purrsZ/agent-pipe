# 需求 worktype 转向:设计外置 · 实现聚焦

> 日期:2026-06-24 ｜ 状态:**第 0 步 + A 阶段已落地(实现聚焦),574 测试绿** ｜ 作者:本次对话推演

---

## ✅ 落地记要(2026-06-24,第 0 步 + A 阶段)

按第 7 节从第 0 步 + A 阶段切入,已实现并通过 `npm run check`(typecheck + lint + **574 测试**绿),并经
**5 维度对抗式审查 workflow(14 条确认缺陷)→ 批量修复**。本次落地的范围与关键决策:

**新主线(五相位「两灯一 gate」)**:`立项 →[立项 gate]→ 拆解(owner 跨仓对账) → 并行实现 → 集成验证
→[灯③]→ 交付 →[灯④ close]`。砍掉 understand/contract/design 三相位 + 灯①②(`phases.ts`/`index.ts`/
`lights.ts`/`board.ts` 全清);`composeSpecDesignPrompt` 删除(设计外置,owner 不再产设计)。

**第 0 步(owner 拼凑+对账闭环)= 新建 `reconcile.ts`**:`composeReconcilePrompt`(owner 读各仓设计的
「外部方契约」节)+ `parseReconcileResult` + `structuralDangling`(纯结构化安全网:providerRepo/consumerRepos
必须落在立项仓库清单内)+ `reconcileVerdict`(owner 自报 unresolved ∪ 结构化悬空 ∪ **多仓零接口疑则判大**)
+ `createReconcileCheckHandler`(与 integration_check 同构的 effect)。owner 对账 run 的 `afterRun` 升格写
`contract/contract.json`(灯③ 对账基准)+ `contract/reconcile.json`(对账结论)。冲突/悬空 → `reconcile_conflict`
病历 raise 人;人改完单仓设计 resolve 病历 → 重派 owner 重对账(多轮收敛)。

**灯③ 长牙(审查暴露的头号坑已补)**:对账只是「契约侧」,审查发现「实现侧」`impl-claims.json` 生产代码
**无人写** → `integration_check` 永远 no_claims 空转。已补:**owner assess run(并行实现 fan-in 后唯一一次跑)
的 `afterRun` 登记各仓实际实现接口 → `contract/impl-claims.json`**(单写口、无并发竞争);assess prompt 末尾
要求输出实现接口块。至此 `contractStructuralDiff(契约, 实现)` 真对账,灯③ 有牙。

**审查批量修复(blocker + high)**:
1. **`run_failed` 静默卡死(blocker)** → worktype 新增 `run_failed` 分支 raise 人病历(容器对 run_failed 不
   自动重试;尤其末位 worker 失败时 fan-in 不唤醒 owner、批次永久挂起 —— 病历兜住)。
2. **`wait_resolved` 按 reason 精确路由** → 容器 `enrichEventForType` 注入 `resolvedWaitReason`,worktype 据此
   区分「取消确认病历 / 对账病历 / run 失败病历 / checkpoint 拍板」,**修掉「在 implement 阶段 resolve 一个取消
   病历被误判成阶段拍板、错推到集成验证」的反向破坏**,且不再依赖生产侧不产出的 `payload.action==='cancel'`。
3. **幂等防护补活** → `enrichEventForType` 对**每条** owner-workers 事件注入 `openWaitReasons`;`requestAdvance`
   读它,使灯③/对账病历在 effect 崩溃恢复重跑(recovery:'rerun')时不重复 raise 孤儿 wait。
4. **多仓零接口疑则判大** → owner 对出 0 接口但有 ≥2 仓 → 不当「全咬合」放行,raise 人核对(§3.1 铁律)。

**看板(§7.1)随改**:`board.ts` 投影 5 相位/2 灯一 gate/对账面板;`web/src` 的 `theme/types/derive/Detail/seed`
跟改(「对接合同」→「跨仓契约·owner 对账」、删「破坏性→回灯②」)。

**仍是 skeleton / 留作 live 半(诚实标注)**:owner 对账「读散文外部方契约节」、assess「登记真实现接口」靠
AI run 真产出(沙箱用合成报告测 parser/effect);`integration_check`「读各端 worktree 代码做更深对账」仍是 live
扩展(当前是结构化对账 skeleton)。**审查中标为「应做/可忽略」的项**:`reconcile_conflict`/`run_failed` 病历目前
只能从管控台 resolve(飞书侧出口卡待补)、`isRequirementDecisionStale` 成防御性 no-op(合同变更引擎已砍)、
worker 切片仓 key 靠 prompt 约定不归一(结构化安全网已兜「不在清单」一类)。

---

## ✅ 落地记要(2026-06-25,B 阶段 worker 韧性化)

继续从 A 接 B(用户「继续完成后续工作」)。`npm run check` 全绿(**581 测试**)。B 落地两件:

**1. D-04 写权限 hook fail-closed 探针(主)+ 撞出一条真线上坑**
- `write-guard.ts` 加 `probeWriteGuard(scriptPath, writableDirs)`:写档 run 启动前,跑真 `node <guard脚本>` 喂两条合成 PreToolUse——越界写**必须 deny**、worktree 内写**必须 allow**;任一不符(或 node 跑不起来)→ `ok:false`。`runner.ts` runTurn 在写模式 spawn 后、喂 prompt 前调它,失败 → kill 刚 spawn 的进程(零副作用)+ 抛错 →(pool.send reject → effects)`run_failed` → `onRunFailed` 病历。**绝不放无防护的写 agent 跑**。
- **探针第一次跑就逮到真 bug**:原 `renderWriteGuardScript` 用 `decideWriteGuard.toString()` 把函数嵌进独立 hook 脚本——但打包器会污染 toString:esbuild/tsx 的 keepNames 把内层函数包成 `__name(fn,…)`、vitest SSR 把 `path.resolve` 改写成 `__vite_ssr_import_1__.resolve`,独立脚本一跑就 `ReferenceError` → **hook 崩溃 → Claude 当成放行 → 写 agent 一直在无防护裸跑**。而 `npm start` 正是 `tsx src/index.ts`,所以这是**真线上坑**(D-04 一直「半成」从没被验证真生效)。修法:`renderWriteGuardScript` 改为**手写、与打包器无关的脚本串**(不再 `.toString()`,只引用脚本内 import 的 `path`),保证任何打包方式下 `node` 都能跑;`decideWriteGuard` 仍是单测纯核心,加**反漂移 parity 测试**(真 node 跑渲染脚本、逐例对比 decideWriteGuard)锁同步;探针是运行时兜底。
- 测试:probe 正例(真渲染脚本 deny/allow)+ 反例(always-allow/always-deny/缺文件/坏输出 全 fail-closed)+ parity(Write/Edit/NotebookEdit/Bash/Read 逐例一致)。

**2. owner assess 聚合各仓工人完成回执(回执语义)**
- A 阶段遗留:assess(并行实现 fan-in 后唯一一次跑的批次评估 run)只读 `workitem.repos`(原仓)、读不到工人在各自 worktree 的改动,**批次评估 + impl-claims 登记其实是盲的**。补:`run-handler` 把全历史 `run_completed` 报告路径作 `priorReportPaths` 传给 `composePrompt`;worker-handler 的 assess 读全部工人 `report.md` 聚合进 prompt(「各仓工人完成回执」节)。这样 assess 据**真实回执**评估 + 登记 impl-claims,灯③ 的实现侧输入才有据。
- 「执行单元」其余四件(独立 workspace[worktree]/可恢复 session_id[onSession,D-30]/独立 cancel·observe/完成·失败回执[run_completed/run_failed + onRunFailed 病历])经核验**已就绪**,B 不重复造。

**B 经一轮独立对抗审查(general-purpose agent),修了 4 条**:
- **H1(又一个写权限漏洞)**:写 guard 的 matcher + `decideWriteGuard` 漏了 `MultiEdit`(但 readonly profile 的 `READONLY_DENIED_TOOLS` 却显式 deny 它,自相矛盾)——若 Claude CLI 仍有 MultiEdit,写 agent 用它可写 worktree 外任意路径、guard 拦不住也测不出。修:`MultiEdit` 纳入 matcher + decide(与 Edit 同走 file_path);probe/parity 加 MultiEdit 例。「deny 一个可能不存在的工具」零副作用,直接消除假设风险。
- **M2/M3(pool 死壳泄漏 + 复用接缝)**:probe fail-closed 调 `dispose()` 后,runner 空壳滞留 `pool.runners`,evictLRU 只扫 hot runner 故永不回收。修:`pool.send` 的 finally 清理「非 hot 非 busy」死壳(hot/busy 不动,零回归)。
- **L4/L5**:parity 补 MultiEdit/NotebookEdit 越界 deny + 相对路径 redirect 例;assess 聚合工人回执加上界(最多 16 份 × 每份 6000 字符,防 prompt 随工人数×重跑轮数膨胀撞 context)。

**未提交**:B 全部改动随 A + 看板一并在工作树未提交。

> 下一步可选:C 阶段(监工科层:工人疑则上报→独立监工疑则判大→回写图纸/raise 人)→ D 阶段(夜间调度+晨审批量)。

---

## ✅ 落地记要(2026-06-25,C 阶段 监工科层)

继续接 C(用户「继续 C」)。`npm run check` 全绿(**593 测试**)。监工科层(PIVOT §4):**工人图纸只读 → 疑则上报 →
独立监工判「小=本仓自治回写图纸/大=跨仓外溢 raise 人」,疑则判大**。

- **新建 `gatekeeper.ts`**(监工域,与 reconcile/integration 同构):`parseWorkerRaises`(从工人报告抽 ```gatekeeper 块)+
  `gatekeeperVerdict`(interfaceId 非空=碰跨仓契约/疑则→**大**;空=纯本仓→**小**)+ `renderGatekeeperLog`(回写图纸留痕)
  + `createGatekeeperReviewHandler`(recovery:'rerun' 的 gatekeeper_review effect:扫各仓工人回执→判大/小→写
  contract/gatekeeper-log.md→emit gatekeeper_passed / gatekeeper_big)。五条铁律落点见文件头注。
- **状态机**:并行实现 fan-in 改成「最后一个工人完成 → 先过**监工 gate**(gatekeeper_review),放行(gatekeeper_passed)
  才 owner assess」;gatekeeper_big → raise 人病历(幂等)。worker prompt 加「冻结契约不可擅改·疑则上报」指令(rule #5)。
- **回写图纸真被消费**:assess prompt 织入 gatekeeper-log.md(否则回写名不副实)。
- **独立 AI 监工 subagent**(对「本仓改动会不会隐性外溢」做对抗式复核——rule #1 真正的对抗式审查官)是 **live 半**,
  叠在这层结构化骨架(跨仓外溢=大,确定性)之上,与 reconcile/integration 的「结构化骨架 + AI live」分界一致。

**C 经一轮独立对抗审查,修 2 条**:
- **HIGH 病历「打回」死状态(且对称存在于所有病历)**:人 resolve 病历时 declined(approved:false)原本返回裸 `{}`,
  而容器已关掉这条 wait → item 停在原阶段、无 open wait、无 run、无任何再触发 = **死状态**。修:declined → **重弹同名病历**
  (病历必须一直 open 到被 approve 或整单 /cancel);统一修了 gatekeeper_big / reconcile_conflict / run_failed /
  integration_unresolved 四类病历,并给 integration_unresolved 补幂等守卫。
- **LOW 回写图纸是死信**:gatekeeper-log.md 原本无消费者 → 已织入 assess prompt(见上)。

**未提交**:A+B+C 全部改动 + 看板一并在工作树未提交。

> 下一步可选:D 阶段(夜间无人值守:撞红线只挂那条路径、工人转无关活、无旁路则休眠;未决攒批晨审一次性给人)。

---

## (B 之前)A 阶段落地记要保留于下 ——

> 下一步可选:B 阶段(worker 韧性化 + D-04 写权限 hook 探针)→ C 阶段(监工科层)→ D 阶段(夜间调度+晨审)。

---

> 原始推演(下文保留):状态曾为 **待审(尚未动代码)** ｜ 作者:本次对话推演
> **一句话定调**:把"需求设计"摘出 agent-pipe——由人在 Claude Code 用 `/spec-design` 独立完成、产出设计文档;agent-pipe 收缩为"拿着设计文档做**实现 + 自测**"的施工+质检引擎。四灯随之收缩为"两灯一 gate"。

## 0. 这份文档是什么

记录本次对话的**设计推演 + 达成的共识 + 落地计划**,供你审阅。你要审的核心是两件事:
1. 每条决策背后的**判断站不站得住**(每节都标了「理由」);
2. 落地**切口对不对**(第 7 节路线)。

文末第 8 节是「待你确认」清单。**此处拦下,改动成本最低。**

> **🔬 修订记要(经对抗审查 + 第一手代码核验 + 真实 spec-design 产物核对,2026-06-24)**:本版修了两类东西——初稿**成本账失真**(夸大收益),以及第一轮修订**反向过度悲观**(把第 0 步评成「最难子任务」,后被真实产物推翻、校准回来)。四条关键结论,细节散见各节:
> 1. **「砍合同引擎 = 复杂度断崖下降」失真** → 合同引擎是 187 行纯同步、CI 红线的函数(`contract.ts`,代码里最可测的一段);真正复杂的是要**保留**的 `reducer.ts`/`worker-handler.ts`。净效果是「把复杂度从可测区搬到难测的监工 §4 + 夜间 §5」,不是断崖下降(见 §2 代价)。
> 2. **「第 0 步要补整个按仓维度」是误判(经真实 spec-design 产物核验已纠正)** → spec-design 产物是**一仓一个设计目录**(以「本仓库做什么 + 外部方契约」组织,设计目录就在各自仓里),「按仓」天然在目录层、「按 domain」是仓内切分。各仓任务边界天然存在,split 不需二次拆分。第 0 步**降级**为「约定多仓目录组织 + owner 跨仓契约对账闭环」(见 §3.1、§7 第 0 步)。
> 3. **灯③ 的牙齿原长在被砍的 `contract.json` 上 → 现已给解** → 砍 contract 后灯③ 本会永久空转放行;解法是用 §3.1 里 owner 对账出的那份跨仓契约当灯③ 新基准(`contractStructuralDiff` 正好留用)。见 §3 表格后注、§3.1。
> 4. **B 阶段地基大半已就绪** → D-30 / D-10 / D-18 已实装或已拆,唯 D-04(写权限 hook fail-closed 探针)半成(见 §7-B)。

---

## 1. 起点:为什么要动四灯

**触发**:四灯模式「太死、缺乏人和 AI 的自主性」。一度想的解法是给灯加「自适应/信任档」(人可预授权跳过、AI 可主动加灯)。

**但更深的病根诊断(本次最关键的洞察)**:

- **设计是高带宽、发散、多轮收敛的活** → 天生要**同步交互**(随时插话、改方向、一起想)。把它塞进飞书「异步审批卡(通过/打回)」这种低带宽范式,必然别扭。这就是「灯①只能通过/打回给不了意见」「灯②被迫拆成快慢两拍」一直拧巴的根本原因。
- **验收/提交(灯③④)是低频、二元、容忍延迟的决策** → 天生适合**异步硬卡**。飞书灯卡对它们是**合适**的。

**结论**:与其给灯打「自适应」补丁(在错误的范式里修修补补),不如把活搬回它对的范式里去——**设计归同步(Claude Code),执行+质检归异步(agent-pipe 的灯)**。搬完之后,「四灯太死」这个问题**自动消失**,不再需要发明自适应灯。

> 旁证(来自 ai-sentinel 的对照):ai-sentinel 是「软流程 + AI 自裁何时停」的另一极,灵活但会「自圆其说滑过流程」,还得靠 awaiting-fallback(每 2s 扫终端 pane 猜 AI 卡哪)这种脆弱兜底。它和四灯不是对错,是同一根轴(「何时停」的 agency 给谁)的两端。我们不照搬它的软流程,只在第 6 节偷它一个具体零件。

---

## 2. 核心决策:把"设计"摘出去

**决策**:`理解 → 合同 → 详设`(灯①②那一整块,含合同冻结/影响计算/变更引擎)从 agent-pipe **完全移除**。设计由人在 Claude Code 用 `/spec-design` 独立完成,产出**设计文档**作为 agent-pipe 的输入。

**这是战略判断,不是战术逃避**:理由是「设计本就该人在 Claude Code 做更好」,不是「设计阶段实现太麻烦想绕开」。(已确认是前者。)

**收益**:
- 砍掉「产设计」这一整段职责,系统边界大幅收窄(相位 7→5、灯 4→2+1 gate),省掉「灯①② 在错误范式里修修补补」的长期拧巴;
- 系统聚焦在**最可能做好、输入输出最可验证**的一段:`拿一份设计文档 → 实现 → 自测绿 → 验收 → 提交`;
- 与项目「向个人助理重定位」的方向一致——个人助理是「拿着你认过的方案去执行」,不是「替你做产品决策」。

**代价(诚实列 · 经核验修正)**:
- **复杂度没降,是转移(初稿「断崖下降」据实修正)**:被砍的合同引擎是 187 行**纯同步、无 IO、CI 红线**的函数(`contract.ts`),是代码里**最可测**的一段;真正复杂脆弱的 `reducer.ts`(1000+ 行)/`worker-handler.ts` 反而**保留**。新换进来的监工(§4)+ 夜间(§5)是难测的待建子系统。净效果 = 「把复杂度从可测区搬到难测区」,真正的收益是**聚焦**,不是**变简单**。
- **愿景收缩**:从「一个全栈工程师 + 半个 PM」退回到「一个拿着图纸的施工队 + 质检队」。前提是「半个 PM」本就是过度承诺、不是真护城河——已确认接受。(⚠️ 审查追问:退到施工队后,相对 Claude Code 自带执行 skill 的**不可替代增量**是什么,§8 待答。)
- **问题被替换而非消除**:省掉「产设计的复杂度」,换来「**消费 N 份外部设计文档 + 把它们的跨仓契约对齐**」(见第 3 节)。这个新问题比初稿评估的**小**(各仓设计天然分好、人已审单仓),但不是零——跨仓契约的「拼凑 + 对账」要认真做,否则只是把对齐失败从灯①② 挪到灯③ 暴雷、暴露得更晚。
- **沉没成本(初稿「全部留用」据实修正)**:`understand/contract/design` 相位、灯①② 要废弃或隔离。但两点初稿乐观了:① **合同引擎砍不干净**——`contractStructuralDiff` 还被灯③、p板 stale 判定(`isRequirementDecisionStale`)、worker 提示词、board 共用,且「领域设计→冻结合同」的升格本身就是 contract 相位 `afterRun` 干的活(`worker-handler.ts` promoteToContract),砍了它 split 拿不到「按仓 + 跨仓合同」;② **灯③ 不能算「全部留用」**——它的牙齿长在 `contract.json` 上(见 §3 表格后注)。另:今天为加固四灯投入的 web/console 看板(~2200 行)**保留**,随 A 改造(数据驱动、工作量小,见 §7.1)。其余底座(状态机/worker 并行/worktree/写权限/自测硬门)留用属实。

---

## 3. 新主线:七相位四灯 → 两灯一 gate

| 现状 | 转向后 | 动作 |
|---|---|---|
| intake 立项(AI 抽自由 PRD) | intake 立项(收**设计文档** + 仓库列表) | **改入口** |
| understand 理解 →[灯①] | — | **砍** |
| contract 合同 →[灯②快] | — | **砍(连合同冻结/影响计算/变更引擎)** |
| design 详设 →[灯②慢] | — | **砍** |
| split 拆解(消费内部详设) | split 拆解(**各仓已有自己的设计目录 → 按仓分发**;owner 先拼凑+对账跨仓契约) | **改:成为新主线第一个 owner 动作** |
| implement 并行实现 + 自测 | implement + **监工回路**(第 4 节) | **留 + 加** |
| integrate 集成验证 | integrate 集成验证 | **留(⚠️ 基准改用 owner 对账出的跨仓契约——见下注)** |
| [灯③ 验收] / [灯④ 提交] | [灯③ 验收] / [灯④ 提交] | **留** |

> **⚠️ 灯③ 基准问题(核验发现 + §3.1 给解)**:灯③ 判定原本**寄生在 `contract.json` 上**——`integration.ts:31` 无 contract 时走 `no_contract` 直接放行;砍 contract 后若不补基准,灯③ 退化成「永久空转放行」。**解法**:用 §3.1 里 owner 拼凑+对账出的那份**需求层级跨仓契约**当灯③ 的对账基准(结构化后喂 `integration.ts`,`contractStructuralDiff` 正好留用),灯③ 就有牙齿了。

**收口**:纠结一路的「四灯太死」,最终答案不是改灯,而是砍掉「天生不适合做灯」的①②,剩下的自然就是适合做灯的③④。灯范式和工作终于对齐了。

### 3.1 设计文档契约 + 跨仓对账(新主线的入口)

**关键认知(经真实 spec-design 产物核验)**:`/spec-design` 的产物是**一仓一个设计目录**——以「本仓库做什么 + 外部方契约」为主语组织,设计目录物理上就在各自仓里(样本 `web-alaeat-enterprise/ai-specs/<feature>/`,含 design/index + domains + internal-apis + requirements + decisions)。由此:

- **「按 domain」是「一个仓内部」的技术切分;「按仓」在更高一层——一仓一个目录。** 初稿「产物缺按仓维度、第 0 步要补整维」是把两层压成一层的**误判**,已纠正。
- 多仓需求 = 多个这样的目录,各自的「外部方契约」节互指(A 仓声明「我要 B 给 X」、B 仓声明「我对外给 Y」)。
- 四要素里:**①改哪些仓 = 立项时人给的仓库列表;②各仓任务边界 = 每个仓自己那份目录(天然分好,split 不需二次拆);④验收标准 = 各仓 requirements 的 AC**。唯一**不天然现成**的是 **③跨仓接口契约**——它以**散文形式散落在各仓的「外部方契约」节**,需要被收拢成需求层级的一份。

**第 0 步真正要做的:owner「拼凑 + 对账」闭环(把砍掉的灯② 合同以轻量形式长回来)**:

```
立项(人给 N 个仓 + 各仓设计已分别审过)
  └→ owner 读各仓「外部方契约」节，拼凑 + 对账
        ├─ 全咬合 ───────────────────→ 跨仓契约定稿 → split 按仓分发 → 施工
        └─ 发现 冲突(两边对不上)/ 悬空(一边声明、对方无应答) → raise 人
               └→ 人拍板 → 改对应单仓设计（单仓 = 唯一真值源）
                    └→ owner 再拼凑 + 对账 ──(可能多轮)──→ 收敛后定稿
```

几条定死的设计选择:
- **owner 是「拼凑 + 对账者」,不是「只汇总者」**:拼到一页只是聚合视图、假一致性;真正的价值是发现 X≠Y 就 raise 人。上报判据 = **冲突 + 悬空**(悬空比冲突更危险:有一方完全没意识到这个接口的存在)。
- **单仓设计 = 唯一真值源,owner 契约 = 纯派生物**:冲突修复一律回写单仓、再重新拼凑,不存在双真值源 drift。
- **owner 对账契约 = 灯③ 的对账基准**:正好补上「砍 contract 后灯③ 靠什么对账」(见 §3 表格后注)。本质是 `contract.json` 换了产地——从「contract 相位升格」挪到「owner 汇总」,复杂度搬家、没蒸发,但复用了已有的 owner、比专门相位轻。

**两个落点(已定,见 §8)**:① owner 对账可靠性取决于各仓「外部方契约」够不够结构化——方向上**升成 `/spec-design` 强制产出节**(provider/consumer/字段/方向/符号;enterprise 产物 §2/§8 是范本),但**不作 A 启动前置**,先用「owner 尽力对账 + 疑则 raise 人」起步、痛了再结构化;② 冲突修复**拆开**:**改设计 = 人**(Claude Code,设计归人)、**按新设计返工实现 = owner 派 worker**——不让 agent 自动改图纸。

---

## 4. 实现中改设计:监工科层

**前提共识**:实现中发现**小问题可以就地修正、继续跑**,不必每个偏离都停下惊动人(否则系统退化成「问题反射器」)。这与「设计外置」不冲突。

**但唯一的命门——「小 vs 大」由谁判定**:

- **不能交给写实现的工人**(运动员当裁判,会「自我宽容偷工」,把大偏离编成「小修正」滑过去);
- **交给一个与实现解耦的独立 AI 监工**。这与原四灯取舍#3「跨端契约测试必须独立于实现工人」是**同一条原则**的延伸:判定者必须独立于实现者。

### 科层与回路

```
工人(干活,图纸只读,无编辑权)
  └─ 撞到图纸疑问 → 上报 →
包工头 / owner(协调,起监工 subagent)
  └─ 起一个独立监工 →
监工(独立 subagent,只审这一件事)
  ├─ 判「小」→ 放行 + 回写图纸 → 工人继续
  └─ 判「大」→ raise 人 wait(病历)→
人(终审,只在「大」时出场)
```

### 五条配套铁律(缺一则机制退化)

1. **监工必须是对抗式审查官,疑罪从有**:默认姿态「拿不准 → 判大、上报人」,而非「拿不准 → 放行」。否则只是把自我宽容从工人挪到监工。这是整套机制成不成立的**第一命门**。
2. **放行必留痕 + 回写图纸**:工人无编辑权 → 编辑权收归「监工批准→包工头落笔」这条受控回路,且每次放行强制伴随图纸更新。否则图纸与实现 drift,下次拿图纸的人/AI 看到的是旧的。
3. **人划红线区给监工当锚**:图纸里标清「哪些是关键约束/跨仓接口」。人划线(给锚)+ 监工裁量(处理灰色)是**叠加**,不是二选一。没有锚的监工判断会飘。
4. **跨仓外溢 ≈ 自动判大**:改动技术上再小,只要外溢到别的工人依赖的接口(要协调返工),对系统就是大。监工看「波及面」,不只看「改动大小」。
5. **工人「疑则上报」做廉价一级分流**:明显纯本仓内部、碰都没碰图纸的,留一笔痕即可;只要工人**怀疑**可能碰约束就上报。注意这里工人判的是「要不要上报」(疑则报,只会多报),不是「要不要放行」——偏置方向安全。工人疑则上报 + 监工疑则判大,两级都偏向安全,红线破不了,成本还可控。

---

## 5. 夜间无人值守(终审者缺席时)

**场景**:夜间无人,监工判「大」需要人拍板,但人不在。不能让工人就此卡死、拖停整条线。

**「不卡死」的正确定义**:不是「工人永不停」,而是「**一个未决点只阻塞依赖它的那条路径,不阻塞与它无关的活**」。调度单位是**任务,不是工人**:工人在 T1 撞红线 → 挂起 T1 → 转去做不依赖 T1 的 T2/T3。

**由此推出**:若一个仓的剩余活全都(直接/间接)依赖那个未决点 → 该工人**干净休眠**(事件驱动,不占资源),等人拍板后唤醒。这**不是卡死**——别的仓的工人照常跑,系统整体仍在推进。「一个仓的一条路径走到红线、无旁路,那个仓停下等人」是**正确且必要**的。

**最危险的坑(重锤):夜间不卡死 ≠ 夜间放行红线**。夜间恰恰是**终审者缺席**的时段,如果监工因「现在没人、为了不中断」就松动「疑则判大」,整套制衡就被「夜间模式」这个后门击穿,没有任何人兜底。**红线白天夜里一样硬;唯一变的是「判大之后工人去干别的,而不是干等」**。这条线就是「调度」与「偷工」的分界,必须焊死。

**配套**:
- **依赖封锁,别乐观赌**:工人去干的「别的活」必须与未决点**无依赖**。绝不能「假设监工会放行」先把下游写了——赌错则下游全废、污染仓库(退化成乐观执行)。
- **晨审批量**:夜里积累的多个未决(不同仓/不同问题)攒成**一叠病历**,早上一次性给人集中拍板,而非零散打断。这是异步无人值守的红利。**owner 拼凑契约时发现的跨仓冲突/悬空(§3.1)走同一条通道**——夜间不放行、挂起依赖它的活、攒进晨审,与「监工判大」同构,不单开机制。

**这版先不做**:乐观执行 + worktree 隔离回滚(只对「赌错能干净回滚」的改动安全,复杂度/算力成本高;先把「挂起+调度无关活+晨审」跑通,确认产能浪费真痛到值得再上)。

---

## 6. 协调模型取舍:为什么不整体学 ai-sentinel

**澄清一个观察偏差**:ai-sentinel **也有「包工头」**——`sessions_hub` 登记父子关系、`project_groups` 让中枢 chat 给各 project chat 派活、`AgentDmReceipt` 收「受理/完成」回执。你看到的「对等并行」是它的**执行单元层**;协调层它一样有中枢。

**真正的区别不是「有没有包工头」,而是「包工头用什么指挥」**:

| | agent-pipe(我们) | ai-sentinel |
|---|---|---|
| 协调介质 | 状态机 effect 派发 + 事件 fan-in | cross-chat **消息 + 回执** |
| 耦合 | 进程内、紧耦合 | 跨 session、松耦合 |
| 比喻 | 包工头拿**花名册**(全局状态)点名 | 包工头拿**对讲机**(异步消息)喊话 |

这是经典的 **编排(orchestration)vs 协同(choreography)**。对我们的刚需,**花名册正好命中**:`fan-in barrier`(所有仓自测绿才进集成/灯③)、`checkpoint 硬卡`(灯③④真卡住)、`监工裁决回路`、`夜间调度`——全是中心编排的强项,而恰恰是「对等消息协同」的弱项(barrier 和强一致状态最难做)。

**决策**:
- **协调模型不换**。owner + 状态机编排是我们 fan-in/checkpoint 的护城河,不是要被取代的负债。为了「像人家」拆成消息协同 = 拿护城河换扩展性,而扩展性(多需求并行)这版根本不做。
- **只偷一个零件**:把 worker 升级成「**独立可恢复执行单元**」(独立 workspace[worktree 已有] + 独立可恢复 session_id + 可独立 cancel/observe + 显式受理/完成/失败回执)。这正好填悬着的 **D-30**(worker 崩溃恢复)+ 第 5 节的**夜间自愈**。偷零件,不偷架构。

**分层视角(不必二选一,留给未来)**:
- **需求内部(多仓协调)** → 中心编排(owner-workers 状态机)。现状即对。
- **需求之间(多需求并行)** → 这版 cut 了。将来真要做时,用 ai-sentinel 式对等并行(每需求一独立 session、无跨需求中心、加需求=加 session)——因为需求间没有 fan-in 需求,正是对等模型水平扩展的主场。

---

## 7. 落地路线:4 阶段 + 第 0 步

**第 0 步(前置,主要是约定 + 轻代码):定多仓目录组织 + owner 跨仓对账闭环**(见 §3.1)。经真实产物核验,这步比初稿评估的**轻得多**——各仓设计天然一仓一目录、边界现成,不用补「按仓维度」。真正要定的是:① 约定立项收「N 个仓 + 各仓设计目录」;② 把「外部方契约」升成 `/spec-design` 强制产出节(让 owner 能读不靠猜);③ owner「拼凑 + 对账」闭环(冲突/悬空 → raise 人 → 改单仓 → 再对账);④ 这份对账契约同时当**灯③ 对账基准**(补 `integration.ts:31` 空转)。**仍是 A 阶段前置(split 要消费它),但不再是「最难子任务」。**

| 阶段 | 做什么 | 动哪些代码 | 为什么这个顺序 |
|---|---|---|---|
| **A. 立主线**(改入口+收窄,**非纯减法**) | 砍 understand/contract/design 三相位 + 灯①②;intake 收「N 仓 + 各仓设计目录」;split 改成**按仓分发 + owner 拼凑对账跨仓契约**。**不是纯减法**:① 灯③ 基准改用 owner 对账契约(否则空转);② `contractStructuralDiff` 砍不干净、正好**留用**给 owner 对账 + 灯③ 结构化比对 | `phases.ts`(删相位/改 nextPhase 链/改 `CHECKPOINT_REQUIRED_BEFORE`)、`index.ts`(删对应 transition 分支)、`contract.ts` **不整删**(留 `contractStructuralDiff` 等对账件)、`integration.ts` 改基准为 owner 契约、改 `intake.ts` 收料字段、新增 owner 对账 effect | **最高优先 · 第 0 步过了才能切**:相位砍掉是纯减法(底座 kernel 层留用、不波及其它 worktype),但灯③/合同对账要外科手术式保留并改基准。做完手验「喂文档→实现→集成→灯③④」。 |
| **B. worker 韧性化** | worker 升级成独立可恢复 + 显式受理/完成/失败回执 | worker 执行层 + run 收口;偷 ai-sentinel 的 `AgentDmReceipt` 语义 | **核验更新**:D-30(onSession 恢复)/ D-10(inflight 键)/ D-18(派 worker 不占槽、防二级死锁)**已实装**;本阶段真正要补的是**回执语义** + **D-04 写权限 hook 的 fail-closed 探针**(启动前发探针验证 hook 真生效——目前缺,约 20-30% 工作量) |
| **C. 监工科层** | 工人只读图纸(权限 hook 硬拦);工人「疑则上报」→ owner 起监工 subagent →监工「疑则判大」→ 判小:回写图纸+继续 / 判大:raise 人 wait;跨仓外溢≈判大 | 新 event(worker 上报)、新 effect(起监工 `gatekeeper_review`)、回写图纸 effect、复用 `raiseCheckpoint` | 最有判断力含量、也最易做歪(监工偏置/回写/依赖封锁);等主线+韧性稳了再上 |
| **D. 夜间调度 + 晨审** | 撞红线只挂那条路径、工人转无关活、无旁路则休眠;未决攒批、晨审一次性给人 | owner 调度逻辑 + wait 批量化 | 依赖 B(可恢复)和 C(监工产未决);是吞吐优化非主线正确性,放最后 |

**这版先不做**:乐观执行+worktree 回滚、多需求并行(对等 session 层)、合同变更引擎(砍了)。

### 7.1 看板(web/console)随主线改造

看板是后端模型的投影(`web/src/types.ts` = 后端 requirement-board projection 的契约形状),且大半**数据驱动**(`derive.ts` 折算 VM、组件 `map` 渲染)——「四灯→两灯、七相位→五相位」主要改 `theme.ts` 常量 + 后端投影,组件几乎不动。**代码改动绑对应阶段、不单独做**;此处只把清单挂住,免得脱节漂着。

**A 阶段跟改(随砍相位/灯/合同一起)**:

| 改什么 | 落点 | 说明 |
|---|---|---|
| 七相位 → 五相位 | `theme.ts` `STAGES` + `Detail.tsx`「阶段时间线 · 7 步」文案 | 去 understand/contract/design;`map` 自动跟变 |
| 四灯 → 两灯一 gate | `theme.ts` `LIGHTS`、`types.ts` `lights` | 立项 gate/③/④;组件数据驱动不动 |
| **「对接合同」面板 → 「跨仓契约 · owner 对账」** | `Detail.tsx`「对接合同」段、`types.ts` `Contract` | 唯一要重做的面板:frozen/breaking → 契约条目 + 对账状态(全咬合 / 冲突 N / 悬空 M) |
| **删「⚠ 破坏性变更 → 回灯②」** | `Detail.tsx` `vm.contract.breaking` 那块 | 灯② 没了;换成 owner 对账「冲突/悬空 → raise 人」 |
| 集成验证基准语义换 | `Detail.tsx`「集成验证」段、`derive.ts` | round/diffs/status 字段复用,diffs 改为「实现 vs owner 对账契约」 |
| 后端投影跟改 | `src/worktypes/requirement/board.ts`、`src/console/server.ts`、`web/src/seed.ts` | board.ts 现消费 contract,改投影 owner 对账契约 |

**C / D 阶段新增(等机制落地再设计 UI)**:
- **监工回路**可视化(上报 → 判小/大 → 回写图纸 / raise 人)——挂现有「实时活动流」+「待办·等待」,载体已有。C 阶段。
- **夜间调度 / 晨审批量**(挂起任务、休眠仓、晨审一叠)——D 阶段。

**不动(通用,PIVOT 后照用)**:各仓工人 / WorkItem 清单 / 风险 / 待办·等待 / 活动流 / 决策台账 / 指标 / 健康 / 归档 / 「等我拍板」区。

---

## 8. 待你确认(审阅拍板点)

- [ ] **大方向**:设计外置、agent-pipe 聚焦「实现+自测」,认不认可(第 2 节)。
- [x] **跨仓契约 = owner 拼凑+对账闭环**(§3.1、§7 第 0 步):认不认可「各仓设计天然一仓一目录、按仓维度不用补」「owner 当**对账器**(冲突+悬空就 raise 人)而非只汇总」「单仓 = 唯一真值源、冲突回写单仓」「这份对账契约即灯③ 基准」。
- [x] **「外部方契约」升强制节**:方向认可,但**不作 A 启动前置**——agent-pipe 先用「owner 尽力对账 + 疑则 raise 人」起步,`/spec-design` 契约节结构化(provider/consumer/字段/方向/符号)作为可后补增强(跨 skill 改动)。
- [x] **冲突修复分工(拆开定)**:**改设计文档 = 人**(Claude Code,设计归人);**按新设计返工实现 = owner 派 worker**(implement 既有能力)。不让 agent 自动改图纸。
- [x] **(a) 交互可解性反问 → 已答**:删对——砍灯①② 的地基是「设计本就该在 Claude Code 做」(§2),这条交互再厚也翻不了案;web 看板保留改造(§7.1)。
- [ ] **(b) 护城河(仍待答)**:退到「施工 + 质检队」后,相对 Claude Code 自带执行 skill 的**不可替代增量**是什么——不阻拦动手,可边做边答。
- [ ] **监工科层**:工人无图纸编辑权 + 独立监工裁决 + 五条铁律(尤其「监工疑则判大」「放行必回写图纸」),有无异议(第 4 节)。
- [ ] **夜间红线**:认可「夜间允许调度无关活、绝不放行红线」「无旁路则休眠不算卡死」(第 5 节)。
- [ ] **协调模型**:认可「保留状态机编排、只偷 worker 可恢复」,不整体学 ai-sentinel(第 6 节)。
- [ ] **切口**:认可从 A 阶段(立主线)切入,还是先单独深挖某阶段(第 7 节)。
- [ ] **待定项**:D-30(worker 崩溃恢复 onSession)在 B 阶段一并解决——确认。

> ✅ 无疑 → 我按第 7 节从第 0 步(定契约)+ A 阶段动手;❌ 有异议 → 在对应小节拦下。
