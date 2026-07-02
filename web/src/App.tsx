import { useCallback, useEffect, useMemo, useState } from 'react';
import { resolveDecisionLocal } from './actions.js';
import { fetchBoard, postResolve } from './api.js';
import { Board } from './Board.js';
import { Detail } from './Detail.js';
import { buildBoard, buildVM } from './derive.js';
import { SEED } from './seed.js';
import { accentColor } from './theme.js';
import type { Accent, BoardData } from './types.js';
import { isInflight } from './types.js';
import { css } from './ui.js';

// 顶层外壳 + 顶栏 + 看板/详情切换。数据走真 API（GET /api/requirement-board，5s 轮询）；连不上后端时
// 回退到 seed 假数据并在顶栏打「演示数据」标，让 npm run dev 无后端也能看 UI。拍板回流串上具体 waitId，
// 走后端 POST /api/requirement/resolve（与飞书灯卡同一 resolveWait 单写口）。
const ACCENT: Accent = 'cyan';
const SHOW_HISTORY = true;
const POLL_MS = 5000;

export function App(): JSX.Element {
  const [data, setData] = useState<BoardData>(SEED);
  const [degraded, setDegraded] = useState(true); // 首帧未连上前按降级处理
  const [view, setView] = useState<'board' | 'detail'>('board');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const board = await fetchBoard();
      setData(board);
      setDegraded(false);
    } catch {
      // 轮询失败：保留上一次好数据（首帧则仍是 seed），仅打降级标，不闪烁清空。
      setDegraded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [reload]);

  const board = useMemo(() => buildBoard(data, ACCENT, SHOW_HISTORY), [data]);
  const accentCol = accentColor(ACCENT);

  const selected =
    view === 'detail' && selectedId ? data.reqs.find((r) => r.id === selectedId) : undefined;
  const detailVM = selected && isInflight(selected) ? buildVM(selected, data.extra, ACCENT) : null;

  const open = (id: string) => {
    setSelectedId(id);
    setView('detail');
  };
  const back = () => setView('board');
  const resolve = useCallback(
    async (waitId: string) => {
      if (degraded) {
        // 演示模式：本地乐观更新（与原型一致）。
        if (selectedId) setData((d) => resolveDecisionLocal(d, selectedId));
        return;
      }
      try {
        await postResolve(waitId, true, '');
      } catch (e) {
        console.error('拍板回流失败（可能未配置 WORKBENCH_TOKEN）', e);
      }
      await reload();
    },
    [degraded, selectedId, reload],
  );

  return (
    <div
      style={css(
        "height:100vh;display:flex;flex-direction:column;background:#0c0e12;color:#e8eaed;font-family:'IBM Plex Sans',-apple-system,sans-serif;font-size:14px;overflow:hidden",
      )}
    >
      <div
        style={css(
          'height:56px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:0 24px;border-bottom:1px solid #1d2129;background:#0e1016',
        )}
      >
        <div style={css('display:flex;align-items:center;gap:12px')}>
          <div
            style={css(
              'width:9px;height:9px;border-radius:50%;background:#3fb950;box-shadow:0 0 10px #3fb95077',
            )}
          />
          <span style={css('font-weight:700;font-size:15px;letter-spacing:.2px')}>需求管控台</span>
          <span
            style={css(
              "font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#7d8694;padding-left:2px",
            )}
          >
            agent-pipe · 一人扛需求
          </span>
          {degraded && (
            <span
              style={css(
                "font-size:11px;color:#e3a008;background:#2a2008;border:1px solid #4a3a12;padding:2px 9px;border-radius:20px;font-family:'IBM Plex Mono',monospace",
              )}
            >
              演示数据 · 未连后端
            </span>
          )}
        </div>
        <div style={css('display:flex;align-items:center;gap:18px;font-size:12.5px;color:#9aa0ac')}>
          <span>
            并发上限&nbsp;
            <b style={css("color:#e8eaed;font-family:'IBM Plex Mono',monospace")}>
              {board.capacityText}
            </b>
          </span>
          <span style={css('width:1px;height:16px;background:#262c37')} />
          <span style={css('display:flex;align-items:center;gap:6px')}>
            <span style={css('color:#e3a008')}>⚑</span>待你拍板&nbsp;
            <b style={css("color:#e3a008;font-family:'IBM Plex Mono',monospace")}>
              {board.decisionCount}
            </b>
          </span>
        </div>
      </div>

      <div style={css('flex:1;overflow-y:auto;outline:none')}>
        {view === 'board' && <Board board={board} onOpen={open} />}
        {view === 'detail' && detailVM && (
          <Detail vm={detailVM} accentCol={accentCol} onBack={back} onResolve={resolve} />
        )}
      </div>
    </div>
  );
}
