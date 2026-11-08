import { CATALOG } from './catalog';
import type { ComponentKind, Design, NodeMetrics, PressureReason, SimSnapshot } from './types';

export interface Advice {
  headline: string;
  techniques: string[];
  curriculum: string[];
}

export interface Pressure {
  nodeId: string;
  name: string;
  score: number;
  reason: PressureReason | null;
  advice: Advice;
  bindsAtRps: number | null;
  symptomOf: string | null;
}

export interface Diagnosis {
  binding: Pressure | null;
  next: Pressure | null;
  closestWall: Pressure | null;
  symptoms: Pressure[];
  warnings: string[];
}

const BINDING_THRESHOLD = 0.85;

export function diagnose(design: Design, snap: SimSnapshot): Diagnosis {
  const byId = new Map(design.nodes.map((n) => [n.id, n]));
  const offered = snap.global.offeredRps;

  const pressures: Pressure[] = design.nodes
    .filter((n) => n.kind !== 'clients' && snap.nodes[n.id])
    .map((n) => {
      const m = snap.nodes[n.id];
      return {
        nodeId: n.id,
        name: n.name,
        score: scoreFor(m),
        reason: m.reason,
        advice: adviceFor(n.kind, m.reason, m),
        bindsAtRps: m.utilization > 0.01 && m.inRps > 0 && offered > 0 ? offered / m.utilization : null,
        symptomOf: null,
      };
    })
    .sort((a, b) => b.score - a.score);

  const downstream = reachability(design);
  for (const p of pressures) {
    const m = snap.nodes[p.nodeId];
    const waitsOnOthers = m.reason === 'concurrency' || m.reason === 'breaker-open';
    if (!waitsOnOthers) continue;
    const culprit = pressures.find(
      (other) => other !== p && downstream.get(p.nodeId)?.has(other.nodeId) && other.score >= 0.7 && snap.nodes[other.nodeId].reason !== 'concurrency',
    );
    if (culprit) p.symptomOf = culprit.nodeId;
  }

  const causes = pressures.filter((p) => p.symptomOf === null);
  const binding = causes[0] && causes[0].score >= BINDING_THRESHOLD ? causes[0] : null;
  const rest = causes.filter((p) => p !== binding && p.reason !== 'rate-limit');
  const next = binding && rest[0] && rest[0].score >= 0.3 ? rest[0] : null;
  const closestWall = binding ? null : rest[0] ?? null;
  const symptoms = pressures.filter((p) => p.symptomOf !== null && p.score >= 0.7);

  return { binding, next, closestWall, symptoms, warnings: designWarnings(design, byId) };
}

function scoreFor(m: NodeMetrics): number {
  switch (m.reason) {
    case 'down':
      return 10;
    case 'no-backend':
      return 9;
    case 'replication-lag':
      return Math.max(m.utilization, 0.8 + (m.replicationLag ?? 0) / 10);
    case 'backlog':
      return Math.max(m.utilization, 0.75 + Math.min(0.5, (m.queueLagSeconds ?? 0) / 120));
    case 'breaker-open':
      return 0.85;
    default:
      return m.utilization;
  }
}

function reachability(design: Design): Map<string, Set<string>> {
  const out = new Map<string, string[]>();
  for (const e of design.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const result = new Map<string, Set<string>>();
  for (const n of design.nodes) {
    const seen = new Set<string>();
    const stack = [...(out.get(n.id) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(out.get(id) ?? []));
    }
    result.set(n.id, seen);
  }
  return result;
}

function designWarnings(design: Design, byId: Map<string, Design['nodes'][number]>): string[] {
  const warnings: string[] = [];
  const kinds = new Set(design.nodes.map((n) => n.kind));
  const parentsOf = (id: string) => design.edges.filter((e) => e.to === id).map((e) => byId.get(e.from)!);
  const childrenOf = (id: string) => design.edges.filter((e) => e.from === id).map((e) => byId.get(e.to)!);

  if (!kinds.has('clients')) warnings.push('No Clients node. Nothing is sending traffic.');
  if (kinds.has('replica') && !kinds.has('db') && !kinds.has('shard')) warnings.push('Read replicas with no primary. Who do they replicate from?');

  for (const n of design.nodes) {
    if (n.kind !== 'clients' && parentsOf(n.id).length === 0) warnings.push(`${n.name} has nothing connected into it.`);
    if (n.kind === 'queue' && !childrenOf(n.id).some((c) => c.kind === 'workers')) warnings.push(`${n.name} has no Workers consuming it. The backlog only grows.`);
    if (n.kind === 'app' && Number(n.params.instances) === 1 && !n.params.autoscale) warnings.push(`${n.name} is a single instance: a single point of failure.`);
    if (n.kind === 'cache' && childrenOf(n.id).length === 0 && !parentsOf(n.id).some((p) => childrenOf(p.id).some((c) => ['db', 'replica', 'shard'].includes(c.kind)))) {
      warnings.push(`${n.name}: misses have nowhere to go. Connect the app (or the cache) to a database.`);
    }
  }
  return warnings;
}

const C = {
  singleMachine: 'Day 7 · Single-machine limits',
  replication: 'Day 12 · Replication',
  sharding: 'Day 13 · Sharding',
  pooling: 'Day 14 · Connection pooling',
  cacheStrategies: 'Day 15 · Cache strategies',
  cdn: 'Day 18 · CDNs & edge caching',
  objectStorage: 'Day 19 · Object storage',
  search: 'Day 20 · Search',
  syncAsync: 'Day 21 · Sync vs async',
  queues: 'Day 24 · Queues',
  failureModes: 'Day 28 · Failure modes',
  retries: 'Day 29 · Retries',
  breaker: 'Day 30 · Circuit breaker',
  bulkhead: 'Day 31 · Bulkhead',
  timeouts: 'Day 32 · Timeouts & deadlines',
  health: 'Day 33 · Health checks',
  degradation: 'Day 34 · Graceful degradation',
  lb: 'Day 35 · Load balancing',
  rateLimit: 'Day 36 · Rate limiting',
  backpressure: 'Day 37 · Backpressure',
  horizontal: 'Day 38 · Horizontal scaling',
  autoscaling: 'Day 39 · Auto-scaling',
  workers: 'Day 40 · Job & worker architectures',
  readWrite: 'Day 41 · Read-heavy vs write-heavy',
};

export function adviceFor(kind: ComponentKind, reason: PressureReason | null, m: NodeMetrics): Advice {
  const label = CATALOG[kind].label;
  switch (reason) {
    case 'down':
      return {
        headline: `${label} is down. Everything behind it fails with it.`,
        techniques: ['Run more than one instance', 'Put a load balancer with health checks in front', 'Add a circuit breaker so callers fail fast instead of hanging'],
        curriculum: [C.failureModes, C.health, C.breaker],
      };
    case 'no-backend':
      return {
        headline: `${label} has nowhere to send this traffic.`,
        techniques: ['Connect it to something that can serve the requests', 'Check the load balancer still has a healthy backend'],
        curriculum: [C.lb, C.health],
      };
    case 'concurrency':
      return {
        headline: `${label} worker pool is full, but the CPU is not. Requests are stuck waiting on something downstream.`,
        techniques: ['Fix the slow dependency first, not the app', 'Set tighter timeouts', 'Move the slow call off the request path with a queue', 'Wrap it in a circuit breaker'],
        curriculum: [C.timeouts, C.syncAsync, C.breaker, C.bulkhead],
      };
    case 'connections':
      return {
        headline: `${label} ran out of connections. Each query holds one for longer than the pool can afford.`,
        techniques: ['Make the queries faster (indexes, fewer N+1s)', 'Raise max connections or add a pooler', 'Take reads elsewhere: cache or replicas'],
        curriculum: [C.pooling, C.cacheStrategies, C.replication],
      };
    case 'write-ceiling':
      return {
        headline: `${label} hit its write ceiling. Writes all land on one primary and replicas cannot help.`,
        techniques: ['Queue the writes and absorb spikes as backlog', 'Batch writes', 'Shard by key', 'Size up (buys time, not a plan)'],
        curriculum: [C.readWrite, C.queues, C.sharding, C.singleMachine],
      };
    case 'hot-shard':
      return {
        headline: `${label}: one hot key is pinning one shard. Adding shards will not help.`,
        techniques: ['Cache the hot key in front of the shard', 'Split the hot key (salting / sub-keys)', 'Re-pick the shard key'],
        curriculum: [C.sharding, C.cacheStrategies],
      };
    case 'replication-lag':
      return {
        headline: `${label} are behind the primary by ${(m.replicationLag ?? 0).toFixed(1)}s. Users read stale data.`,
        techniques: ['Add replicas or size them up', 'Route read-your-own-writes to the primary', 'Reduce write volume on the primary'],
        curriculum: [C.replication, C.readWrite],
      };
    case 'cold-cache':
      return {
        headline: `${label} is cold (hit ratio ${pct(m.hitRatio ?? 0)}). Every miss goes to the database at the same time.`,
        techniques: ['Pre-warm before cutting traffic over', 'Request coalescing (single-flight) on misses', 'More cache nodes so one loss empties less of the keyspace'],
        curriculum: [C.cacheStrategies, C.failureModes],
      };
    case 'backlog':
      return {
        headline: `${label} backlog is growing (${formatSeconds(m.queueLagSeconds ?? 0)} behind). Accepted, but not done.`,
        techniques: ['Add workers or autoscale them on queue depth', 'Find what slows the workers down', 'Decide what happens when the queue fills'],
        curriculum: [C.queues, C.workers, C.autoscaling, C.backpressure],
      };
    case 'rate-limit':
      return {
        headline: `${label} is shedding ${Math.round(m.shedRps)} rps with 429s. Working as designed, if the limit is right.`,
        techniques: ['Raise the limit only if what is behind it can carry it', 'Per-client limits so one tenant cannot use them all'],
        curriculum: [C.rateLimit, C.bulkhead],
      };
    case 'provider-limit':
      return {
        headline: `${label} is rate-limiting you. You cannot scale someone else's system.`,
        techniques: ['Queue the calls and drain at their limit', 'Cache their responses', 'Circuit breaker + graceful degradation'],
        curriculum: [C.queues, C.breaker, C.degradation],
      };
    case 'breaker-open':
      return {
        headline: `${label} is open. It is failing fast so the dependency can recover.`,
        techniques: ['Decide what the user sees while it is open', 'Fix the dependency it is protecting'],
        curriculum: [C.breaker, C.degradation],
      };
    case 'cpu':
    case null:
      return cpuAdvice(kind, label);
  }
}

function cpuAdvice(kind: ComponentKind, label: string): Advice {
  switch (kind) {
    case 'app':
    case 'workers':
      return {
        headline: `${label} CPU is the wall.`,
        techniques: ['Add instances (scale out)', 'Autoscale', 'Cache so less work reaches it', 'Push static assets to a CDN'],
        curriculum: [C.horizontal, C.autoscaling, C.cdn],
      };
    case 'db':
      return {
        headline: `${label} CPU is the wall. Reads and writes share one box.`,
        techniques: ['Cache-aside for hot reads', 'Read replicas', 'Move LIKE searches to a search index', 'Size up', 'Shard if writes are the problem'],
        curriculum: [C.cacheStrategies, C.replication, C.search, C.singleMachine],
      };
    case 'replica':
      return {
        headline: `${label} are saturated. They serve reads and replay every write.`,
        techniques: ['Add replicas', 'Cache in front', 'Cut write volume (each replica replays all of it)'],
        curriculum: [C.replication, C.cacheStrategies],
      };
    case 'shard':
      return {
        headline: `${label} shards are saturated.`,
        techniques: ['Add shards', 'Cache hot reads in front'],
        curriculum: [C.sharding],
      };
    case 'cache':
      return {
        headline: `${label} is saturated.`,
        techniques: ['Add cache nodes', 'Local in-process cache for the hottest keys'],
        curriculum: [C.cacheStrategies],
      };
    case 'objectStorage':
      return {
        headline: `${label} request rate is the wall.`,
        techniques: ['Put a CDN in front', 'Spread keys across prefixes'],
        curriculum: [C.cdn, C.objectStorage],
      };
    case 'search':
      return {
        headline: `${label} is saturated.`,
        techniques: ['Add search nodes', 'Cache popular queries'],
        curriculum: [C.search],
      };
    case 'lb':
    case 'gateway':
    case 'cdn':
    case 'dns':
      return {
        headline: `${label} is saturated.`,
        techniques: ['Run more than one', 'Spread traffic with DNS'],
        curriculum: [C.lb],
      };
    default:
      return {
        headline: `${label} is under pressure.`,
        techniques: ['Add capacity', 'Shed or queue load before it arrives'],
        curriculum: [C.backpressure],
      };
  }
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatSeconds(s: number): string {
  if (!isFinite(s)) return '∞';
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
