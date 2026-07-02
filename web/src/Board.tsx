import type { BoardVM } from './derive.js';
import { Hover, css } from './ui.js';

// 看板总览屏 —— 移植自原型 isBoard 段（dc_document.html 28-119）。
export function Board({
  board,
  onOpen,
}: {
  board: BoardVM;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <div
      data-screen-label="看板总览"
      style={css('padding:28px 24px 56px;max-width:1180px;margin:0 auto')}
    >
      {board.hasDecisions && (
        <div
          style={css(
            'background:linear-gradient(180deg,#211a0a,#181307);border:1px solid #4a3a12;border-radius:12px;padding:18px 20px;margin-bottom:28px',
          )}
        >
          <div style={css('display:flex;align-items:center;gap:9px;margin-bottom:14px')}>
            <span style={css('color:#e3a008;font-size:15px')}>⚑</span>
            <span style={css('font-weight:600;font-size:14px;color:#f0c14b')}>等我拍板</span>
            <span
              style={css(
                "font-family:'IBM Plex Mono',monospace;font-size:12px;color:#9a7b2a;background:#2a2008;padding:1px 8px;border-radius:20px",
              )}
            >
              {board.decisionCount}
            </span>
          </div>
          <div style={css('display:flex;flex-direction:column;gap:8px')}>
            {board.decisionItems.map((d) => (
              <Hover
                key={d.id}
                onClick={() => onOpen(d.id)}
                base="display:flex;align-items:center;gap:14px;padding:12px 14px;background:#16130b;border:1px solid #332810;border-radius:9px;cursor:pointer"
                hover="border-color:#5a460f;background:#1a160c"
              >
                <span
                  style={css(
                    "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#9a7b2a;background:#241c08;padding:2px 7px;border-radius:5px;flex:none",
                  )}
                >
                  {d.idMono}
                </span>
                <div style={css('flex:1;min-width:0')}>
                  <div style={css('font-weight:600;font-size:13.5px;color:#e8eaed')}>{d.name}</div>
                  <div style={css('font-size:12px;color:#b89a52;margin-top:3px')}>
                    {d.waitBadge}
                  </div>
                </div>
                <span style={css('font-size:12.5px;color:#f0c14b;flex:none;font-weight:500')}>
                  去处理 →
                </span>
              </Hover>
            ))}
          </div>
        </div>
      )}

      <div style={css('display:flex;align-items:baseline;gap:10px;margin-bottom:16px')}>
        <span style={css('font-weight:600;font-size:13px;color:#e8eaed')}>在途需求</span>
        <span style={css("font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:#7d8694")}>
          {board.capacityText}
        </span>
      </div>

      <div style={css('display:flex;flex-direction:column;gap:14px')}>
        {board.items.map((item) => (
          <Hover
            key={item.id}
            onClick={() => onOpen(item.id)}
            base="background:#14171e;border:1px solid #171a20;border-radius:12px;padding:18px 20px;cursor:pointer;display:flex;flex-direction:column;gap:15px"
            hover="border-color:#323a48;background:#161a22"
          >
            <div style={css('display:flex;align-items:center;gap:11px')}>
              <span style={css('font-weight:600;font-size:15px;color:#e8eaed')}>{item.name}</span>
              <span
                style={css(
                  "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#7d8694;background:#1b2029;padding:2px 7px;border-radius:5px",
                )}
              >
                {item.idMono}
              </span>
              <span
                style={css(
                  `display:flex;align-items:center;gap:5px;font-size:11.5px;color:${item.healthColor}`,
                )}
              >
                <span
                  style={css(
                    `width:6px;height:6px;border-radius:50%;background:${item.healthColor}`,
                  )}
                />
                {item.healthLabel}
              </span>
              <div style={css('flex:1')} />
              {item.waitOnHuman && (
                <span
                  style={css(
                    'display:flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;color:#f0c14b;background:#2a2008;border:1px solid #4a3a12;padding:3px 10px;border-radius:20px',
                  )}
                >
                  ⚑ 待你拍板
                </span>
              )}
            </div>

            <div>
              <div
                style={css(
                  'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px',
                )}
              >
                <span style={css('font-size:12px;color:#9aa0ac')}>
                  阶段&nbsp;·&nbsp;
                  <b style={css('color:#e8eaed;font-weight:600')}>{item.stageLabel}</b>
                </span>
                <div style={css('display:flex;align-items:center;gap:7px')}>
                  {item.lights.map((lg) => (
                    <span
                      key={lg.n}
                      title={lg.label}
                      style={css(
                        `width:19px;height:19px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-family:'IBM Plex Mono',monospace;border:1.5px solid ${lg.color};color:${lg.color}`,
                      )}
                    >
                      {lg.n}
                    </span>
                  ))}
                </div>
              </div>
              <div style={css('display:flex;gap:3px;height:7px')}>
                {item.stages.map((st) => (
                  <div
                    key={st.name}
                    style={css(`flex:1;border-radius:2px;background:${st.color}`)}
                  />
                ))}
              </div>
            </div>

            <div
              style={css('display:flex;align-items:center;gap:10px;font-size:12.5px;color:#9aa0ac')}
            >
              <span style={css('display:flex;align-items:center;gap:4px;flex:none')}>
                {item.workerDots.map((d, i) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: 工人圆点纯展示、无稳定 id
                    key={i}
                    style={css(`width:7px;height:7px;border-radius:50%;background:${d.color}`)}
                  />
                ))}
              </span>
              <span style={css('color:#3a4150')}>|</span>
              <span
                style={css(
                  'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
                )}
              >
                {item.summary}
              </span>
              <span style={css('flex:none;color:#5b626f')}>详情 →</span>
            </div>
          </Hover>
        ))}
      </div>

      {board.hasHistory && (
        <div style={css('margin-top:32px')}>
          <div
            style={css(
              'font-weight:600;font-size:12px;color:#7d8694;margin-bottom:12px;letter-spacing:.3px',
            )}
          >
            已交付归档
          </div>
          <div
            style={css(
              'display:flex;flex-direction:column;gap:1px;border:1px solid #1a1f27;border-radius:9px;overflow:hidden',
            )}
          >
            {board.historyItems.map((h) => (
              <div
                key={h.idMono}
                style={css(
                  'display:flex;align-items:center;gap:12px;padding:11px 16px;background:#101319;font-size:12.5px',
                )}
              >
                <span
                  style={css('width:6px;height:6px;border-radius:50%;background:#2f6f3e;flex:none')}
                />
                <span
                  style={css("font-family:'IBM Plex Mono',monospace;font-size:11px;color:#5b626f")}
                >
                  {h.idMono}
                </span>
                <span style={css('color:#8b919e;flex:1')}>{h.name}</span>
                <span style={css('color:#5b626f;font-size:11.5px')}>{h.when}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
