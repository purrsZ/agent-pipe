import type { Task } from '../store.js';
import type { TurnResult } from '../agents/types.js';

const MAX_CARD_MARKDOWN = 28_000;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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
      ? text.slice(0, MAX_CARD_MARKDOWN) + '\n\n_…已截断，完整结果请在本地查看 session_'
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
  if (r.durationMs !== undefined) metaParts.push(`${Math.round(r.durationMs / 1000)}s`);
  if (r.toolCount > 0) metaParts.push(`${r.toolCount} tools`);

  const ctxUsed =
    (r.inputTokens ?? 0) +
    (r.cacheCreationInputTokens ?? 0) +
    (r.cacheReadInputTokens ?? 0);
  const ctxWindow = r.contextWindow;
  let ctxPct: number | null = null;
  if (ctxUsed > 0 && ctxWindow && ctxWindow > 0) {
    ctxPct = (ctxUsed / ctxWindow) * 100;
    metaParts.push(`ctx ${ctxPct.toFixed(1)}% (${formatTokens(ctxUsed)} / ${formatTokens(ctxWindow)})`);
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
      content: `<font color="orange">⚠ 上下文已用 ${ctxPct.toFixed(1)}%，建议尽快用 \`/clear ${taskName}\` 清空会话以避免触发压缩。</font>`,
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
