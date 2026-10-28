/**
 * 大肥鱼游戏厅 · 设置页卡片。
 *
 * 这一屏就是用户看到的全部插件界面，所以按「门面」的标准写：
 * 状态一眼看清、主按钮永远是「下一步该做的事」、失败时给能照做的建议。
 *
 * 所有数据来自宿主半侧的 /whale-arcade 路由；这里不 import 游戏厅的任何代码。
 */
import { POLL_INTERVAL_MS, ROUTE_PREFIX, type LauncherConfig, type LauncherState } from '../shared.ts';

export interface SectionRuntime {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 h 无静态类型
  h: any;
  /** 宿主提供的 hooks：签名按 React 的来写，避免在插件里再引一份 @types/react。 */
  useState: <T>(initial: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void];
  useEffect: (effect: () => void | (() => void), deps?: ReadonlyArray<unknown>) => void;
  useRef: <T>(initial: T) => { current: T };
  useCallback: <T extends (...args: never[]) => unknown>(fn: T, deps: ReadonlyArray<unknown>) => T;
  t: (key: string, params?: Record<string, unknown>) => string;
  /** 关闭气泡（点 × 或 Esc） */
  onClose: () => void;
}

function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

const STATUS_LABEL: Record<string, string> = {
  stopped: '未启动',
  starting: '正在拉起…',
  running: '运行中',
  stopping: '正在停止…',
  failed: '启动失败',
};

const DOT_CLASS: Record<string, string> = {
  running: 'is-running',
  starting: 'is-busy',
  stopping: 'is-busy',
  failed: 'is-failed',
};

export function makeSection(rt: SectionRuntime) {
  const { h, useState, useEffect, useRef, useCallback } = rt;
  const tr = (key: string): string => (typeof rt.t === 'function' ? rt.t(key) : key);

  /** 宿主侧接口：同源 fetch，失败一律抛给人话。 */
  const request = async (path: string, init?: RequestInit): Promise<any> => {
    const res = await fetch(`${ROUTE_PREFIX}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok || body?.ok === false) {
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    return body;
  };

  return function WhaleArcadeSection() {
    const [state, setState] = useState<LauncherState | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [toast, setToast] = useState<string | null>(null);
    const [fatal, setFatal] = useState<string | null>(null);
    const [draft, setDraft] = useState<LauncherConfig | null>(null);
    const [dirty, setDirty] = useState(false);
    const [showLogs, setShowLogs] = useState(false);
    const [showConfig, setShowConfig] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const aliveRef = useRef(true);

    const showToast = useCallback((text: string) => {
      setToast(text);
      window.setTimeout(() => {
        if (aliveRef.current) setToast(null);
      }, 2400);
    }, []);

    const applyState = useCallback((next: LauncherState | null) => {
      if (!next) return;
      setState(next);
      setDraft((current: LauncherConfig | null) => (current && dirtyRef.current ? current : next.config));
    }, []);

    // 用 ref 记住 dirty：applyState 在 interval 里跑，闭包里的 dirty 会是旧值
    const dirtyRef = useRef(false);
    const markDirty = useCallback((next: boolean) => {
      dirtyRef.current = next;
      setDirty(next);
    }, []);

    const refresh = useCallback(async () => {
      try {
        const body = await request('/status');
        if (!aliveRef.current) return;
        setFatal(null);
        applyState(body.state);
      } catch (err) {
        if (!aliveRef.current) return;
        setFatal(err instanceof Error ? err.message : String(err));
      }
    }, [applyState]);

    useEffect(() => {
      aliveRef.current = true;
      void refresh();
      const poll = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
      const tick = window.setInterval(() => setNow(Date.now()), 1000);
      return () => {
        aliveRef.current = false;
        window.clearInterval(poll);
        window.clearInterval(tick);
      };
    }, [refresh]);

    const act = useCallback(
      async (kind: 'start' | 'stop' | 'restart') => {
        setBusy(kind);
        try {
          const body = await request(`/${kind}`, { method: 'POST', body: '{}' });
          applyState(body.state);
          if (kind === 'start' || kind === 'restart') {
            if (body.state?.status === 'running') showToast(`游戏厅已开张 · ${body.state.url}`);
            else if (body.state?.status === 'failed') showToast('没起来，看下面的日志');
          } else {
            showToast('已停止，端口已释放');
          }
        } catch (err) {
          showToast(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(null);
        }
      },
      [applyState, showToast],
    );

    const copy = useCallback(
      async (text: string, label: string) => {
        try {
          await navigator.clipboard.writeText(text);
          showToast(`已复制${label}`);
        } catch {
          showToast('复制失败，手动选中吧');
        }
      },
      [showToast],
    );

    const openHall = useCallback(() => {
      if (!state?.url) return;
      window.open(state.url, '_blank', 'noopener');
    }, [state?.url]);

    const saveConfig = useCallback(async () => {
      if (!draft) return;
      setBusy('save');
      try {
        const body = await request('/config', { method: 'PUT', body: JSON.stringify(draft) });
        setState(body.state);
        markDirty(false);
        showToast('配置已保存，下次启动生效');
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    }, [draft, markDirty, showToast]);

    const status = state?.status ?? 'stopped';
    const running = status === 'running';
    const transitioning = status === 'starting' || status === 'stopping';
    const uptime = running && state?.startedAt ? formatUptime(now - state.startedAt) : null;

    let meta = state?.url ?? '尚未配置';
    if (running) {
      const bits: string[] = [];
      if (state?.health.games != null) bits.push(`${state.health.games} 款游戏`);
      if (state?.health.latencyMs != null) bits.push(`${state.health.latencyMs}ms`);
      if (uptime) bits.push(`已运行 ${uptime}`);
      if (state?.pid) bits.push(`pid ${state.pid}`);
      meta = bits.join(' · ');
    } else if (status === 'failed') {
      meta = state?.error ?? '启动失败';
    } else if (transitioning) {
      meta = `${state?.url ?? ''} · 请稍等`;
    }

    const mcpJson = JSON.stringify(
      { mcpServers: { 'ai-playground': { type: 'http', url: state?.mcpUrl ?? '' } } },
      null,
      2,
    );

    // ── 三块计分牌：游戏数 / 端口 / 运行时长 ──────────────────────────────
    const gamesValue = running && state?.health.games != null ? String(state.health.games) : '—';
    const portValue = String(state?.config.port ?? '—');
    const uptimeValue =
      running && state?.startedAt
        ? (() => {
            const total = Math.max(0, Math.floor((now - (state.startedAt as number)) / 1000));
            const hh = Math.floor(total / 3600);
            const mm = Math.floor((total % 3600) / 60);
            const ss = total % 60;
            return hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}` : mm > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : `${ss}s`;
          })()
        : '—';

    // 计分牌：小图标 + 标签在上、数字在下，像游园门口的告示牌
    const stat = (icon: string, label: string, value: string, gold = false) =>
      h(
        'div',
        { className: 'wa-stat' },
        h(
          'span',
          { className: 'wa-stat-top' },
          h('span', { className: 'wa-stat-icon', 'aria-hidden': 'true' }, icon),
          h('span', { className: 'wa-stat-label' }, label),
        ),
        h('span', { className: `wa-stat-value${gold ? ' is-gold' : ''}` }, value),
      );

    const stats = h(
      'div',
      { className: 'wa-stats' },
      stat('🎮', '游戏', gamesValue, true),
      stat('🔌', '端口', portValue),
      stat('⏱', '运行', uptimeValue),
    );

    // ── 金色大按键：永远是「下一步该做的事」 ──────────────────────────────
    const ctaLabel =
      busy === 'start'
        ? '正在拉开卷帘门…'
        : running
          ? '🎮 打开游戏厅'
          : status === 'failed'
            ? '重新开张'
            : '🎮 开启游戏厅';
    const cta = h(
      'button',
      {
        className: 'wa-cta',
        type: 'button',
        disabled: busy !== null || transitioning,
        onClick: () => (running ? openHall() : void act('start')),
      },
      ctaLabel,
    );

    const chip = (label: string, onClick: () => void, opts: { danger?: boolean; disabled?: boolean } = {}) =>
      h(
        'button',
        {
          className: `wa-chip${opts.danger ? ' is-danger' : ''}`,
          type: 'button',
          disabled: Boolean(opts.disabled),
          onClick,
        },
        label,
      );

    const chips = h(
      'div',
      { className: 'wa-chips' },
      running &&
        chip(busy === 'stop' ? '正在停止…' : '⏹ 停止', () => void act('stop'), {
          danger: true,
          disabled: busy !== null,
        }),
      (running || status === 'failed') &&
        chip(busy === 'restart' ? '重启中…' : '⟳ 重启', () => void act('restart'), { disabled: busy !== null }),
      running && chip('复制地址', () => void copy(state?.url ?? '', '地址')),
      running && chip('复制 MCP', () => void copy(mcpJson, ' MCP 配置')),
    );

    const statusLine = h(
      'div',
      { className: 'wa-statusline' },
      h('span', { className: `wa-dot ${DOT_CLASS[status] ?? ''}` }),
      h('span', { className: 'wa-status-text' }, STATUS_LABEL[status] ?? status),
      h('span', { className: 'wa-status-meta' }, meta),
    );

    // ── 配置区 ────────────────────────────────────────────────────────────
    const field = (label: string, input: any, wide = false) =>
      h('label', { className: `wa-field${wide ? ' is-wide' : ''}` }, h('span', { className: 'wa-label' }, label), input);

    const numeric = (value: number, onChange: (n: number) => void) =>
      h('input', {
        className: 'wa-input',
        type: 'number',
        min: 1024,
        max: 65535,
        value: String(value),
        onChange: (e: any) => {
          markDirty(true);
          onChange(Number(e.target.value));
        },
      });

    const text = (value: string, placeholder: string, onChange: (s: string) => void) =>
      h('input', {
        className: 'wa-input',
        type: 'text',
        value,
        placeholder,
        spellCheck: false,
        onChange: (e: any) => {
          markDirty(true);
          onChange(e.target.value);
        },
      });

    const toggle = (label: string, checked: boolean, onChange: (b: boolean) => void) =>
      h(
        'label',
        { className: 'wa-switch' },
        h('input', {
          type: 'checkbox',
          checked,
          onChange: (e: any) => {
            markDirty(true);
            onChange(e.target.checked);
          },
        }),
        h('span', null, label),
      );

    const configFold = draft
      ? h(
          'div',
          { className: 'wa-fold' },
          h(
            'div',
            {
              className: `wa-fold-head${showConfig ? ' is-open' : ''}`,
              onClick: () => setShowConfig(!showConfig),
            },
            h('span', { className: 'wa-chev' }, '▶'),
            h('span', null, '⚙ 运行设置'),
            dirty ? h('span', { className: 'wa-status-meta' }, '· 有未保存修改') : null,
          ),
          showConfig
            ? h(
                'div',
                { className: 'wa-fold-body' },
                h(
                  'div',
                  { className: 'wa-grid' },
                  field('端口', numeric(draft.port, (port) => setDraft({ ...draft, port }))),
                  field(
                    '启动命令',
                    text(draft.command, '留空 = 自动（本机仓库 → npx）', (command) => setDraft({ ...draft, command }),
                    ),
                    true,
                  ),
                  field(
                    '工作目录',
                    text(draft.cwd, '留空 = 跟随 DSH 进程', (cwd) => setDraft({ ...draft, cwd })),
                    true,
                  ),
                ),
                h(
                  'div',
                  { className: 'wa-switches' },
                  toggle('随 DSH 启动', draft.autoStart, (autoStart) => setDraft({ ...draft, autoStart })),
                  toggle('启动后自动打开', draft.openOnStart, (openOnStart) => setDraft({ ...draft, openOnStart })),
                ),
                h(
                  'div',
                  { className: 'wa-row' },
                  h(
                    'button',
                    {
                      className: 'wa-btn-sm is-primary',
                      type: 'button',
                      disabled: !dirty || busy !== null,
                      onClick: () => void saveConfig(),
                    },
                    busy === 'save' ? '保存中…' : dirty ? '保存' : '已保存',
                  ),
                  dirty &&
                    h(
                      'button',
                      {
                        className: 'wa-btn-sm',
                        type: 'button',
                        onClick: () => {
                          setDraft(state?.config ?? draft);
                          markDirty(false);
                        },
                      },
                      '放弃修改',
                    ),
                ),
              )
            : null,
        )
      : null;

    // ── 日志折叠区 ────────────────────────────────────────────────────────
    const logs = state?.logs ?? [];
    const logsFold = h(
      'div',
      { className: 'wa-fold' },
      h(
        'div',
        {
          className: `wa-fold-head${showLogs ? ' is-open' : ''}`,
          onClick: () => setShowLogs(!showLogs),
        },
        h('span', { className: 'wa-chev' }, '▶'),
        h('span', null, `📜 运行日志${logs.length > 0 ? ` · ${logs.length}` : ''}`),
      ),
      showLogs ? h('pre', { className: 'wa-logs' }, logs.join('\n') || '暂无日志') : null,
    );

    return h(
      'div',
      { className: 'wa-root' },
      h(
        'div',
        { className: 'wa-cabinet' },
        // 灯箱：鲸鱼吉祥物 + 店名 + 跑马灯底边
        h(
          'div',
          { className: 'wa-hero' },
          h(
            'div',
            { className: 'wa-hero-row' },
            h('div', { className: 'wa-mascot', 'aria-hidden': 'true' }, '🐳'),
            h(
              'div',
              { className: 'wa-hero-text' },
              h('h3', { className: 'wa-hero-title' }, '大肥鱼游戏厅'),
              h('p', { className: 'wa-hero-sub' }, tr('subtitle') || '和你的大肥鱼一起玩游戏'),
            ),
          ),
          h(
            'button',
            { className: 'wa-close', type: 'button', onClick: rt.onClose, title: '收起', 'aria-label': '收起' },
            '✕',
          ),
        ),
        // 灯箱和机身之间挂一串小灯泡
        h('div', { className: 'wa-bulbs', 'aria-hidden': 'true' }),
        // 机身：状态 → 计分牌 → 大按键 → 小动作 → 折叠区
        h(
          'div',
          { className: 'wa-body' },
          statusLine,
          status === 'failed' && state?.error ? h('div', { className: 'wa-error' }, state.error) : null,
          fatal ? h('div', { className: 'wa-error' }, `插件接口不可用：${fatal}`) : null,
          stats,
          cta,
          chips,
          toast ? h('div', { className: 'wa-notice' }, toast) : null,
          configFold,
          logsFold,
          state?.pluginVersion
            ? h('div', { className: 'wa-plate' }, `WHALE ARCADE · NO.${state.pluginVersion}`)
            : null,
        ),
      ),
    );
  };
}
