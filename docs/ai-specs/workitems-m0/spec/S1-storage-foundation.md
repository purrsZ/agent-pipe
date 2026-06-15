# S1: 存储与数据基座

> Scope: workitems 容器层的持久化地基——独立 workitems.sqlite 五表 schema、每工作项独立 git 仓布局、backup 扩展
> AC: AC-1.1~1.14

---

## 需求（Step 1 产出）

### 概述

本组定义容器层全部存储面：独立 `workitems.sqlite`（与 kernel `db.sqlite` 分离，独立 migration 体系）中的 workitem_* 五表 schema 与约束（UNIQUE 幂等键、waits 溯源外键、事件 append-only + seq）；`$DATA_DIR/workitems/<id>/` 每工作项独立 git 仓布局与「每次写 artifact 提交一次」；以及 kernel backup 扩展纳入 workitems.sqlite 与 workitems/ 目录。**边界**：表结构归本组，行为语义归各组——rollup 计算（G2）、reducer/seq 分配（G3）、效果执行与崩溃恢复及事件↔artifact 对账（G4）、到期动作（G5）均不在此定义；§10 提及的 knowledge/ 备份属 M1b（EX-4），M0 不做。

### AC 列表

### AC-1.1: 独立 workitems.sqlite 初始化与配置触点

**GIVEN** config 提供 workitems DB 路径（默认 `$DATA_DIR/workitems.sqlite`）与 artifact 根目录（默认 `$DATA_DIR/workitems/`），且 DB 文件不存在
**WHEN** 容器存储层初始化
**THEN** 创建独立 workitems.sqlite（不与 kernel db.sqlite 共文件），连接启用 WAL 与 `foreign_keys=ON`，五张 workitem_* 表全部建出；kernel 库的 schema 与 migration 记录不受任何影响

### AC-1.2: 独立 migration 体系

**GIVEN** 磁盘上存在旧 schema 版本的 workitems.sqlite
**WHEN** 存储层初始化
**THEN** 仅按 workitems 自身的 migration 序列升级到最新版本，版本记录存于 workitems.sqlite 内部，与 kernel 库的 migration 互不读写、互不感知

### AC-1.3: workitems 主表 schema

**GIVEN** migration 完成
**WHEN** 检视 workitems 表（表名即 workitems，非 workitem_items）
**THEN** 含 §4.2 全部字段：id、type、title、status、phase、source_json、dedupe_key、repos_json、context_json、created_at、updated_at；phase 为不透明字符串，存储层不校验其取值

### AC-1.4: UNIQUE(type, dedupe_key) 幂等约束

**GIVEN** 已存在 (type='noop', dedupe_key='K1') 的工作项行
**WHEN** 插入相同 (type, dedupe_key) 的第二行
**THEN** 写入因唯一约束失败，上层可捕获识别为幂等冲突；dedupe_key 为 NULL 的行不受此约束（允许多条无幂等键的内部创建）

### AC-1.5: workitem_assignments 表 schema 与 replaces 链

**GIVEN** migration 完成
**WHEN** 检视 workitem_assignments 表
**THEN** 含 §4.2 全部字段：id、workitem_id、parent_id、repo、role（owner|worker|solo）、status、agent_session_id、replaces_assignment_id、deadline_at、wallclock_cap_sec、retries、based_on_seq、brief_path、report_path；replaces_assignment_id 可引用既有 assignment 行形成可导航重派链；概念命名全程 assignment，schema 与代码不出现第二个 task 概念（§3.3）

### AC-1.6: workitem_waits 表与 origin_assignment_id 溯源外键

**GIVEN** migration 完成且某 assignment 行存在
**WHEN** 写入 wait 行：kind ∈ {human, agent, timer}，origin_assignment_id 填该 assignment 的 id
**THEN** 写入成功且可经外键导航回源头 assignment；origin_assignment_id 引用不存在的 id 时写入被外键约束拒绝；该字段可为 NULL（非 stalled 升级来源的 wait）；表含 reason、deadline_at、renewed_count、resolved_at 字段

### AC-1.7: workitem_effects 表 schema

**GIVEN** migration 完成
**WHEN** 检视 workitem_effects 表
**THEN** 含 §4.2 全部字段：id、workitem_id、seq（标记由哪次转移声明）、kind、payload_json、status（取值限定 pending|running|done|aborted）、created_at、updated_at；「与状态转移同事务写入」及恢复策略的行为归 G4，本组仅保证表结构可承载

### AC-1.8: workitem_events append-only 与 seq 存储面

**GIVEN** 某 workitem 已写入若干事件行
**WHEN** 经存储层操作事件表
**THEN** store API 仅暴露追加与查询，不存在更新/删除事件的接口；同一 workitem_id 下 seq 以 UNIQUE(workitem_id, seq) 约束兜底唯一（单调分配行为归 G3）；按 seq 升序查询可重现完整审计序列（状态权威 + 事件作审计，非事件溯源）

### AC-1.9: 每工作项独立 git 仓初始化

**GIVEN** 新建工作项 id=W1
**WHEN** 存储层为其创建 artifact 仓
**THEN** `$DATA_DIR/workitems/W1/` 成为独立 git 仓（每项一仓，非全局单仓，免 index.lock 争抢；整目录移走即归档）；布局按约定解析 brief.md、journal.md、decisions.md、assignments/<assignment_id>/、report.md（contract/ 为 requirement 专用，M0 不预建）

### AC-1.10: 每次写 artifact 提交一次

**GIVEN** W1 的 git 仓已初始化
**WHEN** 经存储层 API 连续两次写入/更新 artifact 文件（如 brief.md）
**THEN** git log 出现恰好两个对应提交（每写一提交，不合并、不遗漏），提交信息含可追溯标识；文件历史版本可经 git 取回

### AC-1.11: DB 只存索引与状态，内容在文件系统

**GIVEN** assignment 的任务卡与报告已写入 git 仓
**WHEN** 检视 workitems.sqlite 各表
**THEN** 仅存 brief_path / report_path 等路径引用与状态字段，artifact 正文不出现在任何 workitem_* 表字段中

### AC-1.12: backup 扩展覆盖 workitems.sqlite

**GIVEN** backup 调度触发（启动补备或每日定时，沿用现有 scheduleDailyBackup 节奏）
**WHEN** 备份执行
**THEN** 备份目录新增 workitems.sqlite 副本，副本已做 WAL checkpoint 折叠、无 -wal/-shm 残留（单文件即完整恢复物）；副本按保留策略修剪，且与 kernel db 副本互不误删

### AC-1.13: backup 扩展覆盖 workitems/ 目录

**GIVEN** `$DATA_DIR/workitems/` 下存在至少一个工作项 git 仓
**WHEN** 备份执行
**THEN** workitems/ 目录内容（含 .git 历史）被纳入备份产物，可据以完整恢复 artifact 仓；产物同样受保留/修剪策略约束

### AC-1.14: backup 失败隔离

**GIVEN** workitems 侧备份将失败（如目录不可读或 DB 文件异常）
**WHEN** 备份任务执行
**THEN** 错误仅记日志、不抛出、进程不退出；kernel db 备份照常完成（双库备份互不连坐，沿用 backup.ts「备份失败不得拖垮进程」语义）

### Flow AC

### FLOW-1.1: 工作项存储全链路（建项 → 写产物 → 记事件 → 备份）

- **路径**: 初始化存储层 → 插入 workitems 行 → 初始化 W1 git 仓 → 写 brief.md（一次提交）→ 追加事件 → 触发备份
- **涉及 AC**: AC-1.1 -> AC-1.3 -> AC-1.9 -> AC-1.10 -> AC-1.8 -> AC-1.12 -> AC-1.13
- **验证点**: DB 行 id 与 git 仓目录名一致可互查；事件按 seq 可回放审计序列；备份副本可独立打开并查到该工作项行与 artifact 历史
- **跨组**: 无（纯存储面，不经 reducer/效果执行）

### Gaps

- [WHITE] G-1.1: §4.2 是宏观 schema，列类型/NOT NULL/默认值/索引，以及 workitem_id、parent_id、replaces_assignment_id 等其余引用列是否声明 FK 未定 — 候选：时间戳用 TEXT(ISO8601) 对齐 kernel store 习惯，引用列全部声明 FK 并依赖 foreign_keys=ON，Step 2 落定
- [WHITE] G-1.2: workitems/ 备份形态 §10 给了两个候选「git 仓直接打包或远端推送」 — 候选：M0 先 tar 打包入 backups 目录（零外部依赖），远端推送留作后续增量
- [WHITE] G-1.3: 事件表 append-only 的 enforce 强度 — store API 不暴露更新/删除是底线，是否再加 SQLite trigger 在 DB 层硬拒绝待选型 — 候选：加 trigger，防未来旁路误用
- [WHITE] G-1.4: git 仓初始化形态 — 是否预建占位文件、是否打初始空提交、commit 作者身份（服务器无全局 user.name/email 时 git commit 直接失败）— 候选：repo-local config 写死容器身份
- [YELLOW] G-1.5: workitems.sqlite 备份命名与 backup.ts 现有 `BACKUP_NAME_RE`（`^db-….sqlite$`）耦合 — 同目录混放则新副本要么不被修剪（无限堆积）要么被误删，需新命名前缀且修剪按前缀分流，Step 2 设计解决
- [YELLOW] G-1.6: 「写文件成功但 commit 失败/进程崩溃」会留下未提交脏区 — §10 的事件↔artifact 对账恢复归 G4，但存储层需先定义「写+提交」失败窗口的约定（如幂等补提交接口），否则 G4 无抓手
- [YELLOW] G-1.7: assignments/<id>/ 目录内文件命名 PRD 未给（仅「任务卡 + 报告」），brief_path/report_path 取值需与布局约定一致 — 候选：assignments/<id>/brief.md 与 report.md，Step 2 定稿

### UI 需求

无（has_ui=否，纯后端存储层）。

### PRD 覆盖对照（自检，正式校验在 Step 1.5）

| PRD 锚点 | 要点 | 覆盖 AC |
|---|---|---|
| §4.2 开篇 / §12 存储布局行 | 独立 DB 文件 + 独立 migration，两套 migration 不共管一文件 | AC-1.1, AC-1.2 |
| §4.2 五表定义 | workitems / assignments / waits / effects / events 字段 | AC-1.3, AC-1.5~1.8 |
| §4.2 dedupe_key / §12 周期性工作行 | UNIQUE(type, dedupe_key) 外部触发幂等 | AC-1.4 |
| §4.2 waits / v4 修订记录 | origin_assignment_id 溯源外键 | AC-1.6 |
| §4.2 事件表注释 | append-only；状态权威 + 事件作审计 | AC-1.8 |
| §4.2 artifact 段 / §12 | 每项独立 git 仓、目录布局、每写一提交、DB 只存索引 | AC-1.9~1.11 |
| §10 备份行 | 扩展纳入 workitems.sqlite 与 workitems/（knowledge/ 属 M1b 排除） | AC-1.12~1.14 |
| §3.3 反模式 | 不出现第二个 task 概念（assignment 命名）；「2099 撒谎」条款的不变量归 G5，本组仅承载 deadline_at 字段 | AC-1.5（边界声明） |

---

## 设计（Step 2 追加）

### 对外接口

```ts
// src/workitems/store.ts —— 容器层唯一 DB 入口（独立 workitems.sqlite）
export class WorkitemsStore {
  constructor(dbPath: string, clock: Clock);          // mkdir + open + WAL + FK + migrate (→ AC-1.1, AC-1.2)
  tx<T>(fn: () => T): T;                              // better-sqlite3 同步事务包装（reducer 提交用）
  // workitems
  insertWorkItem(row: WorkItemRow): void;             // UNIQUE(type,dedupe_key) 冲突抛 SQLITE_CONSTRAINT (→ AC-1.4)
  getWorkItem(id: string): WorkItemRow | undefined;
  findByDedupe(type: string, key: string): WorkItemRow | undefined;
  countNonTerminal(): number;
  listNonTerminal(): WorkItemRow[];
  updateWorkItem(id: string, patch: Partial<WorkItemRow>): void;   // status/phase/wake_pending/discard_streak…
  // assignments / waits（行为语义归 G2/G5，这里只是行读写）
  insertAssignment(row: AssignmentRow): void;
  updateAssignment(id: string, patch: Partial<AssignmentRow>): void;
  getAssignment(id: string): AssignmentRow | undefined;            // 单行读取（S3 结构检查 / S4 恢复 / S5 stalled 处置用）
  listAssignments(workitemId: string): AssignmentRow[];
  listRunningAssignments(): AssignmentRow[];
  insertWait(row: WaitRow): void;
  updateWait(id: string, patch: Partial<Pick<WaitRow,              // 可写面收窄（I-018）：仅 wait 生命周期字段
    'resolvedAt' | 'resolvedBy' | 'resolveReason' | 'renewedCount' | 'deadlineAt' | 'remindedAt'>>): void;
                                                                   // deadlineAt 仅 renewWait 的 apply 路径可写——
                                                                   // 续期是唯一改期入口（→ S5 AC-5.4）
  getWait(id: string): WaitRow | undefined;                        // 单行读取（S3 结构检查 / S5 resolveWait/renewWait 用）
  listOpenWaits(workitemId?: string): WaitRow[];
  // effects
  insertEffect(row: Omit<EffectRow, 'id'>): number;
  setEffectStatus(id: number, status: EffectStatus): void;
  getEffect(id: number): EffectRow | undefined;                    // 单行读取（S3 结论前置检查用，→ S3 ADR-7）
  listInflightEffects(workitemId?: string): EffectRow[];           // pending|running, ORDER BY seq, id
  lastRunEffectSeqBefore(workitemId: string, effectId: number, runKinds: string[]): number;
                                                                   // id < effectId 的最近一条运行类效果的 seq，无则 0
                                                                   // —— 批量窗口起点（→ S3 AC-3.7, ADR-6）
  // events —— 仅追加与查询，无 update/delete API (→ AC-1.8)
  appendEvent(workitemId: string, seq: number, kind: string, payload?: unknown): number;
  nextSeq(workitemId: string): number;                             // MAX(seq)+1（事务内调用）
  eventsSince(workitemId: string, afterSeq: number, beforeSeq?: number): EventRow[];  // (after, before) 开区间
  listEvents(workitemId: string): EventRow[];                      // seq 升序，审计回放 (→ AC-1.8)
  backup(destPath: string): Promise<void>;                         // better-sqlite3 online backup
  close(): void;
}

// src/workitems/artifacts.ts —— 每工作项独立 git 仓
export class ArtifactStore {
  constructor(rootDir: string, logger: Logger);       // rootDir = $DATA_DIR/workitems/
  repoPath(workitemId: string): string;
  initRepo(workitemId: string): void;                 // git init + repo-local 身份 + 初始空提交 (→ AC-1.9, G-1.4)
  writeFile(workitemId: string, relPath: string, content: string, message: string): void;
                                                      // 写文件 → add -A → commit，一写一提交 (→ AC-1.10)
  readFile(workitemId: string, relPath: string): string | undefined;
  isClean(workitemId: string): boolean;               // git status --porcelain 为空
  reconcile(workitemId: string, label: string): 'noop'|'committed'|'recreated';  // 幂等对账 (→ G-1.6)
}

// src/workitems/backup.ts —— 挂入 kernel scheduleDailyBackup 的 extraJobs
export function createWorkitemsBackupJob(deps: {
  store: WorkitemsStore; artifactsDir: string; backupsDir: string; logger: Logger;
}): BackupJob;   // BackupJob = { label: string; run(now: Date): Promise<void> }（kernel backup.ts 通用类型）
```

git 操作统一 `execFileSync('git', [...], { cwd })`（同步、零依赖；调用点全部在效果执行器/恢复路径，永不在 reducer 事务内）。

### 内部结构

#### 1. DDL（migration v1，PRAGMA user_version 管版本 — AC-1.2, G-1.1）

```sql
CREATE TABLE workitems (
  id             TEXT PRIMARY KEY,                   -- 'wi-' + randomUUID
  type           TEXT NOT NULL,
  title          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','active','waiting','done','failed','cancelled')),
  status_detail  TEXT CHECK (status_detail IN ('human','agent','timer')),   -- (→ G-2.5)
  phase          TEXT NOT NULL,                      -- 不透明字符串，无任何取值校验 (→ AC-1.3)
  source_json    TEXT NOT NULL,
  dedupe_key     TEXT,
  repos_json     TEXT,
  context_json   TEXT,                               -- noop 参数（delayMs/failAt/…）存于此
  wake_pending   INTEGER NOT NULL DEFAULT 0,         -- 单飞合并标记 (→ G-3.1)
  discard_streak INTEGER NOT NULL DEFAULT 0,         -- 防颠簸计数 (→ G-3.2)
  created_at     INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(type, dedupe_key)                           -- SQLite NULL 互异，NULL 行不受限 (→ AC-1.4)
);
CREATE INDEX idx_workitems_status ON workitems(status);

CREATE TABLE workitem_assignments (                  -- (→ AC-1.5；全程 assignment，无 task)
  id TEXT PRIMARY KEY,                               -- 'as-' + randomUUID
  workitem_id TEXT NOT NULL REFERENCES workitems(id),
  parent_id   TEXT REFERENCES workitem_assignments(id),
  repo TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner','worker','solo')),
  status TEXT NOT NULL CHECK (status IN ('running','done','failed','superseded','cancelled')),  -- (→ G-5.1)
  agent_session_id TEXT,
  replaces_assignment_id TEXT REFERENCES workitem_assignments(id),   -- 重派链 (→ AC-1.5)
  deadline_at INTEGER NOT NULL, wallclock_cap_sec INTEGER NOT NULL,
  retries INTEGER NOT NULL DEFAULT 0,
  based_on_seq INTEGER NOT NULL,
  brief_path TEXT, report_path TEXT,                 -- 仓内相对路径 (→ AC-1.11, G-1.7)
  created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER
);
CREATE INDEX idx_assignments_item ON workitem_assignments(workitem_id, status);

CREATE TABLE workitem_waits (
  id TEXT PRIMARY KEY,                               -- 'wt-' + randomUUID
  workitem_id TEXT NOT NULL REFERENCES workitems(id),
  kind TEXT NOT NULL CHECK (kind IN ('human','agent','timer')),
  origin_assignment_id TEXT REFERENCES workitems_assignments_fk_guard,  -- 见下注 (→ AC-1.6)
  reason TEXT NOT NULL,
  deadline_at INTEGER NOT NULL,
  renewed_count INTEGER NOT NULL DEFAULT 0,
  reminded_at INTEGER,                               -- 同到期仅提醒一次的载体 (→ S5 AC-5.3)
  resolved_at INTEGER, resolved_by TEXT, resolve_reason TEXT,           -- (→ S5 AC-5.13)
  created_at INTEGER NOT NULL
);
-- 注：实际 DDL 为 REFERENCES workitem_assignments(id)；引用不存在 id 时 FK 拒绝 (→ AC-1.6)
CREATE INDEX idx_waits_open ON workitem_waits(workitem_id) WHERE resolved_at IS NULL;

CREATE TABLE workitem_effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workitem_id TEXT NOT NULL REFERENCES workitems(id),
  seq INTEGER NOT NULL,                              -- 声明转移的 seq = based_on_seq (→ G-3.6)
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
         CHECK (status IN ('pending','running','done','aborted')),       -- (→ AC-1.7)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_effects_inflight ON workitem_effects(workitem_id, seq, id)
  WHERE status IN ('pending','running');

CREATE TABLE workitem_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workitem_id TEXT NOT NULL REFERENCES workitems(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(workitem_id, seq)                           -- 兜底唯一，单调分配归 G3 (→ AC-1.8)
);
CREATE TRIGGER trg_events_no_update BEFORE UPDATE ON workitem_events
  BEGIN SELECT RAISE(ABORT, 'workitem_events is append-only'); END;     -- (→ G-1.3)
CREATE TRIGGER trg_events_no_delete BEFORE DELETE ON workitem_events
  BEGIN SELECT RAISE(ABORT, 'workitem_events is append-only'); END;
```

migration 形态：`const MIGRATIONS: Array<(db) => void>`，构造时读 `PRAGMA user_version`、逐个执行未跑版本、事务内置 user_version——版本记录在 workitems.sqlite 自身，与 kernel store.ts 的 PRAGMA table_info 探测式 migration 互不读写（→ AC-1.2）。kernel db.sqlite 路径完全不被本模块触碰（→ AC-1.1）。

#### 2. git 仓布局与写提交（AC-1.9/1.10/1.11, G-1.4/1.6/1.7）

```
$DATA_DIR/workitems/<workitem_id>/   # initRepo: git init → config user.name/email → 空提交 "init <id>"
  brief.md  journal.md  decisions.md  report.md     # 按需写入（不预建）
  assignments/<assignment_id>/brief.md|report.md    # (→ G-1.7)
```

`writeFile` 伪代码：`mkdir -p dirname → fs.writeFileSync → git add -A → git commit -m "<message>"`——每写一提交（→ AC-1.10），message 格式 `<action>(<workitem_id>): <relPath>` 可追溯。崩溃落在 write 与 commit 之间 ⇒ 工作区脏 = 唯一脏区形态，`reconcile()` 为 G4 抓手：仓不存在 → initRepo 返回 'recreated'；脏 → `add -A && commit -m "reconcile(<id>): <label> <ISO>"` 返回 'committed'；净 → 'noop'（→ G-1.6）。DB 各表只存 *_path 相对路径，正文永不入库（→ AC-1.11）。

#### 3. 备份扩展（AC-1.12/1.13/1.14, G-1.2/1.5）

kernel backup.ts 泛化（通用能力，无业务词）：

```ts
// 既有四个导出全部加 prefix/ext 参数（kernel 调用点传 'db'/'.sqlite'，行为不变）：
backupFileName(prefix, now): string                       // `${prefix}-YYYYMMDD-HHMMSS${ext}`
selectBackupsToPrune(names, { prefix, ext, keep }): string[]   // 正则锚定前缀+扩展名 → 分流修剪 (→ G-1.5)
shouldBackupNow(names, prefix, now): boolean
scheduleDailyBackup(store, backupsDir, logger, extraJobs?: BackupJob[]): () => void
// attempt() 内对 kernel 备份与每个 extraJob 各自独立 try/catch+log (→ AC-1.14)
```

workitems 侧 job（src/workitems/backup.ts）：(1) `store.backup()` → `workitems-<ts>.sqlite` → 副本上 `wal_checkpoint(TRUNCATE)` 折叠 + 删 -wal/-shm（复用 kernel runBackup 同款折叠逻辑，→ AC-1.12）；(2) `execFile('tar', ['-czf', dest, '-C', dataDir, 'workitems'])` → `workitems-files-<ts>.tar.gz`（含 .git，→ AC-1.13, G-1.2）；各自按前缀修剪。`db-*` 与 `workitems-*` 正则互不匹配 ⇒ 互不误删。

### 依赖关系

依赖：kernel `logger.ts`（类型）、kernel `backup.ts`（BackupJob 类型与折叠工具）——方向 workitems→kernel 合法。被依赖：S2~S6 全部组件经 WorkitemsStore/ArtifactStore 读写。

### 数据契约

行类型 `WorkItemRow/AssignmentRow/WaitRow/EffectRow/EventRow` 定义于 src/workitems/types.ts，字段与 DDL 一一对应（snake_case 列 ↔ camelCase 字段由 store 层映射）；时间一律 epoch ms（Clock.now() 同单位）。模块内部类型，不出 workitems 层。

### 测试策略

- 单元：备份命名/解析/修剪纯函数——前缀分流矩阵（db-/workitems-/workitems-files- 混放互不误删 → G-1.5）；shouldBackupNow 既有用例回归。
- 集成（临时目录真 DB/真 git）：migration 幂等重入（开两次）；五表 CHECK/FK/UNIQUE 逐条触发（→ AC-1.3~1.7）；events trigger 拒绝 UPDATE/DELETE（→ AC-1.8, G-1.3）；initRepo 后 git log=1、连续两次 writeFile 后 git log=3 且历史可取回（→ AC-1.9/1.10）；正文不入库断言——writeFile 写入 brief/report 正文后扫描五张 workitem_* 表全部相关行，断言仅出现 *_path 仓内相对路径、任何字段不含 artifact 正文内容（→ AC-1.11）；reconcile 三态（→ G-1.6）；备份副本独立打开无 -wal 残留、kernel 备份注入失败时 workitems job 照常完成及反向（→ AC-1.12/1.14）。
- FLOW-1.1：一条集成用例串联 建项→写产物→记事件→备份，断言 DB 行/git 目录/事件序列/备份产物四面互查。

| 场景 | 类型 | 输入 | 期望 |
|---|---|---|---|
| 同 (type,dedupe_key) 二次插入 | Error | insertWorkItem×2 | 第二次抛 SQLITE_CONSTRAINT，首行无恙 |
| dedupe_key=NULL 多行 | Happy | 两行 NULL 键 | 均成功 (→ AC-1.4) |
| origin_assignment_id 悬空 | Error | 不存在的 id | FK 拒绝 (→ AC-1.6) |
| 崩溃窗口模拟 | Edge | 写文件后跳过 commit，再 reconcile | 'committed' 且工作区净 (→ G-1.6) |
