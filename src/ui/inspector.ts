import { adviceFor, formatSeconds } from '../sim/analysis';
import { CATALOG, type ParamDef } from '../sim/catalog';
import { formatRps } from '../render/scene';
import type { Store } from '../state/store';
import type { NodeMetrics, NodeSpec, SimSnapshot } from '../sim/types';
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

export class Inspector {
  private live: HTMLElement | null = null;
  private restartButton: HTMLButtonElement | null = null;
  private renderedFor: string | null = null;

  constructor(private root: HTMLElement, private store: Store, private actions: InspectorActions) {
    store.onSelection(() => this.render());
    store.onDesign(() => {
      if (this.store.selection && !this.exists()) this.render();
      else if (this.store.selection?.type === 'edge') this.render();
    });
    this.render();
  }

  render(): void {
    const sel = this.store.selection;
    this.root.replaceChildren();
    this.live = null;
    this.renderedFor = sel ? `${sel.type}:${sel.id}` : null;

    if (!sel || !this.exists()) {
      this.root.append(
        h('h2', { class: 'panel-title' }, 'Inspector'),
        h(
          'div',
          { class: 'muted small' },
          h('p', {}, 'Pick a component on the left, then click the grid to place it.'),
          h('p', {}, 'Shift-drag from one component to another to connect them. Traffic flows in the direction of the arrow.'),
          h('p', {}, 'Set the traffic, press Run, and watch for the first thing to turn red.'),
        ),
      );
      return;
    }

    if (sel.type === 'edge') {
      const edge = this.store.edge(sel.id)!;
      const from = this.store.node(edge.from)!;
      const to = this.store.node(edge.to)!;
      this.live = h('div');
      const extra = edge.latencyMs ?? 0;
      const extraValue = h('span', { class: 'field-value' }, `${extra} ms`);
      const extraSlider = h('input', {
        type: 'range',
        min: '0',
        max: '500',
        step: '5',
        value: String(extra),
        disabled: this.store.editingLocked,
        on: {
          input: () => {
            extraValue.textContent = `${extraSlider.value} ms`;
          },
          change: () => this.store.setEdgeLatency(edge.id, Number(extraSlider.value)),
        },
      });
      const shareField = from.kind === 'gateway' ? this.shareField(edge.id, from.id) : null;
      this.root.append(
        h('h2', { class: 'panel-title' }, 'Connection'),
        h('div', { class: 'insp-head' }, h('strong', {}, `${from.name} → ${to.name}`)),
        this.live,
        ...(shareField ? [shareField] : []),
        h(
          'div',
          { class: 'field' },
          h('div', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Extra latency'), extraValue),
          extraSlider,
          h('div', { class: 'field-help' }, 'On top of the network. A chatty protocol, TLS without reuse, a slow proxy.'),
        ),
        h(
          'div',
          { class: 'actions' },
          h('button', { on: { click: () => this.store.reverseEdge(edge.id) } }, '⇄ Reverse'),
          h('button', { class: 'danger', on: { click: () => this.store.removeEdge(edge.id) } }, 'Delete'),
        ),
      );
      return;
    }

    const node = this.store.node(sel.id)!;
    const def = CATALOG[node.kind];
    const nameInput = h('input', {
      class: 'insp-name',
      value: node.name,
      disabled: node.locked || this.store.editingLocked,
      on: { change: () => this.store.rename(node.id, nameInput.value.trim() || def.label) },
    });

    const params = h('div');
    for (const param of def.params) params.append(this.field(node, param));

    this.live = h('div');
    this.restartButton = h('button', { class: 'primary', title: 'Bring it back in 5s instead of waiting', hidden: true, on: { click: () => this.actions.restart(node.id) } }, '🔄 Restart');
    const chaos = h('div', { class: 'actions' }, this.restartButton, h('button', { class: 'danger', title: 'Kill every instance for 30s', on: { click: () => this.actions.kill(node.id) } }, '💥 Kill'));
    if (node.kind === 'cache') chaos.append(h('button', { title: 'Empty the cache', on: { click: () => this.actions.flush(node.id) } }, '🧹 Flush'));
    if (node.kind !== 'clients') {
      const region = regionAt(node.z);
      chaos.append(h('button', { class: 'danger', title: `Take every component in ${region} down for 60s`, on: { click: () => this.actions.killRegion(region) } }, `🌩 Kill ${region}`));
    }
    if (!node.locked && !this.store.editingLocked) chaos.append(h('button', { class: 'danger', on: { click: () => this.store.removeNode(node.id) } }, 'Delete'));
    if (node.locked) chaos.append(h('span', { class: 'muted small' }, '🔒 Part of the scenario. You cannot change it.'));

    this.root.append(
      h('h2', { class: 'panel-title' }, def.label, h('span', { class: 'palette-swatch', style: `background:${hex(def.color)};width:auto;height:auto;padding:1px 6px` }, def.short)),
      h('div', { class: 'insp-head' }, nameInput),
      h('p', { class: 'muted small' }, def.blurb),
      this.live,
      params,
      chaos,
    );
  }

  private shareField(edgeId: string, gatewayId: string): HTMLElement {
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
      disabled: this.store.editingLocked,
      on: {
        input: () => {
          value.textContent = `${effective(Number(slider.value))}%`;
        },
        change: () => this.store.setEdgeShare(edgeId, Number(slider.value)),
      },
    });
    return h(
      'div',
      { class: 'field' },
      h('div', { class: 'field-row' }, h('span', { class: 'field-label' }, 'Path share'), value),
      slider,
      h('div', { class: 'field-help' }, 'How much of the gateway\'s traffic goes down this path, like /search or /checkout. Shares are relative to the other paths.'),
    );
  }

  refresh(snap: SimSnapshot | null): void {
    const sel = this.store.selection;
    if (!sel || !this.live) return;
    if (this.renderedFor !== `${sel.type}:${sel.id}`) return;

    if (sel.type === 'edge') {
      const em = snap?.edges[sel.id];
      const flow = em?.flow;
      const total = flow ? totalFlow(flow) : 0;
      const bars = h('div', { class: 'flow-bars' });
      if (flow && total > 0) {
        for (const cls of TRAFFIC_CLASSES) bars.append(h('div', { style: `width:${(flow[cls] / total) * 100}%;background:var(--${cls})` }));
      }
      this.live.replaceChildren(
        h(
          'dl',
          { class: 'stats' },
          h('dt', {}, 'Flow'),
          h('dd', {}, `${formatRps(total)} rps`),
          h('dt', {}, 'Failing downstream'),
          h('dd', {}, `${((em?.failFrac ?? 0) * 100).toFixed(1)}%`),
          h('dt', {}, em?.crossRegion ? 'Round trip (cross-region)' : 'Round trip'),
          h('dd', {}, `${Math.round((em?.rtt ?? 0) * 1000)} ms`),
        ),
        bars,
        h('div', { class: 'legend' }, ...TRAFFIC_CLASSES.map((cls) => h('span', {}, h('i', { style: `background:var(--${cls})` }), `${cls} ${formatRps(flow?.[cls] ?? 0)}`))),
      );
      return;
    }

    const node = this.store.node(sel.id);
    const m = snap?.nodes[sel.id];
    if (this.restartButton) this.restartButton.hidden = this.store.editingLocked || !this.actions.canRestart(sel.id);
    if (!node || !m) {
      this.live.replaceChildren(h('p', { class: 'muted small' }, 'Press Run to see live numbers.'));
      return;
    }
    const advice = this.advice(node, m);
    this.live.replaceChildren(this.stats(node, m, snap!), ...(advice ? [advice] : []));
  }

  private stats(node: NodeSpec, m: NodeMetrics, snap: SimSnapshot): HTMLElement {
    const rows: Array<[string, string]> = [
      ['Region', regionLabel(m.region as RegionId)],
      ['Incoming', `${formatRps(m.inRps)} rps`],
      ['Utilisation', `${Math.round(m.utilization * 100)}%`],
      ['Own latency', ms(m.ownLatency)],
      ['Latency incl. downstream', ms(m.pathLatency)],
      ['p99 incl. downstream', ms(m.pathP99)],
      ['Success', `${(m.successFrac * 100).toFixed(1)}%`],
    ];
    if (m.droppedRps > 0.5) rows.push(['Dropped', `${formatRps(m.droppedRps)} rps`]);
    if (m.shedRps > 0.5) rows.push(['Shed (429 / fail-fast)', `${formatRps(m.shedRps)} rps`]);
    if (m.concurrencyUtil > 0.05) rows.push([node.kind === 'db' ? 'Connections in use' : 'Worker pool in use', `${Math.round(Math.min(m.concurrencyUtil, 9.99) * 100)}%`]);
    if (['app', 'workers', 'cache', 'replica', 'search'].includes(node.kind)) rows.push(['Instances up', `${m.healthyInstances} / ${m.totalInstances}${m.bootingInstances ? ` (${m.bootingInstances} starting)` : ''}`]);
    if (m.hitRatio !== undefined) rows.push(['Hit ratio', `${Math.round(m.hitRatio * 100)}%`]);
    if (m.replicationLag !== undefined) rows.push(['Replication lag', `${m.replicationLag.toFixed(2)}s`]);
    if (m.queueDepth !== undefined) rows.push(['Queue depth', formatRps(m.queueDepth)], ['Consumer lag', formatSeconds(m.queueLagSeconds ?? 0)]);
    if (m.inFlight) rows.push(['Waiting to retry', formatRps(m.inFlight)]);
    if (m.dlqDepth) rows.push(['Dead-letter queue', formatRps(m.dlqDepth)]);
    if (node.kind === 'queue' || node.kind === 'workers') {
      if (snap.global.lostTotal > 0.5) rows.push(['Jobs lost', formatRps(snap.global.lostTotal)]);
      if (snap.global.duplicatesTotal > 0.5) rows.push(['Duplicated work', formatRps(snap.global.duplicatesTotal)]);
    }
    if (m.breakerState) rows.push(['Breaker', m.breakerState.toUpperCase()]);
    if (m.hotShardShare !== undefined) rows.push(['Hottest shard share', `${Math.round(m.hotShardShare * 100)}%`]);
    rows.push(['Cost', `$${Math.round(m.costPerMonth).toLocaleString()}/mo`]);
    return h('dl', { class: 'stats' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  }

  private advice(node: NodeSpec, m: NodeMetrics): HTMLElement | null {
    if (!m.reason || (m.utilization < 0.7 && !['down', 'no-backend', 'replication-lag', 'cold-cache', 'backlog', 'breaker-open', 'rate-limit', 'provider-limit'].includes(m.reason))) return null;
    const advice = adviceFor(node.kind, m.reason, m);
    const tone = m.status === 'overloaded' || m.status === 'down' ? 'bad' : 'warn';
    return h(
      'div',
      { class: 'card', dataset: { tone } },
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
      return h('div', { class: 'field' }, h('label', { class: 'toggle' }, h('span', { class: 'field-label' }, param.label), input), param.help ? h('div', { class: 'field-help' }, param.help) : null);
    }
    if (param.type === 'select') {
      const select = h(
        'select',
        { on: { change: () => this.store.setParam(node.id, param.key, select.value) } },
        ...param.options.map((o) => h('option', { value: o, selected: o === current }, o)),
      );
      return h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'field-label' }, param.label), select), param.help ? h('div', { class: 'field-help' }, param.help) : null);
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
    return h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'field-label' }, param.label), value), slider, param.help ? h('div', { class: 'field-help' }, param.help) : null);
  }

  private exists(): boolean {
    const sel = this.store.selection;
    if (!sel) return false;
    return sel.type === 'node' ? !!this.store.node(sel.id) : !!this.store.edge(sel.id);
  }
}

function formatParam(value: number, unit?: string): string {
  const shown = Number.isInteger(value) ? (value >= 10000 ? formatRps(value) : String(value)) : value.toFixed(2);
  return unit ? `${shown}${unit === '%' ? '%' : ` ${unit}`}` : shown;
}

function ms(seconds: number): string {
  if (seconds >= 1) return `${seconds.toFixed(2)} s`;
  return `${(seconds * 1000).toFixed(seconds < 0.01 ? 1 : 0)} ms`;
}
