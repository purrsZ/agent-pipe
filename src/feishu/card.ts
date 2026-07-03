import type { AskUserQuestion, TurnResult } from '../agents/types.js';
import type { Task } from '../store.js';

const MAX_CARD_MARKDOWN = 28_000;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 956s 这种裸秒数不直观——格式化成时钟样式：15:56 / 1:02:05。 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

export function buildTaskRootCard(task: Task): object {
  const lines = [
    `**agent**: ${task.agent_kind}`,
    `**模式**: ${task.mode}`,
    `**cwd**: \`${task.cwd}\``,
    `**model**: ${task.model ?? '(default)'}`,
    '',
    '_在此消息下回复即向该任务发送消息。_',
  ].join('\n');
  return {
    schema: '2.0',
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: `任务 ${task.display_name} 已创建` },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [{ tag: 'markdown', content: lines }],
    },
  };
}

/**
 * Anchor card for a managed (upper-layer) thread. Pure display: id / title / stage /
 * status. Replying under it routes a follow-up into the owning unit; `/done` closes it.
 * Kept free of upper-layer vocabulary so this kernel-layer file stays within the
 * architecture guard (neutral field names: `stage`, `status`).
 */
export interface AnchorCardData {
  id: string;
  title: string;
  stage: string;
  status: string;
  closed?: boolean;
  // Header 名词，缺省"调查"（probe）。上层按单元类型传入（requirement 传"需求"），让这个
  // kernel-neutral 文件不必识别业务类型。
  noun?: string;
}

export function buildAnchorCard(data: AnchorCardData): object {
  const title = data.title.length > 40 ? `${data.title.slice(0, 40)}…` : data.title;
  // Three visual states, closed taking precedence: closed (grey) > failed (red) > open (blue).
  // `failed` is driven by the neutral status value so callers just pass through item.status.
  const failed = !data.closed && data.status === 'failed';
  const footer = data.closed
    ? '_已关闭。_'
    : failed
      ? '_已失败，可回复 `/done` 关闭。_'
      : '_在此消息下回复即可追问；满意后回复 `/done` 关闭。_';
  const lines = [
    `**ID**: \`${data.id}\``,
    `**进度**: ${data.stage}`,
    `**状态**: ${data.status}`,
    '',
    footer,
  ].join('\n');
  const template = data.closed ? 'grey' : failed ? 'red' : 'blue';
  const noun = data.noun ?? '调查';
  const headTitle = data.closed
    ? `已关闭 · ${title}`
    : failed
      ? `${noun}失败 · ${title}`
      : `${noun} · ${title}`;
  return {
    schema: '2.0',
    header: {
      template,
      title: { tag: 'plain_text', content: headTitle },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [{ tag: 'markdown', content: lines }],
    },
  };
}

/**
 * M1b WI-6: result card posted back into a managed thread once a run produces a report.
 * Green header + markdown body (reuses the same truncation budget as the task result card).
 * Neutral naming keeps this kernel-layer file within the architecture guard.
 */
export function buildReportCard(title: string, report: string): object {
  const head = title.length > 40 ? `${title.slice(0, 40)}…` : title;
  const body = (report ?? '').trim() || '(空报告)';
  const shown =
    body.length > MAX_CARD_MARKDOWN
      ? `${body.slice(0, MAX_CARD_MARKDOWN)}\n\n_…已截断，完整报告见本地仓库_`
      : body;
  return {
    schema: '2.0',
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: `调查报告 · ${head}` },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [{ tag: 'markdown', content: shown }],
    },
  };
}

/**
 * M1b WI-7: failure card posted back into a managed thread when a run reaches a terminal
 * failure. Red header + the error summary (truncated, same budget as the report card).
 * Neutral naming keeps this kernel-layer file within the architecture guard.
 */
export function buildErrorCard(title: string, error: string): object {
  const head = title.length > 40 ? `${title.slice(0, 40)}…` : title;
  const body = (error ?? '').trim() || '(未知错误)';
  const shown =
    body.length > MAX_CARD_MARKDOWN ? `${body.slice(0, MAX_CARD_MARKDOWN)}\n\n_…已截断_` : body;
  return {
    schema: '2.0',
    header: {
      template: 'red',
      title: { tag: 'plain_text', content: `调查失败 · ${head}` },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [{ tag: 'markdown', content: `**失败原因**：${shown}` }],
    },
  };
}

/**
 * M2 进度可见性：流式卡因 abort（容器 stall/close 触发 SIGINT）收尾时的中断态卡。Grey
 * header「调查中断 · head」，与 buildReportCard / buildErrorCard 同构，统一一张流式卡三种
 * 归宿（报告 / 失败 / 中断）的标题风格。Neutral naming keeps this kernel-layer file within
 * the architecture guard.
 */
export function buildCancelledCard(title: string): object {
  const head = title.length > 40 ? `${title.slice(0, 40)}…` : title;
  return {
    schema: '2.0',
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: `调查中断 · ${head}` },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [{ tag: 'markdown', content: '_已中断当前轮。_' }],
    },
  };
}

/**
 * M1b WI-7: maps a committed main event + terminal flag to the outbound card action(s).
 * Pure (takes raw kind + bool, no work-item types) so it's unit-testable in isolation and
 * lets the bridge wiring pass `isTerminalStatus(...)` instead of writing `status===`
 * (which the index guard forbids).
 *  - run_failed at a terminal state → refresh the anchor to its failed state ONLY. M2: the
 *    failure card is now the streaming card's own onRunEnd(failed) terminal patch (one card
 *    per run), so the observer no longer replies a separate error card (would double up).
 *  - any other terminal (i.e. done) → skip: runDone already refreshed the anchor on /done.
 *  - non-terminal progress          → refresh the anchor stage only.
 */
export function anchorAction(
  kind: string,
  isTerminal: boolean,
): { reply: boolean; update: boolean } {
  if (kind === 'run_failed' && isTerminal) return { reply: false, update: true };
  if (isTerminal) return { reply: false, update: false };
  return { reply: false, update: true };
}

export function buildProcessingCard(taskName: string, agentKind?: string): object {
  const who = agentKind === 'codex' ? 'Codex' : 'Claude';
  return {
    schema: '2.0',
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `[${taskName}] 处理中...` },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [
        {
          tag: 'markdown',
          content: `<font color="grey">${who} 正在思考中，请稍候…</font>`,
        },
      ],
    },
  };
}

export function buildResultCard(taskName: string, r: TurnResult): object {
  const elements: object[] = [];
  const error = r.error;
  const text = (r.fullText ?? '').trim() || (error ? '' : '(无输出)');
  const shown =
    text.length > MAX_CARD_MARKDOWN
      ? `${text.slice(0, MAX_CARD_MARKDOWN)}\n\n_…已截断，完整结果请在本地查看 session_`
      : text;

  if (error) {
    elements.push({
      tag: 'markdown',
      content: `**执行出错**\n\n\`\`\`\n${error}\n\`\`\``,
    });
    if (text) {
      elements.push({ tag: 'hr' });
      elements.push({ tag: 'markdown', content: shown });
    }
  } else {
    elements.push({ tag: 'markdown', content: shown });
  }

  const metaParts: string[] = [];
  if (r.durationMs !== undefined) metaParts.push(formatClock(r.durationMs));
  if (r.toolCount > 0) metaParts.push(`${r.toolCount} tools`);

  const ctxUsed =
    (r.inputTokens ?? 0) + (r.cacheCreationInputTokens ?? 0) + (r.cacheReadInputTokens ?? 0);
  const ctxWindow = r.contextWindow;
  let ctxPct: number | null = null;
  if (ctxUsed > 0 && ctxWindow && ctxWindow > 0) {
    ctxPct = (ctxUsed / ctxWindow) * 100;
    metaParts.push(
      `ctx ${ctxPct.toFixed(1)}% (${formatTokens(ctxUsed)} / ${formatTokens(ctxWindow)})`,
    );
  }

  if (metaParts.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `<font color="grey">${metaParts.join(' · ')}</font>`,
    });
  }

  if (ctxPct !== null && ctxPct > 55) {
    elements.push({
      tag: 'markdown',
      content: `<font color="orange">⚠ 上下文已用 ${ctxPct.toFixed(1)}%，建议用 \`/compact ${taskName}\`（压缩保留要点）或 \`/clear ${taskName}\`（彻底清空）。</font>`,
    });
  }

  return {
    schema: '2.0',
    header: {
      template: error ? 'red' : 'green',
      title: {
        tag: 'plain_text',
        content: `[${taskName}] ${error ? '失败' : '完成'}`,
      },
    },
    body: { direction: 'vertical', padding: '12px', elements },
  };
}

const STREAM_PREVIEW_MAX = 2000;

/**
 * In-progress card refreshed during a turn (tool activity + streamed text preview).
 * Distinct from buildResultCard: blue header, truncated preview, no token meta —
 * the final result card overwrites this once the turn completes.
 */
export function buildStreamingCard(
  taskName: string,
  agentKind: string,
  s: {
    elapsedMs: number;
    toolCount: number;
    currentTool: string | null;
    text: string;
  },
): object {
  const who = agentKind === 'codex' ? 'Codex' : 'Claude';
  const activity = s.currentTool ? `正在调用 \`${s.currentTool}\`…` : `${who} 正在思考…`;
  const elements: object[] = [
    { tag: 'markdown', content: `<font color="grey">${activity}</font>` },
  ];

  const preview = (s.text ?? '').trim();
  if (preview) {
    const shown =
      preview.length > STREAM_PREVIEW_MAX ? `${preview.slice(0, STREAM_PREVIEW_MAX)} …` : preview;
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: shown });
  }

  const metaParts = [formatClock(s.elapsedMs)];
  if (s.toolCount > 0) metaParts.push(`${s.toolCount} tools`);
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: `<font color="grey">${metaParts.join(' · ')} · 处理中…</font>`,
  });

  return {
    schema: '2.0',
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `[${taskName}] 处理中…` },
    },
    body: { direction: 'vertical', padding: '12px', elements },
  };
}

/**
 * Terminal card for a turn that ended by failure or manual /stop. Patches the stuck
 * "处理中" card into a clear end state instead of leaving it spinning forever.
 */
export function buildStatusCard(
  taskName: string,
  kind: 'error' | 'cancelled',
  message: string,
): object {
  const isCancel = kind === 'cancelled';
  const content = isCancel ? message : `**执行出错**\n\n\`\`\`\n${message}\n\`\`\``;
  return {
    schema: '2.0',
    header: {
      template: isCancel ? 'grey' : 'red',
      title: {
        tag: 'plain_text',
        content: `[${taskName}] ${isCancel ? '已中断' : '失败'}`,
      },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [{ tag: 'markdown', content }],
    },
  };
}

const QUESTION_TEXT_MAX = 600;
const OPTION_DESC_MAX = 300;
const BUTTON_TEXT_MAX = 100;

/** Callback-button payload value for an interactive choice card (see AUQ_ACTION_KIND). */
export const AUQ_ACTION_KIND = 'auq';

/** Routing carried in each choice button so a click can be resumed into the right session. */
export interface QuestionCardRouting {
  taskId: string;
  chatId: string;
}

/**
 * Interactive choice card for an AskUserQuestion. Each option becomes a 2.0 callback button
 * whose action.value carries the routing (taskId/chatId) + the picked label — the card action
 * event itself does NOT include a chat_id, so it must travel in the value. A "也可直接回复选项名"
 * footer is a zero-cost fallback for any click whose callback isn't delivered. Neutral naming
 * keeps this kernel-layer file within the architecture guard.
 */
export function buildQuestionCard(
  taskName: string,
  q: AskUserQuestion,
  routing: QuestionCardRouting,
): object {
  const elements: object[] = [];
  q.questions.forEach((item, qIdx) => {
    if (qIdx > 0) elements.push({ tag: 'hr' });
    const qText = (item.question ?? '').slice(0, QUESTION_TEXT_MAX) || '(请选择)';
    const head = item.header ? `【${item.header}】` : '';
    elements.push({ tag: 'markdown', content: `**❓ ${head}${qText}**` });
    if (item.multiSelect) {
      elements.push({
        tag: 'markdown',
        content: '<font color="grey">可多选：逐个点击，或直接回复多个选项名。</font>',
      });
    }
    for (const opt of item.options) {
      const label = opt.label || '(选项)';
      if (opt.description) {
        elements.push({
          tag: 'markdown',
          content: `**${label}**\n<font color="grey">${opt.description.slice(0, OPTION_DESC_MAX)}</font>`,
        });
      }
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: label.slice(0, BUTTON_TEXT_MAX) },
        type: 'primary',
        width: 'default',
        behaviors: [
          {
            type: 'callback',
            value: {
              kind: AUQ_ACTION_KIND,
              taskId: routing.taskId,
              chatId: routing.chatId,
              qIdx,
              header: item.header ?? '',
              label: opt.label,
            },
          },
        ],
      });
    }
  });
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: '<font color="grey">点选项按钮即可；也可直接回复选项名。</font>',
  });
  return {
    schema: '2.0',
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `[${taskName}] 需要你确认` },
    },
    body: { direction: 'vertical', padding: '12px', elements },
  };
}

/**
 * Terminal patch for a question card once an option is picked: replaces the buttons with a
 * plain "已选择 X" so the card can't be answered twice and the choice is on record.
 */
export function buildQuestionAnsweredCard(taskName: string, answer: string): object {
  return {
    schema: '2.0',
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: `[${taskName}] 已确认` },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [
        {
          tag: 'markdown',
          content: `已选择：**${answer}**\n\n<font color="grey">已转交继续处理…</font>`,
        },
      ],
    },
  };
}

/**
 * Form-card variant of the AskUserQuestion card (multi-question, 凑齐 once submit). Each question
 * renders a `select_static` (preset options) + an `input` (free-text custom, wins when filled),
 * all wrapped in a `form` so nothing fires until the user clicks 提交. The submit button's
 * action.value carries routing + total + headers (the card-action event has no chat id / question
 * text, so they travel in value); per-question answers come back in `form_value` keyed q{i}_pick /
 * q{i}_custom. 2.0 schema (form / select_static / form_action_type) — verify on first real run.
 */
// WS-9：managed run（非 bridge task）里 AskUserQuestion 的提交按钮 kind（区别于 bridge task 的 'auq'）。
export const AUQ_WORKITEM_ACTION_KIND = 'auq-wi';

// 共享的 AUQ 表单卡构建：每题一个 select（预设）+ input（自定义）+ 一个提交按钮。submit 按钮 value 由调用方
// 决定（bridge task 走 auq / managed run 走 auq-wi），其余结构完全一致——WS-9 抽此私有 helper 避免两份表单漂移。
function buildQuestionCardWith(
  taskName: string,
  q: AskUserQuestion,
  makeSubmitValue: (headers: string[], total: number) => object,
): object {
  const formElements: object[] = [];
  const headers: string[] = [];
  q.questions.forEach((item, qIdx) => {
    if (qIdx > 0) formElements.push({ tag: 'hr' });
    const qText = (item.question ?? '').slice(0, QUESTION_TEXT_MAX) || '(请选择)';
    const head = item.header ? `【${item.header}】` : '';
    headers.push(item.header || `问题${qIdx + 1}`);
    formElements.push({ tag: 'markdown', content: `**❓ ${head}${qText}**` });
    const opts = item.options.filter((o) => o.label);
    const optLines = opts.map((o) =>
      o.description
        ? `· **${o.label}** — ${o.description.slice(0, OPTION_DESC_MAX)}`
        : `· **${o.label}**`,
    );
    if (optLines.length) {
      formElements.push({
        tag: 'markdown',
        content: `<font color="grey">${optLines.join('\n')}</font>`,
      });
      formElements.push({
        tag: 'select_static',
        name: `q${qIdx}_pick`,
        placeholder: { tag: 'plain_text', content: '从预设里选…' },
        options: opts.map((o) => ({
          text: { tag: 'plain_text', content: o.label.slice(0, BUTTON_TEXT_MAX) },
          value: o.label,
        })),
      });
    }
    formElements.push({
      tag: 'input',
      name: `q${qIdx}_custom`,
      placeholder: { tag: 'plain_text', content: '或在此自定义（留空则用上面选的）' },
    });
  });
  formElements.push({ tag: 'hr' });
  formElements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '提交' },
    type: 'primary',
    width: 'default',
    form_action_type: 'submit',
    name: 'auq_submit',
    behaviors: [{ type: 'callback', value: makeSubmitValue(headers, q.questions.length) }],
  });
  return {
    schema: '2.0',
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `[${taskName}] 需要你确认` },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [
        { tag: 'form', name: 'auq_form', elements: formElements },
        {
          tag: 'markdown',
          content:
            '<font color="grey">每题可从下拉选预设，或在输入框自定义；填完点「提交」。</font>',
        },
      ],
    },
  };
}

export function buildQuestionFormCard(
  taskName: string,
  q: AskUserQuestion,
  routing: QuestionCardRouting,
): object {
  return buildQuestionCardWith(taskName, q, (headers, total) => ({
    kind: AUQ_ACTION_KIND,
    taskId: routing.taskId,
    chatId: routing.chatId,
    total,
    headers,
  }));
}

// WS-9：managed run 中途 AskUserQuestion 的表单卡（贴在需求群 / 话题里）。提交 → handleCardAction 的 auq-wi
// 分支组装答案 → injectHumanMessage 回灌下一轮 run（提问的那个 run 多半已收尾，答案自然进下一轮）。
export function buildWorkitemQuestionCard(
  taskName: string,
  q: AskUserQuestion,
  routing: { workitemId: string },
): object {
  return buildQuestionCardWith(taskName, q, (headers, total) => ({
    kind: AUQ_WORKITEM_ACTION_KIND,
    workitemId: routing.workitemId,
    total,
    headers,
  }));
}

/** Callback-button payload value for a checkpoint 灯卡 (通过/打回). */
export const CHECKPOINT_ACTION_KIND = 'ckpt';

// WS-5：灯卡/病历卡的意见输入框（form 内）。打回/拍板意见随 form_value.opinion 回传，index.ts
// handleCheckpointAction 在 resolveWait 之前经 injectHumanMessage 注入 → 落入下一轮 run 的 batch 窗口。
// 真机风险（runbook）：一个 form 里放多个 submit 按钮各带 value——buildQuestionFormCard 已验证单 submit
// 可行；多 submit 需真机确认各自 value 都到达，若不行回落方案见 OVERHAUL §5.1。
function opinionInput(hint: string): object {
  return {
    tag: 'input',
    name: 'opinion',
    required: false,
    placeholder: { tag: 'plain_text', content: `意见（可选）：${hint}` },
  };
}

/** Routing carried in each 灯卡 button so a click resolves the right open wait. */
export interface CheckpointCardRouting {
  itemId: string;
  waitId: string;
  boundary: string;
}

/**
 * Interactive checkpoint 灯卡 (D-03/R06): an orange card with 通过/打回 callback buttons. The
 * gate label + 4-灯 rail are pre-rendered upstream (the requirement layer owns the 灯 mapping;
 * this kernel-neutral file only renders the strings). Each button's action.value carries the
 * routing (itemId/waitId) + approved flag — the card-action event has no chat id, so it travels
 * in the value, same as the AUQ card. A click funnels through the single inject门面 (resolveWait).
 */
export function buildCheckpointCard(
  data: { title: string; gateLabel: string; rail: string; note?: string },
  routing: CheckpointCardRouting,
): object {
  const title = data.title.length > 40 ? `${data.title.slice(0, 40)}…` : data.title;
  const lines = [
    `**${data.gateLabel}** — 该你拍板了`,
    '',
    `<font color="grey">${data.rail}</font>`,
    // WS-7 灯③ 厚化：把「对账是否生效 / 交付清单在哪」的证据以灰字注在卡上，人拍板有据。
    ...(data.note && data.note.trim() ? ['', `<font color="grey">${data.note.trim()}</font>`] : []),
    '',
    '通过 → 进入下一步。',
    '要改 → **点【打回】并填写意见**，我按意见安排返工（也可直接在群里回复）。',
  ].join('\n');
  const button = (text: string, type: string, approved: boolean): object => ({
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    width: 'default',
    form_action_type: 'submit',
    name: approved ? 'ckpt_pass' : 'ckpt_reject',
    behaviors: [
      {
        type: 'callback',
        value: {
          kind: CHECKPOINT_ACTION_KIND,
          itemId: routing.itemId,
          waitId: routing.waitId,
          boundary: routing.boundary,
          approved,
        },
      },
    ],
  });
  return {
    schema: '2.0',
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `需要你拍板 · ${title}` },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [
        { tag: 'markdown', content: lines },
        {
          tag: 'form',
          name: 'ckpt_form',
          elements: [
            opinionInput('打回原因 / 通过后想补充的方向'),
            button('通过', 'primary', true),
            button('打回', 'default', false),
          ],
        },
      ],
    },
  };
}

export interface CaseFileCardRouting {
  itemId: string;
  waitId: string;
}

/**
 * WS-10.9 取消确认卡（red）：群里发 /cancel → 需求侧升起 cancel_confirm wait → 出此卡。确认 → 整单终态
 * cancelled（在途 run 中止、worktree 分支保留）；「继续推进」→ 原有 waits/runs 原封不动。普通 callback 按钮。
 */
export function buildCancelConfirmCard(title: string, routing: CaseFileCardRouting): object {
  const head = title.length > 40 ? `${title.slice(0, 40)}…` : title;
  const button = (text: string, type: string, approved: boolean): object => ({
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    width: 'default',
    behaviors: [
      {
        type: 'callback',
        value: {
          kind: CHECKPOINT_ACTION_KIND,
          itemId: routing.itemId,
          waitId: routing.waitId,
          approved,
        },
      },
    ],
  });
  return {
    schema: '2.0',
    header: {
      template: 'red',
      title: { tag: 'plain_text', content: `确认终止需求 · ${head}` },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [
        {
          tag: 'markdown',
          content: '确认终止需求？各仓在途工作将被中止，已产出的 worktree 分支保留。',
        },
        button('⚠️ 确认终止', 'danger', true),
        button('继续推进', 'default', false),
      ],
    },
  };
}

/**
 * WS-7.7 灯④ 关单卡：交付相位「等人关单」的 awaiting_close wait 出此卡（orange）。确认各仓分支已合并/上线后
 * 点关单 → 整单 done；「暂不」→ 保持打开（重弹）。/done 命令是等价出口。普通 callback 按钮（无意见输入）。
 */
export function buildClosureCard(
  data: { title: string; note?: string },
  routing: CaseFileCardRouting,
): object {
  const title = data.title.length > 40 ? `${data.title.slice(0, 40)}…` : data.title;
  const lines = [
    '**交付待关单（灯④）** — 集成验证已过灯③，交付清单见上方卡片。',
    ...(data.note && data.note.trim() ? ['', `<font color="grey">${data.note.trim()}</font>`] : []),
    '',
    '确认各仓分支已合并 / 上线后点【确认关单】收尾整单。',
  ].join('\n');
  const button = (text: string, type: string, approved: boolean): object => ({
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    width: 'default',
    behaviors: [
      {
        type: 'callback',
        value: {
          kind: CHECKPOINT_ACTION_KIND,
          itemId: routing.itemId,
          waitId: routing.waitId,
          approved,
        },
      },
    ],
  });
  return {
    schema: '2.0',
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `交付待关单 · ${title}` },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [
        { tag: 'markdown', content: lines },
        button('✅ 确认关单 · 整单完成', 'primary', true),
        button('暂不，保持打开', 'default', false),
      ],
    },
  };
}

/**
 * Interactive 病历卡 (case file) — for a raised human wait that is NOT a routine 关卡 checkpoint
 * (对账冲突 / 监工判大 / 执行报错 / 集成未决). Unlike a 灯卡's 通过/打回, a 病历 offers【已处理·继续】
 * (the human fixed / accepted it → the caller's forward action) and【终止需求】(abandon the whole
 * unit — the only clean exit for a 病历 that keeps re-raising, e.g. an un-resolvable对账). Both
 * funnel through the same card-action handler; the cancel button carries `cancel:true` so the
 * handler resolves the wait with a cancel decision (→ terminal cancelled). Kept kernel-neutral
 * (no upper-layer vocabulary) so this file holds the architecture red-line.
 */
export function buildCaseFileCard(
  data: { title: string; label: string; detail?: string },
  routing: CaseFileCardRouting,
): object {
  const title = data.title.length > 40 ? `${data.title.slice(0, 40)}…` : data.title;
  const lines = [
    `**${data.label}** — 系统卡住了，需要你裁决`,
    ...(data.detail && data.detail.trim()
      ? ['', `<font color="grey">${data.detail.trim()}</font>`]
      : []),
    '',
    '处理好后点【已处理·继续】我接着往下推；这条推不动就点【终止需求】放弃。',
  ].join('\n');
  const button = (
    text: string,
    type: string,
    name: string,
    extra: Record<string, unknown>,
  ): object => ({
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    width: 'default',
    form_action_type: 'submit',
    name,
    behaviors: [
      {
        type: 'callback',
        value: {
          kind: CHECKPOINT_ACTION_KIND,
          itemId: routing.itemId,
          waitId: routing.waitId,
          caseLabel: data.label,
          ...extra,
        },
      },
    ],
  });
  return {
    schema: '2.0',
    header: {
      template: 'red',
      title: { tag: 'plain_text', content: `需要你裁决 · ${title}` },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [
        { tag: 'markdown', content: lines },
        {
          tag: 'form',
          name: 'case_form',
          elements: [
            opinionInput('我改了什么 / 为什么这么处理'),
            button('已处理·继续', 'primary', 'case_proceed', { approved: true }),
            button('终止需求', 'danger', 'case_cancel', { cancel: true }),
          ],
        },
      ],
    },
  };
}

/**
 * WS-5 监工判大专属卡：跨仓外溢/疑则上报后，红线出口不再只有「放行」——给三条前进方向：
 * ①【已改图纸·重对账并返工】(approved,action:'rework') → 派 owner 重对账人改过的图纸 → 定向返工受影响仓；
 * ②【无需改·放行】(approved,action:'proceed') → 继续评估（现状）；③【终止需求】(cancel)。设计仍只有人能改
 * （agent 只重对账），红线不放松。opinion 输入框随 form 回传，handleCheckpointAction 注入下一轮 run。
 */
export function buildGatekeeperBigCard(
  data: { title: string; label: string; detail?: string },
  routing: CaseFileCardRouting,
): object {
  const title = data.title.length > 40 ? `${data.title.slice(0, 40)}…` : data.title;
  const lines = [
    `**${data.label}** — 有跨仓外溢，需要你裁决`,
    ...(data.detail && data.detail.trim()
      ? ['', `<font color="grey">${data.detail.trim()}</font>`]
      : []),
    '',
    '· 要改跨仓图纸：你改好设计后点【已改图纸·重对账并返工】，我重对账并定向返工受影响的仓。',
    '· 无需改：点【无需改·放行】继续评估。',
    '· 彻底放弃：点【终止需求】。',
  ].join('\n');
  const button = (
    text: string,
    type: string,
    name: string,
    extra: Record<string, unknown>,
  ): object => ({
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    width: 'default',
    form_action_type: 'submit',
    name,
    behaviors: [
      {
        type: 'callback',
        value: {
          kind: CHECKPOINT_ACTION_KIND,
          itemId: routing.itemId,
          waitId: routing.waitId,
          caseLabel: data.label,
          ...extra,
        },
      },
    ],
  });
  return {
    schema: '2.0',
    header: {
      template: 'red',
      title: { tag: 'plain_text', content: `需要你裁决 · ${title}` },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [
        { tag: 'markdown', content: lines },
        {
          tag: 'form',
          name: 'gk_form',
          elements: [
            opinionInput('改了哪些图纸 / 为什么放行'),
            button('已改图纸·重对账并返工', 'primary', 'gk_rework', {
              approved: true,
              action: 'rework',
            }),
            button('无需改·放行', 'default', 'gk_proceed', { approved: true, action: 'proceed' }),
            button('终止需求', 'danger', 'gk_cancel', { cancel: true }),
          ],
        },
      ],
    },
  };
}

/** Terminal patch for a 病历卡 after a button click (已处理继续 / 已终止需求). */
export function buildCaseFileAnsweredCard(
  title: string,
  label: string,
  cancelled: boolean,
): object {
  const head = title.length > 40 ? `${title.slice(0, 40)}…` : title;
  const verb = cancelled ? '已终止需求' : '已处理·继续';
  return {
    schema: '2.0',
    header: {
      template: cancelled ? 'grey' : 'green',
      title: { tag: 'plain_text', content: `${verb} · ${head}` },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [
        {
          tag: 'markdown',
          content: cancelled
            ? `**${label}**：已取消整个需求。`
            : `**${label}**：已按你的处理继续推进…`,
        },
      ],
    },
  };
}

/**
 * Terminal patch for a 灯卡 once a button is clicked (or the wait was resolved elsewhere):
 * replaces the buttons with a plain "已通过/已打回/已处理" so it can't be answered twice.
 * approved === null means it was already resolved through another channel (board / double click).
 */
export function buildCheckpointAnsweredCard(
  title: string,
  gateLabel: string,
  approved: boolean | null,
): object {
  const head = title.length > 40 ? `${title.slice(0, 40)}…` : title;
  const verb = approved === null ? '已处理' : approved ? '已通过' : '已打回';
  const template = approved === true ? 'green' : 'grey';
  return {
    schema: '2.0',
    header: {
      template,
      title: { tag: 'plain_text', content: `${verb} · ${head}` },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      elements: [
        {
          tag: 'markdown',
          content: `**${gateLabel}**：${verb}\n\n<font color="grey">已转交继续处理…</font>`,
        },
      ],
    },
  };
}
