import type { TurnResult } from '../agents/types.js';
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
  const headTitle = data.closed
    ? `已关闭 · ${title}`
    : failed
      ? `调查失败 · ${title}`
      : `调查 · ${title}`;
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
 * M1b WI-7: maps a committed main event + terminal flag to the outbound card action(s).
 * Pure (takes raw kind + bool, no work-item types) so it's unit-testable in isolation and
 * lets the bridge wiring pass `isTerminalStatus(...)` instead of writing `status===`
 * (which the index guard forbids).
 *  - run_failed at a terminal state → error card AND refresh the anchor to its failed state.
 *  - any other terminal (i.e. done) → skip: runDone already refreshed the anchor on /done.
 *  - non-terminal progress          → refresh the anchor stage only.
 */
export function anchorAction(
  kind: string,
  isTerminal: boolean,
): { reply: boolean; update: boolean } {
  if (kind === 'run_failed' && isTerminal) return { reply: true, update: true };
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
