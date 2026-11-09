import { describe, expect, it } from 'vitest';
import { enforceScenario, SCENARIOS, scenarioById } from '../src/scenarios/catalog';
import { runHeadless } from '../src/scenarios/runner';
import type { RunResult } from '../src/scenarios/types';
import { defaultParams } from '../src/sim/catalog';
import { Simulation } from '../src/sim/engine';
import type { ComponentKind, Design, ParamValue } from '../src/sim/types';

type N = [id: string, kind: ComponentKind, params?: Record<string, ParamValue>, z?: number];

const US = 0;
const EU = 96;
const AP = -96;

function build(nodes: N[], edges: Array<[string, string]>): Design {
  return {
    nodes: nodes.map(([id, kind, params, z], i) => ({ id, kind, name: id, x: i * 12, z: z ?? 0, params: { ...defaultParams(kind), ...params } })),
    edges: edges.map(([from, to]) => ({ id: `${from}->${to}`, from, to })),
  };
}

const REFERENCE: Record<string, () => Design> = {
  'region-outage': () =>
    build(
      [
        ['us-users', 'clients', { sharePct: 60 }, US],
        ['eu-users', 'clients', { sharePct: 40 }, EU],
        ['lb-us', 'lb', {}, US],
        ['app-us', 'app', { instances: 12 }, US],
        ['lb-eu', 'lb', {}, EU],
        ['app-eu', 'app', { instances: 20 }, EU],
        ['cache-eu', 'cache', { nodes: 2 }, EU],
        ['db', 'db', { standby: 'eu-west', failoverS: 10 }, US],
      ],
      [
        ['us-users', 'lb-us'],
        ['us-users', 'lb-eu'],
        ['eu-users', 'lb-eu'],
        ['eu-users', 'lb-us'],
        ['lb-us', 'app-us'],
        ['lb-eu', 'app-eu'],
        ['app-us', 'db'],
        ['app-eu', 'cache-eu'],
        ['app-eu', 'db'],
      ],
    ),
  'global-reads': () =>
    build(
      [
        ['us-users', 'clients', { sharePct: 40 }, US],
        ['eu-users', 'clients', { sharePct: 35 }, EU],
        ['ap-users', 'clients', { sharePct: 25 }, AP],
        ['cdn', 'cdn', {}, US],
        ['s3', 'objectStorage', {}, US],
        ['lb-us', 'lb', {}, US],
        ['app-us', 'app', { instances: 12 }, US],
        ['replica-us', 'replica', { count: 1 }, US],
        ['db', 'db', {}, US],
        ['lb-eu', 'lb', {}, EU],
        ['app-eu', 'app', { instances: 10 }, EU],
        ['replica-eu', 'replica', { count: 1 }, EU],
        ['lb-ap', 'lb', {}, AP],
        ['app-ap', 'app', { instances: 8 }, AP],
        ['replica-ap', 'replica', { count: 1 }, AP],
      ],
      [
        ['us-users', 'cdn'],
        ['eu-users', 'cdn'],
        ['ap-users', 'cdn'],
        ['cdn', 's3'],
        ['us-users', 'lb-us'],
        ['eu-users', 'lb-eu'],
        ['ap-users', 'lb-ap'],
        ['lb-us', 'app-us'],
        ['lb-eu', 'app-eu'],
        ['lb-ap', 'app-ap'],
        ['app-us', 'replica-us'],
        ['app-eu', 'replica-eu'],
        ['app-ap', 'replica-ap'],
        ['app-us', 'db'],
        ['app-eu', 'db'],
        ['app-ap', 'db'],
        ['db', 'replica-us'],
        ['db', 'replica-eu'],
        ['db', 'replica-ap'],
      ],
    ),
  'cross-region-writes': () =>
    build(
      [
        ['us-users', 'clients', { sharePct: 50 }, US],
        ['eu-users', 'clients', { sharePct: 50 }, EU],
        ['lb-us', 'lb', {}, US],
        ['app-us', 'app', { instances: 12 }, US],
        ['db', 'db', { size: 'large' }, US],
        ['lb-eu', 'lb', {}, EU],
        ['app-eu', 'app', { instances: 12 }, EU],
        ['replica-eu', 'replica', { count: 1 }, EU],
        ['queue-eu', 'queue', {}, EU],
        ['workers-us', 'workers', { instances: 8 }, US],
      ],
      [
        ['us-users', 'lb-us'],
        ['eu-users', 'lb-eu'],
        ['lb-us', 'app-us'],
        ['lb-eu', 'app-eu'],
        ['app-us', 'db'],
        ['app-eu', 'replica-eu'],
        ['app-eu', 'queue-eu'],
        ['queue-eu', 'workers-us'],
        ['workers-us', 'db'],
        ['db', 'replica-eu'],
      ],
    ),
  payouts: () =>
    build(
      [
        ['clients', 'clients'],
        ['app', 'app', { instances: 4 }],
        ['db', 'db'],
        ['queue', 'queue', { maxReceives: 5, visibilityS: 30 }],
        ['workers', 'workers', { instances: 8, idempotent: true }],
        ['bank', 'external', { rateLimitRps: 300, latencyMs: 400, failurePct: 2 }],
      ],
      [
        ['clients', 'app'],
        ['app', 'db'],
        ['app', 'queue'],
        ['queue', 'workers'],
        ['workers', 'bank'],
        ['workers', 'db'],
      ],
    ),
  'launch-day': () =>
    build(
      [
        ['clients', 'clients'],
        ['lb', 'lb'],
        ['app', 'app', { instances: 8 }],
        ['db', 'db'],
      ],
      [
        ['clients', 'lb'],
        ['lb', 'app'],
        ['app', 'db'],
      ],
    ),
  'url-shortener': () =>
    build(
      [
        ['clients', 'clients'],
        ['cdn', 'cdn', { cacheDynamicPct: 50 }],
        ['lb', 'lb'],
        ['app', 'app', { size: 'large', instances: 14 }],
        ['cache', 'cache', { nodes: 2, hitRatio: 0.9 }],
        ['replica', 'replica', { count: 3 }],
        ['db', 'db'],
      ],
      [
        ['clients', 'cdn'],
        ['cdn', 'lb'],
        ['lb', 'app'],
        ['app', 'cache'],
        ['app', 'replica'],
        ['app', 'db'],
        ['db', 'replica'],
      ],
    ),
  payments: () =>
    build(
      [
        ['clients', 'clients'],
        ['lb', 'lb'],
        ['app', 'app', { instances: 4 }],
        ['db', 'db'],
        ['queue', 'queue'],
        ['workers', 'workers', { instances: 6 }],
        ['cb', 'breaker'],
        ['provider', 'external', { rateLimitRps: 500, latencyMs: 300, failurePct: 1 }],
      ],
      [
        ['clients', 'lb'],
        ['lb', 'app'],
        ['app', 'db'],
        ['app', 'queue'],
        ['queue', 'workers'],
        ['workers', 'db'],
        ['workers', 'cb'],
        ['cb', 'provider'],
      ],
    ),
  'news-feed': () =>
    build(
      [
        ['clients', 'clients'],
        ['cdn', 'cdn'],
        ['s3', 'objectStorage'],
        ['lb', 'lb'],
        ['app', 'app', { size: 'large', instances: 12 }],
        ['cache', 'cache', { nodes: 3, hitRatio: 0.85 }],
        ['search', 'search', { nodes: 4 }],
        ['replica', 'replica', { count: 4 }],
        ['db', 'db'],
      ],
      [
        ['clients', 'cdn'],
        ['clients', 'lb'],
        ['cdn', 's3'],
        ['lb', 'app'],
        ['app', 'cache'],
        ['app', 'search'],
        ['app', 'replica'],
        ['app', 'db'],
        ['db', 'replica'],
      ],
    ),
  'zone-outage': () =>
    build(
      [
        ['clients', 'clients'],
        ['cdn', 'cdn'],
        ['s3', 'objectStorage'],
        ['lb', 'lb'],
        ['app', 'app', { size: 'medium', instances: 22 }],
        ['cache', 'cache', { nodes: 2 }],
        ['db', 'db', { size: 'large' }],
      ],
      [
        ['clients', 'cdn'],
        ['clients', 'lb'],
        ['cdn', 's3'],
        ['lb', 'app'],
        ['app', 'cache'],
        ['app', 'db'],
      ],
    ),
  'flash-sale': () =>
    build(
      [
        ['clients', 'clients'],
        ['gw', 'gateway', { rateLimitRps: 7000 }],
        ['lb', 'lb'],
        ['app', 'app', { size: 'large', instances: 18 }],
        ['cache', 'cache', { nodes: 2 }],
        ['queue', 'queue'],
        ['workers', 'workers', { size: 'medium', instances: 12 }],
        ['shard', 'shard', { shards: 8 }],
      ],
      [
        ['clients', 'gw'],
        ['gw', 'lb'],
        ['lb', 'app'],
        ['app', 'cache'],
        ['app', 'shard'],
        ['app', 'queue'],
        ['queue', 'workers'],
        ['workers', 'shard'],
      ],
    ),
  'retry-storm': () =>
    build(
      [
        ['clients', 'clients'],
        ['gw', 'gateway', { rateLimitRps: 1400 }],
        ['lb', 'lb'],
        ['app', 'app', { instances: 10 }],
        ['cache', 'cache'],
        ['db', 'db', { size: 'medium', maxConnections: 300 }],
      ],
      [
        ['clients', 'gw'],
        ['gw', 'lb'],
        ['lb', 'app'],
        ['app', 'cache'],
        ['app', 'db'],
      ],
    ),
  'telemetry-ingest': () =>
    build(
      [
        ['clients', 'clients'],
        ['lb', 'lb'],
        ['app', 'app', { size: 'xlarge', instances: 26 }],
        ['queue', 'queue'],
        ['workers', 'workers', { size: 'xlarge', instances: 34 }],
        ['shard', 'shard', { shards: 24 }],
      ],
      [
        ['clients', 'lb'],
        ['lb', 'app'],
        ['app', 'queue'],
        ['queue', 'workers'],
        ['workers', 'shard'],
      ],
    ),
};

REFERENCE['service-fan-in'] = () => {
  const d = scenarioById('service-fan-in')!.start();
  const instances: Record<string, number> = { search: 22, users: 36, checkout: 4 };
  for (const n of d.nodes) if (n.id in instances) n.params = { ...n.params, instances: instances[n.id] };
  for (const n of d.nodes) if (n.id === 'catalog-db') n.params = { ...n.params, size: 'large' };
  d.nodes.push({ id: 'users-lb', kind: 'lb', name: 'users LB', x: 12, z: 6, params: defaultParams('lb') });
  d.edges = d.edges.filter((e) => e.id !== 'search->users' && e.id !== 'checkout->users');
  d.edges.push(
    { id: 'search->users-lb', from: 'search', to: 'users-lb' },
    { id: 'checkout->users-lb', from: 'checkout', to: 'users-lb' },
    { id: 'users-lb->users', from: 'users-lb', to: 'users' },
  );
  return d;
};

function run(id: string, design: Design): RunResult {
  return runHeadless(scenarioById(id)!, design, new Simulation());
}

function summary(result: RunResult): string {
  return result.criteria.map((c) => `${c.pass ? '✓' : '✗'} ${c.label}: ${c.measured}`).join(' | ');
}

describe('service fan-in', () => {
  const scaled = () => {
    const d = scenarioById('service-fan-in')!.start();
    const instances: Record<string, number> = { search: 22, users: 36, checkout: 4 };
    for (const n of d.nodes) if (n.id in instances) n.params = { ...n.params, instances: instances[n.id] };
    for (const n of d.nodes) if (n.id === 'catalog-db') n.params = { ...n.params, size: 'large' };
    return d;
  };

  it('fails the outage bonus while callers reach users-svc directly', () => {
    const result = run('service-fan-in', scaled());

    expect(result.criteria.find((c) => c.role === 'bonus')!.pass, summary(result)).toBe(false);
  });

  it('keeps the call share even when the caller is rewired or the call deleted', () => {
    const d = scaled();
    d.edges = d.edges.filter((e) => e.id !== 'checkout->users');
    d.edges.find((e) => e.id === 'search->users')!.sharePct = 0;
    const enforced = enforceScenario(scenarioById('service-fan-in')!, d);

    expect(enforced.edges.find((e) => e.id === 'search->users')!.sharePct).toBe(50);
    expect(enforced.edges.find((e) => e.id === 'checkout->users')!.sharePct).toBe(100);
  });
});

describe('scenarios', () => {
  it('every scenario has a reference solution', () => {
    expect(SCENARIOS.map((s) => s.id).sort()).toEqual(Object.keys(REFERENCE).sort());
  });

  it.each(SCENARIOS.map((s) => s.id))('%s: the reference design earns three stars', (id) => {
    const result = run(id, REFERENCE[id]());

    expect(result.stars, summary(result)).toBe(3);
  });

  it.each(SCENARIOS.map((s) => s.id))('%s: the starting design fails', (id) => {
    const scenario = scenarioById(id)!;
    const result = run(id, scenario.start());

    expect(result.passed, summary(result)).toBe(false);
  });
});

