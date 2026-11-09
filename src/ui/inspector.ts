import { adviceFor, formatSeconds } from '../sim/analysis';
import { CATALOG, type ParamDef } from '../sim/catalog';
import { formatRps } from '../render/scene';
import type { Store } from '../state/store';
import type { NodeMetrics, NodeSpec, NodeStatus, SimSnapshot } from '../sim/types';
import { TRAFFIC_CLASSES, totalFlow } from '../sim/types';
import { regionAt, regionLabel, type RegionId } from '../sim/regions';
import { h, hex } from './dom';

export interface InspectorActions {
  kill(id: string): void;
  restart(id: string): void;
  canRestart(id: string): boolean;
  flush(id: string): void;
  killRegion(region: RegionId): void;
}

export type InspectorTab = 'live' | 'settings';

type Tone = 'good' | 'warn' | 'bad' | '';

interface Row {
  label: string;
  value: string;
  fill?: number;
  tone?: Tone;
}

const STATUS_LABEL: Record<NodeStatus, string> = {
  idle: 'Idle',
  healthy: 'Healthy',
  warm: 'Warm',
  hot: 'Hot',
  overloaded: 'Overloaded',
  down: 'Down',
};

export class Inspector {
  private live: HTMLElement | null = null;
  private vitals: HTMLElement | null = null;
  private status: HTMLElement | null = null;
  private restartButton: HTMLButtonElement | null = null;
  private renderedFor: string | null = null;
  private tab: InspectorTab = 'live';

  constructor(private root: HTMLElement, private store: Store, private actions: InspectorActions) {
    store.onSelection(() => this.render());
    store.onDesign(() => {
      if (this.store.selection && !this.exists()) this.render();
      else if (this.store.selection?.type === 'edge') this.render();
    });
    this.render();
  }

  showTab(tab: InspectorTab): void {
    this.tab = tab;
    this.render();
  }

  render(): void {
    const sel = this.store.selection;
    this.root.replaceChildren();
    this.live = null;
    this.vitals = null;
    this.status = null;
    this.restartButton = null;
    this.renderedFor = sel ? `${sel.type}:${sel.id}` : null;
    const selected = !!sel && this.exists();
    this.root.parentElement?.classList.toggle('inspecting', selected);

    if (!sel || !selected) {
      this.root.append(
        h('h2', { class: 'panel-title' }, 'Inspector'),
        h(
          'div',
          { class: 'muted small' },
          h('p', {}, 'Click a component on the canvas to see its live numbers and settings.'),
          h('p', {}, 'Pick one from the left and click the grid to place it. Shift-drag from one component to another to connect them.'),
          h('p', {}, 'Set the traffic, press Run, and watch for the first thing to turn red.'),
        ),
      );
      return;
    }

    if (sel.type === 'edge') this.renderEdge(sel.id);
    else this.renderNode(sel.id);
  }

  private renderNode(id: string): void {
    const node = this.store.node(id)!;
    const def = CATALOG[node.kind];
    const nameInput = h('input', {
      class: 'insp-name',
      value: node.name,
      title: 'Rename',
      disabled: node.locked || this.store.editingLocked,
      on: { change: () => this.store.rename(node.id, nameInput.value.trim() || def.label) },
    });
    this.status = h('span', { class: 'status-pill', dataset: { status: 'idle' } }, 'Idle');
    this.vitals = h('div', { class: 'vitals' });
    this.live = h('div', { class: 'insp-live' });

    this.restartButton = h('button', { class: 'primary', title: 'Bring it back in 5s instead of waiting', hidden: true, on: { click: () => this.actions.restart(node.id) } }, '🔄 Restart');
    const actions = h('div', { class: 'insp-actions' }, this.restartButton, h('button', { class: 'danger', title: 'Kill every instance for 30s', on: { click: () => this.actions.kill(node.id) } }, '💥 Kill'));
    if (node.kind === 'cache') actions.append(h('button', { title: 'Empty the cache', on: { click: () => this.actions.flush(node.id) } }, '🧹 Flush'));
    if (node.kind !== 'clients') {
      const region = regionAt(node.z);
      actions.append(h('button', { class: 'danger', title: `Take every component in ${regionLabel(region)} down for 60s`, on: { click: () => this.actions.killRegion(region) } }, '🌩 Region'));
    }
    if (!node.locked && !this.store.editingLocked) actions.append(h('button', { class: 'danger icon', title: 'Delete this component', on: { click: () => this.store.removeNode(node.id) } }, '🗑'));

    const settings = h('div', { class: 'insp-settings' }, h('p', { class: 'muted small' }, def.blurb));
    if (node.locked) settings.append(h('p', { class: 'muted small' }, '🔒 Part of the scenario. You cannot change it.'));
    for (const param of def.params) settings.append(this.field(node, param));

    const panes: Record<InspectorTab, HTMLElement> = { live: this.live, settings };
    const tabs = h('div', { class: 'insp-tabs', role: 'tablist' });
    for (const tab of ['live', 'settings'] as const) {
      tabs.append(
        h(
          'button',
          { role: 'tab', class: this.tab === tab ? 'active' : '', on: { click: () => this.showTab(tab) } },
          tab === 'live' ? 'Live' : `Settings · ${def.params.length}`,
        ),
      );
    }

    this.root.append(
      h(
        'div',
        { class: 'insp-top' },
        h('span', { class: 'kind-badge', style: `--kind:${hex(def.color)}`, title: def.label }, def.short),
        nameInput,
        this.status,
      ),
      actions,
      this.vitals,
      tabs,
      panes[this.tab],
    );
  }

  private renderEdge(id: string): void {
    const edge = this.store.edge(id)!;
    const from = this.store.node(edge.from)!;
    const to = this.store.node(edge.to)!;
    const locked = !!edge.locked;
    this.vitals = h('div', { class: 'vitals three' });
    this.live = h('div', { class: 'insp-live' });

    const extra = edge.latencyMs ?? 0;
    const extraValue = h('span', { class: 'field-value' }, `${extra} ms`);
    const extraSlider = h('input', {
      type: 'range',
      min: '0',
      max: '500',
      step: '5',
      value: String(extra),
      disabled: this.store.editingLocked || locked,
      on: {
        input: () => {
          extraValue.textContent = `${extraSlider.value} ms`;
        },
        change: () => this.store.setEdgeLatency(edge.id, Number(extraSlider.value)),
      },
    });
    const shareField = from.kind === 'gateway'
      ? this.shareField(edge.id, from.id, locked)
      : (from.kind === 'app' || from.kind === 'workers') && ['app', 'lb', 'breaker'].includes(to.kind)
        ? this.callField(edge.id, locked)
        : null;

    const actions = h('div', { class: 'insp-actions' });
    if (locked) actions.append(h('span', { class: 'muted small' }, '🔒 Part of the scenario. You cannot change it.'));
    else {
      actions.append(
        h('button', { title: 'Send traffic the other way', on: { click: () => this.store.reverseEdge(edge.id) } }, '⇄ Reverse'),
        h('button', { class: 'danger icon', title: 'Delete this connection', on: { click: () => this.store.removeEdge(edge.id) } }, '🗑'),
      );
    }

    this.root.append(
      h(
        'div',
        { class: 'insp-top' },
        h('span', { class: 'kind-badge', style: '--kind:#64748b', title: 'Connection' }, '⤳'),
        h('div', { class: 'insp-edge-name' }, h('span', {}, from.name), h('span', { class: 'muted' }, ' → '), h('span', {}, to.name)),
      ),
      actions,
      this.vitals,
      this.live,
      ...(shareField ? [shareField] : []),
      this.helpField(
        'Extra latency',
        extraValue,
        extraSlider,
        'On top of the network. A chatty protocol, TLS without reuse, a slow proxy.',
      ),
    );
  }

  private shareField(edgeId: string, gatewayId: string, locked: boolean): HTMLElement {
    const siblings = this.store.design.edges.filter((e) => e.from === gatewayId);
    const weightOf = (id: string, own: number) => siblings.reduce((sum, e) => sum + (e.id === id ? own : e.sharePct ?? 100), 0);
    const current = this.store.edge(edgeId)?.sharePct ?? 100;
    const effective = (own: number) => {
      const total = weightOf(edgeId, own);
      return total > 0 ? Math.round((own / total) * 100) : 0;
    };
    const value = h('span', { class: 'field-value' }, `${effective(current)}%`);
    const slider = h('input', {
      type: 'range',
      min: '0',
      max: '100',
      step: '5',
      value: String(current),
      disabled: this.store.editingLocked || locked,
      on: {
        input: () => {
          value.textContent = `${effective(Number(slider.value))}%`;
        },
        change: () => this.store.setEdgeShare(edgeId, Number(slider.value)),
      },
    });
    return this.helpField('Path share', value, slider, 'How much of the gateway\'s traffic goes down this path, like /search or /checkout. Shares are relative to the other paths.');
  }

  private callField(edgeId: string, locked: boolean): HTMLElement {
    const current = this.store.edge(edgeId)?.sharePct ?? 100;
    const value = h('span', { class: 'field-value' }, `${current}%`);
    const slider = h('input', {
      type: 'range',
      min: '0',
      max: '100',
      step: '5',
      value: String(current),
      disabled: this.store.editingLocked || locked,
      on: {
        input: () => {
          value.textContent = `${slider.value}%`;
        },
        change: () => this.store.setEdgeShare(edgeId, Number(slider.value)),
      },
    });
    return this.helpField('Calls on', value, slider, 'Share of requests that call this service and wait for its answer. If it fails or is slow, so is the caller.');
  }

  refresh(snap: SimSnapshot | null): void {
    const sel = this.store.selection;
    if (!sel || !this.live || !this.vitals) return;
    if (this.renderedFor !== `${sel.type}:${sel.id}`) return;

    if (sel.type === 'edge') {
      const em = snap?.edges[sel.id];
      const flow = em?.flow;
      const total = flow ? totalFlow(flow) : 0;
      const failing = em?.failFrac ?? 0;
      this.vitals.replaceChildren(
        tile('Flow', em ? `${formatRps(total)} rps` : '–'),
        tile('Failing', em ? `${(failing * 100).toFixed(1)}%` : '–', em ? toneAbove(failing, 0.01, 0.05) : ''),
        tile(em?.crossRegion ? 'Round trip · cross-region' : 'Round trip', em ? `${Math.round(em.rtt * 1000)} ms` : '–'),
      );
      if (!flow || total <= 0) {
        this.live.replaceChildren();
        return;
      }
      const bars = h('div', { class: 'flow-bars' });
      for (const cls of TRAFFIC_CLASSES) bars.append(h('div', { style: `width:${(flow[cls] / total) * 100}%;background:var(--${cls})` }));
      this.live.replaceChildren(
        bars,
        h('div', { class: 'legend' }, ...TRAFFIC_CLASSES.map((cls) => h('span', {}, h('i', { style: `background:var(--${cls})` }), `${cls} ${formatRps(flow[cls])}`))),
      );
      return;
    }

    const node = this.store.node(sel.id);
    const m = snap?.nodes[sel.id];
    if (this.restartButton) this.restartButton.hidden = this.store.editingLocked || !this.actions.canRestart(sel.id);
    if (this.status) {
      const status = m?.status ?? 'idle';
      this.status.dataset.status = status;
      this.status.textContent = STATUS_LABEL[status];
    }
    if (!node || !m || !snap) {
      this.vitals.replaceChildren(tile('Traffic', '–'), tile('Busy', '–'), tile('p99', '–'), tile('Success', '–'));
      this.live.replaceChildren(h('p', { class: 'muted small' }, 'Press Run to see live numbers. Settings are in the next tab.'));
      return;
    }

    this.vitals.replaceChildren(
      tile('Traffic', `${formatRps(m.inRps)} rps`),
      tile('Busy', `${Math.round(m.utilization * 100)}%`, toneAbove(m.utilization, 0.7, 0.9), m.utilization),
      tile('p99', ms(m.pathP99), toneAbove(m.pathP99, 0.5, 2)),
      tile('Success', `${(m.successFrac * 100).toFixed(1)}%`, toneAbove(1 - m.successFrac, 0.01, 0.05)),
    );

    if (this.tab !== 'live') return;
    const { key, more } = this.rows(node, m, snap);
    const advice = this.advice(node, m);
    this.live.replaceChildren(
      ...(advice ? [advice] : []),
      statList(key),
      h('details', { class: 'insp-more', open: this.moreOpen() }, h('summary', {}, 'More numbers'), statList(more)),
    );
  }

  private moreOpen(): boolean {
    return this.live?.querySelector('details')?.open ?? false;
  }

  private rows(node: NodeSpec, m: NodeMetrics, snap: SimSnapshot): { key: Row[]; more: Row[] } {
    const key: Row[] = [];
    const more: Row[] = [];
    if (['app', 'workers', 'cache', 'replica', 'search'].includes(node.kind)) {
      key.push({ label: 'Instances up', value: `${m.healthyInstances} / ${m.totalInstances}${m.bootingInstances ? ` · ${m.bootingInstances} starting` : ''}` });
    }
    if (m.concurrencyUtil > 0.05) {
      key.push({ label: node.kind === 'db' ? 'Connections in use' : 'Worker pool in use', value: `${Math.round(Math.min(m.concurrencyUtil, 9.99) * 100)}%`, fill: m.concurrencyUtil, tone: toneAbove(m.concurrencyUtil, 0.7, 0.9) });
    }
    if (m.hitRatio !== undefined) key.push({ label: 'Hit ratio', value: `${Math.round(m.hitRatio * 100)}%`, fill: m.hitRatio });
    if (m.replicationLag !== undefined) key.push({ label: 'Replication lag', value: `${m.replicationLag.toFixed(2)} s` });
    if (m.queueDepth !== undefined) key.push({ label: 'Queue depth', value: formatRps(m.queueDepth) }, { label: 'Consumer lag', value: formatSeconds(m.queueLagSeconds ?? 0) });
    if (m.breakerState) key.push({ label: 'Breaker', value: m.breakerState.toUpperCase() });
    if (m.hotShardShare !== undefined) key.push({ label: 'Hottest shard share', value: `${Math.round(m.hotShardShare * 100)}%`, fill: m.hotShardShare, tone: toneAbove(m.hotShardShare, 0.3, 0.5) });
    if (m.droppedRps > 0.5) key.push({ label: 'Dropped', value: `${formatRps(m.droppedRps)} rps` });
    if (m.shedRps > 0.5) key.push({ label: 'Shed (429 / fail-fast)', value: `${formatRps(m.shedRps)} rps` });
    key.push({ label: 'Cost', value: `$${Math.round(m.costPerMonth).toLocaleString()}/mo` });

    more.push(
      { label: 'Region', value: regionLabel(m.region as RegionId) },
      { label: 'Own latency', value: ms(m.ownLatency) },
      { label: 'Latency incl. downstream', value: ms(m.pathLatency) },
    );
    if (m.inFlight) more.push({ label: 'Waiting to retry', value: formatRps(m.inFlight) });
    if (m.dlqDepth) more.push({ label: 'Dead-letter queue', value: formatRps(m.dlqDepth) });
    if (node.kind === 'queue' || node.kind === 'workers') {
      if (snap.global.lostTotal > 0.5) more.push({ label: 'Jobs lost', value: formatRps(snap.global.lostTotal) });
      if (snap.global.duplicatesTotal > 0.5) more.push({ label: 'Duplicated work', value: formatRps(snap.global.duplicatesTotal) });
    }
    return { key, more };
  }

  private advice(node: NodeSpec, m: NodeMetrics): HTMLElement | null {
    if (!m.reason || (m.utilization < 0.7 && !['down', 'no-backend', 'replication-lag', 'cold-cache', 'backlog', 'breaker-open', 'rate-limit', 'provider-limit'].includes(m.reason))) return null;
    const advice = adviceFor(node.kind, m.reason, m);
    const tone = m.status === 'overloaded' || m.status === 'down' ? 'bad' : 'warn';
    return h(
      'div',
      { class: 'card static', dataset: { tone } },
      h('div', { class: 'card-kicker' }, m.reason.replace('-', ' ')),
      h('div', { class: 'card-title' }, advice.headline),
      h('ul', {}, ...advice.techniques.map((t) => h('li', {}, t))),
      h('div', { class: 'chips' }, ...advice.curriculum.map((c) => h('span', { class: 'chip' }, c))),
    );
  }

  private field(node: NodeSpec, param: ParamDef): HTMLElement {
    const el = this.control(node, param);
    const locked = this.store.isParamLocked(node, param.key);
    if (locked || this.store.editingLocked) {
      el.querySelectorAll('input, select').forEach((input) => ((input as HTMLInputElement).disabled = true));
      if (locked) el.querySelector('.field-label')?.append(h('span', { class: 'lock', title: 'Set by the scenario' }, ' 🔒'));
    }
    return el;
  }

  private control(node: NodeSpec, param: ParamDef): HTMLElement {
    const current = node.params[param.key];
    if (param.type === 'boolean') {
      const input = h('input', { type: 'checkbox', checked: Boolean(current), on: { change: () => this.store.setParam(node.id, param.key, input.checked) } });
      return this.helpField(param.label, input, null, param.help);
    }
    if (param.type === 'select') {
      const select = h(
        'select',
        { on: { change: () => this.store.setParam(node.id, param.key, select.value) } },
        ...param.options.map((o) => h('option', { value: o, selected: o === current }, o)),
      );
      return this.helpField(param.label, select, null, param.help);
    }

    const logScale = param.min > 0 && param.max / param.min >= 1000;
    const toSlider = (v: number) => (logScale ? Math.log10(v) : v);
    const fromSlider = (s: number) => {
      if (!logScale) return s;
      const raw = Math.pow(10, s);
      const magnitude = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
      return Math.min(param.max, Math.max(param.min, Math.round(raw / magnitude) * magnitude));
    };
    const value = h('span', { class: 'field-value' }, formatParam(Number(current), param.unit));
    const slider = h('input', {
      type: 'range',
      min: String(toSlider(param.min)),
      max: String(toSlider(param.max)),
      step: logScale ? '0.01' : String(param.step),
      value: String(toSlider(Number(current))),
      on: {
        input: () => {
          const v = fromSlider(Number(slider.value));
          value.textContent = formatParam(v, param.unit);
          this.store.setParam(node.id, param.key, v);
        },
      },
    });
    return this.helpField(param.label, value, slider, param.help);
  }

  private helpField(label: string, control: HTMLElement, below: HTMLElement | null, help?: string): HTMLElement {
    const field = h('div', { class: 'field' });
    const labelEl = h('span', { class: 'field-label' }, label);
    if (help) {
      labelEl.append(
        h('button', { class: 'help-toggle', title: help, 'aria-label': `About ${label}`, on: { click: () => field.classList.toggle('show-help') } }, 'i'),
      );
    }
    field.append(h('div', { class: 'field-row' }, labelEl, control));
    if (below) field.append(below);
    if (help) field.append(h('div', { class: 'field-help' }, help));
    return field;
  }

  private exists(): boolean {
    const sel = this.store.selection;
    if (!sel) return false;
    return sel.type === 'node' ? !!this.store.node(sel.id) : !!this.store.edge(sel.id);
  }
}

function tile(label: string, value: string, tone: Tone = '', fill?: number): HTMLElement {
  return h(
    'div',
    { class: 'vital', dataset: { tone } },
    h('div', { class: 'vital-label' }, label),
    h('div', { class: 'vital-value' }, value),
    fill === undefined ? null : meter(fill, tone),
  );
}

function statList(rows: Row[]): HTMLElement {
  return h(
    'dl',
    { class: 'stats' },
    ...rows.flatMap((row) => [
      h('dt', {}, row.label),
      h('dd', {}, row.value, row.fill === undefined ? null : meter(row.fill, row.tone ?? '')),
    ]),
  );
}

function meter(fill: number, tone: Tone): HTMLElement {
  const pct = Math.max(0, Math.min(1, fill)) * 100;
  return h('span', { class: 'meter', dataset: { tone } }, h('i', { style: `width:${pct}%` }));
}

function toneAbove(value: number, warn: number, bad: number): Tone {
  if (value >= bad) return 'bad';
  if (value >= warn) return 'warn';
  return 'good';
}

function formatParam(value: number, unit?: string): string {
  const shown = Number.isInteger(value) ? (value >= 10000 ? formatRps(value) : String(value)) : value.toFixed(2);
  return unit ? `${shown}${unit === '%' ? '%' : ` ${unit}`}` : shown;
}

function ms(seconds: number): string {
  if (seconds >= 1) return `${seconds.toFixed(2)} s`;
  return `${(seconds * 1000).toFixed(seconds < 0.01 ? 1 : 0)} ms`;
}
