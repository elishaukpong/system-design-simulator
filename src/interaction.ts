import type { SceneView } from './render/scene';
import type { Store } from './state/store';
import type { ComponentKind } from './sim/types';

type Mode =
  | { type: 'idle' }
  | { type: 'placing'; kind: ComponentKind; fromPaletteDrag: boolean }
  | { type: 'dragging'; id: string; startX: number; startY: number; moved: boolean; cell: { x: number; z: number } | null }
  | { type: 'connecting'; from: string }
  | { type: 'empty-press'; startX: number; startY: number };

const DRAG_THRESHOLD = 5;

export class Interaction {
  connectMode = false;
  private mode: Mode = { type: 'idle' };
  private listeners = new Set<() => void>();

  constructor(private viewport: HTMLElement, private scene: SceneView, private store: Store) {
    viewport.addEventListener('pointerdown', (e) => this.onDown(e), { capture: true });
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    viewport.addEventListener('contextmenu', (e) => {
      if (this.mode.type === 'placing') {
        e.preventDefault();
        this.cancel();
      }
    });
  }

  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  get placingKind(): ComponentKind | null {
    return this.mode.type === 'placing' ? this.mode.kind : null;
  }

  get modeLabel(): string | null {
    if (this.mode.type === 'placing') return 'Click the grid to place. Esc or right-click to stop.';
    if (this.mode.type === 'connecting') return 'Release on the component to connect to.';
    if (this.store.editingLocked) return 'Test running. The design is locked until it ends.';
    if (this.connectMode) return 'Connect mode: drag from one component to another.';
    return null;
  }

  startPlacing(kind: ComponentKind, fromPaletteDrag: boolean): void {
    if (this.store.editingLocked) return;
    this.mode = { type: 'placing', kind, fromPaletteDrag };
    this.emit();
  }

  toggleConnectMode(): void {
    this.connectMode = !this.connectMode;
    this.emit();
  }

  cancel(): void {
    this.mode = { type: 'idle' };
    this.scene.showGhost(null);
    this.scene.showPreview(null);
    this.scene.controls.enabled = true;
    this.emit();
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;

    if (this.mode.type === 'placing') {
      this.place(e);
      e.stopPropagation();
      return;
    }

    const nodeId = this.scene.pickNode(e.clientX, e.clientY);
    if (nodeId && this.store.editingLocked) {
      this.store.select({ type: 'node', id: nodeId });
      return;
    }

    if (nodeId) {
      this.scene.controls.enabled = false;
      if (this.connectMode || e.shiftKey) {
        this.mode = { type: 'connecting', from: nodeId };
      } else {
        this.mode = { type: 'dragging', id: nodeId, startX: e.clientX, startY: e.clientY, moved: false, cell: null };
      }
      this.store.select({ type: 'node', id: nodeId });
      this.emit();
      return;
    }

    const edgeId = this.scene.pickEdge(e.clientX, e.clientY);
    if (edgeId) {
      this.store.select({ type: 'edge', id: edgeId });
      return;
    }

    this.mode = { type: 'empty-press', startX: e.clientX, startY: e.clientY };
  }

  private onMove(e: PointerEvent): void {
    const mode = this.mode;
    if (mode.type === 'placing') {
      const point = this.overViewport(e) ? this.scene.groundPoint(e.clientX, e.clientY) : null;
      if (point) {
        const cell = this.scene.snap(point);
        this.scene.showGhost(mode.kind, cell.x, cell.z, this.store.isOccupied(cell.x, cell.z));
      } else {
        this.scene.showGhost(null);
      }
      return;
    }

    if (mode.type === 'dragging') {
      if (!mode.moved && Math.hypot(e.clientX - mode.startX, e.clientY - mode.startY) < DRAG_THRESHOLD) return;
      mode.moved = true;
      const point = this.scene.groundPoint(e.clientX, e.clientY);
      if (!point) return;
      const cell = this.scene.snap(point);
      if (this.store.isOccupied(cell.x, cell.z, mode.id)) return;
      mode.cell = cell;
      this.scene.moveNodeVisual(mode.id, cell.x, cell.z);
      return;
    }

    if (mode.type === 'connecting') {
      const target = this.scene.pickNode(e.clientX, e.clientY);
      this.scene.setHoverTarget(target && target !== mode.from ? target : null);
      const point = this.scene.groundPoint(e.clientX, e.clientY);
      if (point) this.scene.showPreview(mode.from, point);
      return;
    }

    if (this.overViewport(e) && e.buttons === 0) {
      this.scene.setHoverTarget(this.scene.pickNode(e.clientX, e.clientY));
    }
  }

  private onUp(e: PointerEvent): void {
    const mode = this.mode;

    if (mode.type === 'placing') {
      if (mode.fromPaletteDrag && this.overViewport(e)) {
        this.place(e);
        this.cancel();
      } else if (mode.fromPaletteDrag) {
        this.mode = { ...mode, fromPaletteDrag: false };
      }
      return;
    }

    if (mode.type === 'dragging') {
      if (mode.moved && mode.cell) this.store.moveNode(mode.id, mode.cell.x, mode.cell.z);
      else {
        const node = this.store.node(mode.id);
        if (node) this.scene.moveNodeVisual(node.id, node.x, node.z);
      }
    }

    if (mode.type === 'connecting') {
      const target = this.scene.pickNode(e.clientX, e.clientY);
      if (target && target !== mode.from) this.store.connect(mode.from, target);
      this.scene.showPreview(null);
      this.scene.setHoverTarget(null);
    }

    if (mode.type === 'empty-press' && Math.hypot(e.clientX - mode.startX, e.clientY - mode.startY) < DRAG_THRESHOLD) {
      this.store.select(null);
    }

    this.mode = { type: 'idle' };
    this.scene.controls.enabled = true;
    this.emit();
  }

  private place(e: PointerEvent): void {
    if (this.mode.type !== 'placing') return;
    const point = this.scene.groundPoint(e.clientX, e.clientY);
    if (!point) return;
    const cell = this.scene.snap(point);
    if (this.store.isOccupied(cell.x, cell.z)) return;
    const kind = this.mode.kind;
    this.store.addNode(kind, cell.x, cell.z);
    if (!e.shiftKey && !this.mode.fromPaletteDrag) this.cancel();
  }

  private overViewport(e: PointerEvent): boolean {
    const rect = this.viewport.getBoundingClientRect();
    return e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
