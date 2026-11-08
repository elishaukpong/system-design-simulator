import { describe, expect, it } from 'vitest';
import { defaultParams } from '../src/sim/catalog';
import { Simulation } from '../src/sim/engine';
import type { ComponentKind, Design, ParamValue, SimSnapshot } from '../src/sim/types';

type N = [id: string, kind: ComponentKind, params?: Record<string, ParamValue>];

function pipeline(queue: Record<string, ParamValue> = {}, workers: Record<string, ParamValue> = {}): Design {
  const nodes: N[] = [
    ['clients', 'clients', { staticPct: 0, writePct: 100, retries: 0 }],
    ['app', 'app', { instances: 4, externalCallPct: 0 }],
    ['queue', 'queue', queue],
    ['workers', 'workers', { instances: 4, externalCallPct: 100, ...workers }],
    ['ext', 'external', { failurePct: 0, rateLimitRps: 10000, latencyMs: 50 }],
  ];
  return {
    nodes: nodes.map(([id, kind, params], i) => ({ id, kind, name: id, x: i * 12, z: 0, params: { ...defaultParams(kind), ...params } })),
    edges: [
      ['clients', 'app'],
      ['app', 'queue'],
      ['queue', 'workers'],
      ['workers', 'ext'],
    ].map(([from, to]) => ({ id: `${from}->${to}`, from, to })),
  };
}

function outage(design: Design, outageSeconds: number, after: number): SimSnapshot {
  const sim = new Simulation();
  sim.setDesign(design);
  sim.setTraffic({ peakRps: 20, shape: 'steady' });
  for (let i = 0; i < 50; i++) sim.step(0.1);
  sim.overrideParams('ext', { failurePct: 100 }, outageSeconds);
  let snap!: SimSnapshot;
  for (let i = 0; i < after * 10; i++) snap = sim.step(0.1);
  return snap;
}

describe('queue retries', () => {
  it('an outage shorter than the retry window loses nothing', () => {
    const snap = outage(pipeline({ maxReceives: 5, visibilityS: 30 }, { idempotent: true }), 20, 200);

    expect(snap.global.deadLetteredTotal).toBeLessThan(1);
    expect(snap.global.lostTotal).toBe(0);
  });

  it('retries that burn out during an outage end up in the dead-letter queue', () => {
    const snap = outage(pipeline({ maxReceives: 3, visibilityS: 1 }), 60, 80);

    expect(snap.global.deadLetteredTotal).toBeGreaterThan(100);
    expect(snap.nodes.queue.dlqDepth).toBeGreaterThan(100);
  });

  it('without a dead-letter queue, exhausted jobs are lost', () => {
    const snap = outage(pipeline({ maxReceives: 3, visibilityS: 1, dlq: false }), 60, 80);

    expect(snap.global.lostTotal).toBeGreaterThan(100);
    expect(snap.global.deadLetteredTotal).toBe(0);
  });

  it('non-idempotent workers duplicate work when they retry', () => {
    const dupes = outage(pipeline({ maxReceives: 5 }, { idempotent: false }), 20, 120).global.duplicatesTotal;
    const none = outage(pipeline({ maxReceives: 5 }, { idempotent: true }), 20, 120).global.duplicatesTotal;

    expect(dupes).toBeGreaterThan(10);
    expect(none).toBe(0);
  });

  it('retried jobs come back after the visibility timeout', () => {
    const sim = new Simulation();
    sim.setDesign(pipeline({ maxReceives: 5, visibilityS: 10 }, { idempotent: true }));
    sim.setTraffic({ peakRps: 20, shape: 'steady' });
    for (let i = 0; i < 50; i++) sim.step(0.1);
    sim.overrideParams('ext', { failurePct: 100 }, 3);
    let snap!: SimSnapshot;
    for (let i = 0; i < 40; i++) snap = sim.step(0.1);

    expect(snap.nodes.queue.inFlight).toBeGreaterThan(20);
  });
});
