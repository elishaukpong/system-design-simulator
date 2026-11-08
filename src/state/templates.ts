import { defaultParams } from '../sim/catalog';
import type { ComponentKind, ParamValue, TrafficSettings } from '../sim/types';
import type { SavedState } from './store';

interface Template {
  id: string;
  label: string;
  blurb: string;
  traffic: TrafficSettings;
  nodes: Array<[id: string, kind: ComponentKind, x: number, z: number, params?: Record<string, ParamValue>, name?: string]>;
  edges: Array<[string, string]>;
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
      ['app', 'app', 8, 0, { instances: 6 }],
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
      ['app', 'app', 8, 0, { instances: 8, externalCallPct: 0 }],
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
];

export function templateList(): Array<{ id: string; label: string; blurb: string }> {
  return TEMPLATES.map(({ id, label, blurb }) => ({ id, label, blurb }));
}

export function buildTemplate(id: string): SavedState {
  const template = TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
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
      edges: template.edges.map(([from, to]) => ({ id: `${from}->${to}`, from, to })),
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
