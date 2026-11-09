import { formatRps } from '../render/scene';
import { peakRps, SCENARIOS } from '../scenarios/catalog';
import { describeCriterion, evaluateAll } from '../scenarios/grading';
import type { Best } from '../scenarios/progress';
import type { ScenarioRun } from '../scenarios/runner';
import type { CriterionRole, Scenario } from '../scenarios/types';
import { dialogHeader, foldButton, h } from './dom';

export interface BriefActions {
  startTest(): void;
  abortTest(): void;
  resetDesign(): void;
  exit(): void;
  showLastResult(): void;
}

const ROLE_LABEL: Record<CriterionRole, string> = { core: 'Must', budget: 'Budget', bonus: 'Bonus' };

export class BriefPanel {
  private hintsShown = 0;
  private scenarioId: string | null = null;
  private live: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
  private progressLabel: HTMLElement | null = null;
  private runningShown = false;

  constructor(private root: HTMLElement, private actions: BriefActions) {
    this.root.hidden = true;
  }

  render(scenario: Scenario | null, run: ScenarioRun | null, best: Best | undefined, hasResult: boolean): void {
    if (!scenario) {
      this.root.hidden = true;
      this.scenarioId = null;
      return;
    }
    if (scenario.id !== this.scenarioId) this.hintsShown = 0;
    this.scenarioId = scenario.id;
    this.root.hidden = false;
    this.runningShown = !!run && !run.done;

    const targets = h(
      'div',
      { class: 'targets' },
      ...scenario.criteria.map(({ criterion, role }) => {
        const d = describeCriterion(criterion);
        return h('div', { class: 'target', dataset: { role } }, h('span', { class: 'target-role' }, ROLE_LABEL[role]), h('span', {}, `${d.label} ${d.target}`));
      }),
    );

    const chaos = scenario.chaos.length
      ? h('div', { class: 'small muted' }, h('strong', {}, 'Chaos: '), ...scenario.chaos.map((c) => `t=${c.at}s ${c.message} `))
      : null;

    const hints = h('div', { class: 'hints' });
    const renderHints = () => {
      hints.replaceChildren(
        ...scenario.hints.slice(0, this.hintsShown).map((hint, i) => h('div', { class: 'hint' }, `${i + 1}. ${hint}`)),
        this.hintsShown < scenario.hints.length
          ? h('button', { class: 'link', on: { click: () => { this.hintsShown++; renderHints(); } } }, `Show a hint (${this.hintsShown + 1}/${scenario.hints.length})`)
          : '',
      );
    };
    renderHints();

    const testing = !!run && !run.done;
    this.progressBar = h('div', { class: 'progress-fill' });
    this.progressLabel = h('span', { class: 'muted small' });
    this.live = h('div', { class: 'live-checks' });

    const buttons = testing
      ? h('div', { class: 'actions' }, h('button', { class: 'danger', on: { click: () => this.actions.abortTest() } }, '■ Abort test'))
      : h(
          'div',
          { class: 'actions' },
          h('button', { class: 'primary', title: `Runs the scripted ${scenario.duration}s test and grades it`, on: { click: () => this.actions.startTest() } }, '▶ Start test'),
          hasResult ? h('button', { on: { click: () => this.actions.showLastResult() } }, 'Last result') : null,
          h('button', { title: 'Throw the design away and start this scenario over', on: { click: () => this.actions.resetDesign() } }, 'Start over'),
          h('button', { on: { click: () => this.actions.exit() } }, 'Exit'),
        );

    this.root.replaceChildren(
      h(
        'h2',
        { class: 'panel-title' },
        'Scenario',
        h('span', { class: 'panel-title-end' }, h('span', { class: 'difficulty' }, difficulty(scenario.difficulty), best ? ` ${stars(best.stars)}` : ''), foldButton(this.root)),
      ),
      h('div', { class: 'brief-title' }, scenario.title),
      ...(testing
        ? [
            h('div', { class: 'progress' }, this.progressBar),
            this.progressLabel,
            this.live,
          ]
        : [
            ...scenario.brief.map((p) => h('p', { class: 'small' }, p)),
            h('ul', { class: 'facts small' }, ...scenario.facts.map((f) => h('li', {}, f)), h('li', {}, `Peak ≈ ${formatRps(peakRps(scenario))} rps over ${scenario.duration}s`)),
            targets,
            ...(chaos ? [chaos] : []),
            hints,
          ]),
      buttons,
    );
  }

  refresh(run: ScenarioRun | null): void {
    if (!run || run.done || !this.live || !this.progressBar || !this.progressLabel || !this.runningShown) return;
    this.progressBar.style.width = `${Math.round(run.progress * 100)}%`;
    this.progressLabel.textContent = `${Math.round(run.progress * run.scenario.duration)}s of ${run.scenario.duration}s · design locked`;
    if (run.samples.length < 2) {
      this.live.replaceChildren(h('div', { class: 'muted small' }, 'Measuring…'));
      return;
    }
    const checks = evaluateAll(run.scenario, run.samples);
    this.live.replaceChildren(
      ...checks.map((c) =>
        h(
          'div',
          { class: 'check', dataset: { pass: String(c.pass) } },
          h('span', { class: 'check-icon' }, c.pass ? '✓' : '✗'),
          h('span', { class: 'check-label' }, c.label),
          h('span', { class: 'check-value' }, c.measured),
        ),
      ),
    );
  }
}

export function openScenarioPicker(progress: Record<string, Best>, onPick: (id: string) => void): void {
  const dialog = h(
    'dialog',
    { class: 'picker' },
    dialogHeader('Scenarios', () => dialog.close()),
    h('p', { class: 'muted small' }, 'Each scenario fixes the traffic, the chaos and the targets. You bring the design. Pass the "Must" targets for one star, stay on budget for two, hit the bonus for three.'),
    h(
      'div',
      { class: 'picker-grid' },
      ...SCENARIOS.map((s) => {
        const best = progress[s.id];
        return h(
          'button',
          {
            class: 'picker-card',
            on: {
              click: () => {
                dialog.close();
                onPick(s.id);
              },
            },
          },
          h('div', { class: 'picker-head' }, h('strong', {}, s.title), h('span', { class: 'difficulty' }, difficulty(s.difficulty))),
          h('div', { class: 'small muted' }, s.tagline),
          h('div', { class: 'picker-foot' }, h('span', { class: 'stars' }, best ? stars(best.stars) : '☆☆☆'), h('span', { class: 'small muted' }, best?.passed ? `$${Math.round(best.cost).toLocaleString()}/mo` : 'not passed')),
        );
      }),
    ),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

export function stars(n: number): string {
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

function difficulty(level: number): string {
  return '●'.repeat(level) + '○'.repeat(3 - level);
}
