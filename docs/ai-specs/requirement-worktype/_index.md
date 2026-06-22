# requirement worktype — 设计 spec 索引

> 把"实现 requirement 需求开发 worktype（一次到位）"当作一个需求，用 `/spec-design` 方法论（Full 轨道）产出的全套设计。
> 日期：2026-06-18（决策 2026-06-22 审核通过）｜ 状态：**✅ 设计完成 + 决策已审，可执行**（维护者已接受全部决策）
> 上游：实现总纲 `docs/design/2026-06-18-requirement-implementation-overview.md` + 宏观设计 `docs/design/2026-06-11-workitem-macro-design.md` + 交互原型 `docs/design/prototype-req-flow*`

## 这是什么
本目录是 requirement worktype 的**可执行设计**，供下一个负责实现的 AI（如 `/ai-spec` 类执行 skill）消费。**只做设计、不改一行产品代码**。

## 怎么读（按角色）

**维护者（人）审核** —— 按顺序：
1. `docs/design/2026-06-18-requirement-决策待审.md` — 决策速览（8 条高影响 + 4 条 DEFER），最先看
2. `design-overview.md` — 设计大纲（3 分钟全貌，去编号化说人话）
3. `design-detail.md` — 设计详览（逐条挑刺的业务定稿）
4. `decisions.md` — 31 条决策 + 4 DEFER 全台账（含对抗审查增补）
5. `adversarial-review-gate3.md` / `gate5.md` — 23 条红队挑战 + 逐条回应

**执行 skill（AI）实现** —— 只读 `design/`：
- `design/index.md` — 业务全貌 + 领域划分 + 依赖图 + AC 映射 + Sensor2 矩阵（✅ 通过）
- `design/internal-apis.md` — 新增 API 契约登记（具体字段、引用锚点）
- `design/domains/*.md` — 10 个领域详细设计
- 复用资源查 `codebase-findings.md` Part B（精确 file:line）

## 产物清单

| 文件 | 读者 | 作用 |
|---|---|---|
| `qa.md` | 人 | 需求理解 + 14 个关键疑问（我替你答 + 标待审） |
| `codebase-findings.md` | AI/人 | 代码考古 SSOT（41 断言核验 + 可复用资源精确 file:line） |
| `requirements.md` | 源 | 24 Requirement + EARS AC（含对抗审查回补 AC） |
| `decisions.md` | 人 | 31 决策 + 4 DEFER 台账 |
| `design-overview.md` | 人 | 设计大纲（Gate3 审查对象） |
| `design-detail.md` | 人 | 设计详览（Gate5 审查对象） |
| `adversarial-review-gate3.md` | 人 | requirements 对抗审查（1 阻塞+6 警告+3 提示，全接受） |
| `adversarial-review-gate5.md` | 人 | decisions 对抗审查（4 阻塞+8 警告+1 提示，全接受） |
| `design/index.md` | AI | AI 装配总索引 + Sensor2 矩阵 |
| `design/internal-apis.md` | AI | 新增 API 契约登记 |
| `design/domains/*.md` | AI | 10 领域详细设计 |
| `docs/design/prototype/`（index/workitem/review/feishu + shared.css/js）| 人 | v2 多文件交互原型（默认落地看板，已修 6 阻塞 + 七大主题） |
| `docs/design/prototype/UX-走查结论.md` | 人 | 6 人格 UX 走查 53 finding 归并 + 处置 |
| `docs/design/prototype-req-flow.html` | 人 | v1 单文件原型（蓝本，保留对照） |

## 三层质量保证（已执行）
- 🤖 **Sensor**：Sensor 1（PRD 准确性，41 断言 0 refuted）✅ ｜ Sensor 2（覆盖率矩阵，12 规则全绿）✅
- 👤 **人审 Gate**：本轮维护者不在场，方向性判断我替拍并标待审（汇总进 `决策待审`），等回来审核
- 🔴 **Adversarial**：Gate3（requirements）+ Gate5（decisions）独立红队，**23 条挑战全部接受并回补**

## 关键数字
- 24 Requirement ｜ ≈144 AC ｜ 31 决策 + 4 DEFER ｜ 10 领域
- 8 个并行考古员核验 41 条 file:line 断言（0 refuted，5 处行号漂移）
- 2 轮对抗审查 23 条挑战（5 阻塞，全部回补加固）
- 6 人格 UX 走查交互原型 53 finding（6 阻塞）→ 驱动 v2 多文件原型 `docs/design/prototype/`

## 落地前置（实现 skill 注意，来自决策）
1. **架构红线**：knowledge 层落地前先在 `tests/helpers/architecture.ts:109-114` layerFor 加 `knowledge/` 分层分支（否则触禁词，D-16）。
2. **写权限基建**：PreToolUse hook/settings 注入基建当前零，要新建 + fail-closed 探针（D-04）。
3. **onSession 回调**：worker resume 依赖补 runner onSession（否则恢复退化为重置+重派，D-30）。
4. **inflight 键改造**：effects.ts 6+ 处连锁，漏一处工人互相覆盖（D-10）。
5. **开发序**：地基(并行+关卡+noop 回归)→kernel 能力→worktype 骨架(noop 跑通)→接真 agent→知识/设计审→工作台→端到端（D-26）。
