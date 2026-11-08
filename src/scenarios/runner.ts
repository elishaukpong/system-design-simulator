import { diagnose } from '../sim/analysis';
import type { Simulation } from '../sim/engine';
import type { Design, SimSnapshot } from '../sim/types';
import { enforceScenario, scenarioTraffic } from './catalog';
import { grade } from './grading';
import type { ChaosLogEntry, RunResult, Sample, Scenario } from './types';

const SAMPLE_EVERY = 1;
const STEP = 0.1;

export class ScenarioRun {
  readonly samples: Sample[] = [];
  readonly chaosLog: ChaosLogEntry[] = [];
  result: RunResult | null = null;
  private nextSample = SAMPLE_EVERY;
  private fired = new Set<number>();

  private design: Design;

  constructor(
    readonly scenario: Scenario,
    design: Design,
    private sim: Simulation,
  ) {
    this.design = enforceScenario(scenario, design);
  }

  start(): void {
    this.sim.setDesign(this.design);
    this.sim.setScript(scenarioTraffic(this.scenario));
    this.sim.reset();
  }

  stop(): void {
    this.sim.setScript(null);
  }

  get progress(): number {
    return Math.min(1, this.sim.t / this.scenario.duration);
  }

  get done(): boolean {
    return this.result !== null;
  }

  afterStep(snap: SimSnapshot): void {
    if (this.result) return;
    this.fireChaos();

    if (snap.global.t >= this.nextSample) {
      this.nextSample += SAMPLE_EVERY;
      this.samples.push(this.sample(snap));
    }

    if (snap.global.t >= this.scenario.duration) {
      this.stop();
      this.result = grade(this.scenario, this.design, this.samples, this.chaosLog);
    }
  }

  private fireChaos(): void {
    this.scenario.chaos.forEach((event, index) => {
      if (this.fired.has(index) || this.sim.t < event.at) return;
      this.fired.add(index);
      const targets = this.design.nodes.filter((n) => n.kind === event.target);
      for (const target of targets) {
        if (event.action === 'kill') this.sim.kill(target.id, event.fraction ?? 1, event.seconds);
        if (event.action === 'flush') this.sim.flushCache(target.id);
        if (event.action === 'degrade') this.sim.overrideParams(target.id, event.params, event.seconds);
      }
      this.chaosLog.push({
        t: event.at,
        message: targets.length ? event.message : `${event.message} (Nothing to hit: your design has no ${event.target}.)`,
        applied: targets.length > 0,
      });
    });
  }

  private sample(snap: SimSnapshot): Sample {
    let queueLag = 0;
    let replicationLag = 0;
    for (const m of Object.values(snap.nodes)) {
      if (m.queueLagSeconds !== undefined && isFinite(m.queueLagSeconds)) queueLag = Math.max(queueLag, m.queueLagSeconds);
      if (m.queueLagSeconds !== undefined && !isFinite(m.queueLagSeconds) && (m.queueDepth ?? 0) > 0) queueLag = Infinity;
      if (m.replicationLag !== undefined && m.inRps > 0) replicationLag = Math.max(replicationLag, m.replicationLag);
    }
    const binding = diagnose(this.design, snap).binding;
    const g = snap.global;
    return {
      t: Math.round(g.t),
      offered: g.offeredRps,
      success: g.successRps,
      errorRate: g.errorRate,
      shedRate: g.shedRate,
      p99: g.p99,
      cost: g.costPerMonth,
      retryAmplification: g.retryAmplification,
      queueLag,
      replicationLag,
      binding: binding ? { nodeId: binding.nodeId, name: binding.name, reason: binding.reason } : null,
    };
  }
}

export function runHeadless(scenario: Scenario, design: Design, sim: Simulation): RunResult {
  const run = new ScenarioRun(scenario, design, sim);
  run.start();
  while (!run.done) run.afterStep(sim.step(STEP));
  return run.result!;
}
