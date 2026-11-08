import { Interaction } from './interaction';
import { SceneView } from './render/scene';
import { diagnose } from './sim/analysis';
import { Simulation } from './sim/engine';
import { parseSaved, Store } from './state/store';
import { buildTemplate } from './state/templates';
import { h, isTyping } from './ui/dom';
import { DiagnosisPanel, EventLog, MetricsStrip } from './ui/hud';
import { Inspector } from './ui/inspector';
import { Palette } from './ui/palette';
import { Toolbar } from './ui/toolbar';

const SIM_STEP = 0.1;
const MAX_STEPS_PER_FRAME = 60;

const viewport = document.getElementById('viewport')!;
const store = new Store();
const sim = new Simulation();
const scene = new SceneView(viewport);
const interaction = new Interaction(viewport, scene, store);

let running = false;
let speed = 1;
let simAccumulator = 0;

const palette = new Palette(document.getElementById('palette')!, (kind, event) => {
  interaction.startPlacing(kind, event.pointerType !== 'touch');
});

const toolbar = new Toolbar(document.getElementById('toolbar')!, store, {
  loadTemplate: (id) => {
    store.load(buildTemplate(id));
    resetSim();
    scene.fit(store.design);
  },
  toggleRun: () => setRunning(!running),
  setSpeed: (s) => {
    speed = s;
    syncChrome();
  },
  resetSim: () => resetSim(),
  toggleConnect: () => interaction.toggleConnectMode(),
  fit: () => scene.fit(store.design),
  exportDesign: () => openJsonDialog('export'),
  importDesign: () => openJsonDialog('import'),
  clear: () => {
    if (!window.confirm('Remove every component from the canvas?')) return;
    store.load(buildTemplate('blank'));
    resetSim();
  },
});

const inspector = new Inspector(document.getElementById('inspector')!, store, {
  kill: (id) => sim.kill(id),
  flush: (id) => sim.flushCache(id),
});
const metrics = new MetricsStrip(document.getElementById('metrics')!);
const diagnosis = new DiagnosisPanel(document.getElementById('diagnosis')!, store);
const events = new EventLog(document.getElementById('events')!);
const hints = document.getElementById('hints')!;

store.onDesign(() => {
  sim.setDesign(store.design);
  scene.syncDesign(store.design);
});
store.onSelection(() => scene.setSelection(store.selection));
store.onTraffic(() => sim.setTraffic(store.traffic));
interaction.onChange(() => {
  palette.setActive(interaction.placingKind);
  syncChrome();
});

if (!store.restore()) store.load(buildTemplate('monolith'));
sim.setDesign(store.design);
sim.setTraffic(store.traffic);
scene.syncDesign(store.design);
scene.fit(store.design);
syncChrome();

function setRunning(next: boolean): void {
  running = next;
  syncChrome();
}

function resetSim(): void {
  sim.setDesign(store.design);
  sim.setTraffic(store.traffic);
  sim.reset();
  simAccumulator = 0;
  metrics.reset();
  diagnosis.render(null, running);
  events.render(sim.events);
  syncChrome();
}

function syncChrome(): void {
  toolbar.update(running, speed, interaction.connectMode, sim.t);
  const mode = interaction.modeLabel;
  hints.replaceChildren(
    mode ? h('div', { class: 'mode' }, mode) : '',
    h(
      'div',
      {},
      h('kbd', {}, 'Shift'),
      '-drag between components to connect · ',
      h('kbd', {}, 'Drag'),
      ' pan · ',
      h('kbd', {}, 'Right-drag'),
      ' rotate · ',
      h('kbd', {}, 'Scroll'),
      ' zoom · ',
      h('kbd', {}, 'Del'),
      ' remove · ',
      h('kbd', {}, 'Space'),
      ' run',
    ),
  );
}

window.addEventListener('keydown', (e) => {
  if (isTyping(e)) return;
  if (e.key === 'Escape') {
    interaction.cancel();
    store.select(null);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    store.removeSelected();
  } else if (e.key === ' ') {
    e.preventDefault();
    setRunning(!running);
  } else if (e.key === 'c' || e.key === 'C') {
    interaction.toggleConnectMode();
  } else if (e.key === 'f' || e.key === 'F') {
    scene.fit(store.design);
  } else if (e.key === 'r' || e.key === 'R') {
    resetSim();
  }
});

function openJsonDialog(mode: 'export' | 'import'): void {
  const textarea = h('textarea', { spellcheck: false });
  const error = h('div', { class: 'warning' });
  if (mode === 'export') textarea.value = JSON.stringify(store.serialize(), null, 2);
  const dialog = h(
    'dialog',
    {},
    h('h3', {}, mode === 'export' ? 'Export design' : 'Import design'),
    h('p', { class: 'muted small' }, mode === 'export' ? 'Copy this JSON, or download it.' : 'Paste a design exported from this simulator.'),
    textarea,
    error,
    h(
      'div',
      { class: 'actions' },
      mode === 'export'
        ? h(
            'button',
            {
              class: 'primary',
              on: {
                click: () => {
                  const blob = new Blob([textarea.value], { type: 'application/json' });
                  const a = h('a', { href: URL.createObjectURL(blob), download: 'system-design.json' });
                  a.click();
                  URL.revokeObjectURL(a.href);
                },
              },
            },
            'Download',
          )
        : h(
            'button',
            {
              class: 'primary',
              on: {
                click: () => {
                  try {
                    const parsed = parseSaved(textarea.value);
                    if (!parsed) throw new Error('That is not a design exported from this simulator.');
                    store.load(parsed);
                    resetSim();
                    scene.fit(store.design);
                    dialog.close();
                  } catch (err) {
                    error.textContent = err instanceof Error ? err.message : String(err);
                  }
                },
              },
            },
            'Import',
          ),
      h('button', { on: { click: () => dialog.close() } }, 'Close'),
    ),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

let last = performance.now();
let uiTimer = 0;

function frame(now: number): void {
  const frameDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  let simAdvanced = 0;

  if (running) {
    simAccumulator += frameDt * speed;
    let steps = 0;
    while (simAccumulator >= SIM_STEP && steps < MAX_STEPS_PER_FRAME) {
      sim.step(SIM_STEP);
      simAccumulator -= SIM_STEP;
      simAdvanced += SIM_STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) simAccumulator = 0;
  }

  const snap = sim.snapshot;
  scene.update(snap, frameDt * (running ? Math.min(speed, 3) : 1), running);
  scene.render();

  uiTimer -= frameDt;
  if (uiTimer <= 0) {
    uiTimer = 0.25;
    metrics.update(snap?.global ?? null, simAdvanced > 0 ? 0.5 : 0);
    if (snap) diagnosis.render(diagnose(store.design, snap), running);
    inspector.refresh(snap);
    events.render(sim.events);
    toolbar.update(running, speed, interaction.connectMode, sim.t);
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
