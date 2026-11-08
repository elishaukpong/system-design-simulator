import type { RunResult } from '../scenarios/types';
import type { SimSnapshot } from '../sim/types';
import { h } from './dom';

const SPEEDS = [1, 5, 15];

export class Replay {
  playing = true;
  t = 0;
  private speed = 5;
  private bar: HTMLElement;
  private slider: HTMLInputElement;
  private clock: HTMLElement;
  private playButton: HTMLButtonElement;
  private speedButtons = new Map<number, HTMLButtonElement>();

  constructor(
    viewport: HTMLElement,
    readonly result: RunResult,
    readonly duration: number,
    private onExit: () => void,
  ) {
    this.slider = h('input', {
      type: 'range',
      min: '0',
      max: String(duration),
      step: '0.1',
      value: '0',
      on: {
        input: () => {
          this.t = Number(this.slider.value);
          this.playing = false;
          this.sync();
        },
      },
    });
    this.clock = h('span', { class: 'mono replay-clock' });
    this.playButton = h('button', { class: 'primary', on: { click: () => this.toggle() } });
    const speeds = h('div', { class: 'tool-group' });
    for (const s of SPEEDS) {
      const b = h('button', { on: { click: () => { this.speed = s; this.sync(); } } }, `${s}×`);
      this.speedButtons.set(s, b);
      speeds.append(b);
    }
    const markers = h('div', { class: 'replay-markers' });
    for (const c of result.chaos) {
      markers.append(h('span', { class: 'replay-marker', title: c.message, style: `left:${(c.t / duration) * 100}%` }, '⚡'));
    }
    for (const w of result.walls) {
      markers.append(h('span', { class: 'replay-marker wall', title: `${w.name} gave way`, style: `left:${(w.t / duration) * 100}%` }, '▲'));
    }
    this.bar = h(
      'div',
      { class: 'replay-bar' },
      h('span', { class: 'replay-tag' }, 'REPLAY'),
      this.playButton,
      h('div', { class: 'replay-track' }, markers, this.slider),
      this.clock,
      speeds,
      h('button', { on: { click: () => this.onExit() } }, 'Exit replay'),
    );
    viewport.append(this.bar);
    this.sync();
  }

  toggle(): void {
    if (!this.playing && this.t >= this.duration) this.t = 0;
    this.playing = !this.playing;
    this.sync();
  }

  advance(frameDt: number): void {
    if (!this.playing) return;
    this.t = Math.min(this.duration, this.t + frameDt * this.speed);
    if (this.t >= this.duration) this.playing = false;
    this.sync();
  }

  frame(): SimSnapshot | null {
    const frames = this.result.frames;
    if (!frames.length) return null;
    const index = Math.min(frames.length - 1, Math.max(0, Math.round(this.t) - 1));
    return frames[index];
  }

  destroy(): void {
    this.bar.remove();
  }

  private sync(): void {
    if (document.activeElement !== this.slider) this.slider.value = String(this.t);
    this.clock.textContent = `${Math.floor(this.t)}s / ${this.duration}s`;
    this.playButton.textContent = this.playing ? '❚❚' : '▶';
    for (const [s, b] of this.speedButtons) b.classList.toggle('active', s === this.speed);
  }
}
