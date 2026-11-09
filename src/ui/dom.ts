type Child = Node | string | number | null | undefined | false;

interface Attrs {
  class?: string;
  title?: string;
  dataset?: Record<string, string>;
  style?: string;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
  [key: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'dataset') Object.assign(el.dataset, value as Record<string, string>);
    else if (key === 'style') el.setAttribute('style', String(value));
    else if (key === 'on') {
      for (const [event, handler] of Object.entries(value as Record<string, EventListener>)) el.addEventListener(event, handler);
    } else if (key in el) (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
}

export function dialogHeader(title: string, close: () => void): HTMLElement {
  return h('div', { class: 'dialog-header' }, h('h3', {}, title), h('button', { class: 'dialog-close', title: 'Close (Esc)', 'aria-label': 'Close', on: { click: close } }, '×'));
}

export function foldButton(panel: HTMLElement): HTMLButtonElement {
  const label = () => (panel.classList.contains('folded') ? '▴' : '▾');
  const button = h(
    'button',
    {
      class: 'fold-button',
      title: 'Fold or unfold this card',
      on: {
        click: () => {
          panel.classList.toggle('folded');
          button.textContent = label();
        },
      },
    },
    label(),
  );
  return button;
}
