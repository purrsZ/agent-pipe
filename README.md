# agent-pipe

把本地 coding CLI agent（Claude Code、Codex…）接入 IM 平台的轻量级桥接器。用户在 IM 里通过斜杠命令创建任务，每个任务对应一个隔离的 agent 进程，拥有独立工作目录、模型与会话；普通消息按线程上下文自动路由到对应任务，结果以卡片回复。

**当前实现**：飞书 × (Claude Code / Codex)。架构上 IM 平台与 agent 都是可替换的抽象层（见"架构"），新增平台/agent 不动主流程。

适用场景：个人或小团队希望在 IM 里直接调用 coding CLI，不想频繁切到终端。

---

## 特性

- **多 agent 支持**：同一个 bot 同时跑 Claude Code（长连接进程 + `--resume` 续传）和 Codex（`codex exec --json` 每轮 spawn + `exec resume` 续传），可在任务间随意切换
- **多任务并发**：每个任务独立 cwd、独立子进程；Claude 任务进入热进程池（默认 4 个，LRU 淘汰），Codex 任务每轮短命进程不占槽
- **会话续传**：Claude 用 `--resume`、Codex 用 `exec resume <thread_id>`；任务被淘汰后仍可恢复上下文
- **线程路由**：回复任务主帖或任务历史消息会自动路由回该任务；无上下文时回退到"当前任务 → 最近活跃任务"
- **两种任务模式**
  - `sandbox`（默认）：在 `$DATA_DIR/sessions/<name>` 下创建独立沙箱目录
  - `project`：`/new --cwd` 指向已有项目目录（必须命中白名单）
- **模型/agent 切换**：
  - `/model <task> <model>` 切模型（当前 Claude / Codex 都会清上下文 respawn；Codex 的保守语义会在 `exec resume --model` 真实行为验证后再放宽）
  - `/agent <task> <claude|codex>` 切 agent（必然清上下文，但保留 cwd 和任务名 — 沙箱里的文件不动，可用于 "Claude 写代码、Codex 来 review" 的接力流程）
- **安全默认值**：仅白名单 `open_id` 可用，项目模式 cwd 必须落在 `ALLOWED_CWD_PREFIXES` 前缀内
- **单实例保护**：PID 锁自动 kill 旧进程，避免双跑抢消息
- **持久化**：SQLite 存任务、事件日志、消息映射；重启后任务列表恢复

---

## 架构

```
飞书用户
   │  (im.message.receive_v1 事件, WebSocket)
   ▼
feishu/event-router   去重 + 过滤 + @提取
   │
   ▼
index.ts              鉴权 → 线程路由回退链 → 命令 or 任务转发
   │
   ├─▶ bridge/commands         /new /list /use /agent /model /stop /rm /status /help
   │
   └─▶ agents/pool             按 task.id 管理 Runner (LRU 只对 hot Runner 生效)
         │
         ├─▶ agents/claude/runner   长连接 claude -p --input-format stream-json
         │     ↓
         │   agents/claude/parser   stream-json → AgentEvent[]
         │
         └─▶ agents/codex/runner    每轮 spawn codex exec --json
               ↓
             agents/codex/parser    thread.started/turn.completed/item.* → AgentEvent[]
                  ↓
feishu/card + feishu/sender    把 AgentEvent → 结果卡片
```

所有 agent 共享同一个 `AgentEvent` 事件流（session / text / tool_use / tool_result / usage / done），上层路由与 UI 完全 agent-agnostic。要接新 agent，实现 `AgentFactory + Runner + Parser` 即可，主流程零改动。

---

## 先决条件

- Node.js ≥ 18
- 至少安装其中一个 agent CLI：
  - [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)（默认从 `PATH` 查找 `claude`）
  - [Codex CLI](https://developers.openai.com/codex/cli)（默认从 `PATH` 查找 `codex`，需 ≥ 0.125 以支持 `--skip-git-repo-check`）
- 用到的 CLI 都需要事先在本地登录一次（首次跑交互登录）
- 一个飞书自建应用（见下文"飞书应用配置"）
- 自己的 `open_id`（在飞书开发者后台 → 通讯录 API 里查，或通过 Bot 日志查看）

---

## 飞书应用配置

1. 进入 [飞书开放平台](https://open.feishu.cn/) → 开发者后台 → **创建企业自建应用**
2. 记下 **App ID** 与 **App Secret**（稍后填入 `.env`）
3. **权限管理** 中申请以下权限（均为 IM 范畴）：
   - `im:message`
   - `im:message:send_as_bot`
   - `im:message.receive_v1`（事件订阅用）
   - `im:chat`（可选，用于读取群聊信息）
   - `bot:info`（读取 bot 自身信息，用于启动时自检）
4. **事件订阅** → 选择 **长连接模式（WebSocket）**（本项目正是 WS 模式，无需配置回调 URL）
5. 在事件列表中订阅 **接收消息 `im.message.receive_v1`**
6. **应用能力 → 机器人** 启用
7. **版本管理与发布** → 创建版本并发布，等待管理员审批；审批通过后，去飞书客户端与 bot 私聊即可

> 说明：本项目只处理 P2P 私聊文本消息，群聊消息会被 event-router 过滤掉。

---

## 快速开始

```bash
cd agent-pipe
npm install
cp .env.example .env
# 按下文填写 .env
npm run start
```

启动成功后日志会打印 `agent-pipe ready` 和 bot 的 `open_id`。去飞书私聊 bot，发送 `/help` 验证。

开发时用 `npm run dev`（tsx watch 热重载）。

---

## 环境变量

所有变量见 `.env.example`；下表列出完整说明：

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `FEISHU_APP_ID` | 是 | — | 飞书应用 App ID（`cli_` 开头） |
| `FEISHU_APP_SECRET` | 是 | — | 飞书应用 App Secret |
| `ALLOWED_OPEN_IDS` | 是 | — | 允许使用 bot 的 `open_id`，逗号分隔；非白名单消息静默丢弃 |
| `ALLOWED_CWD_PREFIXES` | 否 | 空 | 项目模式 cwd 白名单，冒号分隔；未配置则 `/new --cwd` 全部拒绝 |
| `DEFAULT_AGENT` | 否 | `claude` | `/new` 不带 `--agent` 时用哪个：`claude` / `codex` |
| `CLAUDE_PATH` | 否 | `claude` | Claude Code CLI 可执行文件路径 |
| `CLAUDE_MODEL` | 否 | `claude-opus-4-7[1m]` | Claude 默认模型 |
| `CLAUDE_EFFORT` | 否 | `xhigh` | effort 级别：`low` / `medium` / `high` / `xhigh` / `max` |
| `CODEX_PATH` | 否 | `codex` | Codex CLI 可执行文件路径 |
| `CODEX_MODEL` | 否 | `gpt-5.1-codex` | Codex 默认模型 |
| `CODEX_REASONING_EFFORT` | 否 | — | `low` / `medium` / `high`，等价于 `-c model_reasoning_effort=...` |
| `MAX_HOT` | 否 | `4` | 热进程池容量上限（只对 Claude 等长连接 agent 生效；Codex 每轮 spawn 不占槽） |
| `LOG_LEVEL` | 否 | `info` | `debug` / `info` / `warn` / `error` |
| `DATA_DIR` | 否 | `~/.agent-pipe` | 数据根目录，支持 `~` |

### 数据目录结构

```
$DATA_DIR/
├── bot.pid                  单实例 PID 锁
├── db.sqlite                任务 / 事件 / 消息映射
└── sessions/
    └── <task-name>/         sandbox 模式任务的独立工作目录
```

---

## 命令参考

| 命令 | 说明 |
|---|---|
| `/new <name> [--agent claude\|codex] [--cwd <path>] [--model <m>]` | 新建任务，自动设为当前任务；`name` 需满足 `^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$` |
| `/list` | 列出全部任务，★ 标出当前；每行带 `[agent/status]` 标签 |
| `/use <name>` | 切换当前任务；不带参数时查看当前任务 |
| `/agent <name> <claude\|codex>` | 切换任务 agent；**必然清空上下文**，但保留 cwd 与任务名（沙箱里的文件不变） |
| `/agent <name>` | 查看任务当前 agent |
| `/model <name> <m>` | 切换任务模型（当前 Claude / Codex 都会清空上下文 — Codex 是保守实现，因为尚未确认 `exec resume --model` 真能换模型，等真机验证后可放宽） |
| `/model <name>` | 查看任务当前模型 |
| `/clear <name>` | 清空任务会话上下文，下条消息开全新会话；文件保留 |
| `/status` | Bot 进程状态（PID、uptime、任务数、hot 槽位） |
| `/stop <name>` | 向任务发送 SIGINT，中止当前轮 |
| `/rm <name>` | 删除任务；sandbox 模式连同工作目录一起删 |
| `/help` | 命令帮助 |

### 消息路由规则

收到普通消息（不以 `/` 开头）时按以下顺序定位任务：

1. 消息的 `root_id`（线程根）对应的任务
2. 消息的 `parent_id`（父消息）对应的任务
3. 当前任务（`/use` 设置）
4. 最近活跃任务
5. 都找不到 → 回复提示 `/new` 新建

---

## 部署教程

项目是纯 Node.js 长连接进程，部署无需公网端口。推荐三种方式：

### 方式 A：`pm2`（跨平台，推荐）

```bash
npm install -g pm2

# 先构建
cd /path/to/agent-pipe
npm install
npm run build

# 启动
pm2 start dist/index.js --name agent-pipe \
  --cwd /path/to/agent-pipe \
  --env production

# 开机自启
pm2 save
pm2 startup   # 按输出提示执行一条 sudo 命令

# 查看日志
pm2 logs agent-pipe

# 重启 / 停止
pm2 restart agent-pipe
pm2 stop agent-pipe
```

### 方式 B：macOS `launchd`

新建 `~/Library/LaunchAgents/com.local.agent-pipe.plist`（把 `ZWH_USER` 替换成你的用户名与路径）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.local.agent-pipe</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/ZWH_USER/agent-pipe/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/ZWH_USER/agent-pipe</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/ZWH_USER/agent-pipe/agent-pipe.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/ZWH_USER/agent-pipe/agent-pipe.err.log</string>
</dict>
</plist>
```

加载：

```bash
launchctl load -w ~/Library/LaunchAgents/com.local.agent-pipe.plist

# 查看状态
launchctl list | grep agent-pipe

# 停止 / 卸载
launchctl unload -w ~/Library/LaunchAgents/com.local.agent-pipe.plist
```

> `.env` 必须放在 `WorkingDirectory` 指定的目录下（进程启动时 dotenv 从 cwd 读取）。

### 方式 C：Linux `systemd`

`/etc/systemd/system/agent-pipe.service`：

```ini
[Unit]
Description=agent-pipe bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/agent-pipe
ExecStart=/usr/bin/node /home/youruser/agent-pipe/dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/agent-pipe.log
StandardError=append:/var/log/agent-pipe.err.log

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agent-pipe
sudo systemctl status agent-pipe
journalctl -u agent-pipe -f
```

### 部署前清单

- [ ] `.env` 不要提交到 git；`.gitignore` 已忽略
- [ ] `ALLOWED_OPEN_IDS` 填入授权用户（多人用逗号分隔）
- [ ] 若用 `project` 模式，`ALLOWED_CWD_PREFIXES` 必须配置；路径以冒号分隔
- [ ] `CLAUDE_PATH` 指向的 `claude` CLI 已登录（`claude` 首次运行需交互登录）
- [ ] 飞书应用已发布并被管理员审批
- [ ] 部署机能访问 `open.feishu.cn`（WebSocket 出站连接）

---

## 常见问题

**bot 不响应消息**

1. 检查日志有无 `unauthorized sender` —— `ALLOWED_OPEN_IDS` 没配你的 `open_id`
2. 确认飞书应用已发布审核通过，且事件订阅选择了 **长连接（WebSocket）** 模式
3. 确认订阅了 `im.message.receive_v1` 事件
4. 仅支持 P2P（私聊），群里 @bot 不会响应

**`claude exited` 或子进程秒退**

- 手动执行 `claude -p --input-format stream-json --output-format stream-json` 看是否能启动
- 未登录 Claude Code：`claude` 直接运行一次完成登录
- `CLAUDE_MODEL` 填错：模型名参考 `claude --help`

**切模型后上下文丢了**

这是预期行为。Claude Code 的 `--resume` 会锁定首次会话的模型，因此 `/model` 切换必须清空 `cc_session_id` 并开全新会话。

**想同时跑两个 bot 实例**

别。项目自带 PID 锁，启动时会主动 SIGTERM 旧实例；同时消费同一个 App 的消息会乱序重复。若确有此需求，用不同 `DATA_DIR` 且配不同飞书应用。

---

## 目录结构

```
agent-pipe/
├── src/
│   ├── index.ts              主编排：鉴权 / 路由 / 生命周期
│   ├── config.ts             env 加载与校验
│   ├── logger.ts             pino 封装
│   ├── store.ts              SQLite 持久化层 (任务带 agent_kind)
│   ├── bridge/
│   │   └── commands.ts       斜杠命令分发
│   ├── feishu/
│   │   ├── client.ts         HTTP + WS Client 构造
│   │   ├── event-router.ts   消息事件去重与派发
│   │   ├── sender.ts         回复文本 / 卡片
│   │   ├── card.ts           结果卡片模板（agent-agnostic）
│   │   └── types.ts
│   └── agents/
│       ├── types.ts          AgentEvent / Runner / AgentFactory 接口
│       ├── pool.ts           按 task.id 管理 Runner（LRU 只对 hot Runner 生效）
│       ├── claude/
│       │   ├── runner.ts     长连接 Runner（spawn + 多次 stdin）
│       │   └── parser.ts     Claude stream-json → AgentEvent[]
│       └── codex/
│           ├── runner.ts     One-shot Runner（每轮 spawn codex exec --json）
│           └── parser.ts     Codex JSONL → AgentEvent[]
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 开发脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` | tsx watch 热重载（开发用） |
| `npm run start` | tsx 直接运行（不编译，生产也能跑但略慢） |
| `npm run build` | `tsc` 编译到 `dist/` |
| `npm run typecheck` | 仅类型检查 |

---

## 状态

v0.1.0。核心功能可用；暂无自动化测试，生产使用前建议补 integration test 与监控告警。
