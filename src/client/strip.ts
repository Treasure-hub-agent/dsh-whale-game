/**
 * 左侧栏那条细长条。
 *
 * 只做一件事：点一下把气泡打开/关上。它自己不含任何业务逻辑——数据都在气泡里，
 * 这样侧栏永远只占一行高度，收起时（DSH 的 rail 模式）自动退化成只有鲸鱼图标。
 */

export interface StripRuntime {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 h 无静态类型
  h: any;
  useRef: <T>(initial: T) => { current: T };
  openPanel: (anchor: { left: number; bottom: number }) => void;
  closePanel: () => void;
  isOpen: () => boolean;
  subscribe: (listener: () => void) => () => void;
  useEffect: (effect: () => void | (() => void), deps?: ReadonlyArray<unknown>) => void;
  useState: <T>(initial: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void];
}

export function makeStrip(rt: StripRuntime) {
  const { h, useRef, useEffect, useState } = rt;

  return function WhaleArcadeStrip() {
    const ref = useRef<HTMLButtonElement | null>(null);
    const [active, setActive] = useState(rt.isOpen());

    useEffect(() => rt.subscribe(() => setActive(rt.isOpen())), []);

    const onClick = () => {
      if (rt.isOpen()) {
        rt.closePanel();
        return;
      }
      // 用按钮自身的矩形算锚点：气泡贴在侧栏右侧、按钮下方，不依赖写死的边距
      const rect = ref.current?.getBoundingClientRect();
      rt.openPanel({
        left: Math.round((rect?.right ?? 76) + 12),
        bottom: Math.round(window.innerHeight - (rect?.bottom ?? 88) + 6),
      });
    };

    return h(
      'button',
      {
        ref,
        type: 'button',
        className: `wa-strip${active ? ' is-active' : ''}`,
        onClick,
        title: '大肥鱼游戏厅',
        'aria-label': '大肥鱼游戏厅',
        'aria-expanded': active,
      },
      // 图标只用 emoji 本身，外面那层 18px 固定宽是为了和其它行的图标列对齐；
      // 右侧不要再放任何装饰符号——那个位置会被宿主的窄列挤成一个黑点。
      h('span', { className: 'wa-strip-icon', 'aria-hidden': 'true' }, '🎮'),
      h('span', { className: 'wa-strip-label' }, '大肥鱼游戏厅'),
    );
  };
}
