import type { Diagnosis, Pressure } from '../sim/analysis';
import { formatRps } from '../render/scene';
import type { Store } from '../state/store';
import type { GlobalMetrics, SimEvent } from '../sim/types';
import { h } from './dom';

type Tone = 'good' | 'warn' | 'bad' | '';

interface Tile {
  key: string;
  label: string;
  value: (g: GlobalMetrics) => number;
  format: (v: number) => string;
  tone: (g: GlobalMetrics) => Tone;
  color: string;
  el?: HTMLElement;
  valueEl?: HTMLElement;
  canvas?: HTMLCanvasElement;
  history: number[];
}

const HISTORY = 120;

export class MetricsStrip {
  private tiles: Tile[] = [
    { key: 'offered', label: 'Offered', value: (g) => g.offeredRps, format: (v) => `${formatRps(v)} rps`, tone: () => '', color: '#fde68a', history: [] },
    { key: 'success', label: 'Served OK', value: (g) => g.successRps, format: (v) => `${formatRps(v)} rps`, tone: (g) => (g.offeredRps > 0 && g.successRps / g.offeredRps < 0.99 ? 'warn' : 'good'), color: '#86efac', history: [] },
    { key: 'errors', label: 'Errors', value: (g) => Math.max(0, g.errorRate - g.shedRate) * 100, format: pctFmt, tone: (g) => toneFor(g.errorRate - g.shedRate, 0.001, 0.01), color: '#f87171', history: [] },
    { key: 'shed', label: 'Shed (429)', value: (g) => g.shedRate * 100, format: pctFmt, tone: (g) => (g.shedRate > 0.001 ? 'warn' : ''), color: '#fbbf24', history: [] },
    { key: 'p50', label: 'p50', value: (g) => g.p50 * 1000, format: msFmt, tone: (g) => toneFor(g.p50, 0.2, 1), color: '#7dd3fc', history: [] },
    { key: 'p99', label: 'p99', value: (g) => g.p99 * 1000, format: msFmt, tone: (g) => toneFor(g.p99, 0.5, 2), color: '#a78bfa', history: [] },
    { key: 'retry', label: 'Retry amp.', value: (g) => g.retryAmplification, format: (v) => `${v.toFixed(2)}×`, tone: (g) => toneFor(g.retryAmplification - 1, 0.05, 0.3), color: '#fb923c', history: [] },
    { key: 'cost', label: 'Cost', value: (g) => g.costPerMonth, format: (v) => `$${formatRps(v)}/mo`, tone: () => '', color: '#5eead4', history: [] },
  ];
  private sampleTimer = 0;

  constructor(root: HTMLElement) {
    for (const tile of this.tiles) {
      tile.valueEl = h('div', { class: 'metric-value' }, '–');
      tile.canvas = h('canvas', { width: 160, height: 44 });
      tile.el = h('div', { class: 'metric' }, h('div', { class: 'metric-label' }, tile.label), tile.valueEl, tile.canvas);
      root.append(tile.el);
    }
  }

  reset(): void {
    for (const tile of this.tiles) tile.history = [];
    this.sampleTimer = 0;
  }

  update(g: GlobalMetrics | null, simDt: number): void {
    if (!g) return;
    this.sampleTimer -= simDt;
    const sample = this.sampleTimer <= 0;
    if (sample) this.sampleTimer = 0.5;
    for (const tile of this.tiles) {
      const value = tile.value(g);
      tile.valueEl!.textContent = tile.format(value);
      tile.el!.dataset.tone = tile.tone(g);
      if (sample) {
        tile.history.push(value);
        if (tile.history.length > HISTORY) tile.history.shift();
        drawSpark(tile.canvas!, tile.history, tile.color);
      }
    }
  }
}

export class DiagnosisPanel {
  private lastKey = '';

  constructor(private root: HTMLElement, private store: Store) {
    this.render(null, false);
  }

  render(d: Diagnosis | null, running: boolean): void {
    const key = d ? JSON.stringify([d.binding?.nodeId, d.binding?.reason, Math.round((d.binding?.score ?? 0) * 20), d.next?.nodeId, d.closestWall?.nodeId, Math.round(Math.log10(d.closestWall?.bindsAtRps ?? 1) * 10), d.symptoms.map((s) => s.nodeId), d.warnings]) : `none:${running}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const title = h('h2', { class: 'panel-title' }, 'Binding pressure');
    if (!d) {
      this.root.replaceChildren(title, h('p', { class: 'muted small' }, running ? 'Measuring…' : 'Press Run. The first wall your design hits shows up here.'));
      return;
    }

    const parts: HTMLElement[] = [title];
    if (d.binding) parts.push(this.card(d.binding, 'bad', 'Binding now'));
    if (d.next) parts.push(this.card(d.next, 'warn', 'Next to bind', true));
    if (!d.binding && d.closestWall) {
      const wall = d.closestWall;
      parts.push(
        h(
          'div',
          { class: 'card', dataset: { tone: 'good' }, on: { click: () => this.store.select({ type: 'node', id: wall.nodeId }) } },
          h('div', { class: 'card-kicker' }, 'Nothing binding yet'),
          h('div', { class: 'card-title' }, `Closest wall: ${wall.name}, ${Math.round(wall.score * 100)}% utilised`),
          wall.bindsAtRps ? h('div', { class: 'muted small' }, `At this traffic shape it binds around ${formatRps(wall.bindsAtRps)} rps. Push the dial and check.`) : null,
        ),
      );
    }
    for (const s of d.symptoms) {
      const culprit = this.store.node(s.symptomOf!)?.name ?? s.symptomOf;
      parts.push(h('div', { class: 'symptom' }, `↳ ${s.name} is struggling (${s.reason}), but that is a symptom of ${culprit}.`));
    }
    for (const w of d.warnings.slice(0, 4)) parts.push(h('div', { class: 'warning' }, `⚠ ${w}`));
    this.root.replaceChildren(...parts);
  }

  private card(p: Pressure, tone: Tone, kicker: string, compact = false): HTMLElement {
    return h(
      'div',
      { class: 'card', dataset: { tone }, on: { click: () => this.store.select({ type: 'node', id: p.nodeId }) } },
      h('div', { class: 'card-kicker' }, `${kicker} · ${p.name} · ${p.reason === 'down' ? 'DOWN' : p.reason === 'no-backend' ? 'NO ROUTE' : `${Math.round(p.score * 100)}%`}`),
      h('div', { class: 'card-title' }, p.advice.headline),
      compact
        ? p.bindsAtRps && p.score < 1
          ? h('div', { class: 'muted small' }, `Binds around ${formatRps(p.bindsAtRps)} rps.`)
          : null
        : h('ul', {}, ...p.advice.techniques.map((t) => h('li', {}, t))),
      compact ? null : h('div', { class: 'chips' }, ...p.advice.curriculum.map((c) => h('span', { class: 'chip' }, c))),
    );
  }
}

export class EventLog {
  private shown = -1;
  private list: HTMLElement;

  constructor(root: HTMLElement) {
    this.list = h('div');
    root.append(h('h2', { class: 'panel-title' }, 'Events'), this.list);
  }

  render(events: SimEvent[]): void {
    const stamp = events.length ? events.length * 1e6 + events[events.length - 1].t : 0;
    if (stamp === this.shown) return;
    this.shown = stamp;
    if (!events.length) {
      this.list.replaceChildren(h('div', { class: 'muted small' }, 'Crashes, autoscaling and breaker trips show up here.'));
      return;
    }
    this.list.replaceChildren(
      ...[...events].reverse().slice(0, 60).map((e) => h('div', { class: 'event', dataset: { level: e.level } }, h('time', {}, `${e.t.toFixed(0)}s`), h('span', {}, e.message))),
    );
  }
}

function drawSpark(canvas: HTMLCanvasElement, values: number[], color: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const hgt = canvas.height;
  ctx.clearRect(0, 0, w, hgt);
  if (values.length < 2) return;
  const max = Math.max(...values, 1e-9);
  const step = w / (HISTORY - 1);
  const x0 = w - (values.length - 1) * step;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = x0 + i * step;
    const y = hgt - 3 - (v / max) * (hgt - 8);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(w, hgt);
  ctx.lineTo(x0, hgt);
  ctx.closePath();
  ctx.fillStyle = `${color}22`;
  ctx.fill();
}

function toneFor(value: number, warn: number, bad: number): Tone {
  if (value >= bad) return 'bad';
  if (value >= warn) return 'warn';
  return 'good';
}

function pctFmt(v: number): string {
  return v < 0.1 && v > 0 ? `${v.toFixed(2)}%` : `${v.toFixed(1)}%`;
}

function msFmt(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(0)} ms`;
}
