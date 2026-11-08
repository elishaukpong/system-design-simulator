import { boolParam, numberParam, sizeMultiplier } from './catalog';
import type { ClassFlow, ComponentKind, NodeSpec } from './types';

export interface Profile {
  unitCapacity: number;
  units: number;
  weights: ClassFlow;
  baseLatency: number;
  threadsPerUnit: number | null;
  serversPerUnit: number;
  connectionLimit: number | null;
  maxQueueSeconds: number;
  crashable: boolean;
  passThrough: boolean;
  monthlyPerUnit: number;
  perMillionRequests: number;
}

const UNIFORM: ClassFlow = { static: 1, read: 1, write: 1 };

const DATABASE_WEIGHTS: ClassFlow = { static: 1, read: 1, write: 4 };

export const SECONDS_PER_MONTH = 2_592_000;

export function profileFor(node: NodeSpec): Profile {
  const p = node.params;
  const mult = sizeMultiplier(p);

  const base: Profile = {
    unitCapacity: 1e9,
    units: 1,
    weights: UNIFORM,
    baseLatency: 0.001,
    threadsPerUnit: null,
    serversPerUnit: 8,
    connectionLimit: null,
    maxQueueSeconds: 1,
    crashable: false,
    passThrough: false,
    monthlyPerUnit: 0,
    perMillionRequests: 0,
  };

  switch (node.kind) {
    case 'clients':
      return { ...base, unitCapacity: 1e12, baseLatency: 0, passThrough: true };
    case 'dns':
      return { ...base, unitCapacity: 1e9, baseLatency: 0.0005, passThrough: true, monthlyPerUnit: 1 };
    case 'cdn':
      return { ...base, unitCapacity: 5e6, baseLatency: 0.012, passThrough: true, monthlyPerUnit: 20, perMillionRequests: 0.1 };
    case 'lb':
      return { ...base, unitCapacity: 100_000, baseLatency: 0.001, passThrough: true, monthlyPerUnit: 20, perMillionRequests: 0.02 };
    case 'gateway':
      return { ...base, unitCapacity: 50_000, baseLatency: 0.003, passThrough: true, perMillionRequests: 1 };
    case 'breaker':
      return { ...base, unitCapacity: 1e9, baseLatency: 0.0002, passThrough: true };
    case 'app':
      return {
        ...base,
        unitCapacity: 150 * mult,
        units: numberParam(p, 'instances', 1),
        weights: { static: 0.5, read: 1, write: 1.5 },
        baseLatency: 0.025,
        threadsPerUnit: 16 * mult,
        serversPerUnit: 2 * mult,
        maxQueueSeconds: 2,
        crashable: true,
        monthlyPerUnit: 30 * mult,
      };
    case 'workers':
      return {
        ...base,
        unitCapacity: 80 * mult,
        units: numberParam(p, 'instances', 2),
        baseLatency: 0.04,
        threadsPerUnit: 16 * mult,
        serversPerUnit: 2 * mult,
        maxQueueSeconds: 1,
        crashable: true,
        monthlyPerUnit: 30 * mult,
      };
    case 'cache':
      return {
        ...base,
        unitCapacity: 50_000,
        units: numberParam(p, 'nodes', 1),
        baseLatency: 0.001,
        serversPerUnit: 1,
        maxQueueSeconds: 0.5,
        crashable: true,
        monthlyPerUnit: 40,
      };
    case 'db':
      return {
        ...base,
        unitCapacity: 2000 * mult,
        weights: DATABASE_WEIGHTS,
        baseLatency: 0.004,
        serversPerUnit: 4 * mult,
        connectionLimit: numberParam(p, 'maxConnections', 300),
        monthlyPerUnit: 120 * mult,
      };
    case 'replica':
      return {
        ...base,
        unitCapacity: 2000 * mult,
        units: numberParam(p, 'count', 2),
        weights: DATABASE_WEIGHTS,
        baseLatency: 0.004,
        serversPerUnit: 4 * mult,
        monthlyPerUnit: 120 * mult,
      };
    case 'shard':
      return {
        ...base,
        unitCapacity: 2000 * mult,
        weights: DATABASE_WEIGHTS,
        baseLatency: 0.004,
        serversPerUnit: 4 * mult,
        monthlyPerUnit: 120 * mult * numberParam(p, 'shards', 4),
      };
    case 'objectStorage':
      return { ...base, unitCapacity: 5500, weights: { static: 1, read: 1, write: 1.5 }, baseLatency: 0.04, monthlyPerUnit: 20, perMillionRequests: 0.4 };
    case 'search':
      return { ...base, unitCapacity: 400, units: numberParam(p, 'nodes', 2), baseLatency: 0.03, monthlyPerUnit: 90 };
    case 'queue':
      return { ...base, unitCapacity: 20_000, baseLatency: 0.005, monthlyPerUnit: 100, perMillionRequests: 0.05 };
    case 'external':
      return {
        ...base,
        unitCapacity: numberParam(p, 'rateLimitRps', 200),
        baseLatency: numberParam(p, 'latencyMs', 250) / 1000,
        maxQueueSeconds: 0,
      };
  }
}

export function isAutoscaled(node: NodeSpec): boolean {
  return (node.kind === 'app' || node.kind === 'workers') && boolParam(node.params, 'autoscale', false);
}

export const PASS_THROUGH_KINDS: ComponentKind[] = ['clients', 'dns', 'cdn', 'lb', 'gateway', 'breaker'];
