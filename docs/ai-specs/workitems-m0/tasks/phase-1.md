# Phase 1: 存储与数据基座

> 输入：spec/overview.md、S1-storage-foundation.md、S6-noop-verification.md 的 AC-6.12 架构守护要求。
> 目标：先立类型、独立 DB、artifact git 仓、备份扩展与架构红线，为后续 reducer/effects/watchdog 提供稳定地基。
> 统一验证：每个 Task 完成后运行 `npm run typecheck && npm run lint && npm test`；涉及备份的 Task 还需单跑 `npm test -- tests/backup.test.ts`。

## Task T1: 域类型、Clock 与容器配置骨架

**AC**：AC-2.13 签名面、AC-6.12 的类型边界前置  
**依赖**：无  
**文件**：
- Create: `src/workitems/types.ts`
- Create: `src/workitems/clock.ts`
- Create: `src/workitems/config.ts`
- Test: `tests/workitems/types.test.ts`

**RED**
- 新增类型编译测试：构造一个缺少 `checkpoints` 的 WorkType fixture，预期 `tsc` 报错。
- 新增配置测试：默认 `WORKITEMS_MAX_OPEN=3`、`defaultDeadlineTtlSec=3600`、`defaultWallclockCapSec=1800`、`humanWaitTtlSec=86400`。

**GREEN**
- 在 `types.ts` 定义 WorkItem/Assignment/Wait/Effect/WorkItemEvent/Transition/Decision/CreateInput/CreateResult/WorkType/Clock 等公共契约。
- 在 `clock.ts` 提供 `SystemClock`；测试 FakeClock 放在测试 helper 内，不进生产代码。
- 在 `config.ts` 解析 WORKITEMS_* 调参，非正数配置抛明确错误。

**完成判据**
- `npm run typecheck` 能证明 WorkType 九成员是编译期契约。
- 后续模块只 import `src/workitems/types.ts`，不从 reducer/api 互相借类型。

## Task T2: WorkitemsStore migration v1 与五表基础 API

**AC**：AC-1.1~1.8  
**依赖**：T1  
**文件**：
- Create: `src/workitems/store.ts`
- Test: `tests/workitems/store.test.ts`

**RED**
- 测试打开不存在的 `workitems.sqlite` 后应创建五表、启用 WAL、`PRAGMA foreign_keys=ON`、`PRAGMA user_version=1`。
- 测试 UNIQUE(type,dedupe_key)：同键失败，NULL dedupe 可多条。
- 测试 waits origin 外键、assignments replaces 外键、events UNIQUE(workitem_id,seq)。
- 测试 events UPDATE/DELETE 触发器拒绝旁路修改。

**GREEN**
- 用 better-sqlite3 同步打开 DB，migration 独立于 kernel store。
- DDL 按 S1 设计落 `workitems`、`workitem_assignments`、`workitem_waits`、`workitem_effects`、`workitem_events`。
- 提供 tx、insert/get/list/update、appendEvent/nextSeq/eventsSince/listEvents、backup、close。
- `updateWait` 写面收窄为 resolved/renew/reminded 字段集合。

**完成判据**
- store 测试不依赖 reducer/effects。
- DB 不创建或读取 kernel migration 表。

## Task T3: ArtifactStore 每工作项 git 仓

**AC**：AC-1.9~1.11  
**依赖**：T1  
**文件**：
- Create: `src/workitems/artifacts.ts`
- Test: `tests/workitems/artifacts.test.ts`

**RED**
- 测试 `initRepo('wi-1')` 后目录是独立 git repo，含 repo-local `user.name/user.email` 与初始空提交。
- 测试连续两次 `writeFile` 产生两次提交，提交信息含 workitem/relPath 标识。
- 测试正文只存在 git 仓文件中，DB 测试通过路径引用间接覆盖。
- 测试 `reconcile`：净工作区返回 noop；脏工作区提交后返回 committed；缺仓重建后返回 recreated。

**GREEN**
- 使用 `execFileSync('git', ...)`，所有 git 命令 cwd 固定到工作项仓。
- 仓内路径拒绝 `..` 与绝对路径，避免写出 artifact 根目录。
- `writeFile` 执行写文件、`git add -A`、`git commit`；空内容提交被测试覆盖为失败。

**完成判据**
- git 全路径在临时目录可重复跑。
- `isClean()` 可作为 S4 对账断言。

## Task T4: kernel backup 前缀参数化与 extraJobs 钩子

**AC**：AC-1.14，AC-1.12 的命名分流支撑  
**依赖**：无  
**文件**：
- Modify: `src/backup.ts`
- Test: `tests/backup.test.ts`

**RED**
- 补测试：`db-*.sqlite`、`workitems-*.sqlite`、`workitems-files-*.tar.gz` 混放时，各自按 prefix/ext 修剪，互不误删。
- 补测试：一个 extraJob 抛错时 kernel DB 备份仍成功，错误被 logger 记录。

**GREEN**
- 将备份命名/修剪函数改成 prefix/ext 参数化。
- `scheduleDailyBackup` 增 `extraJobs?: BackupJob[]`，每个 job 独立 try/catch。
- 既有 kernel 调用传 prefix=`db`，保持原行为。

**完成判据**
- 既有 backup 测试全部绿。
- `src/backup.ts` 不出现 workitem 业务语义，只暴露通用 BackupJob。

## Task T5: workitems backup job

**AC**：AC-1.12~1.14  
**依赖**：T2、T3、T4  
**文件**：
- Create: `src/workitems/backup.ts`
- Test: `tests/workitems/backup.test.ts`

**RED**
- 测试 job 执行后生成 `workitems-<ts>.sqlite`，副本可独立打开并查询工作项。
- 测试生成 `workitems-files-<ts>.tar.gz`，解包后含 `.git` 历史。
- 测试 DB 备份失败与 tar 失败分别被捕获，不影响另一个 job 的可观测日志。

**GREEN**
- `createWorkitemsBackupJob` 调用 store.backup 生成 SQLite 副本。
- 使用系统 `tar -czf` 打包 artifacts 根目录，产物命名按 S1 ADR。
- 复用 T4 的 prefix 修剪策略。

**完成判据**
- 备份产物不含 `-wal/-shm`。
- workitems 文件备份恢复后 git log 可读。

## Task T6: 架构守护测试提前落地

**AC**：AC-6.12  
**依赖**：T1  
**文件**：
- Create: `tests/architecture.test.ts`

**RED**
- 测试扫描 `src/**/*.ts` imports：kernel 文件禁止 import `src/workitems`/`src/worktypes`，豁免 `src/index.ts` 和 `src/config.ts`。
- 测试 `src/workitems/**` 禁止 import `src/worktypes/**`。
- 测试 kernel 源码业务词扫描，豁免 `index.ts/config.ts`。
- 测试 phase 不出现在比较表达式或 switch 判别中。

**GREEN**
- 用 Node `fs/path` 自写扫描器，不引新依赖。
- import 解析支持相对路径与 `.ts` 省略后缀。
- 错误输出列出违规文件与 import 行，方便执行期修复。

**完成判据**
- 架构测试当前即纳入 `npm test`。
- 后续 Task 若破坏依赖方向会立刻红。

## Task T7: 存储全链路集成

**AC**：FLOW-1.1  
**依赖**：T2、T3、T5  
**文件**：
- Test: `tests/workitems/storage-flow.test.ts`

**RED**
- 测试初始化 store/artifacts → 插入 workitem → initRepo → 写 brief.md → append event → 执行 backup job。
- 断言 DB id 与 repo 目录互查、event seq 升序、备份副本可查同一行、tar 解包后 git history 保留。

**GREEN**
- 只补必要测试 helper，不添加生产逻辑。
- 若前置 Task API 不顺手，只允许在对应源文件做小幅签名修正并回补测试。

**完成判据**
- Phase 1 完成后，`src/workitems/` 已具备可被 Phase 2~6 复用的存储、artifact、backup 与架构护栏。

