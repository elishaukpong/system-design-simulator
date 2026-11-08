import type { RunResult } from './types';

export interface Best {
  stars: number;
  passed: boolean;
  cost: number;
}

const KEY = 'sds:progress:v1';

export function loadProgress(): Record<string, Best> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, Best>) : {};
  } catch {
    return {};
  }
}

export function recordResult(result: RunResult): Best {
  const all = loadProgress();
  const previous = all[result.scenarioId];
  const better =
    !previous ||
    result.stars > previous.stars ||
    (result.stars === previous.stars && result.passed && result.averageCost < previous.cost);
  const best = better ? { stars: result.stars, passed: result.passed, cost: result.averageCost } : previous;
  all[result.scenarioId] = best;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Progress is a convenience; the run result is still shown when storage is unavailable.
  }
  return best;
}
