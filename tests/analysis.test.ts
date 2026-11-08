import { describe, expect, it } from 'vitest';
import { diagnose } from '../src/sim/analysis';
import { defaultParams } from '../src/sim/catalog';
import { Simulation } from '../src/sim/engine';
import type { ComponentKind, Design, ParamValue } from '../src/sim/types';

function design(nodes: Array<[string, ComponentKind, Record<string, ParamValue>?]>, edges: Array<[string, string]>): Design {
  return {
    nodes: nodes.map(([id, kind, params]) => ({ id, kind, name: id, x: 0, z: 0, params: { ...defaultParams(kind), ...params } })),
    edges: edges.map(([from, to]) => ({ id: `${from}->${to}`, from, to })),
  };
}

function diagnosisAt(d: Design, rps: number, seconds: number) {
  const sim = new Simulation();
  sim.setDesign(d);
  sim.setTraffic({ peakRps: rps, shape: 'steady' });
  for (let i = 0; i < seconds * 10; i++) sim.step(0.1);
  return diagnose(d, sim.snapshot!);
}

const shardDesign = design(
  [
    ['clients', 'clients', { staticPct: 0, writePct: 100, retries: 0 }],
    ['app', 'app', { instances: 40 }],
    ['shard', 'shard', { shards: 8, hotKeyPct: 60 }],
  ],
  [
    ['clients', 'app'],
    ['app', 'shard'],
  ],
);

describe('diagnose', () => {
  it('names the root cause, not the component waiting on it', () => {
    const result = diagnosisAt(shardDesign, 3000, 5);

    expect(result.binding?.nodeId).toBe('shard');
    expect(result.binding?.reason).toBe('hot-shard');
    expect(result.symptoms.map((s) => s.symptomOf)).toContain('shard');
  });

  it('reports the closest wall and where it binds when nothing is binding yet', () => {
    const d = design(
      [
        ['clients', 'clients', { staticPct: 0, retries: 0 }],
        ['app', 'app', { instances: 2 }],
        ['db', 'db'],
      ],
      [
        ['clients', 'app'],
        ['app', 'db'],
      ],
    );
    const result = diagnosisAt(d, 100, 5);

    expect(result.binding).toBeNull();
    expect(result.closestWall?.nodeId).toBe('app');
    expect(result.closestWall?.bindsAtRps).toBeGreaterThan(250);
    expect(result.closestWall?.bindsAtRps).toBeLessThan(320);
  });

  it('warns about a queue nobody consumes', () => {
    const d = design(
      [
        ['clients', 'clients'],
        ['app', 'app'],
        ['queue', 'queue'],
      ],
      [
        ['clients', 'app'],
        ['app', 'queue'],
      ],
    );
    const result = diagnosisAt(d, 10, 1);

    expect(result.warnings.some((w) => w.includes('no Workers'))).toBe(true);
  });

  it('a dead component nobody routes to is not the binding pressure', () => {
    const d = design(
      [
        ['users', 'clients', { staticPct: 0, retries: 0 }],
        ['lb-us', 'lb'],
        ['app-us', 'app', { instances: 4 }],
        ['lb-eu', 'lb'],
        ['app-eu', 'app', { instances: 4 }],
      ],
      [
        ['users', 'lb-us'],
        ['users', 'lb-eu'],
        ['lb-us', 'app-us'],
        ['lb-eu', 'app-eu'],
      ],
    );
    d.nodes.find((n) => n.id === 'lb-eu')!.z = 96;
    d.nodes.find((n) => n.id === 'app-eu')!.z = 96;
    const sim = new Simulation();
    sim.setDesign(d);
    sim.setTraffic({ peakRps: 100, shape: 'steady' });
    for (let i = 0; i < 20; i++) sim.step(0.1);
    sim.killRegion('us-east', 60);
    for (let i = 0; i < 20; i++) sim.step(0.1);
    const result = diagnose(d, sim.snapshot!);

    expect(result.binding?.nodeId ?? null).not.toBe('lb-us');
    expect(result.binding?.nodeId ?? null).not.toBe('app-us');
  });
});
