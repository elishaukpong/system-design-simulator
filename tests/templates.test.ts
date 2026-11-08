import { describe, expect, it } from 'vitest';
import { diagnose } from '../src/sim/analysis';
import { Simulation } from '../src/sim/engine';
import { buildTemplate, templateList } from '../src/state/templates';

function simulate(id: string, seconds: number) {
  const state = buildTemplate(id);
  const sim = new Simulation();
  sim.setDesign(state.design);
  sim.setTraffic(state.traffic);
  let maxErrorRate = 0;
  let everBound = new Set<string>();
  for (let i = 0; i < seconds * 10; i++) {
    const snap = sim.step(0.1);
    maxErrorRate = Math.max(maxErrorRate, snap.global.errorRate);
    if (i % 10 === 0) {
      const binding = diagnose(state.design, snap).binding;
      if (binding) everBound = new Set([...everBound, `${binding.nodeId}:${binding.reason}`]);
    }
  }
  return { state, sim, maxErrorRate, everBound };
}

describe('templates', () => {
  it('has ten', () => {
    expect(templateList()).toHaveLength(10);
  });

  it.each(templateList().map((t) => t.id))('%s is well-formed', (id) => {
    const { design } = buildTemplate(id);
    const ids = new Set(design.nodes.map((n) => n.id));
    const cells = new Set(design.nodes.map((n) => `${n.x},${n.z}`));

    expect(ids.size).toBe(design.nodes.length);
    expect(cells.size).toBe(design.nodes.length);
    for (const edge of design.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });

  it.each(templateList().map((t) => t.id))('%s keeps the error rate a valid fraction', (id) => {
    const { maxErrorRate } = simulate(id, 90);

    expect(maxErrorRate).toBeGreaterThanOrEqual(0);
    expect(maxErrorRate).toBeLessThanOrEqual(1);
  });

  it.each(['monolith', 'three-tier', 'async', 'url-shortener', 'news-feed', 'upload-pipeline'])('%s holds at its starting traffic', (id) => {
    const { maxErrorRate } = simulate(id, 120);

    expect(maxErrorRate).toBeLessThan(0.01);
  });

  it('flash sale breaks on the hot shard', () => {
    expect([...simulate('flash-sale', 60).everBound]).toContain('shard:hot-shard');
  });

  it('synchronous payments exhaust the app worker pool', () => {
    const { sim } = simulate('sync-payments', 30);

    expect(sim.snapshot!.nodes.app.reason).toBe('concurrency');
  });

  it('retry storm amplifies its own load', () => {
    let maxAmplification = 0;
    const state = buildTemplate('retry-storm');
    const sim = new Simulation();
    sim.setDesign(state.design);
    sim.setTraffic(state.traffic);
    for (let i = 0; i < 900; i++) maxAmplification = Math.max(maxAmplification, sim.step(0.1).global.retryAmplification);

    expect(maxAmplification).toBeGreaterThan(2);
  });
});
