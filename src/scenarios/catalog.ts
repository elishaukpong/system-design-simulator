import { defaultParams } from '../sim/catalog';
import type { ComponentKind, Design, NodeSpec, ParamValue } from '../sim/types';
import { buildTemplate } from '../state/templates';
import type { Scenario } from './types';

const CELL = 12;

function node(id: string, kind: ComponentKind, gx: number, gz: number, params: Record<string, ParamValue> = {}, extra: Partial<NodeSpec> = {}): NodeSpec {
  return { id, kind, name: extra.name ?? defaultName(kind), x: gx * CELL, z: gz * CELL, params: { ...defaultParams(kind), ...params }, ...extra };
}

function design(nodes: NodeSpec[], edges: Array<[string, string]> = []): Design {
  return { nodes, edges: edges.map(([from, to]) => ({ id: `${from}->${to}`, from, to })) };
}

function defaultName(kind: ComponentKind): string {
  const names: Partial<Record<ComponentKind, string>> = {
    clients: 'Clients',
    app: 'App Servers',
    db: 'Primary DB',
    external: 'External API',
  };
  return names[kind] ?? kind;
}

function clientsOnly(clients: Record<string, ParamValue>): () => Design {
  return () => design([node('clients', 'clients', -1, 0, clients)]);
}

const LAUNCH_CLIENTS = { staticPct: 30, writePct: 10, retries: 2, timeoutMs: 5000 };
const SHORTENER_CLIENTS = { staticPct: 5, writePct: 2, retries: 2, timeoutMs: 3000 };
const FLASH_CLIENTS = { staticPct: 10, writePct: 60, retries: 3, timeoutMs: 5000 };
const PAYMENT_CLIENTS = { staticPct: 0, writePct: 50, retries: 1, timeoutMs: 10000 };
const FEED_CLIENTS = { staticPct: 40, writePct: 5, retries: 2, timeoutMs: 3000 };
const ZONE_CLIENTS = { staticPct: 20, writePct: 15, retries: 2, timeoutMs: 5000 };
const STORM_CLIENTS = { staticPct: 0, writePct: 20, retries: 4, timeoutMs: 800 };
const INGEST_CLIENTS = { staticPct: 0, writePct: 98, retries: 1, timeoutMs: 2000 };
const REGION_CLIENTS = { staticPct: 20, writePct: 10, retries: 2, timeoutMs: 5000 };
const GLOBAL_CLIENTS = { staticPct: 30, writePct: 5, retries: 2, timeoutMs: 5000 };
const WRITE_CLIENTS = { staticPct: 0, writePct: 40, retries: 1, timeoutMs: 5000 };
const PAYOUT_CLIENTS = { staticPct: 0, writePct: 100, retries: 1, timeoutMs: 10000 };
const SERVICE_CLIENTS = { staticPct: 0, writePct: 10, retries: 2, timeoutMs: 3000 };
const SERVICE_APP = { searchPct: 0, externalCallPct: 0 };

function services(): Design {
  const d = design(
    [
      node('clients', 'clients', -1, 0, SERVICE_CLIENTS, { locked: true }),
      node('gw', 'gateway', 0, 0, { rateLimit: false }, { name: 'API Gateway', locked: true }),
      node('search', 'app', 1, -1, { ...SERVICE_APP, instances: 4 }, { name: 'search-svc' }),
      node('users', 'app', 1, 0, { ...SERVICE_APP, instances: 2 }, { name: 'users-svc' }),
      node('checkout', 'app', 1, 1, { ...SERVICE_APP, instances: 2 }, { name: 'checkout-svc' }),
      node('catalog-db', 'db', 2, -1, {}, { name: 'Catalog DB' }),
      node('users-db', 'db', 2, 0, {}, { name: 'Users DB' }),
      node('orders-db', 'db', 2, 1, {}, { name: 'Orders DB' }),
    ],
    [
      ['clients', 'gw'],
      ['gw', 'search'],
      ['gw', 'users'],
      ['gw', 'checkout'],
      ['search', 'users'],
      ['checkout', 'users'],
      ['search', 'catalog-db'],
      ['users', 'users-db'],
      ['checkout', 'orders-db'],
    ],
  );
  const shares: Record<string, number> = { 'gw->search': 70, 'gw->users': 20, 'gw->checkout': 10 };
  for (const edge of d.edges) {
    if (edge.id in shares) {
      edge.sharePct = shares[edge.id];
      edge.locked = true;
    }
    if (edge.id === 'clients->gw') edge.locked = true;
    if (edge.id === 'search->users') edge.sharePct = 50;
  }
  return d;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'launch-day',
    title: 'Launch day',
    difficulty: 1,
    tagline: 'Your side project hit the front page. One server will not do.',
    brief: [
      'You shipped a small Laravel app on one server and one database. It just landed on the front page of Hacker News.',
      'Traffic ramps from 50 to 1,200 requests per second over two minutes and stays there. Keep the site up and fast without spending like a bank.',
    ],
    facts: ['Read-heavy: 90% reads, 10% writes', '30% of requests are static assets (images, JS, CSS)', 'Clients retry twice and give up after 5s'],
    duration: 180,
    keyframes: [
      [0, 50],
      [30, 100],
      [120, 1200],
      [180, 1200],
    ],
    clients: LAUNCH_CLIENTS,
    start: () => {
      const d = buildTemplate('monolith').design;
      const clients = d.nodes.find((n) => n.kind === 'clients')!;
      clients.params = { ...clients.params, ...LAUNCH_CLIENTS };
      return d;
    },
    criteria: [
      { role: 'core', criterion: { type: 'availability', min: 0.99 } },
      { role: 'core', criterion: { type: 'p99', maxMs: 500, withinPct: 0.95 } },
      { role: 'budget', criterion: { type: 'cost', max: 700 } },
      { role: 'bonus', criterion: { type: 'availability', min: 0.999 } },
    ],
    chaos: [],
    hints: [
      'The app server is the first wall. Each small instance handles about 150 requests per second.',
      'One server behind nothing has no plan B. A load balancer lets you run several, and route around the ones that die.',
      'Once the app holds, watch the database. Searches without an index are four times the work.',
    ],
    curriculum: ['Day 7 · Single-machine limits', 'Day 18 · CDNs & edge caching', 'Day 35 · Load balancing', 'Day 38 · Horizontal scaling'],
  },
  {
    id: 'url-shortener',
    title: 'URL shortener',
    difficulty: 2,
    tagline: '10k redirects a second, 2% writes, and a deploy that wipes Redis.',
    brief: [
      'Design the redirect path of a URL shortener. Almost everything is a read: someone clicks a short link and gets redirected.',
      'Peak is 10,000 requests per second. At t=100s a bad deploy flushes the cache. Your database must survive the stampede.',
    ],
    facts: ['98% reads, 2% writes (new links)', '5% static', 'p99 matters: a slow redirect is a lost click', 'Clients give up after 3s'],
    duration: 180,
    keyframes: [
      [0, 2000],
      [60, 10000],
      [130, 10000],
      [180, 4000],
    ],
    clients: SHORTENER_CLIENTS,
    lockedParams: { app: { searchPct: 0, externalCallPct: 0 } },
    start: clientsOnly(SHORTENER_CLIENTS),
    criteria: [
      { role: 'core', criterion: { type: 'availability', min: 0.995 } },
      { role: 'core', criterion: { type: 'p99', maxMs: 300, withinPct: 0.95 } },
      { role: 'budget', criterion: { type: 'cost', max: 6500 } },
      { role: 'bonus', criterion: { type: 'chaosAvailability', min: 0.99, from: 100, to: 140 } },
    ],
    chaos: [{ at: 100, action: 'flush', target: 'cache', message: 'A deploy flushed the cache.' }],
    hints: [
      'Redirects are the same answer every time. Cache them, and consider caching them at the edge.',
      'When the cache flushes, every read goes to the database at once. Replicas give that stampede somewhere to land.',
      'Every redirect is the same answer for everyone. The edge can serve a share of them before they reach you.',
    ],
    curriculum: ['Day 15 · Cache strategies', 'Day 16 · Cache invalidation', 'Day 12 · Replication', 'Day 53 · URL shortener'],
  },
  {
    id: 'payments',
    title: 'Checkout with a flaky provider',
    difficulty: 2,
    tagline: 'Every order calls a payment provider. At t=60s it starts timing out.',
    brief: [
      'Half of your traffic is checkouts, and every checkout calls an external payment provider. You do not control it.',
      'At t=60s the provider degrades for 45 seconds: 70% of calls fail and the rest take 4 seconds. The rest of your site must not go down with it.',
    ],
    facts: ['300 rps steady, 50% checkouts', 'Provider: 300ms, rate limit 500 rps, 1% baseline failures', 'Every write calls the provider (locked)', 'Clients retry once, 10s timeout'],
    duration: 150,
    keyframes: [
      [0, 300],
      [150, 300],
    ],
    clients: PAYMENT_CLIENTS,
    lockedParams: { app: { externalCallPct: 100, searchPct: 0 }, workers: { externalCallPct: 100 } },
    start: () =>
      design(
        [
          node('clients', 'clients', -1, 0, PAYMENT_CLIENTS),
          node('app', 'app', 0, 0, { instances: 4, externalCallPct: 100, searchPct: 0 }),
          node('db', 'db', 1, -1),
          node('provider', 'external', 1, 1, { rateLimitRps: 500, latencyMs: 300, failurePct: 1 }, { name: 'Payment provider', locked: true }),
        ],
        [
          ['clients', 'app'],
          ['app', 'db'],
          ['app', 'provider'],
        ],
      ),
    criteria: [
      { role: 'core', criterion: { type: 'availability', min: 0.95 } },
      { role: 'core', criterion: { type: 'p99', maxMs: 1500, withinPct: 0.9 } },
      { role: 'budget', criterion: { type: 'cost', max: 900 } },
      { role: 'bonus', criterion: { type: 'chaosAvailability', min: 0.9, from: 60, to: 105 } },
    ],
    chaos: [
      {
        at: 60,
        action: 'degrade',
        target: 'external',
        seconds: 45,
        params: { failurePct: 70, latencyMs: 4000 },
        message: 'The payment provider is degraded: 70% failures, 4s latency.',
      },
    ],
    hints: [
      'A slow call holds an app worker for its whole duration. Watch the worker pool, not the CPU.',
      'Does the user need the payment confirmed before you answer? Or only accepted?',
      'A circuit breaker stops you calling something that is already on fire.',
    ],
    curriculum: ['Day 21 · Sync vs async', 'Day 24 · Queues', 'Day 30 · Circuit breaker', 'Day 34 · Graceful degradation', 'Day 55 · Payments'],
  },
  {
    id: 'news-feed',
    title: 'News feed at peak',
    difficulty: 2,
    tagline: 'Evening peak, 9k rps of timelines, and the cache node dies mid-peak.',
    brief: [
      'Serve the home timeline. Reads dominate, 15% of reads are searches, and 40% of requests are images.',
      'Traffic climbs to 9,000 rps for the evening peak. At t=80s your cache node dies for 30 seconds.',
    ],
    facts: ['95% of dynamic requests are reads', '15% of reads are searches (locked)', '40% static', 'Replicas may lag at most 2s'],
    duration: 180,
    keyframes: [
      [0, 1500],
      [60, 9000],
      [120, 9000],
      [180, 2000],
    ],
    clients: FEED_CLIENTS,
    lockedParams: { app: { searchPct: 15, externalCallPct: 0 } },
    start: clientsOnly(FEED_CLIENTS),
    criteria: [
      { role: 'core', criterion: { type: 'availability', min: 0.995 } },
      { role: 'core', criterion: { type: 'p99', maxMs: 500, withinPct: 0.95 } },
      { role: 'budget', criterion: { type: 'cost', max: 5500 } },
      { role: 'bonus', criterion: { type: 'replicationLag', maxS: 2 } },
      { role: 'bonus', criterion: { type: 'chaosAvailability', min: 0.98, from: 80, to: 120 } },
    ],
    chaos: [{ at: 80, action: 'kill', target: 'cache', fraction: 0.34, seconds: 30, message: 'A cache node died. With one node, that is the whole cache.' }],
    hints: [
      'Searches on the primary database cost four normal queries each. A search index takes them off.',
      'One cache node is one point of failure. What happens to the database the second it goes?',
      'Images belong on a CDN in front of object storage, not on your app servers.',
    ],
    curriculum: ['Day 15 · Cache strategies', 'Day 20 · Search', 'Day 41 · Read-heavy vs write-heavy', 'Day 57 · Feed / timeline'],
  },
  {
    id: 'zone-outage',
    title: 'Zone outage',
    difficulty: 2,
    tagline: 'At t=60s an availability zone goes dark. Half your fleet, gone for a minute.',
    brief: [
      'A steady 3,000 rps of mixed traffic. At t=60s one availability zone fails, and half of every app and worker fleet is gone for 60 seconds.',
      'Design with enough headroom, and enough sense in the routing, that users barely notice.',
    ],
    facts: ['3,000 rps steady', '15% writes, 20% static', 'Half of every App Servers and Workers fleet dies at t=60s for 60s'],
    duration: 180,
    keyframes: [
      [0, 3000],
      [180, 3000],
    ],
    clients: ZONE_CLIENTS,
    lockedParams: { app: { externalCallPct: 0 } },
    start: clientsOnly(ZONE_CLIENTS),
    criteria: [
      { role: 'core', criterion: { type: 'availability', min: 0.99 } },
      { role: 'core', criterion: { type: 'p99', maxMs: 500, withinPct: 0.95 } },
      { role: 'budget', criterion: { type: 'cost', max: 3000 } },
      { role: 'bonus', criterion: { type: 'chaosAvailability', min: 0.99, from: 60, to: 120 } },
    ],
    chaos: [
      { at: 60, action: 'kill', target: 'app', fraction: 0.5, seconds: 60, message: 'Zone A is down: half the app fleet is gone.' },
      { at: 60, action: 'kill', target: 'workers', fraction: 0.5, seconds: 60, message: 'Zone A is down: half the workers are gone.' },
    ],
    hints: [
      'Losing half the fleet doubles the load on the other half. Run at 50% or less before the outage, or be ready to scale.',
      'Without health checks a load balancer keeps sending traffic to the dead half.',
      'Autoscaling helps, but new instances take 30 seconds to boot.',
    ],
    curriculum: ['Day 33 · Health checks', 'Day 35 · Load balancing', 'Day 38 · Horizontal scaling', 'Day 39 · Auto-scaling'],
  },
  {
    id: 'flash-sale',
    title: 'Flash-sale ticketing',
    difficulty: 3,
    tagline: 'Two 15-second stampedes to 8k rps, mostly writes, all for the same event.',
    brief: [
      'Tickets for one huge event go on sale. Baseline is 500 rps. At t=45s and t=120s the crowd hits for 15 seconds at 8,000 rps, 60% of it orders.',
      'Every order is for the same event, so in a sharded database they all land on the same shard (locked at 40% of traffic). You may turn some users away, but nothing you accept may be lost or slow.',
    ],
    facts: ['60% writes, 10% static', 'Hot key: 40% of sharded traffic lands on one shard (locked)', 'Clients retry 3 times', 'Shedding with 429s is allowed, within limits'],
    duration: 180,
    keyframes: [
      [0, 500],
      [180, 500],
    ],
    spikes: [
      { at: 45, length: 15, multiplier: 16 },
      { at: 120, length: 15, multiplier: 16 },
    ],
    clients: FLASH_CLIENTS,
    lockedParams: { shard: { hotKeyPct: 40 }, app: { searchPct: 0, externalCallPct: 0 }, workers: { externalCallPct: 0 } },
    start: clientsOnly(FLASH_CLIENTS),
    criteria: [
      { role: 'core', criterion: { type: 'availability', min: 0.9 } },
      { role: 'core', criterion: { type: 'p99', maxMs: 1000, withinPct: 0.9 } },
      { role: 'budget', criterion: { type: 'cost', max: 17500 } },
      { role: 'bonus', criterion: { type: 'queueLag', maxS: 60 } },
      { role: 'bonus', criterion: { type: 'shed', maxPct: 10 } },
    ],
    chaos: [],
    hints: [
      'You cannot provision for 16× forever. A queue turns a 15-second stampede into a backlog you drain at your own pace.',
      'Adding shards does not help the hot one. Find a way to send less to it.',
      'Retries during a stampede multiply it. A rate limit at the front door keeps the rest alive.',
    ],
    curriculum: ['Day 13 · Sharding', 'Day 24 · Queues', 'Day 36 · Rate limiting', 'Day 37 · Backpressure'],
  },
  {
    id: 'retry-storm',
    title: 'Stop the retry storm',
    difficulty: 3,
    tagline: 'Aggressive clients, short timeouts. One wobble and they attack you.',
    brief: [
      'You inherit this system. The mobile clients retry four times with an 800ms timeout, and you cannot ship a client fix this week.',
      'Two traffic surges at t=40s and t=100s tip the database over, the retries multiply the load, and it never recovers. Make it recover.',
    ],
    facts: ['Clients: 4 retries, 800ms timeout (locked)', '20% writes, 10% searches', 'Base 400 rps, 3× surges for 15s'],
    duration: 160,
    keyframes: [
      [0, 400],
      [160, 400],
    ],
    spikes: [
      { at: 40, length: 15, multiplier: 3 },
      { at: 100, length: 15, multiplier: 3 },
    ],
    clients: STORM_CLIENTS,
    lockedParams: { app: { searchPct: 10, externalCallPct: 0 } },
    start: () => {
      const d = buildTemplate('retry-storm').design;
      const clients = d.nodes.find((n) => n.kind === 'clients')!;
      clients.params = { ...clients.params, ...STORM_CLIENTS };
      return d;
    },
    criteria: [
      { role: 'core', criterion: { type: 'availability', min: 0.97 } },
      { role: 'core', criterion: { type: 'p99', maxMs: 800, withinPct: 0.9 } },
      { role: 'budget', criterion: { type: 'cost', max: 2700 } },
      { role: 'bonus', criterion: { type: 'retryAmplification', max: 1.3 } },
    ],
    chaos: [],
    hints: [
      'Every failed request comes back up to four more times. Failing less is worth more than anything else here.',
      'A rate limiter turns an overload into fast, cheap 429s instead of slow timeouts.',
      'What is actually slow? Look at what the database spends its time on.',
    ],
    curriculum: ['Day 28 · Failure modes', 'Day 29 · Retries', 'Day 32 · Timeouts & deadlines', 'Day 36 · Rate limiting'],
  },
  {
    id: 'telemetry-ingest',
    title: 'Telemetry ingest',
    difficulty: 3,
    tagline: '20k writes a second from devices. No reads. Do not drop anything.',
    brief: [
      'Devices report telemetry continuously. It ramps to 20,000 requests per second, 98% writes. Nobody reads it in real time.',
      'Acknowledge fast, never lose a reading, and keep processing no more than 30 seconds behind.',
    ],
    facts: ['98% writes', 'Ramps to 20k rps by t=60s', 'Clients retry once, 2s timeout', 'Processing may lag, but not by more than 30s'],
    duration: 150,
    keyframes: [
      [0, 2000],
      [60, 20000],
      [150, 20000],
    ],
    clients: INGEST_CLIENTS,
    lockedParams: { app: { searchPct: 0, externalCallPct: 0 }, workers: { externalCallPct: 0 } },
    start: clientsOnly(INGEST_CLIENTS),
    criteria: [
      { role: 'core', criterion: { type: 'availability', min: 0.999 } },
      { role: 'core', criterion: { type: 'p99', maxMs: 300, withinPct: 0.95 } },
      { role: 'budget', criterion: { type: 'cost', max: 30000 } },
      { role: 'bonus', criterion: { type: 'queueLag', maxS: 30 } },
    ],
    chaos: [],
    hints: [
      'A single primary database tops out around 1,000 writes per second at medium size. You need 20.',
      'Acknowledge on enqueue, write later. Then make the writing side keep up.',
      'Writes scale out by key. How many shards does 20k need?',
    ],
    curriculum: ['Day 13 · Sharding', 'Day 24 · Queues', 'Day 40 · Job & worker architectures', 'Day 41 · Read-heavy vs write-heavy'],
  },
  {
    id: 'region-outage',
    title: 'Region outage',
    difficulty: 3,
    tagline: 'us-east goes dark for 90 seconds. Your users are on two continents.',
    brief: [
      'Everything runs in us-east: 60% of your users are in the US, 40% in Europe. At t=60s the whole region goes down for 90 seconds. Every component on that plate dies with it.',
      'Keep serving. Users route to the nearest healthy region, so give them one. The database is the hard part.',
    ],
    facts: ['2,000 rps steady', 'US users 60%, EU users 40% (locked)', '10% writes, 20% static', 'us-east is down from t=60s to t=150s'],
    duration: 180,
    keyframes: [
      [0, 2000],
      [180, 2000],
    ],
    clients: REGION_CLIENTS,
    lockedParams: { app: { searchPct: 0, externalCallPct: 0 } },
    start: () =>
      design(
        [
          node('us-users', 'clients', -1, 0, { ...REGION_CLIENTS, sharePct: 60 }, { name: 'US users', locked: true }),
          node('eu-users', 'clients', -1, 8, { ...REGION_CLIENTS, sharePct: 40 }, { name: 'EU users', locked: true }),
          node('lb-us', 'lb', 0, 0, {}, { name: 'LB us-east' }),
          node('app-us', 'app', 1, 0, { instances: 12, searchPct: 0, externalCallPct: 0 }, { name: 'App us-east' }),
          node('db', 'db', 2, 0),
        ],
        [
          ['us-users', 'lb-us'],
          ['eu-users', 'lb-us'],
          ['lb-us', 'app-us'],
          ['app-us', 'db'],
        ],
      ),
    criteria: [
      { role: 'core', criterion: { type: 'availability', min: 0.98 } },
      { role: 'core', criterion: { type: 'p99', maxMs: 800, withinPct: 0.9 } },
      { role: 'budget', criterion: { type: 'cost', max: 2200 } },
      { role: 'bonus', criterion: { type: 'chaosAvailability', min: 0.97, from: 60, to: 150 } },
    ],
    chaos: [{ at: 60, action: 'region', region: 'us-east', seconds: 90, message: 'us-east is down.' }],
    hints: [
      'Users go to the nearest healthy entry point. Put a load balancer and an app fleet in eu-west, and connect both user groups to both.',
      'The surviving region takes all the traffic. Size it for 100%, not 40%.',
      'A database dies with its region unless it has a standby elsewhere. Failover time is downtime for every write.',
    ],
    curriculum: ['Day 28 · Failure modes', 'Day 33 · Health checks', 'Day 42 · CAP, PACELC', 'Day 12 · Replication'],
  },
  {
    id: 'global-reads',
    title: 'Global read-heavy app',
    difficulty: 2,
    tagline: 'Users on three continents, everything in Virginia. The speed of light disagrees.',
    brief: [
      'A content site with readers in the US, Europe and India. 95% of requests are reads. Everything is deployed in us-east today.',
      'A reader in Mumbai pays 200ms of round trip before your code runs. Get the median request under 120ms for everyone, without doubling the bill three times over.',
    ],
    facts: ['4,000 rps peak, daily wave', 'Users: US 40%, EU 35%, India 25% (locked)', '95% reads, 30% static', 'Round trip: us↔eu 75ms, us↔ap 200ms, eu↔ap 120ms'],
    duration: 180,
    keyframes: [
      [0, 1500],
      [60, 4000],
      [120, 4000],
      [180, 2000],
    ],
    clients: GLOBAL_CLIENTS,
    lockedParams: { app: { searchPct: 0, externalCallPct: 0 } },
    start: () =>
      design(
        [
          node('us-users', 'clients', -1, 0, { ...GLOBAL_CLIENTS, sharePct: 40 }, { name: 'US readers', locked: true }),
          node('eu-users', 'clients', -1, 8, { ...GLOBAL_CLIENTS, sharePct: 35 }, { name: 'EU readers', locked: true }),
          node('ap-users', 'clients', -1, -8, { ...GLOBAL_CLIENTS, sharePct: 25 }, { name: 'India readers', locked: true }),
          node('lb-us', 'lb', 0, 0, {}, { name: 'LB us-east' }),
          node('app-us', 'app', 1, 0, { instances: 24, searchPct: 0, externalCallPct: 0 }, { name: 'App us-east' }),
          node('db', 'db', 2, 0),
        ],
        [
          ['us-users', 'lb-us'],
          ['eu-users', 'lb-us'],
          ['ap-users', 'lb-us'],
          ['lb-us', 'app-us'],
          ['app-us', 'db'],
        ],
      ),
    criteria: [
      { role: 'core', criterion: { type: 'availability', min: 0.995 } },
      { role: 'core', criterion: { type: 'p50', maxMs: 120, withinPct: 0.95 } },
      { role: 'budget', criterion: { type: 'cost', max: 3200 } },
      { role: 'bonus', criterion: { type: 'p99', maxMs: 400, withinPct: 0.9 } },
    ],
    chaos: [],
    hints: [
      'A third of the traffic is static. A CDN answers from a PoP near the user, wherever your servers are.',
      'Reads can be served where the reader is. Put an app fleet and a read replica in each region.',
      'Writes still go to the one primary. That is fine at 5%. It would not be at 50%.',
    ],
    curriculum: ['Day 4 · The network stack', 'Day 12 · Replication', 'Day 18 · CDNs & edge caching', 'Day 43 · Consistency models'],
  },
  {
    id: 'cross-region-writes',
    title: 'Cross-region writes',
    difficulty: 3,
    tagline: 'Half your users are an ocean from the primary, and 40% of what they do is write.',
    brief: [
      'A messaging app with users split between the US and Europe. 40% of requests send a message. The primary database is in us-east and stays there: one leader, no multi-master.',
      'A European write pays 75ms of round trip to the primary before it can be acknowledged. Get p99 under 110ms for everyone.',
    ],
    facts: ['2,000 rps steady', 'US 50%, EU 50% (locked)', '40% writes, no static', 'The primary stays in us-east'],
    duration: 150,
    keyframes: [
      [0, 2000],
      [150, 2000],
    ],
    clients: WRITE_CLIENTS,
    lockedParams: { app: { searchPct: 0, externalCallPct: 0 }, workers: { externalCallPct: 0 } },
    start: () =>
      design(
        [
          node('us-users', 'clients', -1, 0, { ...WRITE_CLIENTS, sharePct: 50 }, { name: 'US users', locked: true }),
          node('eu-users', 'clients', -1, 8, { ...WRITE_CLIENTS, sharePct: 50 }, { name: 'EU users', locked: true }),
          node('lb-us', 'lb', 0, 0, {}, { name: 'LB us-east' }),
          node('app-us', 'app', 1, 0, { instances: 20, searchPct: 0, externalCallPct: 0 }, { name: 'App us-east' }),
          node('db', 'db', 2, 0, { size: 'large' }, { name: 'Primary DB', locked: true }),
        ],
        [
          ['us-users', 'lb-us'],
          ['eu-users', 'lb-us'],
          ['lb-us', 'app-us'],
          ['app-us', 'db'],
        ],
      ),
    criteria: [
      { role: 'core', criterion: { type: 'availability', min: 0.995 } },
      { role: 'core', criterion: { type: 'p99', maxMs: 110, withinPct: 0.95 } },
      { role: 'budget', criterion: { type: 'cost', max: 2600 } },
      { role: 'bonus', criterion: { type: 'queueLag', maxS: 10 } },
    ],
    chaos: [],
    hints: [
      'An app fleet in eu-west gets European users off the ocean for reads. Writes are the problem.',
      'Does a sent message have to be in the primary before you say "sent"? Or only somewhere durable nearby?',
      'A queue in eu-west acknowledges locally. Workers near the primary drain it. You have just chosen eventual consistency.',
    ],
    curriculum: ['Day 21 · Sync vs async', 'Day 42 · CAP, PACELC', 'Day 43 · Consistency models', 'Day 48 · Event-driven architecture'],
  },
  {
    id: 'payouts',
    title: 'Payouts, exactly once',
    difficulty: 2,
    tagline: 'The bank API is down for a minute. Lose nothing, and pay nobody twice.',
    brief: [
      'Sellers request payouts. Each one is a call to the bank API, which you do not control. At t=40s the bank fails every call for 60 seconds.',
      'Accept every request, lose none of them, and do not pay anyone twice when you retry.',
    ],
    facts: ['200 rps steady, all writes', 'Bank: 400ms, rate limit 300 rps, 2% baseline failures', 'Workers call the bank for every job (locked)', 'Bank fails 100% from t=40s to t=100s'],
    duration: 180,
    keyframes: [
      [0, 200],
      [180, 200],
    ],
    clients: PAYOUT_CLIENTS,
    lockedParams: { app: { externalCallPct: 100, searchPct: 0 }, workers: { externalCallPct: 100 } },
    start: () =>
      design(
        [
          node('clients', 'clients', -1, 0, PAYOUT_CLIENTS, { name: 'Sellers' }),
          node('app', 'app', 0, 0, { instances: 4, externalCallPct: 100, searchPct: 0 }),
          node('db', 'db', 1, -1),
          node('bank', 'external', 1, 1, { rateLimitRps: 300, latencyMs: 400, failurePct: 2 }, { name: 'Bank API', locked: true }),
        ],
        [
          ['clients', 'app'],
          ['app', 'db'],
          ['app', 'bank'],
        ],
      ),
    criteria: [
      { role: 'core', criterion: { type: 'availability', min: 0.99 } },
      { role: 'core', criterion: { type: 'dataLoss', max: 0 } },
      { role: 'budget', criterion: { type: 'cost', max: 950 } },
      { role: 'bonus', criterion: { type: 'duplicates', max: 0 } },
      { role: 'bonus', criterion: { type: 'deadLettered', max: 0 } },
    ],
    chaos: [
      { at: 40, action: 'degrade', target: 'external', seconds: 60, params: { failurePct: 100 }, message: 'The bank API is failing every call.' },
    ],
    hints: [
      'Accepting a payout and making it are two different things. A queue separates them.',
      'A retry only helps if it happens after the bank is back. Visibility timeout × max receives is how long a job keeps trying.',
      'If the bank charged but the reply was lost, a retry pays twice. Mark the workers idempotent (an idempotency key per payout).',
    ],
    curriculum: ['Day 6 · Idempotency', 'Day 24 · Queues', 'Day 29 · Retries', 'Day 45 · Idempotency keys'],
  },
  {
    id: 'service-fan-in',
    title: 'The 20% service',
    difficulty: 2,
    tagline: 'users-svc gets 20% of the traffic. So why is it the first thing to melt?',
    brief: [
      'Three services behind one gateway: search takes 70% of requests, users 20%, checkout 10%. Traffic climbs to 3,000 rps.',
      'But services call each other. Half of all searches call users-svc to personalise results, and every checkout calls it to load the buyer. At t=100s a bad deploy takes out half of users-svc for 40 seconds.',
      'Keep every path up, and do not pay to scale what does not need it.',
    ],
    facts: [
      '1,500 rps rising to 3,000 by t=60s, 10% writes',
      'Gateway paths: search 70%, users 20%, checkout 10% (locked)',
      'search calls users on 50% of requests, checkout on 100%. You can route these calls, not drop them',
      'Half of users-svc dies at t=100s for 40s',
      'The gateway health-checks its services. A direct service-to-service call does not.',
    ],
    duration: 180,
    keyframes: [
      [0, 1500],
      [60, 3000],
      [180, 3000],
    ],
    clients: SERVICE_CLIENTS,
    lockedParams: { app: SERVICE_APP },
    start: services,
    calls: [
      { from: 'search', to: 'users', pct: 50 },
      { from: 'checkout', to: 'users', pct: 100 },
    ],
    criteria: [
      { role: 'core', criterion: { type: 'availability', min: 0.99 } },
      { role: 'core', criterion: { type: 'p99', maxMs: 400, withinPct: 0.95 } },
      { role: 'budget', criterion: { type: 'cost', max: 10800 } },
      { role: 'bonus', criterion: { type: 'chaosAvailability', min: 0.98, from: 100, to: 140 } },
    ],
    chaos: [{ at: 100, action: 'kill', target: 'app', node: 'users', fraction: 0.5, seconds: 40, message: 'A bad deploy: half of users-svc is down.' }],
    hints: [
      'Count the real load on users-svc: its own 20%, plus half of search, plus all of checkout.',
      'A service that everyone calls is a single point of failure for everyone. When it slows down, its callers wait, and their worker pools fill up too.',
      'Scale each service to its own load. Scaling all three the same is the expensive way to pass.',
      'search and checkout call users-svc directly, so they keep calling the dead half. A load balancer in front of a shared service routes around it.',
    ],
    curriculum: ['Day 28 · Failure modes', 'Day 31 · Bulkhead', 'Day 38 · Horizontal scaling', 'Day 47 · Monolith → microservices'],
  },

];

export function enforceScenario(scenario: Scenario, d: Design): Design {
  const ids = new Set(d.nodes.map((n) => n.id));
  const lockedEdges = scenario.start().edges.filter((e) => e.locked && ids.has(e.from) && ids.has(e.to));
  const lockedIds = new Set(lockedEdges.map((e) => e.id));
  const edges = [...d.edges.filter((e) => !lockedIds.has(e.id)).map((e) => ({ ...e })), ...lockedEdges];
  for (const call of scenario.calls ?? []) {
    if (!ids.has(call.from) || !ids.has(call.to)) continue;
    const hop = edges.find((e) => e.from === call.from && reaches(edges, d, e.to, call.to));
    if (hop) hop.sharePct = call.pct;
    else edges.push({ id: `${call.from}->${call.to}`, from: call.from, to: call.to, sharePct: call.pct });
  }
  return {
    edges,
    nodes: d.nodes.map((n) => {
      const locked = n.kind === 'clients' ? scenario.clients : scenario.lockedParams?.[n.kind];
      return locked ? { ...n, params: { ...n.params, ...locked } } : { ...n, params: { ...n.params } };
    }),
  };
}

function reaches(edges: Design['edges'], d: Design, from: string, target: string, depth = 0): boolean {
  if (from === target) return true;
  const kind = d.nodes.find((n) => n.id === from)?.kind;
  if (depth > 4 || (kind !== 'lb' && kind !== 'breaker')) return false;
  return edges.some((e) => e.from === from && reaches(edges, d, e.to, target, depth + 1));
}

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export function scenarioTraffic(scenario: Scenario): (t: number) => number {
  return (t: number) => {
    const frames = scenario.keyframes;
    let rps = frames[frames.length - 1][1];
    for (let i = 0; i < frames.length - 1; i++) {
      const [t0, r0] = frames[i];
      const [t1, r1] = frames[i + 1];
      if (t >= t0 && t <= t1) {
        rps = r0 + ((r1 - r0) * (t - t0)) / Math.max(1e-9, t1 - t0);
        break;
      }
    }
    for (const spike of scenario.spikes ?? []) {
      if (t >= spike.at && t < spike.at + spike.length) rps *= spike.multiplier;
    }
    return rps;
  };
}

export function peakRps(scenario: Scenario): number {
  const traffic = scenarioTraffic(scenario);
  let peak = 0;
  for (let t = 0; t <= scenario.duration; t += 1) peak = Math.max(peak, traffic(t));
  return peak;
}
