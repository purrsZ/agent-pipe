# 模块设计校验 -- 校验报告

> Step 2.2a | Feature: workitems-m0 | 模式: module (S1, AC-1.1~1.14) | 2026-06-12

## 校验范围

| 类别 | 文件 |
|------|------|
| 被检产出 | docs/ai-specs/workitems-m0/spec/S1-storage-foundation.md（§设计 对照 §需求） |
| 对照来源 | docs/ai-specs/workitems-m0/spec/overview.md（ADR 决策表 G-1.1~G-1.7） |

## AC 覆盖

| AC | 设计覆盖位置 | 状态 |
|----|------------|------|
| AC-1.1 | WorkitemsStore 构造（mkdir+open+WAL+FK+migrate）+「kernel db.sqlite 不被触碰」；测试经 FLOW-1.1 | COVERED |
| AC-1.2 | migration 形态段（PRAGMA user_version）；测试「migration 幂等重入」 | COVERED |
| AC-1.3~1.7 | DDL（五表全字段 + CHECK/FK/UNIQUE）；测试「五表约束逐条触发」 | COVERED |
| AC-1.8 | events trigger + store 仅 append/查询 API；测试 trigger 拒绝 UPDATE/DELETE | COVERED |
| AC-1.9/1.10 | initRepo / writeFile 一写一提交；测试 git log=1 / log=3 | COVERED |
| AC-1.11 | 「DB 各表只存 *_path 相对路径，正文永不入库」——实现要点有，**测试要点缺** | 部分 COVERED |
| AC-1.12~1.14 | 备份扩展节 + 前缀分流；测试副本无 -wal 残留 / 失败隔离双向 | COVERED |
| FLOW-1.1 | 测试策略末条四面互查 | COVERED |

## 问题清单

| # | 严重度 | 类型 | 描述 | 涉及位置 | 建议 |
|---|--------|------|------|---------|------|
| 1 | YELLOW | 遗漏 | AC-1.11 无对应测试要点：单元/集成清单与场景表均未断言「写入 artifact 后 workitem_* 各表字段不含正文」；FLOW-1.1 验证点只做 DB 行/git 目录互查，覆盖不到「正文不入库」断言 | S1 §测试策略 | 补一条集成断言：writeFile 写入 brief/report 后扫描五表相关行，断言仅出现 *_path 相对路径、无文件正文内容 |

## 总结

- 检查项: 5/6 通过（①AC 覆盖部分通过；②契约 ③漂移 ④测试形态 ⑤模式合规 ⑥Gap 兑现 G-1.1~1.7 全部通过；DDL 新增列 status_detail/wake_pending/discard_streak/reminded_at 等均有 overview ADR 来源支撑，非漂移）
- RED: 0 | YELLOW: 1
- **结论**: PASS（YELLOW 建议在 Step 3 前补齐）
