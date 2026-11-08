import type { ComponentKind, ParamValue } from './types';

export type ParamDef =
  | { key: string; label: string; type: 'number'; min: number; max: number; step: number; default: number; unit?: string; help?: string }
  | { key: string; label: string; type: 'boolean'; default: boolean; help?: string }
  | { key: string; label: string; type: 'select'; options: string[]; default: string; help?: string };

export type ComponentGroup = 'Edge' | 'Compute' | 'Data' | 'Async' | 'Resilience';

export interface ComponentDef {
  kind: ComponentKind;
  label: string;
  short: string;
  group: ComponentGroup;
  color: number;
  blurb: string;
  params: ParamDef[];
}

export const SIZES = ['small', 'medium', 'large', 'xlarge'] as const;

export const SIZE_MULTIPLIER: Record<string, number> = {
  small: 1,
  medium: 2,
  large: 4,
  xlarge: 8,
};

const size = (fallback: string): ParamDef => ({
  key: 'size',
  label: 'Instance size',
  type: 'select',
  options: [...SIZES],
  default: fallback,
  help: 'Each step up doubles capacity and cost. Vertical scaling.',
});

export const CATALOG: Record<ComponentKind, ComponentDef> = {
  clients: {
    kind: 'clients',
    label: 'Clients',
    short: 'CLI',
    group: 'Edge',
    color: 0x7dd3fc,
    blurb: 'Where traffic comes from. The traffic dial sets how much; this sets its shape.',
    params: [
      { key: 'staticPct', label: 'Static assets', type: 'number', min: 0, max: 90, step: 5, default: 30, unit: '%', help: 'Images, JS, CSS. Cheap to serve from a CDN, expensive from an app server.' },
      { key: 'writePct', label: 'Writes (of dynamic)', type: 'number', min: 0, max: 100, step: 5, default: 10, unit: '%' },
      { key: 'retries', label: 'Client retries', type: 'number', min: 0, max: 5, step: 1, default: 2, help: 'Failed requests are retried immediately. Watch the amplification when things go wrong.' },
      { key: 'timeoutMs', label: 'Client timeout', type: 'number', min: 200, max: 30000, step: 100, default: 5000, unit: 'ms' },
    ],
  },
  dns: {
    kind: 'dns',
    label: 'DNS',
    short: 'DNS',
    group: 'Edge',
    color: 0xa5b4fc,
    blurb: 'Resolves names to addresses. Cached almost everywhere, so it rarely binds.',
    params: [],
  },
  cdn: {
    kind: 'cdn',
    label: 'CDN',
    short: 'CDN',
    group: 'Edge',
    color: 0x67e8f9,
    blurb: 'Serves static assets from the edge. Misses go to the origin behind it.',
    params: [
      { key: 'hitRatio', label: 'Static hit ratio', type: 'number', min: 0, max: 0.99, step: 0.01, default: 0.9 },
      { key: 'cacheDynamicPct', label: 'Cacheable dynamic reads', type: 'number', min: 0, max: 80, step: 5, default: 0, unit: '%', help: 'Edge-cached API reads (public pages, short TTL).' },
    ],
  },
  lb: {
    kind: 'lb',
    label: 'Load Balancer',
    short: 'LB',
    group: 'Edge',
    color: 0xc4b5fd,
    blurb: 'Spreads traffic across the nodes behind it. With health checks it routes around dead ones.',
    params: [
      { key: 'healthChecks', label: 'Health checks', type: 'boolean', default: true, help: 'Off: traffic still goes to dead backends and fails.' },
      { key: 'algorithm', label: 'Algorithm', type: 'select', options: ['round-robin', 'least-connections'], default: 'round-robin', help: 'Least-connections weighs by spare capacity.' },
    ],
  },
  gateway: {
    kind: 'gateway',
    label: 'API Gateway',
    short: 'GW',
    group: 'Edge',
    color: 0xf0abfc,
    blurb: 'Auth, routing and rate limiting at the front door. Sheds load with 429s instead of falling over.',
    params: [
      { key: 'rateLimit', label: 'Rate limiting', type: 'boolean', default: true },
      { key: 'rateLimitRps', label: 'Rate limit', type: 'number', min: 100, max: 1000000, step: 100, default: 5000, unit: 'rps' },
    ],
  },
  app: {
    kind: 'app',
    label: 'App Servers',
    short: 'APP',
    group: 'Compute',
    color: 0x86efac,
    blurb: 'Stateless request handlers. Scale out by adding instances. Each has a fixed worker pool.',
    params: [
      size('small'),
      { key: 'instances', label: 'Instances', type: 'number', min: 1, max: 64, step: 1, default: 1 },
      { key: 'autoscale', label: 'Autoscaling', type: 'boolean', default: false },
      { key: 'maxInstances', label: 'Autoscale max', type: 'number', min: 1, max: 200, step: 1, default: 20 },
      { key: 'externalCallPct', label: 'Writes calling external API', type: 'number', min: 0, max: 100, step: 5, default: 30, unit: '%', help: 'Only applies if an External API is connected.' },
      { key: 'searchPct', label: 'Reads that are searches', type: 'number', min: 0, max: 100, step: 5, default: 20, unit: '%', help: 'Go to Search if connected. Otherwise each one hits the DB as a LIKE query costing 4 normal queries.' },
    ],
  },
  workers: {
    kind: 'workers',
    label: 'Workers',
    short: 'WRK',
    group: 'Compute',
    color: 0xbef264,
    blurb: 'Consume jobs from a queue at their own pace. Their speed sets how fast the backlog drains.',
    params: [
      size('small'),
      { key: 'instances', label: 'Instances', type: 'number', min: 1, max: 64, step: 1, default: 2 },
      { key: 'autoscale', label: 'Autoscale on queue depth', type: 'boolean', default: false },
      { key: 'maxInstances', label: 'Autoscale max', type: 'number', min: 1, max: 200, step: 1, default: 20 },
      { key: 'externalCallPct', label: 'Jobs calling external API', type: 'number', min: 0, max: 100, step: 5, default: 30, unit: '%' },
    ],
  },
  cache: {
    kind: 'cache',
    label: 'Cache (Redis)',
    short: 'CACHE',
    group: 'Data',
    color: 0xfca5a5,
    blurb: 'Cache-aside for reads. Hits never reach the DB. A cold or dead cache sends every read through.',
    params: [
      { key: 'nodes', label: 'Nodes', type: 'number', min: 1, max: 32, step: 1, default: 1 },
      { key: 'hitRatio', label: 'Target hit ratio', type: 'number', min: 0, max: 0.99, step: 0.01, default: 0.85 },
      { key: 'warmupS', label: 'Warm-up time', type: 'number', min: 1, max: 300, step: 1, default: 30, unit: 's' },
    ],
  },
  db: {
    kind: 'db',
    label: 'DB Primary',
    short: 'DB',
    group: 'Data',
    color: 0xfdba74,
    blurb: 'The source of truth. Every write lands here. Scales up, not out.',
    params: [
      size('medium'),
      { key: 'maxConnections', label: 'Max connections', type: 'number', min: 20, max: 5000, step: 10, default: 300 },
    ],
  },
  replica: {
    kind: 'replica',
    label: 'Read Replicas',
    short: 'REPL',
    group: 'Data',
    color: 0xfcd34d,
    blurb: 'Copies of the primary that serve reads. They still replay every write, and they lag.',
    params: [
      size('medium'),
      { key: 'count', label: 'Replicas', type: 'number', min: 1, max: 15, step: 1, default: 2 },
    ],
  },
  shard: {
    kind: 'shard',
    label: 'Sharded DB',
    short: 'SHARD',
    group: 'Data',
    color: 0xfb923c,
    blurb: 'Data split by key across many primaries. Scales writes, until one key gets hot.',
    params: [
      size('medium'),
      { key: 'shards', label: 'Shards', type: 'number', min: 2, max: 64, step: 1, default: 4 },
      { key: 'hotKeyPct', label: 'Traffic on hottest shard', type: 'number', min: 0, max: 100, step: 5, default: 0, unit: '%', help: '0 = evenly spread. A celebrity user or a flash-sale SKU pushes this up.' },
    ],
  },
  objectStorage: {
    kind: 'objectStorage',
    label: 'Object Storage',
    short: 'S3',
    group: 'Data',
    color: 0x5eead4,
    blurb: 'Blob storage for files and assets. Very wide, a little slow, priced per request.',
    params: [],
  },
  search: {
    kind: 'search',
    label: 'Search Index',
    short: 'SRCH',
    group: 'Data',
    color: 0xf9a8d4,
    blurb: 'A purpose-built index for text search. Takes LIKE-queries off the database.',
    params: [
      { key: 'nodes', label: 'Nodes', type: 'number', min: 1, max: 32, step: 1, default: 2 },
    ],
  },
  queue: {
    kind: 'queue',
    label: 'Queue',
    short: 'QUEUE',
    group: 'Async',
    color: 0x93c5fd,
    blurb: 'Accepts writes now, processes them later. Turns a spike into a backlog instead of an outage.',
    params: [
      { key: 'maxDepth', label: 'Max depth', type: 'number', min: 1000, max: 10000000, step: 1000, default: 1000000 },
    ],
  },
  breaker: {
    kind: 'breaker',
    label: 'Circuit Breaker',
    short: 'CB',
    group: 'Resilience',
    color: 0xfde047,
    blurb: 'Wraps a dependency. When it keeps failing, stop calling it and fail fast so it can recover.',
    params: [
      { key: 'errorThresholdPct', label: 'Trip at error rate', type: 'number', min: 5, max: 95, step: 5, default: 50, unit: '%' },
      { key: 'cooldownS', label: 'Cool-down', type: 'number', min: 1, max: 120, step: 1, default: 10, unit: 's' },
    ],
  },
  external: {
    kind: 'external',
    label: 'External API',
    short: 'EXT',
    group: 'Resilience',
    color: 0xd4d4d8,
    blurb: 'A third party you do not control: payments, couriers, email. Rate-limited, slow, sometimes down.',
    params: [
      { key: 'rateLimitRps', label: 'Provider rate limit', type: 'number', min: 10, max: 100000, step: 10, default: 200, unit: 'rps' },
      { key: 'latencyMs', label: 'Latency', type: 'number', min: 20, max: 5000, step: 10, default: 250, unit: 'ms' },
      { key: 'failurePct', label: 'Baseline failures', type: 'number', min: 0, max: 100, step: 1, default: 1, unit: '%' },
    ],
  },
};

export const GROUP_ORDER: ComponentGroup[] = ['Edge', 'Compute', 'Data', 'Async', 'Resilience'];

export function defaultParams(kind: ComponentKind): Record<string, ParamValue> {
  const params: Record<string, ParamValue> = {};
  for (const def of CATALOG[kind].params) {
    params[def.key] = def.default;
  }
  return params;
}

export function numberParam(params: Record<string, ParamValue>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' ? value : fallback;
}

export function boolParam(params: Record<string, ParamValue>, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function sizeMultiplier(params: Record<string, ParamValue>): number {
  const value = params.size;
  return typeof value === 'string' ? SIZE_MULTIPLIER[value] ?? 1 : 1;
}
