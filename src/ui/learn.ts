import type { CheckStatus } from '../learn/checks';
import { LESSONS } from '../learn/lessons';
import type { LearnProgress } from '../learn/progress';
import type { Exercise, Lesson } from '../learn/types';
import { dialogHeader, foldButton, h, restoreOnClick } from './dom';

export type LearnView =
  | { kind: 'lesson'; lesson: Lesson; step: number }
  | { kind: 'complete'; lesson: Lesson }
  | { kind: 'exercise'; lesson: Lesson; exercise: Exercise; done: boolean };

export interface LearnActions {
  next(): void;
  back(): void;
  restartStep(): void;
  startExercise(id: string): void;
  backToLesson(): void;
  pickLesson(): void;
  exit(): void;
}

export class LearnPanel {
  private checks: HTMLElement | null = null;
  private nextButton: HTMLButtonElement | null = null;

  constructor(private root: HTMLElement, private actions: LearnActions) {
    this.root.hidden = true;
    restoreOnClick(this.root);
  }

  render(view: LearnView | null, progress: LearnProgress): void {
    this.checks = null;
    this.nextButton = null;
    if (!view) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    const { lesson } = view;
    const header = h(
      'h2',
      { class: 'panel-title' },
      view.kind === 'exercise' ? 'Try it' : 'Learn',
      h('span', { class: 'panel-title-end' }, h('span', { class: 'learn-days' }, dayLabel(lesson.days)), foldButton(this.root)),
    );

    if (view.kind === 'lesson') {
      const step = lesson.steps[view.step];
      const last = view.step === lesson.steps.length - 1;
      this.checks = h('div', { class: 'live-checks' });
      this.nextButton = h('button', { class: step.task ? '' : 'primary', on: { click: () => this.actions.next() } }, last ? 'Finish' : 'Next →');
      this.root.replaceChildren(
        header,
        h('div', { class: 'brief-title' }, lesson.title),
        h('div', { class: 'learn-steps' }, ...lesson.steps.map((_, i) => h('span', { class: i === view.step ? 'on' : i < view.step ? 'done' : '' }))),
        h('h3', { class: 'learn-step-title' }, `${view.step + 1}. ${step.title}`),
        h('div', { class: 'learn-body small', innerHTML: step.body }),
        ...(step.task ? [this.checks] : []),
        h(
          'div',
          { class: 'actions' },
          view.step > 0 ? h('button', { on: { click: () => this.actions.back() } }, '← Back') : null,
          this.nextButton,
          step.setup ? h('button', { title: 'Reload this step', on: { click: () => this.actions.restartStep() } }, '↺') : null,
          h('button', { on: { click: () => this.actions.pickLesson() } }, 'Lessons'),
          h('button', { on: { click: () => this.actions.exit() } }, 'Exit'),
        ),
      );
      return;
    }

    if (view.kind === 'complete') {
      this.root.replaceChildren(
        header,
        h('div', { class: 'brief-title' }, `✓ ${lesson.title}`),
        h('p', { class: 'small' }, lesson.essence),
        h('p', { class: 'small muted' }, 'Now try it yourself. Each exercise is a starting design and a few live checks. Build freely; the checks tick as you go.'),
        h(
          'div',
          { class: 'learn-exercises' },
          ...lesson.exercises.map((e) =>
            h(
              'button',
              { class: 'picker-card', on: { click: () => this.actions.startExercise(e.id) } },
              h('div', { class: 'picker-head' }, h('strong', {}, e.title), progress.exercises[e.id] ? h('span', { class: 'learn-done' }, '✓') : null),
              h('div', { class: 'small muted' }, e.brief[0]),
            ),
          ),
        ),
        h('div', { class: 'actions' }, h('button', { on: { click: () => this.actions.backToLesson() } }, '← Lesson'), h('button', { class: 'primary', on: { click: () => this.actions.pickLesson() } }, 'Next lesson'), h('button', { on: { click: () => this.actions.exit() } }, 'Exit')),
      );
      return;
    }

    this.checks = h('div', { class: 'live-checks' });
    this.root.replaceChildren(
      header,
      h('div', { class: 'brief-title' }, view.exercise.title),
      ...view.exercise.brief.map((p) => h('p', { class: 'small' }, p)),
      this.checks,
      ...(view.done ? [h('div', { class: 'learn-banner' }, '✓ All checks passed. Nicely done.')] : []),
      h(
        'div',
        { class: 'actions' },
        h('button', { on: { click: () => this.actions.backToLesson() } }, '← Lesson'),
        h('button', { title: 'Throw this design away and start the exercise over', on: { click: () => this.actions.restartStep() } }, 'Start over'),
        h('button', { on: { click: () => this.actions.pickLesson() } }, 'Lessons'),
        h('button', { on: { click: () => this.actions.exit() } }, 'Exit'),
      ),
    );
  }

  refresh(statuses: CheckStatus[]): void {
    if (!this.checks) return;
    this.checks.replaceChildren(
      ...statuses.map((s) =>
        h(
          'div',
          { class: 'check', dataset: { pass: String(s.pass) } },
          h('span', { class: 'check-icon' }, checkIcon(s)),
          h('span', { class: 'check-label' }, s.label),
          h('span', { class: 'check-value' }, checkValue(s)),
        ),
      ),
    );
    if (this.nextButton && statuses.length) this.nextButton.classList.toggle('primary', statuses.every((s) => s.pass));
  }
}

export function openLessonPicker(progress: LearnProgress, onPick: (id: string) => void, onExercise: (id: string) => void): void {
  const order = ['Foundations', 'Storage', 'Communication', 'Reliability', 'Scale', 'Architecture'];
  const topics = [...new Set(LESSONS.map((l) => l.topic))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const dialog = h(
    'dialog',
    { class: 'picker' },
    dialogHeader('Learn', () => dialog.close()),
    h('p', { class: 'muted small' }, 'Short guided lessons on a live system. Each one sets up a design, walks you through what to change and what to watch, then ends with exercises you solve freehand.'),
    ...topics.map((topic) =>
      h(
        'div',
        { class: 'learn-topic' },
        h('h4', {}, topic),
        h(
          'div',
          { class: 'picker-grid' },
          ...LESSONS.filter((l) => l.topic === topic).map((lesson) => {
            return h(
              'div',
              { class: 'picker-card learn-card' },
              h(
                'button',
                { class: 'learn-card-main', on: { click: () => { dialog.close(); onPick(lesson.id); } } },
                h('div', { class: 'picker-head' }, h('strong', {}, lesson.title), h('span', { class: 'learn-days' }, dayLabel(lesson.days))),
                h('div', { class: 'small muted' }, lesson.essence),
              ),
              h(
                'div',
                { class: 'picker-foot' },
                h('span', { class: 'small muted' }, progress.lessons[lesson.id] ? '✓ Read' : `${lesson.steps.length} steps`),
                ...lesson.exercises.map((e) =>
                  h('button', { class: 'link small', title: e.brief.join(' '), on: { click: () => { dialog.close(); onExercise(e.id); } } }, `${progress.exercises[e.id] ? '✓ ' : ''}Try: ${e.title}`),
                ),
              ),
            );
          }),
        ),
      ),
    ),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function checkIcon(status: CheckStatus): string {
  if (status.pass) return '✓';
  if (status.live) return '◔';
  return '○';
}

function checkValue(status: CheckStatus): string {
  if (status.pass) return 'done';
  if (status.live && status.holding > 0) return `holding ${Math.round(status.holding * 100)}%`;
  if (status.live) return 'ok now';
  return '';
}

function dayLabel(days: number[]): string {
  return days.length === 1 ? `Day ${days[0]}` : `Days ${days.join(', ')}`;
}
