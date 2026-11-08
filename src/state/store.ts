import { CATALOG, defaultParams } from '../sim/catalog';
import type { ComponentKind, Design, EdgeSpec, NodeSpec, ParamValue, TrafficSettings } from '../sim/types';

export type Selection = { type: 'node'; id: string } | { type: 'edge'; id: string } | null;

export interface SavedState {
  version: 1;
  design: Design;
  traffic: TrafficSettings;
}

type Listener = () => void;

const STORAGE_KEY = 'sds:design:v1';

export class Store {
  design: Design = { nodes: [], edges: [] };
  traffic: TrafficSettings = { peakRps: 200, shape: 'steady' };
  selection: Selection = null;
  private designListeners = new Set<Listener>();
  private selectionListeners = new Set<Listener>();
  private trafficListeners = new Set<Listener>();
  private counter = 0;

  onDesign(fn: Listener): void {
    this.designListeners.add(fn);
  }

  onSelection(fn: Listener): void {
    this.selectionListeners.add(fn);
  }

  onTraffic(fn: Listener): void {
    this.trafficListeners.add(fn);
  }

  node(id: string): NodeSpec | undefined {
    return this.design.nodes.find((n) => n.id === id);
  }

  edge(id: string): EdgeSpec | undefined {
    return this.design.edges.find((e) => e.id === id);
  }

  addNode(kind: ComponentKind, x: number, z: number): NodeSpec {
    const sameKind = this.design.nodes.filter((n) => n.kind === kind).length;
    const node: NodeSpec = {
      id: this.nextId(kind),
      kind,
      name: sameKind ? `${CATALOG[kind].label} ${sameKind + 1}` : CATALOG[kind].label,
      x,
      z,
      params: defaultParams(kind),
    };
    this.design = { ...this.design, nodes: [...this.design.nodes, node] };
    this.emitDesign();
    this.select({ type: 'node', id: node.id });
    return node;
  }

  moveNode(id: string, x: number, z: number): void {
    const node = this.node(id);
    if (!node || (node.x === x && node.z === z)) return;
    node.x = x;
    node.z = z;
    this.emitDesign();
  }

  isOccupied(x: number, z: number, except?: string): boolean {
    return this.design.nodes.some((n) => n.id !== except && n.x === x && n.z === z);
  }

  removeNode(id: string): void {
    this.design = {
      nodes: this.design.nodes.filter((n) => n.id !== id),
      edges: this.design.edges.filter((e) => e.from !== id && e.to !== id),
    };
    if (this.selection?.id === id) this.select(null);
    this.emitDesign();
  }

  connect(from: string, to: string): boolean {
    if (from === to) return false;
    if (this.design.edges.some((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from))) return false;
    const edge: EdgeSpec = { id: this.nextId('edge'), from, to };
    this.design = { ...this.design, edges: [...this.design.edges, edge] };
    this.emitDesign();
    return true;
  }

  removeEdge(id: string): void {
    this.design = { ...this.design, edges: this.design.edges.filter((e) => e.id !== id) };
    if (this.selection?.id === id) this.select(null);
    this.emitDesign();
  }

  reverseEdge(id: string): void {
    const edge = this.edge(id);
    if (!edge) return;
    [edge.from, edge.to] = [edge.to, edge.from];
    this.emitDesign();
  }

  setParam(id: string, key: string, value: ParamValue): void {
    const node = this.node(id);
    if (!node) return;
    node.params = { ...node.params, [key]: value };
    this.emitDesign();
  }

  rename(id: string, name: string): void {
    const node = this.node(id);
    if (!node) return;
    node.name = name;
    this.emitDesign();
  }

  removeSelected(): void {
    if (!this.selection) return;
    if (this.selection.type === 'node') this.removeNode(this.selection.id);
    else this.removeEdge(this.selection.id);
  }

  select(selection: Selection): void {
    this.selection = selection;
    for (const fn of this.selectionListeners) fn();
  }

  setTraffic(traffic: Partial<TrafficSettings>): void {
    this.traffic = { ...this.traffic, ...traffic };
    this.persist();
    for (const fn of this.trafficListeners) fn();
  }

  load(state: SavedState): void {
    this.design = structuredClone(state.design);
    this.traffic = { ...state.traffic };
    this.counter = 0;
    this.select(null);
    this.emitDesign();
    for (const fn of this.trafficListeners) fn();
  }

  serialize(): SavedState {
    return { version: 1, design: structuredClone(this.design), traffic: { ...this.traffic } };
  }

  restore(): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = parseSaved(raw);
      if (!parsed) return false;
      this.load(parsed);
      return true;
    } catch {
      return false;
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.serialize()));
    } catch {
      // Storage can be unavailable (private mode, blocked site data); the design still works in memory.
    }
  }

  private emitDesign(): void {
    this.persist();
    for (const fn of this.designListeners) fn();
  }

  private nextId(prefix: string): string {
    let id: string;
    do {
      this.counter += 1;
      id = `${prefix}-${this.counter}`;
    } while (this.node(id) || this.edge(id));
    return id;
  }
}

export function parseSaved(raw: string): SavedState | null {
  const data = JSON.parse(raw) as Partial<SavedState>;
  if (!data || data.version !== 1 || !data.design || !Array.isArray(data.design.nodes) || !Array.isArray(data.design.edges)) return null;
  const nodes = data.design.nodes.filter((n) => n && typeof n.id === 'string' && n.kind in CATALOG);
  const ids = new Set(nodes.map((n) => n.id));
  for (const node of nodes) node.params = { ...defaultParams(node.kind), ...node.params };
  const edges = data.design.edges.filter((e) => e && ids.has(e.from) && ids.has(e.to));
  return {
    version: 1,
    design: { nodes, edges },
    traffic: { peakRps: data.traffic?.peakRps ?? 200, shape: data.traffic?.shape ?? 'steady' },
  };
}
