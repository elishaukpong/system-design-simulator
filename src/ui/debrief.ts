import { formatRps } from '../render/scene';
import type { RunResult, Sample, Scenario } from '../scenarios/types';
import { h } from './dom';
import { stars } from './scenarios';

export interface DebriefActions {
  retry(): void;
  pickScenario(): void;
  replay(): void;
}

const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const OFFERED = SERIES[0];
const SERVED = SERIES[2];
const W = 860;
const M = { left: 56, right: 14, top: 14, bottom: 8 };

const REASON_LABEL: Record<string, string> = {
  cpu: 'CPU',
  concurrency: 'worker pool',
  connections: 'connections',
  backlog: 'backlog',
  down: 'down',
  'rate-limit': 'rate limit',
  'hot-shard': 'hot shard',
  'replication-lag': 'replica lag',
  'no-backend': 'no route',
  'cold-cache': 'cold cache',
  'provider-limit': 'provider limit',
  'breaker-open': 'breaker open',
  'write-ceiling': 'write ceiling',
};

export function openDebrief(scenario: Scenario, result: RunResult, actions: DebriefActions): void {
  const dialog = h('dialog', { class: 'debrief' });
  const close = () => dialog.close();

  const verdict = result.passed ? `Passed ${stars(result.stars)}` : 'Failed';
  const charts = buildCharts(scenario, result);

  dialog.append(
    h(
      'div',
      { class: 'debrief-head', dataset: { pass: String(result.passed) } },
      h('div', {}, h('div', { class: 'card-kicker' }, scenario.title), h('h3', {}, `${result.passed ? '✓' : '✗'} ${verdict}`)),
      h('div', { class: 'muted small' }, starsExplainer(result)),
    ),
    h(
      'table',
      { class: 'criteria' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Target'), h('th', {}, 'Goal'), h('th', {}, 'Measured'))),
      h(
        'tbody',
        {},
        ...result.criteria.map((c) =>
          h(
            'tr',
            { dataset: { pass: String(c.pass) } },
            h('td', {}, h('span', { class: 'check-icon' }, c.pass ? '✓' : '✗'), h('span', { class: 'target-role', dataset: { role: c.role } }, c.role === 'core' ? 'Must' : c.role === 'budget' ? 'Budget' : 'Bonus')),
            h('td', {}, c.label),
            h('td', { class: 'muted' }, c.target),
            h('td', { class: 'mono' }, c.measured),
          ),
        ),
      ),
    ),
    charts,
    h(
      'div',
      { class: 'debrief-cols' },
      h(
        'section',
        {},
        h('h4', {}, 'What gave way, in order'),
        result.walls.length
          ? h('ol', {}, ...result.walls.map((w) => h('li', {}, h('span', { class: 'mono' }, `t=${w.t}s`), ` at ${formatRps(w.rps)} rps: `, h('strong', {}, w.name), ` (${REASON_LABEL[w.reason ?? ''] ?? w.reason ?? 'pressure'})`)))
          : h('p', { class: 'muted small' }, 'Nothing hit a wall. Either the design has headroom, or it is over-provisioned. Check the budget line.'),
        result.chaos.length ? h('h4', {}, 'Chaos') : null,
        ...result.chaos.map((c) => h('div', { class: 'small' }, h('span', { class: 'mono' }, `t=${c.t}s `), c.message)),
      ),
      h(
        'section',
        {},
        h('h4', {}, 'Trade-offs you accepted'),
        result.tradeoffs.length
          ? h('ul', { class: 'tradeoffs' }, ...result.tradeoffs.map((t) => h('li', {}, t.text, ' ', h('span', { class: 'chip' }, t.curriculum))))
          : h('p', { class: 'muted small' }, 'None worth naming.'),
      ),
    ),
    h('div', { class: 'chips' }, ...scenario.curriculum.map((c) => h('span', { class: 'chip' }, c))),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'primary', on: { click: () => { close(); actions.retry(); } } }, '▶ Run again'),
      result.frames.length ? h('button', { title: 'Watch the run again in 3D, scrubbable', on: { click: () => { close(); actions.replay(); } } }, '⏵ Replay in 3D') : null,
      h('button', { on: { click: close } }, 'Back to the design'),
      h('button', { on: { click: () => { close(); actions.pickScenario(); } } }, 'Other scenarios'),
    ),
  );

  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function starsExplainer(result: RunResult): string {
  if (!result.passed) return 'A "Must" target was missed. Fix that first; budget and bonus only count once it passes.';
  if (result.stars === 1) return 'Survived, but over budget. Find what you are paying for that does not earn its keep.';
  if (result.stars === 2) return 'Survived on budget. A bonus target is still open.';
  return 'Every target met.';
}

function buildCharts(scenario: Scenario, result: RunResult): HTMLElement {
  const samples = result.samples;
  const duration = scenario.duration;
  const x = (t: number) => M.left + (t / duration) * (W - M.left - M.right);
  const container = h('div', { class: 'charts' });
  if (samples.length < 2) return container;

  const tooltip = h('div', { class: 'chart-tip', hidden: true });
  const crosshairs: SVGLineElement[] = [];

  const rpsMax = Math.max(...samples.map((s) => s.offered)) * 1.1 || 1;
  const throughput = lineChart({
    title: 'Requests per second',
    height: 150,
    max: rpsMax,
    format: formatRps,
    x,
    series: [
      { label: 'Served OK', color: SERVED, values: samples.map((s) => [s.t, s.success]) },
      { label: 'Offered', color: OFFERED, values: samples.map((s) => [s.t, s.offered]), dashed: true },
    ],
    chaos: result.chaos.map((c) => c.t),
    crosshairs,
  });

  const p99Target = scenario.criteria.find((c) => c.criterion.type === 'p99')?.criterion;
  const targetMs = p99Target && p99Target.type === 'p99' ? p99Target.maxMs : null;
  const p99Max = Math.max(targetMs ?? 0, ...samples.map((s) => s.p99 * 1000)) * 1.15 || 1;
  const latency = lineChart({
    title: 'p99 latency',
    height: 130,
    max: p99Max,
    format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`),
    x,
    series: [{ label: 'p99', color: OFFERED, values: samples.map((s) => [s.t, s.p99 * 1000]) }],
    threshold: targetMs !== null ? { value: targetMs, label: `target ${targetMs}ms` } : undefined,
    chaos: result.chaos.map((c) => c.t),
    crosshairs,
  });

  const strip = bindingStrip(samples, x, duration, crosshairs);

  container.append(throughput, latency, strip, tooltip);

  container.addEventListener('pointermove', (event) => {
    const svg = container.querySelector('svg');
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const t = ((px - M.left) / (W - M.left - M.right)) * duration;
    if (t < 0 || t > duration) {
      tooltip.hidden = true;
      crosshairs.forEach((l) => l.setAttribute('visibility', 'hidden'));
      return;
    }
    const sample = nearest(samples, t);
    crosshairs.forEach((l) => {
      l.setAttribute('x1', String(x(sample.t)));
      l.setAttribute('x2', String(x(sample.t)));
      l.setAttribute('visibility', 'visible');
    });
    tooltip.hidden = false;
    tooltip.replaceChildren(
      h('div', { class: 'mono' }, `t = ${sample.t}s`),
      tipRow(OFFERED, 'Offered', `${formatRps(sample.offered)} rps`),
      tipRow(SERVED, 'Served OK', `${formatRps(sample.success)} rps`),
      tipRow(null, 'Errors', `${(Math.max(0, sample.errorRate - sample.shedRate) * 100).toFixed(1)}%`),
      sample.shedRate > 0.001 ? tipRow(null, 'Turned away', `${(sample.shedRate * 100).toFixed(1)}%`) : '',
      tipRow(null, 'p99', sample.p99 >= 1 ? `${sample.p99.toFixed(2)}s` : `${Math.round(sample.p99 * 1000)}ms`),
      tipRow(null, 'Binding', sample.binding ? `${sample.binding.name} (${REASON_LABEL[sample.binding.reason ?? ''] ?? sample.binding.reason})` : 'nothing'),
    );
    const containerRect = container.getBoundingClientRect();
    const left = event.clientX - containerRect.left;
    tooltip.style.left = `${Math.min(left + 14, containerRect.width - 220)}px`;
    tooltip.style.top = `${event.clientY - containerRect.top + 12}px`;
  });
  container.addEventListener('pointerleave', () => {
    tooltip.hidden = true;
    crosshairs.forEach((l) => l.setAttribute('visibility', 'hidden'));
  });

  return container;
}

interface LineChartOptions {
  title: string;
  height: number;
  max: number;
  format: (v: number) => string;
  x: (t: number) => number;
  series: Array<{ label: string; color: string; values: Array<[number, number]>; dashed?: boolean }>;
  threshold?: { value: number; label: string };
  chaos: number[];
  crosshairs: SVGLineElement[];
}

function lineChart(o: LineChartOptions): HTMLElement {
  const H = o.height;
  const y = (v: number) => H - M.bottom - (v / o.max) * (H - M.top - M.bottom);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': o.title });

  for (const frac of [0, 0.5, 1]) {
    const v = o.max * frac;
    svg.append(
      svgEl('line', { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v), class: 'grid' }),
      svgEl('text', { x: M.left - 8, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }, o.format(v)),
    );
  }

  for (const t of o.chaos) {
    svg.append(
      svgEl('line', { x1: o.x(t), x2: o.x(t), y1: M.top - 6, y2: H - M.bottom, class: 'chaos-line' }),
      svgEl('text', { x: o.x(t) + 4, y: M.top + 2, class: 'chaos-label' }, `⚡ ${t}s`),
    );
  }

  if (o.threshold) {
    svg.append(
      svgEl('line', { x1: M.left, x2: W - M.right, y1: y(o.threshold.value), y2: y(o.threshold.value), class: 'threshold' }),
      svgEl('text', { x: W - M.right - 4, y: y(o.threshold.value) - 5, class: 'axis', 'text-anchor': 'end' }, o.threshold.label),
    );
  }

  for (const s of o.series) {
    const d = s.values.map(([t, v], i) => `${i ? 'L' : 'M'}${o.x(t).toFixed(1)},${y(Math.min(v, o.max)).toFixed(1)}`).join('');
    svg.append(svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', ...(s.dashed ? { 'stroke-dasharray': '6 4' } : {}) }));
  }

  const crosshair = svgEl('line', { y1: M.top, y2: H - M.bottom, class: 'crosshair', visibility: 'hidden' }) as SVGLineElement;
  o.crosshairs.push(crosshair);
  svg.append(crosshair);

  const legend = o.series.length > 1
    ? h('div', { class: 'legend' }, ...o.series.map((s) => h('span', {}, h('i', { class: s.dashed ? 'dashed' : '', style: s.dashed ? `border-color:${s.color}` : `background:${s.color}` }), s.label)))
    : null;
  return h('figure', { class: 'chart-figure' }, h('figcaption', {}, h('span', { class: 'chart-title' }, o.title), legend), svg);
}

function bindingStrip(samples: Sample[], x: (t: number) => number, duration: number, crosshairs: SVGLineElement[]): HTMLElement {
  const H = 46;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': 'Binding pressure over time' });
  const order: string[] = [];
  const names = new Map<string, string>();
  for (const s of samples) {
    if (s.binding && !order.includes(s.binding.nodeId)) {
      order.push(s.binding.nodeId);
      names.set(s.binding.nodeId, s.binding.name);
    }
  }
  const color = (id: string) => SERIES[order.indexOf(id) % SERIES.length];

  svg.append(svgEl('rect', { x: M.left, y: 4, width: W - M.left - M.right, height: 20, rx: 4, class: 'strip-bg' }));
  let start = 0;
  while (start < samples.length) {
    const id = samples[start].binding?.nodeId ?? null;
    let end = start;
    while (end + 1 < samples.length && (samples[end + 1].binding?.nodeId ?? null) === id) end++;
    if (id) {
      const x0 = x(Math.max(0, samples[start].t - 1));
      const x1 = x(samples[end].t);
      const width = Math.max(1, x1 - x0 - 2);
      svg.append(svgEl('rect', { x: x0 + 1, y: 4, width, height: 20, rx: 4, fill: color(id) }));
      if (width > 70) svg.append(svgEl('text', { x: x0 + 7, y: 18, class: 'strip-label' }, truncate(names.get(id) ?? id, Math.floor(width / 7))));
    }
    start = end + 1;
  }

  for (let t = 0; t <= duration; t += 30) {
    svg.append(svgEl('text', { x: x(t), y: 40, class: 'axis', 'text-anchor': 'middle' }, `${t}s`));
  }
  const crosshair = svgEl('line', { y1: 2, y2: 26, class: 'crosshair', visibility: 'hidden' }) as SVGLineElement;
  crosshairs.push(crosshair);
  svg.append(crosshair);

  const legend = order.length
    ? h('div', { class: 'legend' }, ...order.map((id) => h('span', {}, h('i', { style: `background:${color(id)}` }), names.get(id) ?? id)))
    : h('div', { class: 'legend' }, h('span', { class: 'muted' }, 'Nothing bound during the run'));
  return h('figure', { class: 'chart-figure' }, h('figcaption', {}, h('span', { class: 'chart-title' }, 'Binding pressure'), legend), svg);
}

function tipRow(color: string | null, label: string, value: string): HTMLElement {
  return h('div', { class: 'tip-row' }, h('span', {}, color ? h('i', { style: `background:${color}` }) : null, label), h('span', { class: 'mono' }, value));
}

function nearest(samples: Sample[], t: number): Sample {
  let best = samples[0];
  for (const s of samples) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
  return best;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function svgEl(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}
