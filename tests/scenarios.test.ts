import { describe, expect, it } from 'vitest';
import { SCENARIOS, scenarioById } from '../src/scenarios/catalog';
import { runHeadless } from '../src/scenarios/runner';
import type { RunResult } from '../src/scenarios/types';
import { defaultParams } from '../src/sim/catalog';
import { Simulation } from '../src/sim/engine';
import type { ComponentKind, Design, ParamValue } from '../src/sim/types';

type N = [id: string, kind: ComponentKind, params?: Record<string, ParamValue>];

function build(nodes: N[], edges: Array<[string, string]>): Design {
  return {
    nodes: nodes.map(([id, kind, params], i) => ({ id, kind, name: id, x: i * 12, z: 0, params: { ...defaultParams(kind), ...params } })),
    edges: edges.map(([from, to]) => ({ id: `${from}->${to}`, from, to })),
  };
}

const REFERENCE: Record<string, () => Design> = {
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

function run(id: string, design: Design): RunResult {
  return runHeadless(scenarioById(id)!, design, new Simulation());
}

function summary(result: RunResult): string {
  return result.criteria.map((c) => `${c.pass ? '✓' : '✗'} ${c.label}: ${c.measured}`).join(' | ');
}

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

