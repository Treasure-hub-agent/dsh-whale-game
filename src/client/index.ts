/**
 * 大肥鱼游戏厅 · 浏览器半侧（client half）入口。
 *
 * DSH 客户端插件契约：这是一份**普通副作用脚本**，加载时调用
 * `window.__ModuleLoader__.load({ id, factory })`；`factory(require)` 拿到宿主
 * 提供的 react，返回 `{ name, inject, apply }`。不能有顶层 ESM import/export。
 *
 * 界面结构（两条注册 + 一个极简 store）：
 *   sidebar.footer.action  → 左侧栏那条细长条（收起时只剩鲸鱼图标）
 *   shell.overlay          → 点开后的悬浮气泡（不受侧栏宽度限制）
 */
import { makeSection } from './section.ts';
import { makeStrip } from './strip.ts';
import { SECTION_CSS } from './styles.ts';
import type { SectionRuntime } from './section.ts';
import { closePanel, getAnchor, isOpen, openPanel, subscribe } from './store.ts';

declare const window: Window & {
  __ModuleLoader__?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 全局模块系统契约（f(require) => module）
    load(info: { id: string; factory: (require: (mod: string) => any) => any }): void;
  };
};

const NS = 'whale-arcade';
const CSS_TAG = 'dsh-whale-game/panel.css';
const BUBBLE_ID = 'whale-arcade';

function injectCss(): void {
  if (document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) !== null) return;
  const tag = document.createElement('style');
  tag.dataset.pluginCss = CSS_TAG;
  tag.textContent = SECTION_CSS;
  document.head.appendChild(tag);
}

const zh = { nav: '大肥鱼游戏厅', subtitle: '和你的大肥鱼一起玩游戏' };
const en = { nav: 'Whale Arcade', subtitle: 'Play games with your big fat fish' };

export function makeFactory(): (require: (mod: string) => any) => any {
  return (require) => {
    const react: any = require('react');
    const h = react.createElement;

    const name = BUBBLE_ID;
    const inject = ['slots', 'locale'];

    function apply(ctx: any): void {
      injectCss();

      let t: (key: string) => string = (key) => (zh as Record<string, string>)[key] ?? key;
      try {
        ctx.locale.register(NS, { zh, en });
        t = ctx.locale.bind(NS) as (key: string) => string;
      } catch (error) {
        console.warn('[dsh-whale-game] locale 不可用，退回内置文案：', error);
      }

      const runtime: Omit<SectionRuntime, 'onClose'> = {
        h,
        useState: react.useState,
        useEffect: react.useEffect,
        useRef: react.useRef,
        useCallback: react.useCallback,
        t,
      };
      const Panel = makeSection({ ...runtime, onClose: closePanel } as SectionRuntime);

      // ── 气泡：单独注册在全局 overlay 里，所以宽度不受左侧栏限制 ──────────
      const ArcadeOverlay = () => {
        const [open, setOpen] = react.useState(isOpen());
        const [anchor, setAnchor] = react.useState(getAnchor());

        react.useEffect(
          () =>
            subscribe(() => {
              setOpen(isOpen());
              setAnchor(getAnchor());
            }),
          [],
        );

        react.useEffect(() => {
          if (!open) return undefined;
          const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closePanel();
          };
          window.addEventListener('keydown', onKey);
          return () => window.removeEventListener('keydown', onKey);
        }, [open]);

        if (!open) return null;

        // 气泡宽 400：靠右时自动往回缩，别被视口裁掉
        const width = 400;
        const maxLeft = Math.max(12, window.innerWidth - width - 16);
        const left = Math.min(Math.max(12, anchor.left), maxLeft);

        return h(
          react.Fragment,
          null,
          h('div', { className: 'wa-backdrop', onClick: closePanel }),
          h(
            'div',
            {
              className: 'wa-bubble',
              style: { left: `${left}px`, bottom: `${Math.max(12, anchor.bottom)}px`, width: `${width}px` },
              role: 'dialog',
              'aria-label': '大肥鱼游戏厅',
            },
            h(Panel),
          ),
        );
      };

      // ── 侧栏细条 ────────────────────────────────────────────────────────
      const Strip = makeStrip({
        h,
        useRef: react.useRef,
        useEffect: react.useEffect,
        useState: react.useState,
        openPanel,
        closePanel,
        isOpen,
        subscribe,
      });

      ctx.slots.inject('sidebar.footer.action', () => {
        return ctx.slots.register(
          { name: 'sidebar.footer.action', id: `${BUBBLE_ID}-entry`, order: 12, locale: NS },
          Strip,
        );
      });

      ctx.slots.inject('shell.overlay', () => {
        return ctx.slots.register(
          { name: 'shell.overlay', id: `${BUBBLE_ID}-bubble`, order: 12, locale: NS },
          ArcadeOverlay,
        );
      });
    }

    return { name, inject, apply };
  };
}

if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({ id: 'dsh-whale-game', factory: makeFactory() });
} else {
  console.warn('[dsh-whale-game] 没有找到 DSH 模块加载器，插件未注册');
}
