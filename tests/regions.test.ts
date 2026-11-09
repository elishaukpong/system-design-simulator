import { describe, expect, it } from 'vitest';
import { defaultParams } from '../src/sim/catalog';
import { Simulation } from '../src/sim/engine';
import { regionAt } from '../src/sim/regions';
import type { ComponentKind, Design, ParamValue, SimSnapshot } from '../src/sim/types';

const US = 0;
const EU = 96;

type N = [id: string, kind: ComponentKind, z: number, params?: Record<string, ParamValue>];

function design(nodes: N[], edges: Array<[string, string]>): Design {
  return {
    nodes: nodes.map(([id, kind, z, params], i) => ({ id, kind, name: id, x: i * 12, z, params: { ...defaultParams(kind), ...params } })),
    edges: edges.map(([from, to]) => ({ id: `${from}->${to}`, from, to })),
  };
}

function steps(sim: Simulation, seconds: number): SimSnapshot {
  let snap!: SimSnapshot;
  for (let i = 0; i < seconds * 10; i++) snap = sim.step(0.1);
  return snap;
}

const twoRegions = (dbParams: Record<string, ParamValue> = {}) =>
  design(
    [
      ['users-eu', 'clients', EU, { staticPct: 0, retries: 0 }],
      ['lb-us', 'lb', US],
      ['app-us', 'app', US, { instances: 6, searchPct: 0 }],
      ['lb-eu', 'lb', EU],
      ['app-eu', 'app', EU, { instances: 6, searchPct: 0 }],
      ['db', 'db', US, dbParams],
    ],
    [
      ['users-eu', 'lb-us'],
      ['users-eu', 'lb-eu'],
      ['lb-us', 'app-us'],
      ['lb-eu', 'app-eu'],
      ['app-us', 'db'],
      ['app-eu', 'db'],
    ],
  );

describe('regions', () => {
  it('places components by which plate they sit on', () => {
    expect(regionAt(0)).toBe('us-east');
    expect(regionAt(96)).toBe('eu-west');
    expect(regionAt(-96)).toBe('ap-south');
  });

  it('clients go to the nearest healthy entry point', () => {
    const sim = new Simulation();
    sim.setDesign(twoRegions());
    sim.setTraffic({ peakRps: 200, shape: 'steady' });
    const snap = steps(sim, 3);

    expect(snap.nodes['lb-eu'].inRps).toBeCloseTo(200, 0);
    expect(snap.nodes['lb-us'].inRps).toBe(0);
  });

  it('when the near region dies, clients fail over to the far one', () => {
    const sim = new Simulation();
    sim.setDesign(twoRegions());
    sim.setTraffic({ peakRps: 200, shape: 'steady' });
    steps(sim, 3);
    sim.killRegion('eu-west', 60);
    const snap = steps(sim, 2);

    expect(snap.nodes['lb-us'].inRps).toBeGreaterThan(150);
    expect(snap.global.errorRate).toBeLessThan(0.01);
  });

  it('a database with a standby fails over to the standby region', () => {
    const sim = new Simulation();
    const d = twoRegions({ standby: 'eu-west', failoverS: 10 });
    sim.setDesign(d);
    sim.setTraffic({ peakRps: 200, shape: 'steady' });
    steps(sim, 3);
    sim.killRegion('us-east', 120);
    const during = steps(sim, 5);
    const after = steps(sim, 10);

    expect(during.nodes.db.status).toBe('down');
    expect(after.nodes.db.status).not.toBe('down');
    expect(after.nodes.db.region).toBe('eu-west');
    expect(sim.events.some((e) => e.message.includes('Promoting the standby'))).toBe(true);
  });

  it('a database without a standby stays down with its region', () => {
    const sim = new Simulation();
    sim.setDesign(twoRegions());
    sim.setTraffic({ peakRps: 200, shape: 'steady' });
    steps(sim, 3);
    sim.killRegion('us-east', 120);
    const snap = steps(sim, 40);

    expect(snap.nodes.db.status).toBe('down');
  });

  it('a replica across the ocean is at least half a round trip behind', () => {
    const d = design(
      [
        ['users', 'clients', US, { staticPct: 0, retries: 0 }],
        ['app', 'app', US, { instances: 4, searchPct: 0 }],
        ['db', 'db', US],
        ['replica', 'replica', EU],
      ],
      [
        ['users', 'app'],
        ['app', 'db'],
        ['app', 'replica'],
        ['db', 'replica'],
      ],
    );
    const sim = new Simulation();
    sim.setDesign(d);
    sim.setTraffic({ peakRps: 100, shape: 'steady' });
    const snap = steps(sim, 10);

    expect(snap.nodes.replica.replicationLag).toBeGreaterThan(0.075 / 2);
  });

  it('traffic shares split users between clients nodes', () => {
    const d = design(
      [
        ['a', 'clients', US, { staticPct: 0, retries: 0, sharePct: 75 }],
        ['b', 'clients', US, { staticPct: 0, retries: 0, sharePct: 25 }],
        ['app', 'app', US, { instances: 4, searchPct: 0 }],
      ],
      [
        ['a', 'app'],
        ['b', 'app'],
      ],
    );
    const sim = new Simulation();
    sim.setDesign(d);
    sim.setTraffic({ peakRps: 100, shape: 'steady' });
    const snap = steps(sim, 2);

    expect(snap.nodes.a.inRps).toBeCloseTo(75, 0);
    expect(snap.nodes.b.inRps).toBeCloseTo(25, 0);
  });

  it('a killed clients group stops sending instead of failing', () => {
    const d = design(
      [
        ['a', 'clients', US, { staticPct: 0, retries: 0 }],
        ['b', 'clients', US, { staticPct: 0, retries: 0 }],
        ['c', 'clients', US, { staticPct: 0, retries: 0 }],
        ['app', 'app', US, { instances: 4, searchPct: 0 }],
      ],
      [
        ['a', 'app'],
        ['b', 'app'],
        ['c', 'app'],
      ],
    );
    const sim = new Simulation();
    sim.setDesign(d);
    sim.setTraffic({ peakRps: 90, shape: 'steady' });
    steps(sim, 2);
    sim.kill('c');
    const snap = steps(sim, 2);

    expect(snap.global.offeredRps).toBeCloseTo(60, 0);
    expect(snap.nodes.app.inRps).toBeCloseTo(60, 0);
    expect(snap.global.errorRate).toBeLessThan(0.001);
  });
});
