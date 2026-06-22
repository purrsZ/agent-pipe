import type { ItemSummary, ItemView } from './types.js';

// Pure SSR (R17). Returns HTML strings from the neutral view-model — no DB, no fs, no
// business vocabulary. Every区块 has an独立 empty state (R17.AC-7): a freshly-created item
// (only brief.md, no events / runs / focus) renders placeholders, never a 500.

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function layout(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="zh"><head><meta charset="utf-8">',
    `<title>${esc(title)}</title>`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<style>body{font-family:system-ui,sans-serif;margin:24px;color:#2b2b2b;background:#fbf7f0}',
    'h1,h2{color:#7a2b2b}.card{border:1px solid #e3d9c8;border-radius:8px;padding:12px;margin:12px 0;background:#fff}',
    '.muted{color:#999}.rail{display:flex;gap:8px;flex-wrap:wrap}.pill{border:1px solid #ccc;border-radius:12px;padding:2px 10px;font-size:13px}',
    'pre{white-space:pre-wrap;background:#f6f1e7;padding:10px;border-radius:6px}button{cursor:pointer}</style>',
    '</head><body>',
    body,
    '</body></html>',
  ].join('\n');
}

export function renderBoard(items: ItemSummary[]): string {
  const rows =
    items.length === 0
      ? '<p class="muted">暂无需求。</p>'
      : items
          .map(
            (i) =>
              `<div class="card"><a href="/item/${esc(i.id)}"><b>${esc(i.title)}</b></a>` +
              `<div class="rail"><span class="pill">${esc(i.stage)}</span><span class="pill">${esc(i.status)}</span></div></div>`,
          )
          .join('\n');
  return layout('需求看板', `<h1>需求看板</h1>${rows}`);
}

export function renderItem(view: ItemView): string {
  const { summary, runs, focus, activity, docs } = view;

  const focusBlock =
    focus.length === 0
      ? '<p class="muted">当前没有需要你拍板的事。</p>'
      : focus
          .map(
            (f) =>
              `<div class="card" style="border-color:#c0392b">` +
              `<b>该你拍一下：</b> ${esc(f.reason)}` +
              `<form method="post" action="/item/${esc(summary.id)}/resolve">` +
              `<input type="hidden" name="waitId" value="${esc(f.waitId)}">` +
              `<input name="reason" placeholder="理由（打回必填）" />` +
              `<button name="approved" value="true">通过</button> ` +
              `<button name="approved" value="false">打回</button></form></div>`,
          )
          .join('\n');

  const runsBlock =
    runs.length === 0
      ? '<p class="muted">还没有工人。</p>'
      : `<div class="rail">${runs
          .map(
            (r) =>
              `<span class="pill">${esc(r.role)} · ${esc(r.repo ?? '—')} · ${esc(r.status)}</span>`,
          )
          .join('')}</div>`;

  const activityBlock =
    activity.length === 0
      ? '<p class="muted">暂无活动。</p>'
      : `<ul>${activity.map((a) => `<li>${esc(a.kind)}</li>`).join('')}</ul>`;

  const docsBlock =
    docs.length === 0
      ? '<p class="muted">暂无文档。</p>'
      : docs
          .map(
            (d) =>
              `<details><summary>${esc(d.name)}</summary><pre>${esc(d.content)}</pre></details>`,
          )
          .join('\n');

  const body = [
    `<h1>${esc(summary.title)}</h1>`,
    `<div class="rail"><span class="pill">${esc(summary.stage)}</span><span class="pill">${esc(summary.status)}</span></div>`,
    '<h2>该你了</h2>',
    focusBlock,
    '<h2>各端工人</h2>',
    runsBlock,
    '<h2>@包工头</h2>',
    `<form method="post" action="/item/${esc(summary.id)}/message"><input name="text" placeholder="给包工头留言（不打断在跑的工人）" /><button>发送</button></form>`,
    '<h2>活动流</h2>',
    activityBlock,
    '<h2>产物</h2>',
    docsBlock,
  ].join('\n');

  return layout(summary.title, body);
}
