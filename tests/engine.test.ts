import { describe, expect, it } from 'vitest';
import { defaultParams } from '../src/sim/catalog';
import { Simulation } from '../src/sim/engine';
import type { ComponentKind, Design, ParamValue, SimSnapshot } from '../src/sim/types';

type NodeInput = [id: string, kind: ComponentKind, params?: Record<string, ParamValue>];

function design(nodes: NodeInput[], edges: Array<[string, string]>): Design {
  return {
    nodes: nodes.map(([id, kind, params], i) => ({
      id,
      kind,
      name: id,
      x: i * 4,
      z: 0,
      params: { ...defaultParams(kind), ...params },
    })),
    edges: edges.map(([from, to]) => ({ id: `${from}->${to}`, from, to })),
  };
}

function run(d: Design, rps: number, seconds: number, setup?: (sim: Simulation) => void): { sim: Simulation; snap: SimSnapshot } {
  const sim = new Simulation();
  sim.setDesign(d);
  sim.setTraffic({ peakRps: rps, shape: 'steady' });
  setup?.(sim);
  let snap!: SimSnapshot;
  for (let i = 0; i < seconds * 10; i++) snap = sim.step(0.1);
  return { sim, snap };
}

const monolith = (appParams: Record<string, ParamValue> = {}) =>
  design(
    [
      ['clients', 'clients', { staticPct: 0, retries: 0 }],
      ['app', 'app', appParams],
      ['db', 'db'],
    ],
    [
      ['clients', 'app'],
      ['app', 'db'],
    ],
  );

describe('Simulation', () => {
  it('serves light traffic with no errors', () => {
    const { snap } = run(monolith(), 50, 10);

    expect(snap.global.errorRate).toBeLessThan(0.001);
    expect(snap.nodes.app.status).toBe('healthy');
    expect(snap.global.p50).toBeGreaterThan(0.02);
    expect(snap.global.p50).toBeLessThan(0.1);
  });

  it('overloads a single app server and names cpu as the reason', () => {
    const { snap } = run(monolith(), 400, 4);

    expect(snap.nodes.app.utilization).toBeGreaterThan(1);
    expect(snap.nodes.app.reason).toBe('cpu');
    expect(snap.global.errorRate).toBeGreaterThan(0.2);
  });

  it('crashes instances under sustained overload, and the survivors inherit the load', () => {
    const { sim, snap } = run(monolith({ instances: 3 }), 900, 30);

    expect(sim.events.some((e) => e.message.includes('crashed'))).toBe(true);
    expect(snap.nodes.app.healthyInstances).toBeLessThan(3);
  });

  it('scales out: more instances carry the same load', () => {
    const { snap } = run(monolith({ instances: 4 }), 400, 10);

    expect(snap.nodes.app.utilization).toBeLessThan(0.9);
    expect(snap.global.errorRate).toBeLessThan(0.01);
  });

  it('a cache takes reads off the database once warm', () => {
    const withoutCache = run(monolith({ instances: 20, searchPct: 0 }), 2500, 60).snap;
    const cached = design(
      [
        ['clients', 'clients', { staticPct: 0, retries: 0 }],
        ['app', 'app', { instances: 20, searchPct: 0 }],
        ['cache', 'cache'],
        ['db', 'db'],
      ],
      [
        ['clients', 'app'],
        ['app', 'cache'],
        ['app', 'db'],
      ],
    );
    const withCache = run(cached, 2500, 60).snap;

    expect(withCache.nodes.db.inRps).toBeLessThan(withoutCache.nodes.db.inRps * 0.5);
    expect(withCache.nodes.cache.hitRatio).toBeGreaterThan(0.8);
  });

  it('a flushed cache sends every read to the database', () => {
    const cached = design(
      [
        ['clients', 'clients', { staticPct: 0, retries: 0 }],
        ['app', 'app', { instances: 20, searchPct: 0 }],
        ['cache', 'cache'],
        ['db', 'db'],
      ],
      [
        ['clients', 'app'],
        ['app', 'cache'],
        ['app', 'db'],
      ],
    );
    const { sim } = run(cached, 2000, 60);
    const warm = sim.snapshot!.nodes.db.inRps;
    sim.flushCache('cache');
    const cold = sim.step(0.1).nodes.db.inRps;

    expect(cold).toBeGreaterThan(warm * 3);
  });

  it('retries amplify load when the system is failing', () => {
    const d = monolith();
    d.nodes[0].params.retries = 3;
    const { snap } = run(d, 400, 5);

    expect(snap.global.retryAmplification).toBeGreaterThan(1.5);
  });

  it('a queue absorbs writes the workers cannot keep up with, as backlog', () => {
    const d = design(
      [
        ['clients', 'clients', { staticPct: 0, writePct: 100, retries: 0 }],
        ['app', 'app', { instances: 10 }],
        ['queue', 'queue'],
        ['workers', 'workers', { instances: 1, externalCallPct: 0 }],
        ['db', 'db'],
      ],
      [
        ['clients', 'app'],
        ['app', 'queue'],
        ['queue', 'workers'],
        ['workers', 'db'],
      ],
    );
    const { snap } = run(d, 500, 20);

    expect(snap.global.errorRate).toBeLessThan(0.01);
    expect(snap.nodes.queue.queueDepth).toBeGreaterThan(1000);
    expect(snap.nodes.queue.reason).toBe('backlog');
  });

  it('a load balancer with health checks routes around a dead backend', () => {
    const d = design(
      [
        ['clients', 'clients', { staticPct: 0, retries: 0 }],
        ['lb', 'lb'],
        ['a', 'app', { instances: 4 }],
        ['b', 'app', { instances: 4 }],
      ],
      [
        ['clients', 'lb'],
        ['lb', 'a'],
        ['lb', 'b'],
      ],
    );
    const { sim } = run(d, 300, 5);
    sim.kill('a');
    const snap = sim.step(0.1);

    expect(snap.nodes.a.inRps).toBe(0);
    expect(snap.global.errorRate).toBeLessThan(0.01);
  });

  it('a gateway sheds load above its rate limit instead of passing it on', () => {
    const d = design(
      [
        ['clients', 'clients', { staticPct: 0, retries: 0 }],
        ['gw', 'gateway', { rateLimitRps: 100 }],
        ['app', 'app', { instances: 4 }],
      ],
      [
        ['clients', 'gw'],
        ['gw', 'app'],
      ],
    );
    const { snap } = run(d, 400, 5);

    expect(snap.nodes.app.inRps).toBeCloseTo(100, 0);
    expect(snap.nodes.gw.reason).toBe('rate-limit');
    expect(snap.global.shedRate).toBeGreaterThan(0.7);
  });

  it('a circuit breaker opens when the external API fails and stops calling it', () => {
    const d = design(
      [
        ['clients', 'clients', { staticPct: 0, writePct: 100, retries: 0 }],
        ['app', 'app', { instances: 10, externalCallPct: 100 }],
        ['cb', 'breaker'],
        ['ext', 'external', { failurePct: 90 }],
      ],
      [
        ['clients', 'app'],
        ['app', 'cb'],
        ['cb', 'ext'],
      ],
    );
    const { snap } = run(d, 100, 3);

    expect(snap.nodes.cb.breakerState).toBe('open');
    expect(snap.nodes.ext.inRps).toBe(0);
  });

  it('a hot key caps a sharded database at one shard', () => {
    const shardDesign = (hotKeyPct: number) =>
      design(
        [
          ['clients', 'clients', { staticPct: 0, writePct: 100, retries: 0 }],
          ['app', 'app', { instances: 40 }],
          ['shard', 'shard', { shards: 8, hotKeyPct }],
        ],
        [
          ['clients', 'app'],
          ['app', 'shard'],
        ],
      );

    expect(run(shardDesign(0), 3000, 5).snap.nodes.shard.utilization).toBeLessThan(1);
    const hot = run(shardDesign(60), 3000, 5).snap.nodes.shard;
    expect(hot.utilization).toBeGreaterThanOrEqual(0.99);
    expect(hot.reason).toBe('hot-shard');
  });

  it('a slow database exhausts the app worker pool before the app CPU', () => {
    const d = design(
      [
        ['clients', 'clients', { staticPct: 0, writePct: 100, retries: 0 }],
        ['app', 'app', { instances: 2, externalCallPct: 100 }],
        ['ext', 'external', { latencyMs: 2000, rateLimitRps: 10000 }],
      ],
      [
        ['clients', 'app'],
        ['app', 'ext'],
      ],
    );
    const { snap } = run(d, 100, 10);

    expect(snap.nodes.app.reason).toBe('concurrency');
  });

  it('autoscaling adds instances after the boot delay', () => {
    const { sim, snap } = run(monolith({ instances: 1, autoscale: true, maxInstances: 10 }), 500, 60);

    expect(sim.events.some((e) => e.message.includes('autoscaling'))).toBe(true);
    expect(snap.nodes.app.totalInstances).toBeGreaterThan(1);
  });

  it('a traffic script overrides the dial', () => {
    const sim = new Simulation();
    sim.setDesign(monolith({ instances: 4 }));
    sim.setTraffic({ peakRps: 100, shape: 'steady' });
    sim.setScript((t) => t * 10);
    let snap!: SimSnapshot;
    for (let i = 0; i < 50; i++) snap = sim.step(0.1);

    expect(snap.global.offeredRps).toBeCloseTo(50, 5);
  });

  it('parameter overrides apply for their window and then expire', () => {
    const d = design(
      [
        ['clients', 'clients', { staticPct: 0, writePct: 100, retries: 0 }],
        ['app', 'app', { instances: 10, externalCallPct: 100 }],
        ['ext', 'external', { failurePct: 0, rateLimitRps: 10000 }],
      ],
      [
        ['clients', 'app'],
        ['app', 'ext'],
      ],
    );
    const { sim } = run(d, 50, 2);
    sim.overrideParams('ext', { failurePct: 80 }, 5);
    const during = sim.step(0.1).global.errorRate;
    for (let i = 0; i < 60; i++) sim.step(0.1);
    const after = sim.step(0.1).global.errorRate;

    expect(during).toBeGreaterThan(0.7);
    expect(after).toBeLessThan(0.01);
  });

  it('a partial kill takes down a share of instances, not the node', () => {
    const { sim } = run(monolith({ instances: 6 }), 100, 2);
    sim.kill('app', 0.5, 20);
    const snap = sim.step(0.1);

    expect(snap.nodes.app.healthyInstances).toBe(3);
    expect(snap.nodes.app.status).not.toBe('down');
  });
});
