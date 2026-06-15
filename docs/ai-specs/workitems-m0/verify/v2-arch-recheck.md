# 架构校验（2.2b 修正复检） -- 校验报告

> Step 2.2b 复检 | Feature: workitems-m0 | 模式: arch | 2026-06-12

> 独立复检：不复用 v2-arch.md 旧结论，以修正后文件为唯一事实重新核对四个被修正问题（1 RED + 3 YELLOW）。

## 校验范围

| 类别 | 文件 |
|------|------|
| 被检产出 | spec/overview.md（ADR-7/9/11、G-4.5/G-4.6、交互图）、spec/S3-reducer-concurrency.md、spec/S4-effects-outbox.md、spec/S2-lifecycle-projection.md、spec/S1-storage-foundation.md、spec/S5-waits-watchdog.md、spec/S6-noop-verification.md 各设计节 |
| 对照来源 | spec/_index.md（AC 总览）、各文件 `## 需求` 节 AC 原文 |

## 四个被修正问题的闭合判定

### ① I-015 / ADR-11：自报失败终态化时机（原 RED）—— 已闭合

沿 AC-6.5 纸面推演（failCount=∞，noopMaxRetries=1 默认）：

1. 执行器 catch（S4 #2）：run 类**不**置 aborted，效果保持 running，emit `run_failed {assignmentRetries=0}`；
2. emit → enqueue → 同步 drain → applyEvent：structuralCheck 首查 `getEffect(effectId).status` == 'running' ≠ 'aborted' → **不命中 ADR-7 前置检查**，结论存活（原 RED 的死路已拆除）；
3. apply 事务内统一终态化：`setEffectStatus(effectId, 'aborted')`（S3 #2，仅 pending|running → 终态，单向合法）+ closeAssignment(failed)；noop onEvent 读 `payload.assignmentRetries=0 < 1` → dispatch 重派（replaces 链、retries=1）。终态化先于 applyTransitionWrites ⇒ 单飞检查不见在途 run 效果，新 run 效果可插入；
4. 第二轮：assignmentRetries=1，`1 < 1` 不成立 → `terminal:'failed'` → **failed 终态可达**，事件链（run_failed×2 + replaces）可审计。

三条伴随路径复核：

- **中止通道迟到结论仍被作废（AC-4.12 × ADR-7）**：abort() 先小事务置 aborted 再 enqueue effect_aborted；handler 若仍 emit 结论，structuralCheck 命中 `status=='aborted'` → `decision_discarded(effect_aborted)`，效果保持 aborted（`∈ {pending,running}` 守卫跳过改写）、不计 streak、不重唤醒（S3 #2 提前 return）。ADR-7 语义完整保留。
- **恢复作废路径（AC-4.9）不受影响**：recovery 对不可 resume 的 running run 效果走 `tx{aborted} + enqueue effect_aborted`，仍属 ADR-11 明示保留的 aborted 前置置位通道；apply 经容器机制层 superseded + replaces 重派，与 stalled 管道同路径，无双发。
- **幂等类（rerun）失败自洽**：无结论事件，执行器小事务直接置 aborted（S4 catch else 分支），不经 ADR-7 检查（该检查仅作用于结论事件）；AC-4.4「失败置 aborted、终态不再拾取」成立。补充核验：结论因 assignment_superseded 等非 effect_aborted 原因被作废时，S3 将仍 running 的效果置 done（「决定作废，效果已执行完」）——无效果滞留 running 的缺口。

S3 伪代码、S4 catch 注释、S4 场景表（「run_failed 回流正常 apply（不被作废），效果于该 apply 事务内置 aborted」）、S3 场景表（「结论回流时效果已 aborted → 保持 aborted」）、overview G-4.5 行与 ADR-7「边界（I-015 增补）」段五处口径一致。

### ② I-016：Decision 类型归属（原 YELLOW）—— 已闭合

Decision 定义于 src/workitems/types.ts（S2 接口段），WorkType.isDecisionStale 签名同文件自引用；S3/S4 仅声明引用。

### ③ I-017：CreateInput/CreateResult 归属（原 YELLOW）—— 已闭合

二者定义于 types.ts（S2 接口段注明「S2 api.createWorkItem 与 S3 reducer.bootstrapApply 共享」）；api.ts 与 reducer.ts 各自单向 import types.ts。

②③ 合并画 workitems 内文件 import 方向（依据各设计节「依赖关系」+ 接口注释）：

```
types.ts        ← 纯类型叶子，不 import 任何 workitems 文件
store/registry/projection/artifacts → types.ts
reducer.ts  → types.ts, store, registry, projection, config（isRunClass/postCommit 构造注入，不 import effects）
api.ts      → types.ts, reducer.ts, store        （reducer 不回头 import api）
effects.ts  → types.ts, store, reducer.ts        （reducer←effects 仅经注入回调，无文件边）
watchdog.ts → store, reducer, effects, config
recovery.ts → store, artifacts, effects, reducer
container.ts → 以上全部（组装根）；worktypes/noop → workitems(types/container)，workitems 不 import worktypes
```

拓扑序存在（types → store/registry/projection → reducer → api/effects → watchdog/recovery → container → worktypes），**无环**。

### ④ I-018：updateWait 接口宽度（原 YELLOW）—— 已闭合

S1 收窄为 `Partial<Pick<WaitRow, 'resolvedAt'|'resolvedBy'|'resolveReason'|'renewedCount'|'deadlineAt'|'remindedAt'>>`。逐一核对 S5 全部 wait 写点：

| 写点 | 字段 | 是否在允许集 |
|---|---|---|
| resolveWait apply | resolvedAt/resolvedBy/resolveReason | ✓ |
| renewWait apply | deadlineAt/renewedCount/remindedAt(=NULL) | ✓ |
| wait_reminder apply（human 到期） | remindedAt | ✓ |
| timer_fired apply | resolvedAt | ✓ |
| stalled 早退 origin_terminal（ADR-8） | resolvedAt/resolvedBy/resolveReason | ✓ |

deadlineAt 仅 renewWait 路径可写的注释在 S1 接口与 S5 #4 两侧对齐（wait 创建走 insertWait 不经此接口），与 AC-5.4「续期是唯一改期入口」承诺一致。

## 问题清单

| # | 严重度 | 类型 | 描述 | 涉及位置 | 建议 |
|---|--------|------|------|---------|------|
| 1 | YELLOW | 矛盾（措辞同步残留，低危） | 交互图行「完成/失败/中止 → 封装结论事件 enqueue 回 reducer（效果终态在结论 apply 事务内置位）」把「中止」并入结论通道：中止的回流事件是 effect_aborted（非结论事件，不走 structuralCheck 结论前置检查，归容器机制层），且其 aborted 由 abort() 小事务预置、不在 apply 事务内——与 ADR-11 的 carve-out 及 S4 AC-4.12「不再产出结论回流事件」字面冲突。规范文本（ADR-7/11、S3/S4 伪代码）无歧义，仅此概览行可能误导实现者把 effect_aborted 当结论处理或把 aborted 置位推迟到 apply 事务（后者会改变迟到结论竞态的判废结果） | overview.md:91 | 拆为两支：「完成/失败 → 结论事件 enqueue 回 reducer（效果终态在结论 apply 事务内置位）；中止 → effect_aborted 回流（aborted 已由 abort() 预置 → ADR-11）」 |
| 2 | YELLOW | 矛盾（措辞同步残留，低危） | G-4.6 决策行「aborted 一律产生 `effect_aborted`（或失败时 `run_failed`）事件回流」中的「一律」与 ADR-11 明示的幂等类例外冲突——幂等类（rerun）失败由执行器小事务直接置 aborted，**无任何回流事件** | overview.md:150（G-4.6 行） | 将「一律」限定为运行类，或补注「幂等类失败例外：无回流事件，小事务直接终态化（→ ADR-11）」 |

## 总结

- 检查项: 4 个被修正问题全部闭合（①②③④）；推演 4 条路径（AC-6.5 / 中止迟到结论 / 恢复作废 / 幂等失败）全部走通；import 图无环；updateWait 5 个写点全部合规；ADR-9（assignmentRetries）在 S3/S4/S6/overview 四处同步无残留
- RED: 0 | YELLOW: 2
- **结论**: PASS（2 个 YELLOW 均为 overview.md 概览措辞与 ADR-11 的同步残留，规范层 ADR/伪代码/测试要点一致无歧义，不阻塞设计定稿；建议随手修正以免实现期误读）
