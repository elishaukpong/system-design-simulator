import { defaultParams } from '../sim/catalog';
import type { ComponentKind, ParamValue, TrafficSettings } from '../sim/types';
import type { SavedState } from './store';

interface Template {
  id: string;
  label: string;
  blurb: string;
  traffic: TrafficSettings;
  nodes: Array<[id: string, kind: ComponentKind, x: number, z: number, params?: Record<string, ParamValue>, name?: string]>;
  edges: Array<[from: string, to: string, sharePct?: number]>;
}

const TEMPLATE_SPREAD = 1.5;

const TEMPLATES: Template[] = [
  {
    id: 'blank',
    label: 'Blank canvas',
    blurb: 'Just the clients. Build from nothing.',
    traffic: { peakRps: 100, shape: 'steady' },
    nodes: [['clients', 'clients', -8, 0]],
    edges: [],
  },
  {
    id: 'monolith',
    label: 'Day-one monolith',
    blurb: 'One server, one database. Push the dial until it falls over.',
    traffic: { peakRps: 100, shape: 'steady' },
    nodes: [
      ['clients', 'clients', -8, 0],
      ['app', 'app', 0, 0],
      ['db', 'db', 8, 0],
    ],
    edges: [
      ['clients', 'app'],
      ['app', 'db'],
    ],
  },
  {
    id: 'three-tier',
    label: 'Classic three-tier',
    blurb: 'LB, a fleet of app servers, cache-aside, replicas, CDN for assets.',
    traffic: { peakRps: 2000, shape: 'wave' },
    nodes: [
      ['clients', 'clients', -16, 0],
      ['dns', 'dns', -8, 0],
      ['cdn', 'cdn', -8, -8],
      ['s3', 'objectStorage', 0, -8],
      ['lb', 'lb', 0, 0],
      ['app', 'app', 8, 0, { instances: 12 }],
      ['cache', 'cache', 16, -8],
      ['replica', 'replica', 16, 0],
      ['db', 'db', 16, 8],
    ],
    edges: [
      ['clients', 'dns'],
      ['clients', 'cdn'],
      ['cdn', 's3'],
      ['dns', 'lb'],
      ['lb', 'app'],
      ['app', 'cache'],
      ['app', 'replica'],
      ['app', 'db'],
      ['db', 'replica'],
    ],
  },
  {
    id: 'async',
    label: 'Async writes + flaky provider',
    blurb: 'Writes go through a queue. A payment provider sits behind a circuit breaker.',
    traffic: { peakRps: 1500, shape: 'spike' },
    nodes: [
      ['clients', 'clients', -16, 0, { writePct: 40 }],
      ['gw', 'gateway', -8, 0, { rateLimitRps: 4000 }],
      ['lb', 'lb', 0, 0],
      ['app', 'app', 8, 0, { instances: 12, externalCallPct: 0 }],
      ['cache', 'cache', 16, -8],
      ['queue', 'queue', 16, 8],
      ['workers', 'workers', 24, 8, { instances: 4, externalCallPct: 50 }],
      ['db', 'db', 24, 0],
      ['cb', 'breaker', 32, 8],
      ['ext', 'external', 40, 8, {}, 'Payments API'],
    ],
    edges: [
      ['clients', 'gw'],
      ['gw', 'lb'],
      ['lb', 'app'],
      ['app', 'cache'],
      ['app', 'db'],
      ['app', 'queue'],
      ['queue', 'workers'],
      ['workers', 'db'],
      ['workers', 'cb'],
      ['cb', 'ext'],
    ],
  },
  {
    id: 'url-shortener',
    label: 'URL shortener',
    blurb: '98% reads. Edge-cached redirects, Redis, replicas. Find out how far reads alone can go.',
    traffic: { peakRps: 8000, shape: 'wave' },
    nodes: [
      ['clients', 'clients', -16, 0, { staticPct: 5, writePct: 2 }],
      ['cdn', 'cdn', -8, 0, { cacheDynamicPct: 50 }],
      ['lb', 'lb', 0, 0],
      ['app', 'app', 8, 0, { instances: 24, autoscale: true, maxInstances: 40, searchPct: 0, externalCallPct: 0 }],
      ['cache', 'cache', 16, -8, { hitRatio: 0.9 }],
      ['replica', 'replica', 16, 0, { count: 2 }],
      ['db', 'db', 16, 8],
    ],
    edges: [
      ['clients', 'cdn'],
      ['cdn', 'lb'],
      ['lb', 'app'],
      ['app', 'cache'],
      ['app', 'replica'],
      ['app', 'db'],
      ['db', 'replica'],
    ],
  },
  {
    id: 'flash-sale',
    label: 'Flash-sale ticketing',
    blurb: 'Everyone wants the same event. Orders queue onto a sharded DB, and one shard gets hammered. Breaks on purpose.',
    traffic: { peakRps: 6000, shape: 'spike' },
    nodes: [
      ['clients', 'clients', -16, 0, { staticPct: 10, writePct: 60, retries: 3 }],
      ['gw', 'gateway', -8, 0, { rateLimitRps: 20000 }],
      ['lb', 'lb', 0, 0],
      ['app', 'app', 8, 0, { instances: 60, searchPct: 0, externalCallPct: 0 }],
      ['cache', 'cache', 16, -8],
      ['queue', 'queue', 16, 8],
      ['workers', 'workers', 24, 8, { instances: 40, externalCallPct: 0 }],
      ['shard', 'shard', 24, 0, { shards: 8, hotKeyPct: 45 }],
    ],
    edges: [
      ['clients', 'gw'],
      ['gw', 'lb'],
      ['lb', 'app'],
      ['app', 'cache'],
      ['app', 'shard'],
      ['app', 'queue'],
      ['queue', 'workers'],
      ['workers', 'shard'],
    ],
  },
  {
    id: 'news-feed',
    label: 'News feed (fan-out on read)',
    blurb: 'Timelines read from replicas behind a cache, search on its own index. Read-heavy, with a daily peak.',
    traffic: { peakRps: 5000, shape: 'wave' },
    nodes: [
      ['clients', 'clients', -16, 0, { staticPct: 40, writePct: 5 }],
      ['cdn', 'cdn', -8, -8],
      ['s3', 'objectStorage', 0, -8],
      ['lb', 'lb', -8, 0],
      ['app', 'app', 0, 0, { instances: 20, autoscale: true, maxInstances: 40, searchPct: 15, externalCallPct: 0 }],
      ['cache', 'cache', 8, -8, { nodes: 2, hitRatio: 0.8 }],
      ['search', 'search', 8, 8, { nodes: 2 }],
      ['replica', 'replica', 16, 0, { count: 3 }],
      ['db', 'db', 16, 8],
    ],
    edges: [
      ['clients', 'cdn'],
      ['clients', 'lb'],
      ['cdn', 's3'],
      ['lb', 'app'],
      ['app', 's3'],
      ['app', 'cache'],
      ['app', 'search'],
      ['app', 'replica'],
      ['app', 'db'],
      ['db', 'replica'],
    ],
  },
  {
    id: 'sync-payments',
    label: 'Synchronous payments, no breaker',
    blurb: 'Every checkout calls a slow provider inline. The worker pool fills first, retries pile on, then the app falls over. Breaks on purpose.',
    traffic: { peakRps: 400, shape: 'steady' },
    nodes: [
      ['clients', 'clients', -16, 0, { staticPct: 0, writePct: 50, retries: 2 }],
      ['lb', 'lb', -8, 0],
      ['app', 'app', 0, 0, { instances: 4, searchPct: 0, externalCallPct: 100 }],
      ['db', 'db', 8, -8],
      ['ext', 'external', 8, 8, { rateLimitRps: 300, latencyMs: 1200, failurePct: 5 }],
    ],
    edges: [
      ['clients', 'lb'],
      ['lb', 'app'],
      ['app', 'db'],
      ['app', 'ext'],
    ],
  },
  {
    id: 'upload-pipeline',
    label: 'File upload pipeline',
    blurb: 'Files land in S3 and go out through a CDN. Processing (scan, resize, notify) runs on workers behind a queue.',
    traffic: { peakRps: 3000, shape: 'ramp' },
    nodes: [
      ['clients', 'clients', -16, 0, { staticPct: 60, writePct: 30 }],
      ['cdn', 'cdn', -8, -8, { hitRatio: 0.95 }],
      ['s3', 'objectStorage', 0, -8],
      ['lb', 'lb', -8, 0],
      ['app', 'app', 0, 0, { instances: 12, searchPct: 0, externalCallPct: 0 }],
      ['db', 'db', 8, 0],
      ['queue', 'queue', 8, 8],
      ['workers', 'workers', 16, 8, { instances: 4, autoscale: true, maxInstances: 20, externalCallPct: 20 }],
      ['cb', 'breaker', 24, 8],
      ['ext', 'external', 32, 8, { rateLimitRps: 500, latencyMs: 400 }, 'Virus scanner'],
    ],
    edges: [
      ['clients', 'cdn'],
      ['clients', 'lb'],
      ['cdn', 's3'],
      ['lb', 'app'],
      ['app', 's3'],
      ['app', 'db'],
      ['app', 'queue'],
      ['queue', 'workers'],
      ['workers', 'db'],
      ['workers', 'cb'],
      ['cb', 'ext'],
    ],
  },
  {
    id: 'retry-storm',
    label: 'Retry storm',
    blurb: 'Aggressive client retries, short timeouts, a small DB pool. Fine until one wobble, then it attacks itself. Breaks on purpose.',
    traffic: { peakRps: 1000, shape: 'spike' },
    nodes: [
      ['clients', 'clients', -16, 0, { staticPct: 0, writePct: 20, retries: 5, timeoutMs: 800 }],
      ['lb', 'lb', -8, 0],
      ['app', 'app', 0, 0, { instances: 6, searchPct: 10, externalCallPct: 0 }],
      ['db', 'db', 8, 0, { size: 'small', maxConnections: 60 }],
    ],
    edges: [
      ['clients', 'lb'],
      ['lb', 'app'],
      ['app', 'db'],
    ],
  },
  {
    id: 'microservices',
    label: 'Microservices behind a gateway',
    blurb: 'The gateway splits by path: search takes most of the traffic, checkout the least. Every checkout also calls users-svc. Kill search and only search fails. Kill users and checkout goes down with it.',
    traffic: { peakRps: 1500, shape: 'steady' },
    nodes: [
      ['clients', 'clients', -16, 0, { staticPct: 0, writePct: 10 }],
      ['gw', 'gateway', -8, 0, { rateLimitRps: 20000 }],
      ['search', 'app', 0, -8, { instances: 12, searchPct: 0, externalCallPct: 0 }, 'search-svc'],
      ['users', 'app', 0, 0, { instances: 6, searchPct: 0, externalCallPct: 0 }, 'users-svc'],
      ['checkout', 'app', 0, 8, { instances: 2, searchPct: 0, externalCallPct: 0 }, 'checkout-svc'],
      ['search-cache', 'cache', 8, -8],
      ['search-db', 'replica', 16, -8, {}, 'Catalog Replicas'],
      ['users-db', 'db', 8, 0, {}, 'Users DB'],
      ['orders-db', 'db', 8, 8, {}, 'Orders DB'],
      ['catalog-db', 'db', 24, -8, {}, 'Catalog DB'],
    ],
    edges: [
      ['clients', 'gw'],
      ['gw', 'search', 70],
      ['gw', 'users', 20],
      ['gw', 'checkout', 10],
      ['search', 'search-cache'],
      ['search', 'search-db'],
      ['search', 'catalog-db'],
      ['catalog-db', 'search-db'],
      ['users', 'users-db'],
      ['checkout', 'orders-db'],
      ['checkout', 'users', 100],
    ],
  },
];

export function templateList(): Array<{ id: string; label: string; blurb: string }> {
  return TEMPLATES.map(({ id, label, blurb }) => ({ id, label, blurb }));
}

export function buildTemplate(id: string): SavedState {
  const template = TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
  return designState(template.traffic, template.nodes, template.edges);
}

export function designState(traffic: TrafficSettings, nodes: Template['nodes'], edges: Template['edges']): SavedState {
  const template = { traffic, nodes, edges };
  return {
    version: 1,
    traffic: { ...template.traffic },
    design: {
      nodes: template.nodes.map(([nodeId, kind, x, z, params, name]) => ({
        id: nodeId,
        kind,
        name: name ?? defaultName(kind, nodeId),
        x: x * TEMPLATE_SPREAD,
        z: z * TEMPLATE_SPREAD,
        params: { ...defaultParams(kind), ...params },
      })),
      edges: template.edges.map(([from, to, sharePct]) => ({ id: `${from}->${to}`, from, to, ...(sharePct === undefined ? {} : { sharePct }) })),
    },
  };
}

function defaultName(kind: ComponentKind, id: string): string {
  const names: Partial<Record<ComponentKind, string>> = {
    clients: 'Clients',
    dns: 'DNS',
    cdn: 'CDN',
    lb: 'Load Balancer',
    gateway: 'API Gateway',
    app: 'App Servers',
    workers: 'Workers',
    cache: 'Redis',
    db: 'Primary DB',
    replica: 'Read Replicas',
    shard: 'Sharded DB',
    objectStorage: 'S3',
    search: 'Search',
    queue: 'Queue',
    breaker: 'Breaker',
    external: 'External API',
  };
  return names[kind] ?? id;
}
