import { useState } from 'react';
import type { ReqVM } from './derive.js';
import { Hover, HoverBtn, css } from './ui.js';

// 需求详情屏 —— 移植自原型 isDetail 段（dc_document.html 122-362）。worker 展开态用本地 state 接管。
export function Detail({
  vm,
  accentCol,
  onBack,
  onResolve,
}: {
  vm: ReqVM;
  accentCol: string;
  onBack: () => void;
  onResolve: (waitId: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const toggle = (i: number) => setExpanded((s) => ({ ...s, [i]: !s[i] }));

  return (
    <div
      data-screen-label="需求详情"
      style={css('padding:22px 24px 56px;max-width:1280px;margin:0 auto')}
    >
      <div style={css('display:flex;align-items:center;gap:14px;margin-bottom:22px')}>
        <HoverBtn
          onClick={onBack}
          base="display:flex;align-items:center;gap:6px;background:#161a22;border:1px solid #262c37;color:#c3c9d4;font-size:12.5px;padding:7px 13px;border-radius:8px;cursor:pointer;font-family:inherit"
          hover="border-color:#3a4350;background:#1b212b"
        >
          ← 返回看板
        </HoverBtn>
        <span style={css('font-weight:700;font-size:18px;color:#fff')}>{vm.name}</span>
        <span
          style={css(
            "font-family:'IBM Plex Mono',monospace;font-size:12px;color:#7d8694;background:#1b2029;padding:3px 9px;border-radius:6px",
          )}
        >
          {vm.idMono}
        </span>
        <span
          style={css(
            `display:flex;align-items:center;gap:5px;font-size:12px;color:${vm.healthColor};border:1px solid ${vm.healthColor}44;padding:3px 10px;border-radius:20px`,
          )}
        >
          <span
            style={css(`width:6px;height:6px;border-radius:50%;background:${vm.healthColor}`)}
          />
          {vm.healthLabel}
        </span>
      </div>

      {/* 指标行 */}
      <div style={css('display:flex;gap:14px;margin-bottom:14px')}>
        <div
          style={css(
            'flex:1.5;background:#14171e;border:1px solid #171a20;border-radius:12px;padding:14px 16px',
          )}
        >
          <div style={css('font-size:11px;color:#6b7280;margin-bottom:9px')}>总进度</div>
          <div style={css('display:flex;align-items:center;gap:10px')}>
            <div
              style={css('flex:1;height:7px;background:#1b212b;border-radius:4px;overflow:hidden')}
            >
              <div
                style={css(
                  `height:100%;width:${vm.metrics.progress}%;background:${vm.metrics.progressColor};border-radius:4px`,
                )}
              />
            </div>
            <span
              style={css(
                "font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600;color:#e8eaed",
              )}
            >
              {vm.metrics.progress}%
            </span>
          </div>
        </div>
        <div
          style={css(
            'flex:1;background:#14171e;border:1px solid #171a20;border-radius:12px;padding:14px 16px',
          )}
        >
          <div style={css('font-size:11px;color:#6b7280;margin-bottom:7px')}>WorkItem</div>
          <div
            style={css(
              "font-family:'IBM Plex Mono',monospace;font-size:18px;font-weight:600;color:#e8eaed",
            )}
          >
            {vm.metrics.wiText}
          </div>
        </div>
        <div
          style={css(
            'flex:1;background:#14171e;border:1px solid #171a20;border-radius:12px;padding:14px 16px',
          )}
        >
          <div style={css('font-size:11px;color:#6b7280;margin-bottom:7px')}>已耗时</div>
          <div
            style={css(
              "font-family:'IBM Plex Mono',monospace;font-size:18px;font-weight:600;color:#e8eaed",
            )}
          >
            {vm.metrics.elapsed}
          </div>
        </div>
        <div
          style={css(
            'flex:1.3;background:#14171e;border:1px solid #171a20;border-radius:12px;padding:14px 16px',
          )}
        >
          <div style={css('font-size:11px;color:#6b7280;margin-bottom:7px')}>预计</div>
          <div style={css(`font-size:14px;font-weight:600;color:${vm.metrics.etaColor}`)}>
            {vm.metrics.eta}
          </div>
        </div>
      </div>

      {vm.hasFocus && (
        <div
          style={css(
            `display:flex;align-items:flex-start;gap:12px;background:${vm.focusBg};border:1px solid ${vm.focusBorder};border-radius:12px;padding:15px 18px;margin-bottom:16px`,
          )}
        >
          <span style={css(`font-size:16px;color:${vm.focusColor};flex:none;line-height:1.3`)}>
            {vm.focusIcon}
          </span>
          <div>
            <div
              style={css(
                `font-size:11px;font-weight:600;letter-spacing:.5px;color:${vm.focusColor};margin-bottom:4px`,
              )}
            >
              当前焦点
            </div>
            <div style={css('font-size:13.5px;color:#dfe3e9;line-height:1.55')}>{vm.focusText}</div>
          </div>
        </div>
      )}

      <div
        style={css('display:grid;grid-template-columns:296px 1fr 348px;gap:18px;align-items:start')}
      >
        {/* 左列：阶段时间线 + 关卡灯 */}
        <div style={css('display:flex;flex-direction:column;gap:18px')}>
          <div
            style={css(
              'background:#14171e;border:1px solid #171a20;border-radius:12px;padding:18px 18px 6px',
            )}
          >
            <div
              style={css(
                'font-size:11.5px;font-weight:600;color:#7d8694;letter-spacing:.5px;margin-bottom:16px',
              )}
            >
              阶段时间线 · 5 步
            </div>
            {vm.stages.map((st) => (
              <div
                key={st.name}
                style={css('display:flex;gap:13px;align-items:stretch;min-height:42px')}
              >
                <div style={css('display:flex;flex-direction:column;align-items:center;flex:none')}>
                  <div
                    style={css(
                      `width:13px;height:13px;border-radius:50%;background:${st.dotColor};box-shadow:0 0 0 3px ${st.haloColor};flex:none`,
                    )}
                  />
                  {st.line && (
                    <div
                      style={css(`flex:1;width:2px;background:${st.lineColor};margin-top:3px`)}
                    />
                  )}
                </div>
                <div style={css('padding-bottom:14px')}>
                  <div style={css(`font-size:13.5px;font-weight:500;color:${st.nameColor}`)}>
                    {st.name}
                  </div>
                  <div style={css('font-size:11.5px;color:#6b7280;margin-top:2px')}>
                    {st.statusLabel}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div
            style={css(
              'background:#14171e;border:1px solid #171a20;border-radius:12px;padding:18px',
            )}
          >
            <div
              style={css(
                'font-size:11.5px;font-weight:600;color:#7d8694;letter-spacing:.5px;margin-bottom:16px',
              )}
            >
              关卡灯 · 你的拍板点
            </div>
            <div style={css('display:flex;flex-direction:column;gap:14px')}>
              {vm.lights.map((lg) => (
                <div key={lg.n} style={css('display:flex;align-items:center;gap:12px')}>
                  <span
                    style={css(
                      `width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-family:'IBM Plex Mono',monospace;border:1.5px solid ${lg.color};color:${lg.color};flex:none;box-shadow:0 0 0 3px ${lg.haloColor}`,
                    )}
                  >
                    {lg.n}
                  </span>
                  <div style={css('flex:1')}>
                    <div style={css('font-size:13px;color:#dfe3e9;font-weight:500')}>
                      {lg.label}
                    </div>
                    <div style={css(`font-size:11.5px;color:${lg.color};margin-top:2px`)}>
                      {lg.statusLabel}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 中列：各仓工人 + WorkItem 清单 + 集成验证 + 对接合同 */}
        <div style={css('display:flex;flex-direction:column;gap:18px;min-width:0')}>
          <div
            style={css(
              'background:#14171e;border:1px solid #171a20;border-radius:12px;padding:18px',
            )}
          >
            <div
              style={css(
                'display:flex;align-items:center;justify-content:space-between;margin-bottom:15px',
              )}
            >
              <span
                style={css('font-size:11.5px;font-weight:600;color:#7d8694;letter-spacing:.5px')}
              >
                各仓工人
              </span>
              <span
                style={css("font-size:11px;color:#5b626f;font-family:'IBM Plex Mono',monospace")}
              >
                点击展开
              </span>
            </div>
            <div style={css('display:flex;flex-direction:column;gap:9px')}>
              {vm.workers.map((w, i) => (
                <Hover
                  key={w.repo}
                  onClick={() => toggle(i)}
                  base="border:1px solid #191d23;border-radius:9px;padding:13px 15px;cursor:pointer;background:#11141a"
                  hover="border-color:#2c3340"
                >
                  <div style={css('display:flex;align-items:center;gap:11px')}>
                    <span
                      style={css(
                        "font-family:'IBM Plex Mono',monospace;font-size:12px;color:#c3c9d4;flex:none",
                      )}
                    >
                      {w.repo}
                    </span>
                    <span
                      style={css(
                        'flex:1;min-width:0;font-size:12.5px;color:#8b919e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
                      )}
                    >
                      {w.task}
                    </span>
                    <span
                      style={css(
                        `flex:none;display:flex;align-items:center;gap:5px;font-size:11px;color:${w.stateColor};background:${w.stateBg};padding:3px 9px;border-radius:20px`,
                      )}
                    >
                      <span
                        style={css(
                          `width:5px;height:5px;border-radius:50%;background:${w.stateColor}`,
                        )}
                      />
                      {w.stateLabel}
                    </span>
                    <span style={css(`flex:none;font-size:11px;color:${w.selfColor}`)}>
                      {w.selfLabel}
                    </span>
                  </div>
                  {expanded[i] && (
                    <div
                      style={css(
                        'margin-top:11px;padding-top:11px;border-top:1px solid #191d23;font-size:12px;color:#8b919e;line-height:1.55',
                      )}
                    >
                      {w.detail}
                    </div>
                  )}
                </Hover>
              ))}
            </div>
          </div>

          <div
            style={css(
              'background:#14171e;border:1px solid #171a20;border-radius:12px;padding:18px',
            )}
          >
            <div
              style={css(
                'display:flex;align-items:center;justify-content:space-between;margin-bottom:14px',
              )}
            >
              <span
                style={css('font-size:11.5px;font-weight:600;color:#7d8694;letter-spacing:.5px')}
              >
                WorkItem 清单
              </span>
              <span
                style={css("font-size:11px;color:#5b626f;font-family:'IBM Plex Mono',monospace")}
              >
                {vm.wiText}
              </span>
            </div>
            {vm.hasWorkitems && (
              <div
                style={css(
                  'display:flex;flex-direction:column;gap:1px;border:1px solid #1a1f27;border-radius:8px;overflow:hidden',
                )}
              >
                {vm.workitems.map((wi) => (
                  <div
                    key={wi.code}
                    style={css(
                      'display:flex;align-items:center;gap:11px;padding:10px 13px;background:#11141a',
                    )}
                  >
                    <span
                      style={css(
                        "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#5b626f;flex:none;width:34px",
                      )}
                    >
                      {wi.code}
                    </span>
                    <span
                      style={css(
                        "font-family:'IBM Plex Mono',monospace;font-size:11px;color:#7d8694;flex:none;width:98px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
                      )}
                    >
                      {wi.repo}
                    </span>
                    <span
                      style={css(
                        'flex:1;min-width:0;font-size:12.5px;color:#c3c9d4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
                      )}
                    >
                      {wi.title}
                    </span>
                    <span
                      style={css(
                        "flex:none;font-family:'IBM Plex Mono',monospace;font-size:11px;color:#6b7280",
                      )}
                    >
                      {wi.tests}
                    </span>
                    <span
                      style={css(
                        `flex:none;font-size:11px;color:${wi.stateColor};background:${wi.stateBg};padding:2px 9px;border-radius:20px`,
                      )}
                    >
                      {wi.stateLabel}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {vm.noWorkitems && (
              <div style={css('font-size:12.5px;color:#5b626f;padding:6px 2px;line-height:1.5')}>
                尚未拆解 —— 设计稿完成后自动生成 workitem 并分派各仓。
              </div>
            )}
          </div>

          <div
            style={css(
              'background:#14171e;border:1px solid #171a20;border-radius:12px;padding:18px',
            )}
          >
            <div
              style={css(
                'font-size:11.5px;font-weight:600;color:#7d8694;letter-spacing:.5px;margin-bottom:15px',
              )}
            >
              集成验证
            </div>
            <div style={css('display:flex;gap:12px')}>
              <div
                style={css(
                  'flex:1;background:#11141a;border:1px solid #191d23;border-radius:9px;padding:13px 15px',
                )}
              >
                <div style={css('font-size:11px;color:#6b7280')}>修复轮次</div>
                <div
                  style={css(
                    "font-size:22px;font-weight:600;font-family:'IBM Plex Mono',monospace;color:#e8eaed;margin-top:4px",
                  )}
                >
                  {vm.integration.round}
                </div>
              </div>
              <div
                style={css(
                  'flex:1;background:#11141a;border:1px solid #191d23;border-radius:9px;padding:13px 15px',
                )}
              >
                <div style={css('font-size:11px;color:#6b7280')}>差异数</div>
                <div
                  style={css(
                    `font-size:22px;font-weight:600;font-family:'IBM Plex Mono',monospace;color:${vm.integration.diffColor};margin-top:4px`,
                  )}
                >
                  {vm.integration.diffs}
                </div>
              </div>
              <div
                style={css(
                  'flex:1.4;background:#11141a;border:1px solid #191d23;border-radius:9px;padding:13px 15px',
                )}
              >
                <div style={css('font-size:11px;color:#6b7280')}>状态</div>
                <div
                  style={css(
                    `font-size:14px;font-weight:600;color:${vm.integration.statusColor};margin-top:7px`,
                  )}
                >
                  {vm.integration.status}
                </div>
              </div>
            </div>
          </div>

          <div
            style={css(
              'background:#14171e;border:1px solid #171a20;border-radius:12px;padding:18px',
            )}
          >
            <div
              style={css(
                'font-size:11.5px;font-weight:600;color:#7d8694;letter-spacing:.5px;margin-bottom:14px',
              )}
            >
              跨仓契约 · owner 对账
            </div>
            <div style={css('display:flex;align-items:center;gap:10px;margin-bottom:12px')}>
              <span
                style={css(
                  `font-size:12px;font-weight:500;color:${vm.contract.frozenColor};border:1px solid ${vm.contract.frozenColor}44;padding:3px 10px;border-radius:20px`,
                )}
              >
                {vm.contract.frozenLabel}
              </span>
              {vm.contract.breaking && (
                <span
                  style={css(
                    'font-size:11.5px;font-weight:600;color:#f0533f;background:#2a1110;border:1px solid #5a201c;padding:3px 10px;border-radius:20px',
                  )}
                >
                  ⚠ 冲突/悬空 → 等你裁决回改单仓设计
                </span>
              )}
            </div>
            <div
              style={css(
                "font-size:12.5px;color:#8b919e;line-height:1.6;background:#11141a;border:1px solid #191d23;border-radius:8px;padding:11px 13px;font-family:'IBM Plex Mono',monospace",
              )}
            >
              {vm.contract.note}
            </div>
          </div>
        </div>

        {/* 右列：风险 + 待办 + 活动流 + 决策台账 */}
        <div style={css('display:flex;flex-direction:column;gap:18px')}>
          {vm.hasRisks && (
            <div
              style={css(
                'background:#14171e;border:1px solid #171a20;border-radius:12px;padding:18px',
              )}
            >
              <div
                style={css(
                  'font-size:11.5px;font-weight:600;color:#7d8694;letter-spacing:.5px;margin-bottom:14px',
                )}
              >
                异常 · 风险
              </div>
              <div style={css('display:flex;flex-direction:column;gap:9px')}>
                {vm.risks.map((rk) => (
                  <div
                    key={rk.title}
                    style={css(
                      `background:${rk.bg};border:1px solid ${rk.border};border-radius:9px;padding:12px 13px`,
                    )}
                  >
                    <div style={css('display:flex;align-items:center;gap:7px;margin-bottom:5px')}>
                      <span
                        style={css(`width:7px;height:7px;border-radius:50%;background:${rk.color}`)}
                      />
                      <span style={css(`font-size:12.5px;font-weight:600;color:${rk.color}`)}>
                        {rk.title}
                      </span>
                    </div>
                    <div style={css('font-size:12px;color:#9aa0ac;line-height:1.5')}>
                      {rk.detail}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div
            style={css(
              'background:#14171e;border:1px solid #171a20;border-radius:12px;padding:18px',
            )}
          >
            <div
              style={css(
                'font-size:11.5px;font-weight:600;color:#7d8694;letter-spacing:.5px;margin-bottom:15px',
              )}
            >
              待办 · 等待
            </div>

            {vm.hasHumanWaits && (
              <div style={css('display:flex;flex-direction:column;gap:10px;margin-bottom:12px')}>
                {vm.humanWaits.map((hw) => (
                  <div
                    key={hw.title}
                    style={css(
                      'background:#1a1408;border:1px solid #4a3a12;border-radius:9px;padding:13px 14px',
                    )}
                  >
                    <div style={css('display:flex;align-items:center;gap:7px;margin-bottom:6px')}>
                      <span style={css('color:#e3a008;font-size:12px')}>⚑</span>
                      <span style={css('font-size:12px;font-weight:600;color:#f0c14b')}>
                        等你 · {hw.title}
                      </span>
                    </div>
                    <div
                      style={css('font-size:12px;color:#b89a52;line-height:1.5;margin-bottom:6px')}
                    >
                      {hw.desc}
                    </div>
                    <div
                      style={css('display:flex;align-items:center;justify-content:space-between')}
                    >
                      <span
                        style={css(
                          "font-size:11px;color:#8a7330;font-family:'IBM Plex Mono',monospace",
                        )}
                      >
                        {hw.age}
                      </span>
                      <HoverBtn
                        onClick={() => onResolve(hw.waitId)}
                        base="background:#e3a008;border:none;color:#1a1408;font-size:12px;font-weight:600;padding:6px 14px;border-radius:7px;cursor:pointer;font-family:inherit"
                        hover="background:#f0c14b"
                      >
                        ✓ 拍板通过
                      </HoverBtn>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {vm.hasAgentWaits && (
              <div style={css('display:flex;flex-direction:column;gap:10px')}>
                {vm.agentWaits.map((aw) => (
                  <div
                    key={aw.title}
                    style={css(
                      'background:#11141a;border:1px solid #191d23;border-radius:9px;padding:13px 14px',
                    )}
                  >
                    <div style={css('display:flex;align-items:center;gap:7px;margin-bottom:6px')}>
                      <span
                        style={css(
                          `width:7px;height:7px;border-radius:50%;background:${accentCol};box-shadow:0 0 7px ${accentCol}88`,
                        )}
                      />
                      <span style={css('font-size:12px;font-weight:600;color:#c3c9d4')}>
                        系统进行中 · {aw.title}
                      </span>
                    </div>
                    <div
                      style={css('font-size:12px;color:#8b919e;line-height:1.5;margin-bottom:5px')}
                    >
                      {aw.desc}
                    </div>
                    <span
                      style={css(
                        "font-size:11px;color:#5b626f;font-family:'IBM Plex Mono',monospace",
                      )}
                    >
                      {aw.age}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {vm.noWaits && (
              <div style={css('font-size:12.5px;color:#5b626f;padding:8px 0')}>
                暂无待办，系统自治推进中。
              </div>
            )}
          </div>

          <div
            style={css(
              'background:#14171e;border:1px solid #171a20;border-radius:12px;padding:18px',
            )}
          >
            <div
              style={css(
                'font-size:11.5px;font-weight:600;color:#7d8694;letter-spacing:.5px;margin-bottom:15px',
              )}
            >
              实时活动流
            </div>
            <div style={css('display:flex;flex-direction:column;gap:0')}>
              {vm.events.map((ev, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: 活动流按时间排列、无稳定 id
                  key={i}
                  style={css('display:flex;gap:11px;padding:9px 0;border-bottom:1px solid #1a1f27')}
                >
                  <span
                    style={css(
                      `flex:none;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;color:${ev.color};border:1px solid ${ev.color}55`,
                    )}
                  >
                    {ev.icon}
                  </span>
                  <div style={css('flex:1;min-width:0')}>
                    <div style={css('font-size:12.5px;color:#c3c9d4;line-height:1.5')}>
                      {ev.text}
                    </div>
                    <div
                      style={css(
                        "font-size:10.5px;color:#5b626f;margin-top:2px;font-family:'IBM Plex Mono',monospace",
                      )}
                    >
                      {ev.when}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            style={css(
              'background:#14171e;border:1px solid #171a20;border-radius:12px;padding:18px',
            )}
          >
            <div
              style={css(
                'font-size:11.5px;font-weight:600;color:#7d8694;letter-spacing:.5px;margin-bottom:15px',
              )}
            >
              决策台账
            </div>
            <div style={css('display:flex;flex-direction:column;gap:0')}>
              {vm.decisions.map((dec, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: 台账按时间排列、无稳定 id
                  key={i}
                  style={css(
                    'display:flex;gap:11px;padding:11px 0;border-bottom:1px solid #1a1f27',
                  )}
                >
                  <span
                    style={css(
                      `flex:none;font-size:10.5px;font-weight:600;color:${dec.typeColor};border:1px solid ${dec.typeColor}55;padding:2px 7px;border-radius:5px;height:fit-content`,
                    )}
                  >
                    {dec.typeLabel}
                  </span>
                  <div style={css('flex:1;min-width:0')}>
                    <div style={css('font-size:12.5px;color:#c3c9d4;line-height:1.5')}>
                      {dec.text}
                    </div>
                    <div
                      style={css(
                        "font-size:11px;color:#5b626f;margin-top:3px;font-family:'IBM Plex Mono',monospace",
                      )}
                    >
                      {dec.who}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
