/**
 * Tiny DOM helpers. `h` builds an element with typed options; dynamic text is
 * always set via `textContent` (never innerHTML) so provider labels and error
 * strings can't inject markup. `html` is available for trusted static chrome.
 */

interface Opts {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  type?: string;
  role?: string;
  tabIndex?: number;
  value?: string;
  placeholder?: string;
  ariaSelected?: boolean;
  ariaLabel?: string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string>;
  onClick?: (e: MouseEvent) => void;
  onInput?: (e: Event) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: Opts = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.html !== undefined) node.innerHTML = opts.html;
  if (opts.title) node.title = opts.title;
  if (opts.role) node.setAttribute('role', opts.role);
  if (opts.tabIndex !== undefined) node.tabIndex = opts.tabIndex;
  if (opts.ariaSelected !== undefined) node.setAttribute('aria-selected', String(opts.ariaSelected));
  if (opts.ariaLabel) node.setAttribute('aria-label', opts.ariaLabel);
  if (opts.dataset) for (const [k, v] of Object.entries(opts.dataset)) node.dataset[k] = v;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
  if (node instanceof HTMLInputElement) {
    if (opts.type) node.type = opts.type;
    if (opts.value !== undefined) node.value = opts.value;
    if (opts.placeholder) node.placeholder = opts.placeholder;
  }
  // Widen to the concrete element type so addEventListener resolves its keyed
  // overloads (a generic HTMLElementTagNameMap[K] receiver falls back to the
  // plain `(evt: Event)` signature and rejects Mouse/Keyboard handlers).
  const el: HTMLElement = node;
  if (opts.onClick) el.addEventListener('click', opts.onClick);
  if (opts.onInput) el.addEventListener('input', opts.onInput);
  if (opts.onKeyDown) el.addEventListener('keydown', opts.onKeyDown);
  for (const child of children) node.append(child);
  return node;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

/* ── formatting ───────────────────────────────────────────────────────── */

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
}

export function fmtMs(ms: number): string {
  if (!ms || ms <= 0) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

export function fmtPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function fmtClock(at: number): string {
  const d = new Date(at);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

export function fmtAgo(at: number | null): string {
  if (!at) return 'never';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function statusClass(status: string): string {
  return `s-${status}`;
}
