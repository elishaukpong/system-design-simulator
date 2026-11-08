import { CATALOG, GROUP_ORDER } from '../sim/catalog';
import type { ComponentKind } from '../sim/types';
import { h, hex } from './dom';

export class Palette {
  private items = new Map<ComponentKind, HTMLButtonElement>();

  constructor(root: HTMLElement, onPick: (kind: ComponentKind, event: PointerEvent) => void) {
    for (const group of GROUP_ORDER) {
      const defs = Object.values(CATALOG).filter((d) => d.group === group);
      const section = h('div', { class: 'palette-group' }, h('h3', {}, group));
      for (const def of defs) {
        const item = h(
          'button',
          {
            class: 'palette-item',
            title: def.blurb,
            on: {
              pointerdown: (event: PointerEvent) => {
                event.preventDefault();
                onPick(def.kind, event);
              },
            },
          },
          h('span', { class: 'palette-swatch', style: `background:${hex(def.color)}` }, def.short),
          h('span', {}, def.label),
        );
        this.items.set(def.kind, item);
        section.append(item);
      }
      root.append(section);
    }
  }

  setActive(kind: ComponentKind | null): void {
    for (const [k, item] of this.items) item.classList.toggle('active', k === kind);
  }
}
