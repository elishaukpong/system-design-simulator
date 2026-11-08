import { Interaction } from './interaction';
import { formatRps, SceneView } from './render/scene';
import { diagnose } from './sim/analysis';
import { Simulation } from './sim/engine';
import { peakRps, scenarioById } from './scenarios/catalog';
import { loadProgress, recordResult } from './scenarios/progress';
import { ScenarioRun } from './scenarios/runner';
import type { RunResult, Scenario } from './scenarios/types';
import { parseSaved, SANDBOX_KEY, Store, type SavedState } from './state/store';
import { buildTemplate } from './state/templates';
import { h, isTyping } from './ui/dom';
import { DiagnosisPanel, EventLog, MetricsStrip } from './ui/hud';
import { openDebrief } from './ui/debrief';
import { Inspector } from './ui/inspector';
import { Palette } from './ui/palette';
import { Replay } from './ui/replay';
import { BriefPanel, openScenarioPicker } from './ui/scenarios';
import { Toolbar } from './ui/toolbar';
import { startMainTour, startMainTourOnce, startScenarioTourOnce } from './ui/tour';

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
let scenario: Scenario | null = null;
let run: ScenarioRun | null = null;
let lastResult: RunResult | null = null;
let replay: Replay | null = null;
const MODE_KEY = 'sds:mode';

const palette = new Palette(document.getElementById('palette')!, (kind, event) => {
  interaction.startPlacing(kind, event.pointerType !== 'touch');
});

const toolbar = new Toolbar(document.getElementById('toolbar')!, store, {
  loadTemplate: (id) => {
    if (run) return;
    store.load(buildTemplate(id));
    if (scenario) store.setParamLocks(scenarioLocks(scenario));
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
  exportDesign: () => openExportDialog(),
  importDesign: () => openImportDialog(),
  help: () => startMainTour(),
  openScenarios: () => {
    if (run) return;
    openScenarioPicker(loadProgress(), enterScenario);
  },
  clear: () => {
    if (run || !window.confirm('Remove every component from the canvas?')) return;
    store.load(buildTemplate('blank'));
    resetSim();
  },
});

const inspector = new Inspector(document.getElementById('inspector')!, store, {
  kill: (id) => sim.kill(id),
  flush: (id) => sim.flushCache(id),
  killRegion: (region) => sim.killRegion(region, 60),
});
const metrics = new MetricsStrip(document.getElementById('metrics')!);
const diagnosis = new DiagnosisPanel(document.getElementById('diagnosis')!, store);
const events = new EventLog(document.getElementById('events')!);
const hints = document.getElementById('hints')!;
const brief = new BriefPanel(document.getElementById('brief')!, {
  startTest,
  abortTest,
  resetDesign: () => {
    if (!scenario || !window.confirm('Throw this design away and start the scenario over?')) return;
    store.load(scenarioStart(scenario));
    store.setParamLocks(scenarioLocks(scenario));
    resetSim();
    scene.fit(store.design);
  },
  exit: exitScenario,
  showLastResult: () => {
    if (scenario && lastResult) openDebrief(scenario, lastResult, debriefActions);
  },
});
const debriefActions = {
  retry: () => startTest(),
  pickScenario: () => openScenarioPicker(loadProgress(), enterScenario),
  replay: () => startReplay(),
};

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

const savedMode = readMode();
if (savedMode && scenarioById(savedMode)) {
  enterScenario(savedMode);
} else {
  if (!store.restore()) store.load(buildTemplate('monolith'));
  sim.setDesign(store.design);
  sim.setTraffic(store.traffic);
  scene.syncDesign(store.design);
  scene.fit(store.design);
  syncChrome();
}

window.setTimeout(startMainTourOnce, 500);

function scenarioLocks(s: Scenario) {
  return { ...s.lockedParams, clients: s.clients };
}

function scenarioStart(s: Scenario): SavedState {
  return { version: 1, design: s.start(), traffic: { peakRps: Math.round(peakRps(s)), shape: 'steady' } };
}

function enterScenario(id: string): void {
  const next = scenarioById(id);
  if (!next) return;
  if (replay) exitReplay();
  if (run) abortTest();
  scenario = next;
  lastResult = null;
  store.useStorage(`sds:scenario:${id}`);
  if (!store.restore()) store.load(scenarioStart(next));
  store.setParamLocks(scenarioLocks(next));
  writeMode(id);
  resetSim();
  scene.fit(store.design);
  renderBrief();
  window.setTimeout(startScenarioTourOnce, 300);
}

function exitScenario(): void {
  if (replay) exitReplay();
  if (run) abortTest();
  scenario = null;
  lastResult = null;
  store.setParamLocks({});
  store.useStorage(SANDBOX_KEY);
  if (!store.restore()) store.load(buildTemplate('monolith'));
  writeMode(null);
  resetSim();
  scene.fit(store.design);
  renderBrief();
}

function startReplay(): void {
  if (!scenario || !lastResult || run) return;
  if (replay) exitReplay();
  interaction.cancel();
  store.editingLocked = true;
  running = false;
  replay = new Replay(viewport, lastResult, scenario.duration, exitReplay);
  inspector.render();
  syncChrome();
}

function exitReplay(): void {
  if (!replay) return;
  replay.destroy();
  replay = null;
  store.editingLocked = false;
  inspector.render();
  syncChrome();
}

function startTest(): void {
  if (!scenario) return;
  if (replay) exitReplay();
  interaction.cancel();
  run = new ScenarioRun(scenario, store.design, sim);
  store.editingLocked = true;
  run.start();
  simAccumulator = 0;
  metrics.reset();
  speed = Math.max(speed, 5);
  running = true;
  toolbar.setScripted(true);
  inspector.render();
  renderBrief();
  syncChrome();
}

function abortTest(): void {
  if (!run) return;
  run.stop();
  run = null;
  store.editingLocked = false;
  toolbar.setScripted(false);
  running = false;
  sim.setDesign(store.design);
  sim.reset();
  inspector.render();
  renderBrief();
  syncChrome();
}

function finishTest(): void {
  if (!run || !run.result || !scenario) return;
  const result = run.result;
  run = null;
  lastResult = result;
  recordResult(result);
  store.editingLocked = false;
  running = false;
  toolbar.setScripted(false);
  sim.setDesign(store.design);
  inspector.render();
  renderBrief();
  syncChrome();
  openDebrief(scenario, result, debriefActions);
}

function renderBrief(): void {
  brief.render(scenario, run, scenario ? loadProgress()[scenario.id] : undefined, lastResult !== null);
}

function readMode(): string | null {
  try {
    return localStorage.getItem(MODE_KEY);
  } catch {
    return null;
  }
}

function writeMode(id: string | null): void {
  try {
    if (id) localStorage.setItem(MODE_KEY, id);
    else localStorage.removeItem(MODE_KEY);
  } catch {
    // Without storage the app simply opens in the sandbox next time.
  }
}

function setRunning(next: boolean): void {
  running = next;
  syncChrome();
}

function resetSim(): void {
  if (run) {
    abortTest();
    return;
  }
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
  if (replay && (e.key === 'Escape' || e.key === ' ')) {
    e.preventDefault();
    if (e.key === ' ') replay.toggle();
    else exitReplay();
    return;
  }
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

function currentSnapshot() {
  return replay?.frame() ?? sim.snapshot;
}

function imageCaption(): string {
  const parts: string[] = [];
  const snap = currentSnapshot();
  if (scenario) parts.push(scenario.title);
  if (snap && snap.global.offeredRps > 0) {
    const g = snap.global;
    parts.push(
      `${formatRps(g.offeredRps)} rps`,
      `p99 ${g.p99 >= 1 ? `${g.p99.toFixed(2)}s` : `${Math.round(g.p99 * 1000)}ms`}`,
      `errors ${(Math.max(0, g.errorRate - g.shedRate) * 100).toFixed(1)}%`,
      `$${formatRps(g.costPerMonth)}/mo`,
    );
  }
  parts.push(localStamp().slice(0, 10));
  return parts.join('  ·  ');
}

function localStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function download(href: string, filename: string): void {
  h('a', { href, download: filename }).click();
}

function openExportDialog(): void {
  const image = scene.capture(currentSnapshot(), imageCaption());
  const pngUrl = image.toDataURL('image/png');
  const json = JSON.stringify(store.serialize(), null, 2);
  const stamp = localStamp().replace(/[: ]/g, '-');
  const name = scenario ? scenario.id : 'system-design';
  const dialog = h(
    'dialog',
    { class: 'export' },
    h('h3', {}, 'Export'),
    h('p', { class: 'muted small' }, 'The image is the current view at 2× resolution, labels and live numbers included. Press F before exporting to fit the whole design.'),
    h('img', { class: 'export-preview', src: pngUrl, alt: 'Rendered design' }),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'primary', on: { click: () => download(pngUrl, `${name}-${stamp}.png`) } }, 'Download PNG'),
      h(
        'button',
        {
          title: 'Copy the image to the clipboard',
          on: {
            click: () => {
              image.toBlob((blob) => {
                if (blob) navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(() => undefined);
              });
            },
          },
        },
        'Copy image',
      ),
      h(
        'button',
        {
          title: 'The design as JSON, to import later or share',
          on: {
            click: () => {
              const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
              download(url, `${name}-${stamp}.json`);
              URL.revokeObjectURL(url);
            },
          },
        },
        'Download JSON',
      ),
      h('button', { on: { click: () => dialog.close() } }, 'Close'),
    ),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function openImportDialog(): void {
  const textarea = h('textarea', { spellcheck: false });
  const error = h('div', { class: 'warning' });
  const dialog = h(
    'dialog',
    {},
    h('h3', {}, 'Import design'),
    h('p', { class: 'muted small' }, 'Paste a design exported from this simulator.'),
    textarea,
    error,
    h(
      'div',
      { class: 'actions' },
      h(
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

const IDLE_AFTER_MS = 2000;
const IDLE_FRAME_MS = 500;
let lastActivity = performance.now();
let lastIdleFrame = 0;
const wake = () => {
  lastActivity = performance.now();
};
for (const event of ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const) window.addEventListener(event, wake, { passive: true });
store.onDesign(wake);
store.onSelection(wake);
store.onTraffic(wake);

function idleSkip(now: number, animating: boolean): boolean {
  if (animating || now - lastActivity < IDLE_AFTER_MS) return false;
  if (now - lastIdleFrame < IDLE_FRAME_MS) return true;
  lastIdleFrame = now;
  return false;
}

function tick(now: number): void {
  const frameDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  let simAdvanced = 0;

  if (idleSkip(now, running || !!replay?.playing)) {
    requestAnimationFrame(tick);
    return;
  }

  if (running) {
    simAccumulator += frameDt * speed;
    let steps = 0;
    while (simAccumulator >= SIM_STEP && steps < MAX_STEPS_PER_FRAME) {
      const stepped = sim.step(SIM_STEP);
      simAccumulator -= SIM_STEP;
      simAdvanced += SIM_STEP;
      steps++;
      if (run) {
        run.afterStep(stepped);
        if (run.done) {
          finishTest();
          break;
        }
      }
    }
    if (steps === MAX_STEPS_PER_FRAME) simAccumulator = 0;
  }

  if (replay) {
    replay.advance(frameDt);
    const frame = replay.frame();
    scene.update(frame, frameDt, replay.playing);
    scene.render();
    uiTimer -= frameDt;
    if (uiTimer <= 0 && frame) {
      uiTimer = 0.25;
      const at = replay.t;
      metrics.update(frame.global, 0);
      diagnosis.render(diagnose(store.design, frame), true);
      inspector.refresh(frame);
      events.render(replay.result.events.filter((e) => e.t <= at));
    }
    requestAnimationFrame(tick);
    return;
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
    brief.refresh(run);
    toolbar.update(running, speed, interaction.connectMode, sim.t);
  }

  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
