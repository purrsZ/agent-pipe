# Evaluation — workitems-m0（Step 0 轨道判定报告）

> 依据：docs/design/2026-06-11-workitem-macro-design.md（v4，下称「设计文档」）；代码实勘 src/（~4400 行 TS）

## 需求摘要

按设计文档 §11 落地 M0 里程碑：在现有 kernel（飞书桥）之上新建 **workitems 容器层**——独立 workitems.sqlite 中的 workitem_* 五表、每 workitem 单线程 reducer（纯转移 + 效果声明）、transactional outbox（效果与状态转移同事务落库、崩溃恢复按效果类型分策略）、外层 status rollup 投影、显式等待对象与按 kind 区分的到期动作、watchdog 活性监督（心跳 + 墙钟硬上限）、每工作项独立 git 仓 artifact 布局；并实现 **noop 退化工作类型**打穿并发 / outbox 恢复 / 监督全部路径，同时验证 kernel 现有 PID 锁在容器场景下的单实例正确性（验证，非重写）。M0 无任何飞书交互与真实工作类型。

## 涉及模块

| 模块 | 性质 | 说明 |
|---|---|---|
| `src/workitems/`（新增） | 全新模块 | 容器层：schema/store（独立 DB + 独立 migration）、reducer 运行时（每 item 串行）、effects outbox 执行器与崩溃恢复、waits 与到期动作、watchdog、status rollup、artifact git 仓管理、WorkType 注册表 |
| `src/worktypes/noop/`（新增） | 全新模块 | 实现 §4.5 WorkType 接口的退化类型：可控延时 + 可注入失败，不经 AgentPool |
| `src/index.ts` | 触点修改 | 装配容器运行时、启动时恢复（outbox 重建在途效果）、接入优雅关闭/crash guard |
| `src/config.ts` | 触点修改 | 新增 workitems.sqlite 路径与 `$DATA_DIR/workitems/` 目录配置 |
| `src/lifecycle.ts` | 只测不改 | PID 锁单实例验证（真实双进程测试），6329d35 修复后的回归锁定 |
| `tests/` | 新增 | 容器测试套件：并发、同事务 outbox、kill 崩溃恢复、watchdog/到期（假时钟） |

不触碰：`src/feishu/*`、`src/bridge/commands.ts`、`src/agents/*`（noop 不跑真 agent；流式心跳多路复用给监督者推迟到接真 runner 的 M1b+）。架构硬规则：依赖单向 worktypes → workitems → kernel，kernel 不出现 workitem 概念——M0 对 kernel 的改动仅限 index.ts 装配与 config 路径，均为通用装配而非业务概念。

## 轨道判定：**DDD**

理由（决策矩阵：新模块 + 复杂业务逻辑 → DDD）：
- 新模块：workitems 容器层与 noop 类型均为从零新建，估算 10~15 个新文件 + 2 个触点修改，>1 Phase（schema/store → reducer/outbox → waits/watchdog → noop 打穿 + PID 验证），远超 Lite/直接执行门槛
- 复杂业务逻辑：双层状态机、单 reducer 串行语义、transactional outbox 与按类型恢复策略、rollup 投影优先级、按 kind 到期动作、活性监督——皆是有不变量约束的领域逻辑

**Step 0.5（领域建模）建议由设计文档替代，裁剪为「确认 + 映射」**：设计文档 §4 已是完成度极高的领域模型——实体与聚合（workitem / assignment / wait / effect / event，§4.2 schema）、状态机与不变量（§4.1 外层投影、§4.4「没有无人过问的等待」）、一致性边界（§4.3 单实例 + 单 reducer + 同事务 outbox）、通用语言与决策台账（§12）、兼容性压力测试（§4.6）。重做一轮领域建模是负价值的重复劳动。建议 Step 0.5 不独立执行，改为在 Step 1-2 的 spec/ 中落一页「领域模型映射」：设计文档概念 → TS 类型/模块文件的对应表 + 容器运行时组件交互图 + 设计文档未细化处的补缺（如 effect 执行器的并发度、reducer 队列的进程内实现形态），引用 §4 而非复述。

## UI 涉及判定：**否（无前端节点）**

M0 明确不含飞书交互（锚点卡片、checkpoint 卡片是 M1b/M2），无任何页面/卡片/组件变更；工作项创建在 M0 仅有编程 API（由测试驱动），纯后端容器层 + 测试。

## Verify-Env 判定：**web**（按规则归类；实际为进程级集成测试，无浏览器）

- 按 prompt 规则「纯后端 API / CLI 工具 → web（复用 Dev Server 协议做集成测试）」归类为 web；本项目是无 UI 的常驻 Node 服务（tsx 单进程 + 飞书 WS 长连接），无浏览器入口，Playwright 无用武之地
- **E2E 实际形态建议**：以 noop 类型驱动容器的 vitest 进程级集成测试替代浏览器 E2E——
  - 真 SQLite 文件 + 真 git 仓（临时目录），不 mock 存储层，验证同事务 outbox 与 artifact 布局
  - 崩溃恢复：子进程跑容器 → 在效果 pending/running 窗口 SIGKILL → 重启进程断言恢复策略
  - watchdog/到期路径：注入 clock（或 vitest fake timers）压缩心跳超时、墙钟上限、wait deadline
  - PID 锁验证：spawn 真实双进程竞争锁文件，断言单实例与退出时「只删自己的锁」（6329d35 语义）

## MVP 排除项

| # | 设计文档引用 | 功能描述 | 排除理由 |
|---|---|---|---|
| EX-1 | §11 M1a / §9.2 | thread 认领路由与认领注册表 | M1a kernel 能力 |
| EX-2 | §11 M1a / §3.2 | per-run MCP/工具注入 | M1a kernel 能力 |
| EX-3 | §11 M1a | 运行最小排队；只读权限档（Codex sandbox） | M1a；noop 不跑真 agent，无权限面 |
| EX-4 | §11 M1b / §7 | knowledge 层（repo 知识 + _system） | M1b |
| EX-5 | §11 M1b / §8 | integrations 适配器（日志/Sentry）与凭证 deny | M1b |
| EX-6 | §11 M1b / §9 | investigation 类型、`/status`、锚点卡片、与桥任务共存路由 | M1b；M0 无飞书入口 |
| EX-7 | §11 M2 / §6.1 | checkpoint 机制与交互卡片回调、写权限档、分支检出、bugfix 类型 | M2 |
| EX-8 | §11 M3 / §5.3 §6.3-6.5 | requirement 类型、Owner/Worker 拓扑实战、契约 artifact 与变更流程、isDecisionStale 实战、集成验证修复循环、`/cancel` 收尾、调度优先级 + 预留槽 + worktree | M3（M0 仅定义 WorkType 接口全签名，noop 给退化实现） |
| EX-9 | §11 M4 / §4.7 | 沉淀回写、知识保鲜、cron 触发器、Sentry 触发器 | M4 |
| EX-10 | §4.7 / §12 | 衍生关系编排、多租户、工作项依赖编排 | 明确不覆盖（source_json 仅留溯源字段） |

## 目录结构确认

```
docs/ai-specs/workitems-m0/
├── evaluation.md        ✅ 本文件
├── spec/                ✅ 已创建（Step 1-2 产出）
└── tasks/               ✅ 已创建（Step 3 产出）
```

## 待确认

1. **backup 扩展是否进 M0**：设计 §10 要求备份覆盖 workitems.sqlite 与 workitems/ git 仓，但 §11 M0 行与本次交付 10 项均未列。建议进 M0（backup.ts 已有完整框架，增量小且关乎数据安全），请编排者裁决
2. **§4.3 规则 2/3 的容器机制是否全量进 M0**：交付清单仅明确规则 1（纯转移）与规则 4（outbox）；但 §4.3 整节标题为「M0 实现约束」，schema 已含 based_on_seq，且 noop 要求「打穿并发路径」。建议全量进 M0：单飞 + 事件批量带入、based_on_seq 结构检查、防颠簸计数（语义钩子 isDecisionStale 仅接口 + noop 恒 false 退化实现）
3. **open 工作项上限 ≤3 enforce（§9.1）**：标注「M3 前」，未明确归属里程碑。建议 M0 在容器创建 API 顺手 enforce（一行代码，P3 原则），测试同时覆盖
4. **M0 工作项创建入口形态**：无飞书命令的前提下，确认仅暴露容器编程 API（供测试与后续里程碑调用），不新增任何 CLI/命令——默认按此理解执行
