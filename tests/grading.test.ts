import { describe, expect, it } from 'vitest';
import { evaluateAll } from '../src/scenarios/grading';
import type { Sample, Scenario } from '../src/scenarios/types';

const scenario = {
  criteria: [{ role: 'core', criterion: { type: 'p99', maxMs: 500, withinPct: 0.9 } }],
} as unknown as Scenario;

function sample(t: number, offered: number, success: number, p99: number): Sample {
  return { t, offered, success, errorRate: 1 - success / offered, shedRate: 0, p99, p50: p99, cost: 0, retryAmplification: 1, queueLag: 0, replicationLag: 0, deadLettered: 0, lost: 0, duplicates: 0, binding: null };
}

describe('grading', () => {
  it('a dead system does not meet its latency target by failing fast', () => {
    const samples = Array.from({ length: 10 }, (_, i) => sample(i + 1, 100, 0, 0.05));

    expect(evaluateAll(scenario, samples)[0].pass).toBe(false);
  });

  it('a healthy fast system meets its latency target', () => {
    const samples = Array.from({ length: 10 }, (_, i) => sample(i + 1, 100, 100, 0.05));

    expect(evaluateAll(scenario, samples)[0].pass).toBe(true);
  });
});
