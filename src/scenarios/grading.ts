import { formatSeconds } from '../sim/analysis';
import { boolParam, numberParam } from '../sim/catalog';
import type { Design, SimEvent, SimSnapshot } from '../sim/types';
import type { ChaosLogEntry, Criterion, CriterionResult, GradedCriterion, RunResult, Sample, Scenario, Tradeoff, Wall } from './types';

export function evaluateAll(scenario: Scenario, samples: Sample[]): CriterionResult[] {
  return scenario.criteria.map((c) => evaluate(c, samples));
}

export function grade(
  scenario: Scenario,
  design: Design,
  samples: Sample[],
  chaos: ChaosLogEntry[],
  frames: SimSnapshot[] = [],
  events: SimEvent[] = [],
): RunResult {
  const criteria = evaluateAll(scenario, samples);
  const core = criteria.filter((c) => c.role === 'core');
  const budget = criteria.filter((c) => c.role === 'budget');
  const bonus = criteria.filter((c) => c.role === 'bonus');
  const passed = core.every((c) => c.pass);
  let stars = 0;
  if (passed) {
    stars = 1;
    if (budget.every((c) => c.pass)) {
      stars = 2;
      if (bonus.every((c) => c.pass)) stars = 3;
    }
  }

  return {
    scenarioId: scenario.id,
    passed,
    stars,
    criteria,
    walls: walls(samples),
    tradeoffs: tradeoffs(design, samples),
    samples,
    chaos,
    averageCost: average(samples.map((s) => s.cost)),
    frames,
    events,
  };
}

export function describeCriterion(criterion: Criterion): { label: string; target: string } {
  switch (criterion.type) {
    case 'availability':
      return { label: 'Availability', target: `≥ ${pct(criterion.min, 2)}` };
    case 'p99':
      return { label: 'p99 latency', target: `≤ ${criterion.maxMs} ms, ${Math.round(criterion.withinPct * 100)}% of the time` };
    case 'p50':
      return { label: 'Median latency', target: `≤ ${criterion.maxMs} ms, ${Math.round(criterion.withinPct * 100)}% of the time` };
    case 'cost':
      return { label: 'Budget', target: `≤ $${criterion.max.toLocaleString()}/mo` };
    case 'shed':
      return { label: 'Turned away (429)', target: `≤ ${criterion.maxPct}%` };
    case 'queueLag':
      return { label: 'Processing lag', target: `≤ ${criterion.maxS}s behind` };
    case 'replicationLag':
      return { label: 'Replica staleness', target: `≤ ${criterion.maxS}s` };
    case 'retryAmplification':
      return { label: 'Retry amplification', target: `≤ ${criterion.max}×` };
    case 'dataLoss':
      return { label: 'Jobs lost', target: criterion.max === 0 ? 'none' : `≤ ${criterion.max}` };
    case 'duplicates':
      return { label: 'Duplicated work', target: criterion.max === 0 ? 'none' : `≤ ${criterion.max}` };
    case 'deadLettered':
      return { label: 'Dead-lettered jobs', target: criterion.max === 0 ? 'none' : `≤ ${criterion.max}` };
    case 'chaosAvailability':
      return { label: `Availability during chaos (${criterion.from}–${criterion.to}s)`, target: `≥ ${pct(criterion.min, 1)}` };
  }
}

function evaluate({ criterion, role }: GradedCriterion, samples: Sample[]): CriterionResult {
  const { label, target } = describeCriterion(criterion);
  const result = (measured: string, pass: boolean): CriterionResult => ({ label, target, measured, pass, role });

  switch (criterion.type) {
    case 'availability': {
      const value = availability(samples);
      return result(pct(value, 2), value >= criterion.min);
    }
    case 'p99': {
      const fastAndServing = (s: Sample) => s.p99 * 1000 <= criterion.maxMs && (s.offered <= 0 || s.success / s.offered >= 0.5);
      const within = samples.length ? samples.filter(fastAndServing).length / samples.length : 0;
      const worst = Math.max(0, ...samples.map((s) => s.p99));
      return result(`${Math.round(within * 100)}% of the time (worst ${ms(worst)})`, within >= criterion.withinPct);
    }
    case 'p50': {
      const fastAndServing = (s: Sample) => s.p50 * 1000 <= criterion.maxMs && (s.offered <= 0 || s.success / s.offered >= 0.5);
      const within = samples.length ? samples.filter(fastAndServing).length / samples.length : 0;
      const worst = Math.max(0, ...samples.map((s) => s.p50));
      return result(`${Math.round(within * 100)}% of the time (worst ${ms(worst)})`, within >= criterion.withinPct);
    }
    case 'cost': {
      const value = average(samples.map((s) => s.cost));
      return result(`$${Math.round(value).toLocaleString()}/mo`, value <= criterion.max);
    }
    case 'shed': {
      const offered = sum(samples.map((s) => s.offered));
      const shed = sum(samples.map((s) => (s.errorRate > 0 ? (s.offered - s.success) * Math.min(1, s.shedRate / s.errorRate) : 0)));
      const value = offered > 0 ? (shed / offered) * 100 : 0;
      return result(`${value.toFixed(1)}%`, value <= criterion.maxPct);
    }
    case 'queueLag': {
      const value = Math.max(0, ...samples.map((s) => s.queueLag));
      return result(`${formatSeconds(value)} worst`, value <= criterion.maxS);
    }
    case 'replicationLag': {
      const value = Math.max(0, ...samples.map((s) => s.replicationLag));
      return result(`${value.toFixed(1)}s worst`, value <= criterion.maxS);
    }
    case 'retryAmplification': {
      const value = Math.max(1, ...samples.map((s) => s.retryAmplification));
      return result(`${value.toFixed(2)}× worst`, value <= criterion.max);
    }
    case 'dataLoss': {
      const value = last(samples)?.lost ?? 0;
      return result(Math.round(value).toLocaleString(), value <= criterion.max + 0.5);
    }
    case 'duplicates': {
      const value = last(samples)?.duplicates ?? 0;
      return result(Math.round(value).toLocaleString(), value <= criterion.max + 0.5);
    }
    case 'deadLettered': {
      const value = last(samples)?.deadLettered ?? 0;
      return result(Math.round(value).toLocaleString(), value <= criterion.max + 0.5);
    }
    case 'chaosAvailability': {
      const window = samples.filter((s) => s.t >= criterion.from && s.t <= criterion.to);
      const value = availability(window);
      return result(pct(value, 1), value >= criterion.min);
    }
  }
}

function walls(samples: Sample[]): Wall[] {
  const seen = new Set<string>();
  const out: Wall[] = [];
  for (const s of samples) {
    if (!s.binding || seen.has(s.binding.nodeId)) continue;
    seen.add(s.binding.nodeId);
    out.push({ t: s.t, rps: s.offered, nodeId: s.binding.nodeId, name: s.binding.name, reason: s.binding.reason });
  }
  return out.slice(0, 5);
}

function tradeoffs(design: Design, samples: Sample[]): Tradeoff[] {
  const has = (kind: string) => design.nodes.filter((n) => n.kind === kind);
  const out: Tradeoff[] = [];
  const worstReplicaLag = Math.max(0, ...samples.map((s) => s.replicationLag));
  const worstQueueLag = Math.max(0, ...samples.map((s) => s.queueLag));
  const worstShed = Math.max(0, ...samples.map((s) => s.shedRate));

  if (has('replica').length)
    out.push({ text: `Read replicas: reads can be stale. Worst lag this run was ${worstReplicaLag.toFixed(1)}s, so a user may not see their own write.`, curriculum: 'Day 12 · Replication' });
  if (has('cache').length)
    out.push({ text: 'Cache-aside: reads can be stale until the key expires, and a cold cache sends everything to the database at once.', curriculum: 'Day 16 · Cache invalidation' });
  if (has('cdn').length)
    out.push({ text: 'CDN: the edge serves copies. Invalidation is now part of every deploy.', curriculum: 'Day 18 · CDNs & edge caching' });
  if (has('queue').length)
    out.push({ text: `Queue: users get "accepted", not "done". Worst processing lag was ${formatSeconds(worstQueueLag)}.`, curriculum: 'Day 21 · Sync vs async' });
  if (has('shard').length)
    out.push({ text: 'Sharding: cross-shard queries and re-sharding are now your problem, and a hot key still lands on one shard.', curriculum: 'Day 13 · Sharding' });
  if (has('gateway').some((g) => boolParam(g.params, 'rateLimit', true)))
    out.push({ text: `Rate limiting: you chose to turn users away rather than fall over. At worst ${Math.round(worstShed * 100)}% of requests got a 429.`, curriculum: 'Day 36 · Rate limiting' });
  if (has('breaker').length)
    out.push({ text: 'Circuit breaker: while it is open, users get a fast failure instead of a slow one. Decide what they see.', curriculum: 'Day 34 · Graceful degradation' });
  const queues = has('queue');
  if (queues.some((q) => !boolParam(q.params, 'dlq', true)))
    out.push({ text: 'No dead-letter queue: a job that fails every attempt is gone, and nobody is told.', curriculum: 'Day 24 · Queues' });
  if (queues.length && has('workers').some((w) => !boolParam(w.params, 'idempotent', false)))
    out.push({ text: 'Retries without idempotency: when a call worked but the reply was lost, the retry does the work again.', curriculum: 'Day 45 · Idempotency keys' });
  if (has('search').length)
    out.push({ text: 'Search index: results trail the database by the indexing delay.', curriculum: 'Day 20 · Search' });
  if (design.nodes.some((n) => (n.kind === 'app' || n.kind === 'workers') && boolParam(n.params, 'autoscale', false)))
    out.push({ text: 'Autoscaling: capacity arrives late. Every spike runs on what you already had for the first 30s.', curriculum: 'Day 39 · Auto-scaling' });

  for (const n of design.nodes) {
    const single = (n.kind === 'app' || n.kind === 'workers') && numberParam(n.params, 'instances', 1) === 1 && !boolParam(n.params, 'autoscale', false);
    const singleCache = n.kind === 'cache' && numberParam(n.params, 'nodes', 1) === 1;
    const standby = (n.kind === 'db' || n.kind === 'shard') && n.params.standby && n.params.standby !== 'none';
    if (standby) {
      out.push({
        text: `${n.name} fails over to ${n.params.standby}: ${numberParam(n.params, 'failoverS', 30)}s of downtime (RTO), and the writes still in flight to the standby are lost (RPO). You pay for a second database to get that.`,
        curriculum: 'Day 12 · Replication',
      });
    } else if (single || singleCache || n.kind === 'db') {
      out.push({ text: `${n.name} is a single point of failure.`, curriculum: 'Day 28 · Failure modes' });
    }
  }
  return out;
}

export function availability(samples: Sample[]): number {
  const offered = sum(samples.map((s) => s.offered));
  return offered > 0 ? sum(samples.map((s) => s.success)) / offered : 1;
}

function last<T>(values: T[]): T | undefined {
  return values[values.length - 1];
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function average(values: number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

function pct(value: number, digits: number): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function ms(seconds: number): string {
  return seconds >= 1 ? `${seconds.toFixed(2)}s` : `${Math.round(seconds * 1000)}ms`;
}
