import { describe, expect, it } from 'vitest';
import { CheckTracker } from '../src/learn/checks';
import { LESSONS } from '../src/learn/lessons';
import type { Exercise } from '../src/learn/types';
import { defaultParams } from '../src/sim/catalog';
import { Simulation } from '../src/sim/engine';
import type { ComponentKind, Design, ParamValue } from '../src/sim/types';
import type { SavedState } from '../src/state/store';

const EU = 96;

function setParams(d: Design, id: string, params: Record<string, ParamValue>): void {
  const node = d.nodes.find((n) => n.id === id)!;
  node.params = { ...node.params, ...params };
}

function add(d: Design, id: string, kind: ComponentKind, params: Record<string, ParamValue> = {}, z = 0): void {
  d.nodes.push({ id, kind, name: id, x: 200 + d.nodes.length * 12, z, params: { ...defaultParams(kind), ...params } });
}

function connect(d: Design, from: string, to: string): void {
  d.edges.push({ id: `${from}->${to}`, from, to });
}

function disconnect(d: Design, from: string, to: string): void {
  d.edges = d.edges.filter((e) => !(e.from === from && e.to === to));
}

interface Solution {
  solve: (d: Design) => void;
  during?: (sim: Simulation, t: number) => void;
}

const SOLUTIONS: Record<string, Solution> = {
  'four-dials-300': { solve: (d) => setParams(d, 'app', { instances: 3 }) },
  'single-machine-1000': { solve: (d) => setParams(d, 'app', { size: 'xlarge' }) },
  'scale-out-2000': {
    solve: (d) => {
      setParams(d, 'app-a', { instances: 14 });
      setParams(d, 'app-b', { instances: 14 });
    },
    during: (sim, t) => {
      if (Math.abs(t - 30) < 0.05) sim.kill('app-a', 1, 60);
    },
  },
  'autoscaling-wave': { solve: (d) => setParams(d, 'app', { instances: 8, autoscale: true, maxInstances: 40 }) },
  'caching-4000': {
    solve: (d) => {
      add(d, 'cache', 'cache', { nodes: 2 });
      connect(d, 'app', 'cache');
    },
  },
  'cdn-2500': {
    solve: (d) => {
      setParams(d, 'app', { instances: 10 });
      add(d, 'cdn', 'cdn');
      add(d, 's3', 'objectStorage');
      connect(d, 'clients', 'cdn');
      connect(d, 'cdn', 's3');
    },
  },
  'replication-4000': {
    solve: (d) => {
      add(d, 'replica', 'replica', { count: 3 });
      connect(d, 'app', 'replica');
      connect(d, 'db', 'replica');
    },
  },
  'queues-keep-up': {
    solve: (d) => {
      disconnect(d, 'app', 'ext');
      add(d, 'queue', 'queue');
      add(d, 'workers', 'workers', { instances: 40, externalCallPct: 100, idempotent: true });
      connect(d, 'app', 'queue');
      connect(d, 'queue', 'workers');
      connect(d, 'workers', 'db');
      connect(d, 'workers', 'ext');
    },
  },
  'retries-calm': {
    solve: (d) => {
      setParams(d, 'clients', { retries: 1 });
      setParams(d, 'app', { instances: 10 });
      setParams(d, 'db', { maxConnections: 300 });
    },
  },
  'breaker-isolate': {
    solve: (d) => {
      disconnect(d, 'app', 'ext');
      add(d, 'cb', 'breaker');
      connect(d, 'app', 'cb');
      connect(d, 'cb', 'ext');
    },
  },
  'rate-limit-no-crash': {
    solve: (d) => {
      disconnect(d, 'clients', 'lb');
      add(d, 'gw', 'gateway', { rateLimitRps: 1000 });
      connect(d, 'clients', 'gw');
      connect(d, 'gw', 'lb');
    },
  },
  'microservices-3000': {
    solve: (d) => {
      setParams(d, 'search', { instances: 20 });
      setParams(d, 'users', { instances: 14 });
      setParams(d, 'checkout', { instances: 4 });
    },
  },
  'regions-close': {
    solve: (d) => {
      for (const id of ['lb', 'app', 'db']) d.nodes.find((n) => n.id === id)!.z = EU;
    },
  },
};

const exercises = LESSONS.flatMap((lesson) => lesson.exercises);

function attempt(exercise: Exercise, solution: Solution | null, seconds = 180): { done: boolean; why: string } {
  const state: SavedState = exercise.start();
  const design = structuredClone(state.design);
  solution?.solve(design);
  const sim = new Simulation();
  sim.setDesign(design);
  sim.setTraffic(state.traffic);
  const tracker = new CheckTracker(exercise.checks, true);
  for (let i = 1; i <= seconds * 10; i++) {
    const snap = sim.step(0.1);
    solution?.during?.(sim, sim.t);
    if (i % 5 === 0) tracker.update({ snap, design, traffic: state.traffic, events: sim.events }, sim.t);
    if (tracker.done) return { done: true, why: '' };
  }
  return { done: false, why: failing(exercise, design, state, sim) };
}

function failing(exercise: Exercise, design: Design, state: SavedState, sim: Simulation): string {
  const ctx = { snap: sim.snapshot, design, traffic: state.traffic, events: sim.events };
  return exercise.checks.filter((c) => !c.test(ctx)).map((c) => c.label).join(', ') || 'never all at once';
}

describe('lessons', () => {
  it('have unique ids', () => {
    const ids = [...LESSONS.map((l) => l.id), ...exercises.map((e) => e.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(LESSONS.map((l) => l.id))('%s starts from a design and points at things that exist', (id) => {
    const lesson = LESSONS.find((l) => l.id === id)!;
    expect(lesson.steps[0].setup).toBeDefined();
    let design: Design | null = null;
    for (const step of lesson.steps) {
      if (step.setup) design = step.setup().design;
      const ids = new Set(design!.nodes.map((n) => n.id));
      for (const edge of design!.edges) expect(ids.has(edge.from) && ids.has(edge.to)).toBe(true);
      if (step.focus?.node) expect(ids.has(step.focus.node), `${step.title} focuses ${step.focus.node}`).toBe(true);
    }
  });

  it('every exercise has a reference solution', () => {
    expect(exercises.map((e) => e.id).sort()).toEqual(Object.keys(SOLUTIONS).sort());
  });

  it.each(exercises.map((e) => e.id))('%s: the reference solution passes every check', (id) => {
    const exercise = exercises.find((e) => e.id === id)!;
    const { done, why } = attempt(exercise, SOLUTIONS[id]);

    expect(done, `still failing: ${why}`).toBe(true);
  });

  it.each(exercises.map((e) => e.id))('%s: the starting design does not pass', (id) => {
    const exercise = exercises.find((e) => e.id === id)!;

    expect(attempt(exercise, null).done).toBe(false);
  });
});

describe('check tracker', () => {
  const ctx = { snap: null, design: { nodes: [], edges: [] }, traffic: { peakRps: 1, shape: 'steady' as const }, events: [] };

  it('needs a check to hold for its full time, then keeps it', () => {
    let ok = true;
    const tracker = new CheckTracker([{ label: 'x', holdS: 10, test: () => ok }]);
    tracker.update(ctx, 0);
    expect(tracker.update(ctx, 9)[0].pass).toBe(false);
    expect(tracker.update(ctx, 10)[0].pass).toBe(true);
    ok = false;
    expect(tracker.update(ctx, 11)[0].pass).toBe(true);
  });

  it('in together mode needs every check passing at the same time', () => {
    let a = true;
    let b = false;
    const tracker = new CheckTracker(
      [
        { label: 'a', holdS: 10, test: () => a },
        { label: 'b', holdS: 10, test: () => b },
      ],
      true,
    );
    tracker.update(ctx, 0);
    tracker.update(ctx, 10);
    expect(tracker.done).toBe(false);
    a = false;
    b = true;
    tracker.update(ctx, 11);
    a = true;
    tracker.update(ctx, 12);
    expect(tracker.update(ctx, 21).every((s) => !s.pass)).toBe(true);
    expect(tracker.update(ctx, 22).every((s) => s.pass)).toBe(true);
  });

  it('starts the clock over when a check slips', () => {
    let ok = true;
    const tracker = new CheckTracker([{ label: 'x', holdS: 10, test: () => ok }]);
    tracker.update(ctx, 0);
    ok = false;
    tracker.update(ctx, 5);
    ok = true;
    tracker.update(ctx, 6);
    expect(tracker.update(ctx, 15)[0].pass).toBe(false);
    expect(tracker.update(ctx, 16)[0].pass).toBe(true);
  });
});
