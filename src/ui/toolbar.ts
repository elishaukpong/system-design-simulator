import { formatRps } from '../render/scene';
import type { Store } from '../state/store';
import { templateList } from '../state/templates';
import type { TrafficShape } from '../sim/types';
import { h } from './dom';

export interface ToolbarActions {
  loadTemplate(id: string): void;
  toggleRun(): void;
  setSpeed(speed: number): void;
  resetSim(): void;
  toggleConnect(): void;
  fit(): void;
  exportDesign(): void;
  importDesign(): void;
  clear(): void;
  openScenarios(): void;
}

const SPEEDS = [1, 2, 5, 10];
const MIN_EXP = 0;
const MAX_EXP = 6;

export class Toolbar {
  private runButton: HTMLButtonElement;
  private connectButton: HTMLButtonElement;
  private speedButtons = new Map<number, HTMLButtonElement>();
  private slider: HTMLInputElement;
  private trafficValue: HTMLElement;
  private shapeSelect: HTMLSelectElement;
  private clock: HTMLElement;

  constructor(root: HTMLElement, private store: Store, actions: ToolbarActions) {
    const templateSelect = h(
      'select',
      {
        title: 'Load a starter design',
        on: {
          change: () => {
            if (templateSelect.value) actions.loadTemplate(templateSelect.value);
            templateSelect.value = '';
          },
        },
      },
      h('option', { value: '' }, 'Templates…'),
      ...templateList().map((t) => h('option', { value: t.id, title: t.blurb }, t.label)),
    );

    this.slider = h('input', {
      type: 'range',
      min: String(MIN_EXP),
      max: String(MAX_EXP),
      step: '0.01',
      title: 'Peak requests per second (log scale)',
      on: { input: () => store.setTraffic({ peakRps: this.sliderToRps() }) },
    });
    this.trafficValue = h('span', { class: 'traffic-value' });
    this.shapeSelect = h(
      'select',
      { title: 'Traffic shape over time', on: { change: () => store.setTraffic({ shape: this.shapeSelect.value as TrafficShape }) } },
      h('option', { value: 'steady' }, 'Steady'),
      h('option', { value: 'ramp' }, 'Ramp up'),
      h('option', { value: 'spike' }, 'Spikes'),
      h('option', { value: 'wave' }, 'Daily wave'),
    );

    this.runButton = h('button', { class: 'primary', title: 'Run / pause (Space)', on: { click: () => actions.toggleRun() } }, '▶ Run');
    const speeds = h('div', { class: 'tool-group' });
    for (const speed of SPEEDS) {
      const button = h('button', { title: `Simulation speed ${speed}×`, on: { click: () => actions.setSpeed(speed) } }, `${speed}×`);
      this.speedButtons.set(speed, button);
      speeds.append(button);
    }
    this.clock = h('span', { class: 'clock', title: 'Simulated time' }, 't=0s');
    this.connectButton = h('button', { title: 'Connect mode (C): drag from one component to another', on: { click: () => actions.toggleConnect() } }, '⤳ Connect');

    root.append(
      h('div', { class: 'brand', title: 'System Design Simulator' }, h('span', { class: 'brand-mark' }), 'SysSim'),
      h('div', { class: 'tool-sep' }),
      h('button', { class: 'scenarios-button', title: 'Graded design challenges', on: { click: () => actions.openScenarios() } }, '🎯 Scenarios'),
      templateSelect,
      h('div', { class: 'traffic' }, h('label', {}, 'Traffic'), this.slider, this.trafficValue, this.shapeSelect),
      h('div', { class: 'tool-group' }, this.runButton, speeds, h('button', { title: 'Reset the simulation (R). Keeps the design.', on: { click: () => actions.resetSim() } }, '↺'), this.clock),
      h('div', { class: 'tool-sep' }),
      h(
        'div',
        { class: 'tool-group' },
        this.connectButton,
        h('button', { title: 'Fit the design in view (F)', on: { click: () => actions.fit() } }, '⤢'),
        h('button', { title: 'Export the design as JSON', on: { click: () => actions.exportDesign() } }, 'Export'),
        h('button', { title: 'Import a design from JSON', on: { click: () => actions.importDesign() } }, 'Import'),
        h('button', { class: 'danger', title: 'Remove everything', on: { click: () => actions.clear() } }, 'Clear'),
      ),
    );

    store.onTraffic(() => this.syncTraffic());
    this.syncTraffic();
  }

  setScripted(scripted: boolean): void {
    this.slider.disabled = scripted;
    this.shapeSelect.disabled = scripted;
    if (scripted) this.trafficValue.textContent = 'scripted';
    else this.syncTraffic();
  }

  update(running: boolean, speed: number, connectMode: boolean, t: number): void {
    this.runButton.textContent = running ? '❚❚ Pause' : '▶ Run';
    this.runButton.classList.toggle('primary', !running);
    for (const [s, button] of this.speedButtons) button.classList.toggle('active', s === speed);
    this.connectButton.classList.toggle('active', connectMode);
    this.clock.textContent = `t=${formatTime(t)}`;
  }

  private sliderToRps(): number {
    const raw = Math.pow(10, Number(this.slider.value));
    const magnitude = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
    return Math.max(1, Math.round(raw / magnitude) * magnitude);
  }

  private syncTraffic(): void {
    const { peakRps, shape } = this.store.traffic;
    if (document.activeElement !== this.slider) this.slider.value = String(Math.log10(Math.max(1, peakRps)));
    this.trafficValue.textContent = `${formatRps(peakRps)} rps`;
    this.shapeSelect.value = shape;
  }
}

function formatTime(t: number): string {
  if (t < 60) return `${t.toFixed(0)}s`;
  return `${Math.floor(t / 60)}m${String(Math.floor(t % 60)).padStart(2, '0')}s`;
}
