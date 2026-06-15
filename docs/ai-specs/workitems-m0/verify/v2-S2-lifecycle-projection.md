# 模块设计校验 -- 校验报告

> Step 2.2a | Feature: workitems-m0 | 模式: module (S2, AC-2.1~2.13) | 2026-06-12

## 校验范围

| 类别 | 文件 |
|------|------|
| 被检产出 | docs/ai-specs/workitems-m0/spec/S2-lifecycle-projection.md（§设计 对照 §需求） |
| 对照来源 | docs/ai-specs/workitems-m0/spec/overview.md（ADR 决策表 G-2.1~G-2.6）；S1 设计节（跨模块接口核对） |

## AC 覆盖

| AC | 设计覆盖位置 | 状态 |
|----|------------|------|
| AC-2.1~2.5 | 内部结构 #1 创建路径（TypeNotRegisteredError / 先查后插 dedupe + UNIQUE 兜底 / countNonTerminal 上限）；集成测试逐条对应 | COVERED |
| AC-2.6 | 「maxOpen 读 WORKITEMS_MAX_OPEN（默认 3），改配置重启生效」+ countNonTerminal 终态不计数——实现要点全；「上限可配置（改 4 重启后第 5 个才拒）」分支**测试要点缺** | 部分 COVERED |
| AC-2.7 | #4 生命周期合法转移集 + #2 rollup；测试明示委托 S6 端到端 + 此处验投影面 | COVERED |
| AC-2.8~2.10 | computeRollup 纯函数（优先级 + 终态冻结）；单元全矩阵 + 场景表三条 Edge | COVERED |
| AC-2.11 | #3 phase 承诺（无单调校验 + phase_changed {from,to,reason}）；集成回退转移用例 | COVERED |
| AC-2.12 | #3（原样存查 + 静态断言「phase 只读写不比较」）；集成逐字节回读用例——静态断言落点见问题 #2 | COVERED（带跨模块不一致） |
| AC-2.13 | types.ts WorkType 九成员全签名 + registry 重复注册 throw；单元测试 + tsc 编译期 | COVERED |
| FLOW-2.1/2.2 | S6 委托 + 集成「上限拒绝→收尾→再建」 | COVERED |

## 问题清单

| # | 严重度 | 类型 | 描述 | 涉及位置 | 建议 |
|---|--------|------|------|---------|------|
| 1 | YELLOW | 遗漏 | AC-2.6 的「上限可配置」分支无测试要点：测试策略仅覆盖「终态不计数/收尾释放名额」，未断言「配置改 4 重启后 4 个非终态共存、第 5 个才被拒」 | S2 §测试策略 | 补一条集成用例：以 WORKITEMS_MAX_OPEN=4 装配容器，断言第 5 个创建才抛 OpenLimitError |
| 2 | YELLOW | 矛盾 | AC-2.12 的「静态可审查」承诺依赖 tests/architecture.test.ts 对 src/workitems/ 增加「phase 只读写不比较」断言，但 S6 设计节 §5 给出的 architecture.test.ts 规则清单（4 条：三条 import 规则 + kernel 业务词汇扫描）不含此断言——该断言的实现归属悬空 | S2 §内部结构 #3 ↔ S6 §内部结构 #5 | 在 S6 architecture.test.ts 规则清单补第 (5) 条「src/workitems/ 内 phase 标识符仅出现于赋值/读取，不出现于比较/switch」，或将 S2 的此断言改挂到 S2 自己的测试文件 |

## 总结

- 检查项: 4/6 通过（②契约——WorkType/Transition/CreateInput/CreateResult/错误类型完整，CreateInput.repos、AssignmentSpec.repo 经 S1 repos_json/repo 列核对有来源；③漂移——injectEvent/bootstrapApply 为机制非新需求，无漂移；⑤模式合规——onEvent 纯函数、initRepo post-commit 事务外、投影不读 status 列结构性满足 AC-2.9，全过；⑥Gap 兑现 G-2.1~2.6 全部落地；①AC 覆盖与④测试策略各扣一项）
- RED: 0 | YELLOW: 2
- **结论**: PASS（2 条 YELLOW 建议 Step 3 前补齐）
