/**
 * 气泡开合状态。
 *
 * 侧栏细条和气泡分别注册在两个不同的插槽里（sidebar.footer.action / shell.overlay），
 * 两个组件要共享同一个开关。用一个 20 行的极简 store 比往宿主塞全局变量干净，
 * 也方便关掉侧栏后气泡自动收起。
 */

type Listener = () => void;

export interface Anchor {
  left: number;
  bottom: number;
}

let open = false;
let anchor: Anchor = { left: 92, bottom: 96 };
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function isOpen(): boolean {
  return open;
}

export function getAnchor(): Anchor {
  return anchor;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openPanel(next: Anchor): void {
  anchor = next;
  open = true;
  emit();
}

export function closePanel(): void {
  if (!open) return;
  open = false;
  emit();
}

export function togglePanel(next: Anchor): void {
  if (open) closePanel();
  else openPanel(next);
}
