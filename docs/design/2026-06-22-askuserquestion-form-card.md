# AskUserQuestion 交互卡 → 表单卡升级 · 设计方案

> 日期：2026-06-22 ｜ 分支：codex/workitems-m0 ｜ 状态：待实现（需与 requirement T3 灯卡协调）
>
> 目的：把"Claude 调 `AskUserQuestion` 提问 → 飞书卡片 → 用户作答 → 回灌会话"这条链路，从
> 现有的**单组按钮卡**升级为**表单卡**，支持「多问题一次凑齐提交」+「每题可选预设项也可自定义文本」。
>
> ⚠️ 本方案要改的 `card.ts` / `index.ts` / `event-router.ts` 三个文件，**正被 requirement T3
> 灯卡（checkpoint）那条线同时编辑**。第 6 节专门讲两条线的共享点与协调办法，请优先看。
>
> **2026-06-22 修订（据 T3 已提交代码核验 + 采纳对侧 AI 反馈）**：
> ① checkpoint 的 kind 实际常量是 `CHECKPOINT_ACTION_KIND = 'ckpt'`（不是 `'checkpoint'`），§6.1 已更正，别在别处手写 `'checkpoint'`；
> ② `parseCardAction` 新增的 `formValue` **必须可选**（checkpoint 回调没有 form_value，缺省 `undefined`），写成必读会让灯卡回调解析异常；
> ③ §8 增加回归断言：构造 `{kind:'ckpt'}` 且无 form_value 的 callback，断言仍走 `handleCheckpointAction`，把两条线隔离钉死；
> ④ 基线已转好：auq 按钮卡已并入提交 `9866bb5`、requirement T1–T5 全提交，工作区只剩 `event-router.ts` 在制品，三个目标文件均在 HEAD、互不覆盖；
> ⑤ 顺带机会（本次不做）：表单 `input` 自定义输入可复用到 T3 灯卡「打回」带自由文本理由（现为固定文案 `'飞书拍板：打回…'`）。

---

## 1. 背景与现状

### 1.1 已落地（当前工作区，未提交）

"AskUserQuestion → 按钮卡 → 点选回灌"的**单问题**链路已经打通并真机验证：

| 改动 | 文件 |
|---|---|
| `AskUserQuestion` / `AskUserQuestionItem` 类型、`ask_user` 事件、`onAskUser` 回调 | `src/agents/types.ts` |
| 识别 `AskUserQuestion` tool_use → 解析出完整 questions（绕开 tool_use input 的 500 字符截断） | `src/agents/claude/parser.ts` |
| runner 把 `ask_user` 转发到 `onAskUser` | `src/agents/claude/runner.ts` |
| `buildQuestionCard`（每 option 一个 callback 按钮）、`buildQuestionAnsweredCard`、`AUQ_ACTION_KIND='auq'` | `src/feishu/card.ts` |
| `runOneTurn` 用 `onAskUser` 记录本轮提问、收尾用问题卡替代结果卡；`handleCardAction` 的 auq 分支（鉴权 → 把所选 label 当作下一轮 user 消息 `--resume` 回灌） | `src/index.ts` |
| `parseCardAction` 的 `messageId` 从 `context.open_message_id` 取（修复 WS 回调 messageId 为空导致 `/messages//reply` 404） | `src/feishu/event-router.ts` |

关键事实（实测）：headless `claude -p` 在 ~0.1s 内自动用 error `tool_result` 关闭 `AskUserQuestion`，
**无法通过 stdin 回灌 tool_result**，所以答案一律走「作为下一轮 user 消息 `--resume` 喂回」。

### 1.2 现存问题（本方案要解决）

一次 `AskUserQuestion` 可携带**多个问题**（`questions: [...]`）。现在把它们渲染成**一张卡、多组按钮**，
但 `handleCardAction` 点任意一个按钮就 `updateCard` 把**整张卡**替换成「已确认 X」，于是其余问题的按钮
全部消失，无法继续作答。

### 1.3 用户新诉求

1. **多问题凑齐再一次提交**（不要点一个就封卡 / 回灌）。
2. **每题既能点预设选项，也能自己打字自定义**（Claude 给的预设项不一定是用户想选的）。

---

## 2. 目标

一张**表单卡**：
- 每个问题渲染成「下拉（预设选项） + 输入框（自定义，可留空）」。
- 底部一个「提交」按钮。
- 用户填完所有题 → 点提交 → 一次性回传全部答案 → 拼成一段文本**一次回灌** Claude。
- 单问题场景同样适用（退化为一题的表单）。

---

## 3. 飞书表单卡机制（查证结论）

来源见文末。要点：

- **`form` 容器**包裹若干交互组件 + 一个提交按钮，避免输入框「输入即提交」的问题，做到「填完统一提交」。
- 提交按钮触发后，飞书把表单内**所有带 `name` 的组件值**打包进回调的 **`action.form_value`**（以各组件
  `name` 为键），连同提交按钮自己的 `value` 一起，通过 `card.action.trigger` 回调下发。
- 组件：`input`（单行文本，自定义）、`select_static`（预设下拉）等。

JSON 1.0 实战示例（佐证机制，**注意我们项目用 schema 2.0，字段写法见 §5.4 与 §7 待验证项**）：

```json
{
  "tag": "form",
  "name": "form_1",
  "elements": [
    { "tag": "input", "name": "postfix",
      "placeholder": { "tag": "plain_text", "content": "请输入后缀" },
      "label": { "tag": "plain_text", "content": "后缀:" } },
    { "tag": "button", "action_type": "form_submit", "name": "submit",
      "text": { "tag": "lark_md", "content": "提交" }, "type": "primary" }
  ]
}
```

提交后服务端读 `action.form_value.postfix`，并用 `action.name == "submit"` 判断是提交动作。
**2.0 的提交按钮用 `behaviors` + `form_action_type` 写法**（与 1.0 的 `action_type:"form_submit"` 等价），
确切字段在实现时用临时日志真机敲定（与上次修 `messageId` 同法）。

---

## 4. 方案设计

### 4.1 卡片结构

```
header: [任务名] 需要你确认（orange）
body:
  form 容器 (name=auq_form)
    ── 问题 0 ──
    markdown: **❓【header0】question0 文本**
    select_static (name=q0_pick, options=预设选项, 可空)
    input        (name=q0_custom, placeholder="或自定义输入…", 可空)
    ── 问题 1 ──
    markdown: **❓【header1】question1 文本**
    select_static (name=q1_pick, ...)
    input        (name=q1_custom, ...)
    ── ... ──
    hr
    button (form 提交, value={ kind:'auq', taskId, chatId, total:N })
  note: 「下拉选预设，或在输入框自定义；填完点提交。」
```

### 4.2 `name` 约定

- 第 i 题：下拉 `q{i}_pick`、输入框 `q{i}_custom`。
- 提交按钮 `value` 仍携带路由：`{ kind: 'auq', taskId, chatId, total }`（`total` = 问题数，用于解析时遍历）。
- 每题的 `header` 可编码进 markdown 文案即可（回灌文本用），无需进 form_value。

### 4.3 回灌逻辑（handleCardAction 的 auq 分支）

提交回调到达后：
1. 鉴权（沿用现有白名单门）。
2. `value.kind === 'auq'` 且带 `form_value` → 走表单提交分支。
3. 遍历 `i in [0, total)`：每题答案 = `form_value['q{i}_custom']?.trim() || form_value['q{i}_pick'] || '(未选)'`
   （**输入框优先，留空则用下拉**）。
4. 把所有题答案拼成一段文本回灌（Claude 在 `--resume` 同 session 下记得自己问了什么，能对应）：
   ```
   针对你刚才的问题，我的选择是：
   1. 【早餐】→ 面包
   2. 【颜色】→ 我想要低饱和的莫兰迪色（自定义）
   ```
5. `updateCard(messageId, buildQuestionAnsweredCard(...))` 把表单卡封成「已确认（含答案摘要）」，防重复提交。
6. 走现有 `runWithDrain` / `enqueue` 把回灌文本作为下一轮 user 消息喂回。

### 4.4 改动落点

| 文件 | 改动 |
|---|---|
| `src/feishu/card.ts` | `buildQuestionCard` 改/或新增 `buildQuestionFormCard`：渲染 form + 每题 select_static+input + 提交按钮；`buildQuestionAnsweredCard` 支持答案摘要 |
| `src/feishu/event-router.ts` | `parseCardAction` **加 `form_value` 透出**（见 §6 协调点）；删除上次临时 `card.action raw payload` 日志 |
| `src/agents/*` | 无需改（`ask_user` 已透出完整 questions） |
| `src/index.ts` | `handleCardAction` 的 auq 分支改为表单提交处理（凑齐 → 拼文本 → 回灌）；`runOneTurn` 收尾改用表单卡渲染 |
| `tests/*` | `parseCardAction` 解析 form_value、表单卡 schema、凑齐回灌文本拼装 |

---

## 5. 实现注意

1. **2.0 schema**：`form` / `select_static` / 2.0 提交按钮（`behaviors`+`form_action_type`）的确切字段，
   动手时先发一张最小表单卡到飞书确认能渲染，再铺开。
2. **回灌仍是文本**：不要尝试回灌 tool_result（headless CLI 已自动关闭该工具，回不进去）。
3. **单问题**：表单卡同样适用（一题）；也可保留判断，单题时仍走轻量按钮卡。
4. **重复提交 / 卡过期**：提交后封卡为已确认态；bot 重启后旧卡失效（可接受，提示用户重发）。

---

## 6. ⚠️ 与 requirement T3 灯卡（checkpoint）的协调点

两条线**改同一批文件**，且**共用同一套卡片回调底座**。这是协调的核心。

### 6.1 共享的代码

| 共享物 | checkpoint（T3 灯卡）用法 | auq（本方案）用法 |
|---|---|---|
| `parseCardAction`（`event-router.ts`） | 读**按钮 callback** 的 `action.value`（`{kind:'ckpt', itemId, waitId, approved}`） | 读**表单提交**的 `action.form_value`（各题答案）+ 提交按钮 `action.value`（`{kind:'auq', total}`） |
| `handleCardAction`（`index.ts`） | `value.kind === CHECKPOINT_ACTION_KIND` → `handleCheckpointAction` | `value.kind === AUQ_ACTION_KIND` → 表单提交分支 |
| `CardAction` 类型（`feishu/types.ts`） | `{ value, operatorId, token?, messageId? }` | **需新增 `formValue?` 字段** |
| `card.ts` | `buildCheckpointCard` / `buildCheckpointAnsweredCard` / `CHECKPOINT_ACTION_KIND` | `buildQuestionFormCard` / `buildQuestionAnsweredCard` / `AUQ_ACTION_KIND` |

### 6.2 唯一真正需要协调的改动：`parseCardAction` 加 `form_value`

- checkpoint 的灯卡是**按钮 callback**，回调形态 = `action.value`。
- auq 表单是**form 提交**，回调形态 = `action.value`（提交按钮自己的）**+ `action.form_value`（各题答案）**。
- 所以 `parseCardAction` 要**同时透出 `value` 和 `form_value`**，`CardAction` 类型加 `formValue?: Record<string, unknown>`。
- **这是两条线都受益、且只该改一次的共享点**：建议商定由其中一方实现 `parseCardAction` 的 `form_value` 透出
  + `CardAction.formValue` 字段，另一方基于它消费，避免各改各的、互相覆盖。

`handleCardAction` 的 `value.kind` 分发天然兼容（checkpoint / auq 各走各的分支），互不影响——**只要分发入口
和 `parseCardAction` 是一份、不被各自重写**。

### 6.3 `card.ts` / `index.ts` 文件级冲突

函数互不重名（checkpoint 一套、auq 一套），逻辑上不冲突；但**同一文件被两个 agent 同时编辑会互相覆盖**。
建议：
- 串行化：一方先完成并提交，另一方 rebase 后再动；或
- 分工：约定 `parseCardAction` + `CardAction` 由一方统一改，其余各自函数各自加。

### 6.4 遗留：临时日志

`event-router.ts` 里有一行临时 `logger.info(... 'card.action raw payload')`（上次排查 messageId 用），
本方案动 `event-router` 时**一并删除**。

---

## 7. 待真机验证（动手时用临时日志确认，勿凭记忆）

1. schema 2.0 的 `form` / `select_static` / 提交按钮（`behaviors` + `form_action_type`）能否正常渲染。
2. `action.form_value` 在 WS 回调 `data` 里的**确切位置与结构**（顶层？`event.form_value`？`action.form_value`？）——
   加一行 `JSON.stringify(data)` 日志，点一次提交看真实 payload，再定 `parseCardAction` 取法。
3. WS 长连接能否收到 **form 提交**回调（应与 `card.action.trigger` 同通道，但需确认 `form_action_type` 不走另一种事件）。

---

## 8. 测试

- `parseCardAction`：从回调解析出 `formValue`（含 context 嵌套兼容）。
- `buildQuestionFormCard`：form 容器 + 每题 select_static+input + 提交按钮 + value 路由。
- 凑齐回灌：`form_value` → 每题「输入框优先、否则下拉」→ 文本拼装。
- 回归（钉死隔离）：构造 `{kind:'ckpt'}` 且**无 form_value** 的 callback，跑 `parseCardAction`→`handleCardAction`，断言仍走 `handleCheckpointAction`、不进 auq 分支；单问题 auq 仍可用。

---

## 参考

- [表单容器 - 飞书开放平台](https://open.feishu.cn/document/feishu-cards/feishu-card-cardkit/components/form?lang=zh-CN)
- [输入框 input - 飞书开放平台](https://open.feishu.cn/document/feishu-cards/card-components/interactive-components/input?lang=zh-CN)
- [按钮 button - 飞书开放平台](https://open.feishu.cn/document/feishu-cards/feishu-card-cardkit/components/button?lang=zh-CN)
- [Card JSON 2.0 structure - 飞书开放平台](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure?lang=zh-CN)
- [如何巧用飞书消息卡片输入框实现一套业务交互逻辑 - 白宦成](https://www.ixiqin.com/2023/08/22/how-to-cleverly-use-the-input-box-of-feishu-message-card-to/)
