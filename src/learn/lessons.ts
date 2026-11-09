import { sizeMultiplier } from '../sim/catalog';
import type { ComponentKind, NodeMetrics } from '../sim/types';
import { buildTemplate, designState } from '../state/templates';
import type { Check, LearnContext, Lesson } from './types';

const nodesOf = (ctx: LearnContext, kind: ComponentKind) => ctx.design.nodes.filter((n) => n.kind === kind);
const metricsOf = (ctx: LearnContext, kind: ComponentKind): NodeMetrics[] =>
  nodesOf(ctx, kind)
    .map((n) => ctx.snap?.nodes[n.id])
    .filter((m): m is NodeMetrics => !!m);
const linked = (ctx: LearnContext, from: ComponentKind, to: ComponentKind) =>
  ctx.design.edges.some((e) => {
    const a = ctx.design.nodes.find((n) => n.id === e.from);
    const b = ctx.design.nodes.find((n) => n.id === e.to);
    return a?.kind === from && b?.kind === to;
  });
const running = (ctx: LearnContext) => !!ctx.snap && ctx.snap.global.offeredRps > 0;
const errorsBelow = (pct: number, holdS = 15): Check => ({
  label: `Errors under ${pct}%`,
  holdS,
  test: (ctx) => running(ctx) && ctx.snap!.global.errorRate < pct / 100,
});
const p99Below = (ms: number, holdS = 15): Check => ({
  label: `p99 under ${ms} ms`,
  holdS,
  test: (ctx) => running(ctx) && ctx.snap!.global.p99 < ms / 1000,
});
const trafficAtLeast = (rps: number): Check => ({
  label: `Traffic at ${rps.toLocaleString()} rps or more`,
  test: (ctx) => ctx.traffic.peakRps >= rps,
});
const eventSays = (ctx: LearnContext, text: string) => ctx.events.some((e) => e.message.includes(text));

export const LESSONS: Lesson[] = [
  {
    id: 'four-dials',
    days: [2],
    topic: 'Foundations',
    title: 'The four dials',
    essence: 'Every system is judged on four numbers: latency, throughput, availability and durability. Everything else is how you move them.',
    steps: [
      {
        title: 'Four numbers',
        body: `<p>Users never see your architecture. They feel four things:</p>
          <ul><li><strong>Latency:</strong> how long a request takes.</li><li><strong>Throughput:</strong> how many requests you serve per second.</li><li><strong>Availability:</strong> how many of them succeed.</li><li><strong>Durability:</strong> whether data you accepted is still there later.</li></ul>
          <p>The strip at the bottom shows the first three live, plus cost. This is one server and one database at 50 rps. All calm.</p>`,
        setup: () => ({ ...buildTemplate('monolith'), traffic: { peakRps: 50, shape: 'steady' } }),
        run: true,
        focus: { element: '#metrics' },
      },
      {
        title: 'Turn up throughput',
        body: `<p>Push the traffic dial to <strong>150 rps</strong> or more, or type it into the box.</p><p>Watch <strong>SERVED OK</strong> follow you up.</p>`,
        focus: { element: '.traffic' },
        task: trafficAtLeast(150),
      },
      {
        title: 'Latency moves first',
        body: `<p>Keep pushing. Before anything fails, requests start <strong>waiting</strong>. The server is busy, so new requests queue behind the old ones.</p><p>p50 is the typical request. p99 is the slowest 1%. p99 always goes first.</p><p>Push until p99 is over <strong>300 ms</strong>.</p>`,
        focus: { element: '#metrics' },
        task: { label: 'p99 over 300 ms', test: (ctx) => running(ctx) && ctx.snap!.global.p99 > 0.3 },
      },
      {
        title: 'Then availability',
        body: `<p>Push further. The queue fills, requests time out, and the server starts to crash. <strong>ERRORS</strong> climbs.</p><p>Read the order you saw: throughput flattens, latency climbs, then availability drops. That order is the same in every system.</p>`,
        task: { label: 'Errors over 5%', test: (ctx) => running(ctx) && ctx.snap!.global.errorRate > 0.05 },
      },
      {
        title: 'The dial nobody quotes',
        body: `<p>Every fix you make moves <strong>COST</strong>. A design is not good because it holds. It is good because it holds at a price that makes sense.</p><p>Durability shows up later, with queues: work you accepted and then lost.</p>`,
        focus: { element: '#metrics' },
      },
    ],
    exercises: [
      {
        id: 'four-dials-300',
        title: '300 rps, calmly',
        brief: ['The same monolith now gets 300 rps and falls over.', 'Make it hold with errors under 1% and p99 under 300 ms. Spend as little as you can.'],
        start: () => ({ ...buildTemplate('monolith'), traffic: { peakRps: 300, shape: 'steady' } }),
        checks: [errorsBelow(1), p99Below(300)],
      },
    ],
  },
  {
    id: 'single-machine',
    days: [7],
    topic: 'Foundations',
    title: 'One machine, one ceiling',
    essence: 'Vertical scaling buys a bigger box. It is the simplest fix you have, and it has a hard ceiling and a single point of failure.',
    steps: [
      {
        title: 'One box at its limit',
        body: `<p>One small app server at 300 rps. It is red, and <strong>Binding pressure</strong> on the right names its CPU as the wall.</p><p>Click the app server to see its numbers.</p>`,
        setup: () => ({ ...buildTemplate('monolith'), traffic: { peakRps: 300, shape: 'steady' } }),
        run: true,
        focus: { node: 'app' },
      },
      {
        title: 'Scale up',
        body: `<p>In the inspector, change <strong>Instance size</strong> to <strong>large</strong> or bigger. Each step doubles the capacity and doubles the price.</p><p>No code changes, no new moving parts. That is why vertical scaling is always the first move.</p>`,
        focus: { node: 'app', tab: 'settings' },
        task: { label: 'App size large or bigger', test: (ctx) => nodesOf(ctx, 'app').some((n) => sizeMultiplier(n.params) >= 4) },
      },
      {
        title: 'The ceiling',
        body: `<p>Now push traffic to <strong>2,000 rps</strong>. Even the biggest size runs out. There is no size after xlarge.</p>`,
        focus: { element: '.traffic' },
        task: trafficAtLeast(2000),
      },
      {
        title: 'And it is one box',
        body: `<p>Bring the traffic back down, then click the app server and press <strong>Kill</strong>.</p><p>Everything fails, however big the box was. One machine is one point of failure.</p>`,
        focus: { node: 'app' },
        task: { label: 'Kill the app server', test: (ctx) => metricsOf(ctx, 'app').some((m) => m.status === 'down') },
      },
    ],
    exercises: [
      {
        id: 'single-machine-1000',
        title: 'The biggest single box',
        brief: ['1,000 rps on exactly one app server instance.', 'Make it hold with errors under 1%. Then note what it costs.'],
        start: () => ({ ...buildTemplate('monolith'), traffic: { peakRps: 1000, shape: 'steady' } }),
        checks: [
          { label: 'Exactly one app instance', test: (ctx) => nodesOf(ctx, 'app').length === 1 && nodesOf(ctx, 'app').every((n) => n.params.instances === 1 && !n.params.autoscale) },
          errorsBelow(1),
        ],
      },
    ],
  },
  {
    id: 'scale-out',
    days: [35, 38],
    topic: 'Scale',
    title: 'Scale out behind a load balancer',
    essence: 'Horizontal scaling adds more boxes instead of bigger ones. It removes the ceiling and the single point of failure, and it moves the wall to the database.',
    steps: [
      {
        title: 'Two groups behind a load balancer',
        body: `<p>Two groups of app servers, three instances each, behind a load balancer. 600 rps.</p><p>The load balancer splits traffic evenly. Neither group is the only one.</p>`,
        setup: () =>
          designState({ peakRps: 600, shape: 'steady' }, [
            ['clients', 'clients', -16, 0],
            ['lb', 'lb', -8, 0],
            ['app-a', 'app', 0, -5, { instances: 3 }, 'App group A'],
            ['app-b', 'app', 0, 5, { instances: 3 }, 'App group B'],
            ['db', 'db', 8, 0],
          ], [
            ['clients', 'lb'],
            ['lb', 'app-a'],
            ['lb', 'app-b'],
            ['app-a', 'db'],
            ['app-b', 'db'],
          ]),
        run: true,
        focus: { node: 'lb' },
      },
      {
        title: 'Add servers, not size',
        body: `<p>Push traffic to <strong>1,200 rps</strong>. Both groups go hot.</p><p>Then click each group and raise <strong>Instances</strong> until they calm down. Capacity grows in a straight line, with no ceiling at xlarge.</p>`,
        focus: { element: '.traffic' },
        task: {
          label: '1,200 rps with errors under 1%',
          holdS: 10,
          test: (ctx) => ctx.traffic.peakRps >= 1200 && running(ctx) && ctx.snap!.global.errorRate < 0.01,
        },
      },
      {
        title: 'Lose a group',
        body: `<p>Kill <strong>App group A</strong>. The load balancer health-checks its targets, so it stops sending traffic there. Group B takes all of it.</p><p>If B has headroom, users barely notice. If not, B goes red too. Headroom is what you pay for availability.</p>`,
        focus: { node: 'app-a' },
        task: { label: 'Kill App group A', test: (ctx) => ctx.snap?.nodes['app-a']?.status === 'down' },
      },
      {
        title: 'The wall moves',
        body: `<p>Restart group A, then push traffic towards <strong>3,000 rps</strong> and add instances as you go.</p><p>Sooner or later the app stops being the wall and the <strong>database</strong> is. Every app server talks to the same one. Scaling out the app never fixes that. The next lessons do.</p>`,
        focus: { node: 'db' },
        task: { label: 'Database over 90% busy', test: (ctx) => metricsOf(ctx, 'db').some((m) => m.utilization > 0.9) },
      },
    ],
    exercises: [
      {
        id: 'scale-out-2000',
        title: '2,000 rps with room to lose a group',
        brief: ['2,000 rps through the two groups.', 'Hold it with errors under 1%, then kill either group and keep errors under 5% while it is down.'],
        start: () =>
          designState({ peakRps: 2000, shape: 'steady' }, [
            ['clients', 'clients', -16, 0],
            ['lb', 'lb', -8, 0],
            ['app-a', 'app', 0, -5, { instances: 3 }, 'App group A'],
            ['app-b', 'app', 0, 5, { instances: 3 }, 'App group B'],
            ['db', 'db', 8, 0],
          ], [
            ['clients', 'lb'],
            ['lb', 'app-a'],
            ['lb', 'app-b'],
            ['app-a', 'db'],
            ['app-b', 'db'],
          ]),
        checks: [
          errorsBelow(1),
          {
            label: 'One group down, errors under 5%',
            holdS: 10,
            test: (ctx) => running(ctx) && metricsOf(ctx, 'app').some((m) => m.status === 'down') && ctx.snap!.global.errorRate < 0.05,
          },
        ],
      },
    ],
  },
  {
    id: 'autoscaling',
    days: [39],
    topic: 'Scale',
    title: 'Autoscaling follows the load',
    essence: 'Autoscaling adds servers when load rises and removes them when it falls. It saves money on slow curves and is too slow for sudden spikes.',
    steps: [
      {
        title: 'A daily wave',
        body: `<p>Traffic rises and falls between 20% and 100% of 2,000 rps, like a day squeezed into two minutes. Six app servers, fixed.</p><p>At the peak they are overloaded. At the trough you pay for servers doing nothing. Watch one full wave.</p>`,
        setup: () =>
          designState({ peakRps: 2000, shape: 'wave' }, [
            ['clients', 'clients', -16, 0, { staticPct: 0 }],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 6, externalCallPct: 0 }],
            ['db', 'db', 8, 0],
          ], [
            ['clients', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
          ]),
        run: true,
        speed: 5,
        focus: { element: '#metrics' },
        task: { label: 'See errors at the peak', test: (ctx) => running(ctx) && ctx.snap!.global.errorRate > 0.02 },
      },
      {
        title: 'Turn on autoscaling',
        body: `<p>Click the app servers and turn on <strong>Autoscaling</strong>. Leave the max at 20.</p><p>Every 15 seconds it checks the CPU it would need to run at 65%, and adds or removes servers to match.</p>`,
        focus: { node: 'app' },
        task: { label: 'Autoscaling on', test: (ctx) => nodesOf(ctx, 'app').some((n) => n.params.autoscale === true) },
      },
      {
        title: 'Cost follows the curve',
        body: `<p>Watch the label on the app servers: <strong>ready/total</strong>. New servers take 30 seconds to boot, shown dim.</p><p>Watch <strong>COST</strong> rise and fall with the wave. You pay for the load you have, not the load you might have.</p>`,
        focus: { node: 'app' },
        task: { label: 'Scale past 10 instances', test: (ctx) => metricsOf(ctx, 'app').some((m) => m.totalInstances > 10) },
      },
      {
        title: 'Spikes beat it',
        body: `<p>Switch the shape to <strong>Spikes</strong>: 8 seconds at full load, every 40 seconds.</p><p>By the time new servers boot, the spike is over. Autoscaling handles slow curves. Sudden spikes need headroom, a queue, or a rate limit.</p>`,
        focus: { element: '.traffic select' },
        task: { label: 'Shape set to Spikes', test: (ctx) => ctx.traffic.shape === 'spike' },
      },
    ],
    exercises: [
      {
        id: 'autoscaling-wave',
        title: 'Ride the wave',
        brief: ['A daily wave peaking at 2,400 rps.', 'Keep errors under 2% for a full minute with autoscaling on. Set the minimum and maximum yourself.'],
        start: () =>
          designState({ peakRps: 2400, shape: 'wave' }, [
            ['clients', 'clients', -16, 0, { staticPct: 0 }],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 2, externalCallPct: 0 }],
            ['db', 'db', 8, 0],
          ], [
            ['clients', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
          ]),
        speed: 5,
        checks: [
          { label: 'Autoscaling on', test: (ctx) => nodesOf(ctx, 'app').some((n) => n.params.autoscale === true) },
          errorsBelow(2, 60),
        ],
      },
    ],
  },
  {
    id: 'caching',
    days: [15, 16],
    topic: 'Storage',
    title: 'Cache-aside',
    essence: 'A cache keeps hot reads away from the database. It is the cheapest capacity you will ever buy, until it goes cold.',
    steps: [
      {
        title: 'The database is the wall',
        body: `<p>Plenty of app servers, 2,500 rps, almost all reads. The app is fine. The <strong>database</strong> is red.</p><p>Most of those reads ask for the same few things, again and again.</p>`,
        setup: () =>
          designState({ peakRps: 2500, shape: 'steady' }, [
            ['clients', 'clients', -16, 0, { staticPct: 0, writePct: 5 }],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 24, externalCallPct: 0, searchPct: 0 }],
            ['db', 'db', 8, 0],
          ], [
            ['clients', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
          ]),
        run: true,
        focus: { node: 'db' },
      },
      {
        title: 'Add Redis',
        body: `<p>Drag a <strong>Cache (Redis)</strong> onto the grid and connect the app servers to it. Keep the app connected to the database too.</p><p>Now the app checks Redis first. A hit never reaches the database. A miss reads the database and fills the cache.</p>`,
        focus: { element: '#palette' },
        task: { label: 'App connected to a cache', test: (ctx) => linked(ctx, 'app', 'cache') },
      },
      {
        title: 'Warming up',
        body: `<p>A new cache is empty, so every read misses at first. Watch the <strong>hit</strong> number on Redis climb, and the database cool down with it.</p>`,
        task: { label: 'Hit ratio over 70%', test: (ctx) => metricsOf(ctx, 'cache').some((m) => (m.hitRatio ?? 0) > 0.7) },
      },
      {
        title: 'Cold cache',
        body: `<p>Click Redis and press <strong>Flush</strong>. Every read misses at once and lands on the database together. That is a <strong>cache stampede</strong>.</p><p>A cache you depend on for capacity is part of your availability, not a bonus.</p>`,
        focus: { element: '#inspector' },
        task: { label: 'Flush the cache', test: (ctx) => eventSays(ctx, 'flushed') },
      },
    ],
    exercises: [
      {
        id: 'caching-4000',
        title: '4,000 reads a second, one database',
        brief: ['4,000 rps, 95% reads, one database you may not resize.', 'Hold it with errors under 1%.'],
        start: () =>
          designState({ peakRps: 4000, shape: 'steady' }, [
            ['clients', 'clients', -16, 0, { staticPct: 0, writePct: 5 }],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 36, externalCallPct: 0, searchPct: 0 }],
            ['db', 'db', 8, 0],
          ], [
            ['clients', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
          ]),
        checks: [
          { label: 'Database not resized', test: (ctx) => nodesOf(ctx, 'db').every((n) => sizeMultiplier(n.params) <= 2) },
          errorsBelow(1, 20),
        ],
      },
    ],
  },
  {
    id: 'cdn',
    days: [18, 19],
    topic: 'Storage',
    title: 'Push static files to the edge',
    essence: 'Images, scripts and styles do not need your servers. A CDN serves them from near the user, and your app servers stop paying for them.',
    steps: [
      {
        title: 'Servers serving pictures',
        body: `<p>60% of these requests are static files: images, CSS, JavaScript. Every one of them goes through your app servers.</p><p>Watch the purple dots: that is static traffic eating your CPU.</p>`,
        setup: () =>
          designState({ peakRps: 1500, shape: 'steady' }, [
            ['clients', 'clients', -16, 0, { staticPct: 60 }],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 8, externalCallPct: 0 }],
            ['db', 'db', 8, 0],
          ], [
            ['clients', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
          ]),
        run: true,
        focus: { node: 'app' },
      },
      {
        title: 'Add a CDN and object storage',
        body: `<p>Add a <strong>CDN</strong> and an <strong>Object Storage</strong> (S3). Connect <strong>Clients → CDN → Object Storage</strong>.</p><p>Static requests now go to the CDN. It answers most of them from its edge cache and fetches the rest from storage. Your app never sees them.</p>`,
        focus: { element: '#palette' },
        task: { label: 'Clients → CDN → Object Storage', test: (ctx) => linked(ctx, 'clients', 'cdn') && linked(ctx, 'cdn', 'objectStorage') },
      },
      {
        title: 'The app breathes',
        body: `<p>Look at the app servers now. Same users, and they went from about 90% busy to about half.</p><p>The CDN also answers faster, because its edge is closer to the user than your region is.</p>`,
        focus: { node: 'app' },
        task: { label: 'App servers under 60% busy', test: (ctx) => metricsOf(ctx, 'app').some((m) => m.utilization > 0 && m.utilization < 0.6) },
      },
    ],
    exercises: [
      {
        id: 'cdn-2500',
        title: '2,500 rps on ten small servers',
        brief: ['2,500 rps, 60% static.', 'Serve it with at most 10 small app server instances and errors under 1%.'],
        start: () =>
          designState({ peakRps: 2500, shape: 'steady' }, [
            ['clients', 'clients', -16, 0, { staticPct: 60 }],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 6, externalCallPct: 0 }],
            ['db', 'db', 8, 0],
          ], [
            ['clients', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
          ]),
        checks: [
          {
            label: '10 small app instances or fewer',
            test: (ctx) =>
              nodesOf(ctx, 'app').reduce((sum, n) => sum + Number(n.params.instances ?? 1), 0) <= 10 &&
              nodesOf(ctx, 'app').every((n) => !n.params.autoscale && sizeMultiplier(n.params) === 1),
          },
          errorsBelow(1),
        ],
      },
    ],
  },
  {
    id: 'replication',
    days: [12, 41],
    topic: 'Storage',
    title: 'Read replicas and replication lag',
    essence: 'Replicas copy the primary so reads can spread out. Writes still have one home, and every copy is a little behind.',
    steps: [
      {
        title: 'One database for everything',
        body: `<p>3,000 rps, 90% reads. Every read and every write goes to the one primary database, and it is the wall.</p>`,
        setup: () =>
          designState({ peakRps: 3000, shape: 'steady' }, [
            ['clients', 'clients', -16, 0, { staticPct: 0, writePct: 10 }],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 28, externalCallPct: 0, searchPct: 0 }],
            ['db', 'db', 8, 0],
          ], [
            ['clients', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
          ]),
        run: true,
        focus: { node: 'db' },
      },
      {
        title: 'Add read replicas',
        body: `<p>Add <strong>Read Replicas</strong>. Connect <strong>App → Read Replicas</strong> so reads go there, and <strong>Primary DB → Read Replicas</strong> so they get a copy of every write.</p>`,
        focus: { element: '#palette' },
        task: { label: 'App → Replicas and Primary → Replicas', test: (ctx) => linked(ctx, 'app', 'replica') && linked(ctx, 'db', 'replica') },
      },
      {
        title: 'Every copy is behind',
        body: `<p>Click the replicas and find <strong>Replication lag</strong>. Each write reaches the primary first and the copies a moment later.</p><p>A user who saves a profile and reloads straight away may read the old one from a replica. That is the read-your-writes problem, and it costs more trust than it costs CPU.</p>`,
        focus: { element: '#inspector', tab: 'live' },
        task: { label: 'See replication lag', test: (ctx) => metricsOf(ctx, 'replica').some((m) => (m.replicationLag ?? 0) > 0) },
      },
      {
        title: 'Writes still have one home',
        body: `<p>Replicas spread <strong>reads</strong>. Every write still goes to the primary, and every replica has to replay it too.</p><p>A write-heavy system needs a different shape: queues to smooth writes, or sharding to split them.</p>`,
      },
    ],
    exercises: [
      {
        id: 'replication-4000',
        title: '4,000 rps, lag under a second',
        brief: ['4,000 rps, 95% reads.', 'Hold it with errors under 1% and replication lag under 1 second.'],
        start: () =>
          designState({ peakRps: 4000, shape: 'steady' }, [
            ['clients', 'clients', -16, 0, { staticPct: 0, writePct: 5 }],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 36, externalCallPct: 0, searchPct: 0 }],
            ['db', 'db', 8, 0],
          ], [
            ['clients', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
          ]),
        checks: [
          errorsBelow(1),
          { label: 'Replication lag under 1s', holdS: 15, test: (ctx) => running(ctx) && metricsOf(ctx, 'replica').length > 0 && metricsOf(ctx, 'replica').every((m) => (m.replicationLag ?? 0) < 1) },
        ],
      },
    ],
  },
  {
    id: 'queues',
    days: [6, 21, 24, 40],
    topic: 'Communication',
    title: 'Queues and workers',
    essence: 'Do slow work later. A queue lets the app answer now and hands the work to workers who take it at their own pace.',
    steps: [
      {
        title: 'Users waiting on slow work',
        body: `<p>Half of these writes call a payment provider that takes 800 ms. The user waits for all of it, and the app server holds a thread the whole time.</p><p>Look at <strong>p99</strong>.</p>`,
        setup: () =>
          designState({ peakRps: 600, shape: 'steady' }, [
            ['clients', 'clients', -16, 0, { staticPct: 0, writePct: 50 }],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 10, externalCallPct: 50, searchPct: 0 }],
            ['db', 'db', 8, 0],
            ['ext', 'external', 8, 8, { latencyMs: 800, rateLimitRps: 1000 }, 'Payments API'],
          ], [
            ['clients', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
            ['app', 'ext'],
          ]),
        run: true,
        focus: { element: '#metrics' },
      },
      {
        title: 'Put a queue in the middle',
        body: `<p>Add a <strong>Queue</strong> and <strong>Workers</strong>. Wire it as:</p><p><code>App → Queue → Workers</code>, then <code>Workers → DB</code> and <code>Workers → Payments API</code>.</p><p>Remove the app's direct line to the Payments API. The app now drops each write on the queue and answers at once.</p>`,
        focus: { element: '#palette' },
        task: {
          label: 'App → Queue → Workers → Payments API',
          test: (ctx) => linked(ctx, 'app', 'queue') && linked(ctx, 'queue', 'workers') && linked(ctx, 'workers', 'external') && !linked(ctx, 'app', 'external'),
        },
      },
      {
        title: 'Fast answers, slow work',
        body: `<p>p99 drops, because users no longer wait for the provider. The work still happens, just later.</p><p>Click the queue: <strong>depth</strong> and <strong>lag</strong> are the new numbers to watch. If workers cannot keep up on average, the queue only grows.</p>`,
        focus: { element: '#metrics' },
        task: { label: 'p99 under 300 ms', test: (ctx) => running(ctx) && ctx.snap!.global.p99 < 0.3 },
      },
      {
        title: 'Jobs that run twice',
        body: `<p>Sometimes a job works but the "done" reply is lost. The queue cannot tell, so it hands the job out again. If the job charges a card, the card is charged twice.</p><p>Click the workers and turn on <strong>Idempotent jobs</strong>: running a job twice now has the same effect as once. The queue gives you at-least-once delivery. Idempotency gives you exactly-once effect.</p>`,
        focus: { element: '#inspector', tab: 'settings' },
        task: { label: 'Idempotent jobs on', test: (ctx) => nodesOf(ctx, 'workers').some((n) => n.params.idempotent === true) },
      },
    ],
    exercises: [
      {
        id: 'queues-keep-up',
        title: 'Keep up with the queue',
        brief: ['1,000 rps, half writes, every write needs the 800 ms Payments API.', 'Fast answers (p99 under 300 ms), queue lag under 10 seconds, and nobody charged twice.'],
        start: () =>
          designState({ peakRps: 1000, shape: 'steady' }, [
            ['clients', 'clients', -16, 0, { staticPct: 0, writePct: 50 }],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 10, externalCallPct: 100, searchPct: 0 }],
            ['db', 'db', 8, 0],
            ['ext', 'external', 8, 8, { latencyMs: 800, rateLimitRps: 1000 }, 'Payments API'],
          ], [
            ['clients', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
            ['app', 'ext'],
          ]),
        checks: [
          p99Below(300),
          { label: 'Queue lag under 10s', holdS: 20, test: (ctx) => running(ctx) && metricsOf(ctx, 'queue').length > 0 && metricsOf(ctx, 'queue').every((m) => (m.queueLagSeconds ?? 0) < 10) },
          { label: 'No duplicate charges', holdS: 20, test: (ctx) => running(ctx) && metricsOf(ctx, 'queue').length > 0 && ctx.snap!.global.duplicatesTotal === 0 },
        ],
      },
    ],
  },
  {
    id: 'retries',
    days: [28, 29],
    topic: 'Reliability',
    title: 'Retry storms',
    essence: 'A retry is a free second chance for one user and extra load for everyone. When the system is struggling, retries multiply the very load that broke it.',
    steps: [
      {
        title: 'Generous retries',
        body: `<p>These clients retry up to 5 times with a short timeout. Traffic spikes every 40 seconds.</p><p>Watch <strong>RETRY AMP.</strong>: how many attempts each real request turns into.</p>`,
        setup: () => ({ ...buildTemplate('retry-storm') }),
        run: true,
        speed: 2,
        focus: { element: '#metrics' },
        task: { label: 'Retry amplification over 1.5×', test: (ctx) => running(ctx) && ctx.snap!.global.retryAmplification > 1.5 },
      },
      {
        title: 'The storm',
        body: `<p>When the database slows down, some requests fail. Each failure comes back up to 5 more times. Load jumps, more requests fail, and more retries arrive.</p><p>The system is now attacking itself. It can stay broken after the spike is over. That is a <strong>metastable failure</strong>.</p>`,
        focus: { element: '#diagnosis' },
      },
      {
        title: 'Retry less',
        body: `<p>Click <strong>Clients</strong> and set <strong>Client retries</strong> to 1.</p><p>Fewer users get a second chance, and the system survives to serve all the others. Real clients also wait longer between attempts and add random jitter so retries do not land together. This simulator does not model backoff yet.</p>`,
        focus: { node: 'clients' },
        task: { label: 'Client retries 1 or fewer', test: (ctx) => nodesOf(ctx, 'clients').every((n) => Number(n.params.retries) <= 1) },
      },
    ],
    exercises: [
      {
        id: 'retries-calm',
        title: 'Calm the storm',
        brief: ['The retry-storm design, spikes to 1,000 rps.', 'Keep retry amplification under 1.3× and errors under 2% for a full minute.'],
        start: () => ({ ...buildTemplate('retry-storm') }),
        speed: 2,
        checks: [
          { label: 'Retry amplification under 1.3×', holdS: 60, test: (ctx) => running(ctx) && ctx.snap!.global.retryAmplification < 1.3 },
          errorsBelow(2, 60),
        ],
      },
    ],
  },
  {
    id: 'circuit-breaker',
    days: [30, 32, 34],
    topic: 'Reliability',
    title: 'Circuit breakers',
    essence: 'When a dependency is down, waiting for it is worse than failing fast. A breaker stops calling it until it recovers.',
    steps: [
      {
        title: 'A provider that hangs',
        body: `<p>Half of all writes call an external API that answers in 2 seconds. At 400 rps the app servers spend most of their threads waiting.</p>`,
        setup: () =>
          designState({ peakRps: 400, shape: 'steady' }, [
            ['clients', 'clients', -16, 0, { staticPct: 0, writePct: 30 }],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 6, externalCallPct: 50, searchPct: 0 }],
            ['db', 'db', 8, -5],
            ['ext', 'external', 8, 5, { latencyMs: 2000, rateLimitRps: 1000, failurePct: 1 }, 'Shipping API'],
          ], [
            ['clients', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
            ['app', 'ext'],
          ]),
        run: true,
        focus: { node: 'ext' },
      },
      {
        title: 'Now it fails',
        body: `<p>Click the Shipping API and set <strong>Baseline failures</strong> to 100%. Every call fails, slowly.</p><p>Watch the app. Requests that never touch the provider start failing too, because their threads are stuck behind the ones waiting on it.</p>`,
        focus: { node: 'ext' },
        task: { label: 'Provider failing 90% or more', test: (ctx) => nodesOf(ctx, 'external').some((n) => Number(n.params.failurePct) >= 90) },
      },
      {
        title: 'Add a breaker',
        body: `<p>Add a <strong>Circuit Breaker</strong> and route the call through it: <code>App → Breaker → Shipping API</code>. Delete the direct line.</p>`,
        focus: { element: '#palette' },
        task: { label: 'App → Breaker → Shipping API', test: (ctx) => linked(ctx, 'app', 'breaker') && linked(ctx, 'breaker', 'external') && !linked(ctx, 'app', 'external') },
      },
      {
        title: 'Fail fast',
        body: `<p>The breaker sees the errors and <strong>opens</strong>. Calls fail in a millisecond instead of two seconds, so threads are free again and everything else recovers.</p><p>Every few seconds it lets one call through to test the provider. That is <strong>half-open</strong>.</p>`,
        focus: { element: '#events' },
        task: { label: 'Breaker open', test: (ctx) => metricsOf(ctx, 'breaker').some((m) => m.breakerState === 'open') },
      },
    ],
    exercises: [
      {
        id: 'breaker-isolate',
        title: 'Keep reads fast while the provider is down',
        brief: ['800 rps. The Shipping API fails every call and takes 2 seconds to do it.', 'Keep the provider failing, and keep p99 under 500 ms anyway.'],
        start: () =>
          designState({ peakRps: 800, shape: 'steady' }, [
            ['clients', 'clients', -16, 0, { staticPct: 0, writePct: 30 }],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 8, externalCallPct: 50, searchPct: 0 }],
            ['db', 'db', 8, -5],
            ['ext', 'external', 8, 5, { latencyMs: 2000, rateLimitRps: 1000, failurePct: 100 }, 'Shipping API'],
          ], [
            ['clients', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
            ['app', 'ext'],
          ]),
        checks: [
          { label: 'Provider still failing', test: (ctx) => nodesOf(ctx, 'external').some((n) => Number(n.params.failurePct) >= 90) },
          p99Below(500, 20),
        ],
      },
    ],
  },
  {
    id: 'rate-limiting',
    days: [36, 37],
    topic: 'Scale',
    title: 'Rate limiting',
    essence: 'Turning some users away quickly is better than failing everyone slowly. A rate limit at the front door keeps the rest of the system inside its capacity.',
    steps: [
      {
        title: 'A spike takes everything down',
        body: `<p>Eight app servers. Every 40 seconds traffic jumps to 3,500 rps for 8 seconds. The servers overload, crash, and take 20 seconds to come back, long after the spike is gone.</p>`,
        setup: () =>
          designState({ peakRps: 3500, shape: 'spike' }, [
            ['clients', 'clients', -16, 0, { staticPct: 0 }],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 8, externalCallPct: 0 }],
            ['db', 'db', 8, 0],
          ], [
            ['clients', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
          ]),
        run: true,
        speed: 2,
        focus: { node: 'app' },
        task: { label: 'See a server crash', test: (ctx) => eventSays(ctx, 'crashed') },
      },
      {
        title: 'Add a front door',
        body: `<p>Add an <strong>API Gateway</strong> between Clients and the load balancer: <code>Clients → Gateway → LB</code>. Delete <code>Clients → LB</code>.</p>`,
        focus: { element: '#palette' },
        task: { label: 'Clients → Gateway → LB', test: (ctx) => linked(ctx, 'clients', 'gateway') && linked(ctx, 'gateway', 'lb') && !linked(ctx, 'clients', 'lb') },
      },
      {
        title: 'Set the limit under capacity',
        body: `<p>Eight servers handle about 1,100 rps. Click the gateway and set its <strong>Rate limit</strong> to about 1,000 rps.</p><p>During a spike, the extra requests get a fast 429 "try later" and show in <strong>SHED</strong>. The servers never overload, so they never crash.</p>`,
        focus: { element: '#inspector', tab: 'settings' },
        task: { label: 'Requests being shed', test: (ctx) => running(ctx) && ctx.snap!.global.shedRate > 0.05 },
      },
    ],
    exercises: [
      {
        id: 'rate-limit-no-crash',
        title: 'Survive the spikes',
        brief: ['Spikes to 4,000 rps on eight app servers. You may not add servers.', 'Go a full minute with every app server up, turning away the excess at the front door instead.'],
        start: () =>
          designState({ peakRps: 4000, shape: 'spike' }, [
            ['clients', 'clients', -16, 0, { staticPct: 0 }],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 8, externalCallPct: 0 }],
            ['db', 'db', 8, 0],
          ], [
            ['clients', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
          ]),
        speed: 2,
        checks: [
          { label: '8 app instances, fixed', test: (ctx) => nodesOf(ctx, 'app').reduce((sum, n) => sum + Number(n.params.instances ?? 1), 0) <= 8 && nodesOf(ctx, 'app').every((n) => !n.params.autoscale) },
          { label: 'No app server down', holdS: 60, test: (ctx) => running(ctx) && metricsOf(ctx, 'app').every((m) => m.healthyInstances === m.totalInstances) },
          { label: 'Rate-limited gateway at the front door', test: (ctx) => linked(ctx, 'clients', 'gateway') && nodesOf(ctx, 'gateway').some((n) => n.params.rateLimit !== false) },
        ],
      },
    ],
  },
  {
    id: 'microservices',
    days: [31, 47],
    topic: 'Architecture',
    title: 'Services and blast radius',
    essence: 'Splitting a system into services lets each part scale and fail on its own. Every call between services puts that independence back at risk.',
    steps: [
      {
        title: 'One gateway, three paths',
        body: `<p>The gateway splits traffic by path: search 70%, users 20%, checkout 10%. The pills on each line show the share.</p><p>Each service has its own servers and its own database. Search is the busiest, so it has the most servers.</p>`,
        setup: () => ({ ...buildTemplate('microservices') }),
        run: true,
        focus: { node: 'gw' },
      },
      {
        title: 'Lose search',
        body: `<p>Kill <strong>search-svc</strong>. About 70% of requests fail. But users and checkout carry on. In a single monolith, everything would be down.</p><p>That is the <strong>blast radius</strong> of a failure: how much it takes with it.</p>`,
        focus: { node: 'search' },
        task: { label: 'Kill search-svc', test: (ctx) => ctx.snap?.nodes.search?.status === 'down' },
      },
      {
        title: 'Lose users',
        body: `<p>Restart search, then kill <strong>users-svc</strong>.</p><p>Checkout fails too. Every checkout calls users-svc (the <em>calls 100%</em> pill) and waits for the answer. A service that others call shares its blast radius with all of them.</p>`,
        focus: { node: 'users' },
        task: { label: 'Kill users-svc', test: (ctx) => ctx.snap?.nodes.users?.status === 'down' },
      },
      {
        title: 'Bulkheads',
        body: `<p>Separate servers per service is a <strong>bulkhead</strong>: a hole in one compartment does not sink the ship. Calls between services are the pipes that cut through the bulkheads.</p><p>Keep calls few, fast, and behind timeouts or breakers. The scenario <strong>The 20% service</strong> tests exactly this.</p>`,
      },
    ],
    exercises: [
      {
        id: 'microservices-3000',
        title: 'Double the traffic, scale only what needs it',
        brief: ['The same three services at 3,000 rps.', 'Errors under 1%, with no more than 40 app instances across all services.'],
        start: () => ({ ...buildTemplate('microservices'), traffic: { peakRps: 3000, shape: 'steady' } }),
        checks: [
          { label: '40 app instances or fewer', test: (ctx) => nodesOf(ctx, 'app').reduce((sum, n) => sum + Number(n.params.instances ?? 1), 0) <= 40 && nodesOf(ctx, 'app').every((n) => !n.params.autoscale) },
          errorsBelow(1),
        ],
      },
    ],
  },
  {
    id: 'regions',
    days: [3, 4],
    topic: 'Foundations',
    title: 'Distance is latency',
    essence: 'Light takes time to cross an ocean. No amount of capacity buys back a round trip, so you move the system closer to the user.',
    steps: [
      {
        title: 'Users in Europe, servers in Virginia',
        body: `<p>These users are in eu-west. The whole stack is in us-east. Zoom out to see the regions.</p><p>Every request crosses the Atlantic and comes back: about 75 ms before any work is done.</p>`,
        setup: () =>
          designState({ peakRps: 500, shape: 'steady' }, [
            ['eu-users', 'clients', -16, 64, { staticPct: 0 }, 'EU users'],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 6, externalCallPct: 0, searchPct: 0 }],
            ['db', 'db', 8, 0],
          ], [
            ['eu-users', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
          ]),
        run: true,
        focus: { element: '#metrics' },
      },
      {
        title: 'The numbers to remember',
        body: `<ul><li>Same region: about 1 ms.</li><li>US East ↔ Europe: about 75 ms.</li><li>Europe ↔ India: about 120 ms.</li><li>US East ↔ India: about 200 ms.</li><li>Phone to the nearest server: about 30 ms.</li></ul><p>The amber pills on lines between regions show these round trips.</p>`,
      },
      {
        title: 'Move the app, not just the door',
        body: `<p>Drag the load balancer and app servers onto the <strong>eu-west</strong> plate.</p><p>Now the app is near the users, but the round trip has only moved: every database query crosses the ocean instead. Here that is one query per request. A real page makes several, so it would get <strong>worse</strong>. The app and its data have to move together.</p>`,
        task: { label: 'App server in eu-west', test: (ctx) => metricsOf(ctx, 'app').some((m) => m.region === 'eu-west') },
      },
    ],
    exercises: [
      {
        id: 'regions-close',
        title: 'Serve Europe from Europe',
        brief: ['Make EU users fast: p50 under 80 ms, with errors under 1%.', 'Everything you need is in the palette.'],
        start: () =>
          designState({ peakRps: 500, shape: 'steady' }, [
            ['eu-users', 'clients', -16, 64, { staticPct: 0 }, 'EU users'],
            ['lb', 'lb', -8, 0],
            ['app', 'app', 0, 0, { instances: 6, externalCallPct: 0, searchPct: 0 }],
            ['db', 'db', 8, 0],
          ], [
            ['eu-users', 'lb'],
            ['lb', 'app'],
            ['app', 'db'],
          ]),
        checks: [
          { label: 'p50 under 80 ms', holdS: 15, test: (ctx) => running(ctx) && ctx.snap!.global.p50 < 0.08 },
          errorsBelow(1),
        ],
      },
    ],
  },
];

LESSONS.sort((a, b) => Math.min(...a.days) - Math.min(...b.days));

export function lessonById(id: string): Lesson | undefined {
  return LESSONS.find((l) => l.id === id);
}

export function exerciseById(id: string): { lesson: Lesson; exercise: Lesson['exercises'][number] } | undefined {
  for (const lesson of LESSONS) {
    const exercise = lesson.exercises.find((e) => e.id === id);
    if (exercise) return { lesson, exercise };
  }
  return undefined;
}
