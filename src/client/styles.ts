/**
 * 大肥鱼游戏厅 · 视觉。
 *
 * 主题：**海边的游乐园**。奶油纸做的机身、晴空与海浪做的灯箱、金色小灯泡串、
 * 底纹是浅浅的沙点阵——像一张贴在告示板上的游园海报，而不是一块工具面板。
 *
 * 两条硬规则：
 * 1. 不跟随宿主主题变量（`--dsw-alias-*` 在浅/深主题下取值不同，上一版就在
 *    浅色主题里拿到「近白文字 + 白底」糊成一片）。这里自成一套浅色调色板。
 * 2. 装饰只用 CSS 伪元素与背景层，不额外塞 DOM——面板归根到底只是个小气泡。
 */
export const SECTION_CSS = `
.wa-root {
  --wa-paper: #fdfaf3;
  --wa-paper-2: #f6f0e2;
  --wa-ink: #2b3a4a;
  --wa-ink-2: #6a7c8e;
  --wa-sea: #2f7fae;
  --wa-sea-deep: #1b5580;
  --wa-teal: #33a3a0;
  --wa-gold: #e9a83c;
  --wa-gold-2: #d98a25;
  --wa-line: rgba(43, 58, 74, 0.13);
  --wa-ok: #2fae74;
  --wa-warn: #d9902b;
  --wa-err: #d1604f;
}

/* ── 机身：奶油纸 + 沙点阵底纹 ─────────────────────────────────────────── */
.wa-cabinet {
  position: relative;
  overflow: hidden;
  border-radius: 18px;
  border: 1px solid var(--wa-line);
  background-color: var(--wa-paper);
  background-image: radial-gradient(rgba(43, 58, 74, 0.05) 1px, transparent 1.1px);
  background-size: 15px 15px;
  color: var(--wa-ink);
  font-size: 13px;
  line-height: 1.55;
  box-shadow: 0 10px 30px rgba(43, 58, 74, 0.14);
}

/* ── 灯箱：晴空 + 太阳 + 海面 + 泡泡 ──────────────────────────────────── */
.wa-hero {
  position: relative;
  padding: 16px 46px 17px 16px;
  background:
    radial-gradient(circle at 87% 16%, rgba(255, 214, 120, 0.95) 0 15px, rgba(255, 214, 120, 0.35) 15px 26px, transparent 34px),
    radial-gradient(120% 90% at 8% 0%, rgba(255, 255, 255, 0.85) 0%, transparent 52%),
    linear-gradient(168deg, #eaf7fd 0%, #cfe9f6 48%, #a9d7ee 78%, #8fcbe8 100%);
}
/* 海面波纹：数据 URI 的 SVG 重复贴，比纯 CSS 渐变更像水 */
.wa-hero::before {
  content: '';
  position: absolute;
  inset: auto 0 0 0;
  height: 13px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='44' height='13' viewBox='0 0 44 13'%3E%3Cpath d='M0 7 Q11 1 22 7 T44 7 V13 H0 Z' fill='%23fdfaf3'/%3E%3C/svg%3E");
  background-repeat: repeat-x;
  background-size: 44px 13px;
  pointer-events: none;
}
/* 泡泡：四颗小亮点轻轻浮动，纯装饰 */
.wa-hero::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    radial-gradient(circle at 15% 68%, rgba(255, 255, 255, 0.95) 0 2.6px, transparent 3.4px),
    radial-gradient(circle at 29% 84%, rgba(255, 255, 255, 0.8) 0 1.9px, transparent 2.8px),
    radial-gradient(circle at 72% 74%, rgba(255, 255, 255, 0.9) 0 2.4px, transparent 3.2px),
    radial-gradient(circle at 88% 58%, rgba(255, 255, 255, 0.75) 0 1.7px, transparent 2.5px);
  animation: wa-bob 7s ease-in-out infinite;
}
@keyframes wa-bob {
  0%, 100% { transform: translateY(0); opacity: 0.9; }
  50% { transform: translateY(-4px); opacity: 1; }
}

.wa-hero-row { display: flex; align-items: center; gap: 11px; }
.wa-mascot {
  flex: none;
  width: 46px;
  height: 46px;
  display: grid;
  place-items: center;
  font-size: 26px;
  border-radius: 15px;
  background: linear-gradient(155deg, #ffffff 0%, #e6f4fb 100%);
  border: 2px solid #ffffff;
  box-shadow: 0 4px 12px rgba(31, 105, 148, 0.24), inset 0 -2px 0 rgba(47, 127, 174, 0.12);
  transform: rotate(-3deg);
}
.wa-hero-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wa-hero-title {
  margin: 0;
  font-size: 17px;
  font-weight: 800;
  letter-spacing: 0.02em;
  color: var(--wa-sea-deep);
}
.wa-hero-sub {
  margin: 0;
  font-size: 11.5px;
  color: #4b7fa6;
  display: flex;
  align-items: center;
  gap: 5px;
}
/* 副标题前的小金锚点 */
.wa-hero-sub::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--wa-gold);
  box-shadow: 0 0 0 3px rgba(233, 168, 60, 0.22);
}
.wa-close {
  position: absolute;
  top: 9px;
  right: 9px;
  width: 25px;
  height: 25px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(31, 105, 148, 0.18);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.72);
  color: #3f7a9c;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease, transform 0.14s ease;
}
.wa-close:hover { background: #fff; color: var(--wa-sea-deep); transform: rotate(90deg); }

/* ── 金色灯泡串：灯箱和机身之间的分隔 ─────────────────────────────────── */
.wa-bulbs {
  height: 11px;
  background-image: radial-gradient(circle, var(--wa-gold) 0 1.8px, transparent 2.4px);
  background-size: 16px 11px;
  background-position: 6px center;
  background-repeat: repeat-x;
  opacity: 0.85;
  position: relative;
}
.wa-bulbs::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 5px;
  height: 1px;
  background: rgba(233, 168, 60, 0.35);
}

/* ── 机身内容 ─────────────────────────────────────────────────────────── */
.wa-body { display: flex; flex-direction: column; gap: 11px; padding: 12px 16px 15px; }

.wa-statusline { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wa-dot {
  width: 9px;
  height: 9px;
  flex: none;
  border-radius: 50%;
  background: #b9c4ce;
  box-shadow: 0 0 0 3px rgba(43, 58, 74, 0.06);
}
.wa-dot.is-running { background: var(--wa-ok); animation: wa-pulse 2.2s ease-out infinite; }
.wa-dot.is-busy { background: var(--wa-warn); animation: wa-blink 1s ease-in-out infinite; }
.wa-dot.is-failed { background: var(--wa-err); }
@keyframes wa-pulse {
  0% { box-shadow: 0 0 0 0 rgba(47, 174, 116, 0.5); }
  70% { box-shadow: 0 0 0 7px rgba(47, 174, 116, 0); }
  100% { box-shadow: 0 0 0 0 rgba(47, 174, 116, 0); }
}
@keyframes wa-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

.wa-status-text { font-weight: 800; font-size: 12.5px; color: var(--wa-ink); }
.wa-status-meta {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--wa-ink-2);
  font-variant-numeric: tabular-nums;
}

/* ── 三张计分卡片 ─────────────────────────────────────────────────────── */
.wa-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.wa-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: 12px;
  border: 1px solid var(--wa-line);
  background: #fff;
  box-shadow: 0 1px 2px rgba(43, 58, 74, 0.06), inset 0 -2px 0 rgba(43, 58, 74, 0.04);
}
.wa-stat-top { display: flex; align-items: center; gap: 4px; }
.wa-stat-icon { font-size: 11px; line-height: 1; filter: saturate(0.9); }
.wa-stat-value {
  font-size: 17px;
  font-weight: 800;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  color: var(--wa-ink);
}
.wa-stat-value.is-gold { color: var(--wa-gold-2); }
.wa-stat-label { font-size: 10.5px; letter-spacing: 0.04em; color: var(--wa-ink-2); }

/* ── 金色大按键（游园的「按钮」，带光泽扫过） ─────────────────────────── */
.wa-cta {
  position: relative;
  overflow: hidden;
  appearance: none;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid rgba(217, 138, 37, 0.5);
  border-radius: 14px;
  padding: 13px 16px;
  font: inherit;
  font-size: 14.5px;
  font-weight: 800;
  letter-spacing: 0.03em;
  color: #4a2f07;
  cursor: pointer;
  background: linear-gradient(178deg, #ffdf9a 0%, #f7c05c 46%, #ecab3c 100%);
  box-shadow: 0 3px 0 #b9791f, 0 8px 18px rgba(233, 168, 60, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.85);
  transition: transform 0.1s ease, box-shadow 0.1s ease, filter 0.14s ease;
}
/* 斜向高光，缓慢扫过——像柜台按钮的塑料反光 */
.wa-cta::before {
  content: '';
  position: absolute;
  top: -60%;
  left: -30%;
  width: 40%;
  height: 220%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.55), transparent);
  transform: rotate(18deg);
  animation: wa-sheen 4.5s ease-in-out infinite;
}
@keyframes wa-sheen {
  0%, 62% { left: -30%; }
  85%, 100% { left: 115%; }
}
.wa-cta:hover:not(:disabled) { filter: brightness(1.03); }
.wa-cta:active:not(:disabled) { transform: translateY(2px); box-shadow: 0 1px 0 #b9791f, 0 3px 10px rgba(233, 168, 60, 0.25); }
.wa-cta:disabled {
  cursor: not-allowed;
  color: #8b98a4;
  background: linear-gradient(178deg, #eef1f4, #e2e7ec);
  border-color: var(--wa-line);
  box-shadow: inset 0 1px 0 #fff;
  filter: none;
}
.wa-cta:disabled::before { display: none; }

/* ── 次要动作：小圆片 ─────────────────────────────────────────────────── */
.wa-chips { display: flex; flex-wrap: wrap; gap: 7px; }
.wa-chip {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--wa-line);
  border-radius: 999px;
  background: #fff;
  color: var(--wa-ink);
  font: inherit;
  font-size: 11.5px;
  padding: 5px 11px;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(43, 58, 74, 0.05);
  transition: background 0.14s ease, border-color 0.14s ease, transform 0.12s ease;
}
.wa-chip:hover:not(:disabled) { background: #fdf6e7; border-color: rgba(233, 168, 60, 0.5); }
.wa-chip:active:not(:disabled) { transform: translateY(1px); }
.wa-chip:disabled { opacity: 0.5; cursor: not-allowed; }
.wa-chip.is-danger { color: var(--wa-err); border-color: rgba(209, 96, 79, 0.32); }
.wa-chip.is-danger:hover:not(:disabled) { background: #fdf0ee; }

.wa-notice {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 8px 11px;
  border-radius: 11px;
  font-size: 12px;
  background: #fff8e6;
  border: 1px dashed rgba(233, 168, 60, 0.6);
  color: #7a5a12;
}
.wa-notice::before { content: '🎫'; font-size: 12px; line-height: 1.45; }
.wa-error {
  padding: 9px 12px;
  border-radius: 11px;
  font-size: 12.5px;
  color: #97372a;
  background: #fdeeea;
  border: 1px solid rgba(209, 96, 79, 0.35);
}

/* ── 折叠区：像导览牌上的两行小字 ─────────────────────────────────────── */
.wa-fold { border-top: 1px dashed rgba(43, 58, 74, 0.18); padding-top: 9px; }
.wa-fold-head {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  user-select: none;
  font-size: 11.5px;
  color: var(--wa-ink-2);
  transition: color 0.14s ease;
}
.wa-fold-head:hover { color: var(--wa-sea); }
.wa-fold-head .wa-chev { transition: transform 0.16s ease; font-size: 8px; color: var(--wa-gold-2); }
.wa-fold-head.is-open .wa-chev { transform: rotate(90deg); }
.wa-fold-body { margin-top: 9px; display: flex; flex-direction: column; gap: 9px; }

/* ── 表单 ─────────────────────────────────────────────────────────────── */
.wa-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 10px; }
.wa-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.wa-field.is-wide { grid-column: 1 / -1; }
.wa-label { font-size: 10.5px; letter-spacing: 0.05em; color: var(--wa-ink-2); }
.wa-input {
  appearance: none;
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  font-size: 12px;
  color: var(--wa-ink);
  background: #fff;
  border: 1px solid var(--wa-line);
  border-radius: 9px;
  padding: 6px 9px;
  outline: none;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}
.wa-input:focus { border-color: var(--wa-gold); box-shadow: 0 0 0 3px rgba(233, 168, 60, 0.16); }
.wa-input::placeholder { color: #a8b4bf; }

.wa-switches { display: flex; flex-wrap: wrap; gap: 14px; }
.wa-switch { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; color: var(--wa-ink); }
.wa-switch input { width: 14px; height: 14px; accent-color: var(--wa-gold-2); cursor: pointer; }

.wa-row { display: flex; gap: 8px; }
.wa-btn-sm {
  appearance: none;
  border: 1px solid var(--wa-line);
  border-radius: 9px;
  background: #fff;
  color: var(--wa-ink);
  font: inherit;
  font-size: 12px;
  padding: 6px 12px;
  cursor: pointer;
}
.wa-btn-sm:hover:not(:disabled) { background: #fdf6e7; }
.wa-btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
.wa-btn-sm.is-primary {
  background: linear-gradient(178deg, #f7c05c, #ecab3c);
  border-color: rgba(217, 138, 37, 0.5);
  color: #4a2f07;
  font-weight: 700;
}

.wa-logs {
  margin: 0;
  max-height: 190px;
  overflow: auto;
  padding: 9px 11px;
  border-radius: 10px;
  border: 1px solid var(--wa-line);
  background: #2b3a4a;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  color: #cfe0ec;
}
.wa-logs:empty::after { content: '暂无日志'; color: #8698a8; }

/* ── 本体来源提示：一行小字，回答「这东西从哪来的」 ───────────────────── */
.wa-source {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--wa-ink-2);
}
.wa-source-icon { font-size: 11px; line-height: 1; filter: saturate(0.85); }
/* ── 底部铭牌：像机身角落的出厂编号 ───────────────────────────────────── */
.wa-plate {
  border-top: 1px solid rgba(43, 58, 74, 0.09);
  padding-top: 7px;
  text-align: right;
  font-size: 10px;
  letter-spacing: 0.12em;
  color: #a8b4bf;
}

@media (max-width: 560px) {
  .wa-stat-value { font-size: 15px; }
}

/* ── 左侧栏细条：只用宿主自己的行内边距，别再自己加横向 padding ───────── */
.wa-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 6px 0;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  text-align: left;
  transition: background 0.14s ease;
}
.wa-strip:hover { background: rgba(128, 128, 128, 0.13); }
.wa-strip.is-active { background: rgba(233, 168, 60, 0.2); }
.wa-strip-icon {
  flex: none;
  width: 18px;
  text-align: center;
  font-size: 15px;
  line-height: 1;
}
.wa-strip-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 560;
}

/* DSH 侧栏收起（rail）时只留图标，别把窄轨撑开 */
[data-sidebar-collapsed] .wa-strip-label { display: none; }
[data-sidebar-collapsed] .wa-strip { justify-content: center; padding: 6px 0; }
[data-sidebar-collapsed] .wa-strip-icon { width: auto; }

/* ── 悬浮气泡 ─────────────────────────────────────────────────────────── */
.wa-backdrop { position: fixed; inset: 0; z-index: 60; background: transparent; }
.wa-bubble {
  position: fixed;
  z-index: 61;
  box-sizing: border-box;
  max-height: min(78vh, 700px);
  overflow: auto;
  padding: 0;
  border-radius: 18px;
  background: var(--wa-paper, #fdfaf3);
  box-shadow: 0 20px 50px rgba(43, 58, 74, 0.26), 0 0 0 1px rgba(43, 58, 74, 0.06);
  animation: wa-pop 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes wa-pop {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: none; }
}
`;
