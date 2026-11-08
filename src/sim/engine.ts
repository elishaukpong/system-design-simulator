import { boolParam, numberParam } from './catalog';
import { isAutoscaled, profileFor, SECONDS_PER_MONTH, type Profile } from './profiles';
import {
  TRAFFIC_CLASSES,
  totalFlow,
  zeroFlow,
  type BreakerState,
  type ClassFlow,
  type ComponentKind,
  type Design,
  type EdgeMetrics,
  type GlobalMetrics,
  type NodeMetrics,
  type NodeSpec,
  type NodeStatus,
  type PressureReason,
  type SimEvent,
  type SimSnapshot,
  type TrafficClass,
  type TrafficSettings,
  type TrafficShape,
} from './types';

interface Instance {
  readyAt: number;
  cause: 'boot' | 'restart' | 'manual';
}

interface NodeState {
  instances: Instance[];
  stress: number;
  backlog: number;
  warmth: number;
  breaker: BreakerState;
  breakerUntil: number;
  downstreamFail: number;
  lag: number;
  depth: number;
  nextScaleAt: number;
  ownLatency: number;
  pathLatency: ClassFlow;
  capacityRps: number;
  lastWriteRps: number;
  pullDemand: number;
  lastAttemptFail: number;
  queueFullWarned: boolean;
  lagWarned: boolean;
}

interface Route {
  child: string | null;
  edgeId: string | null;
  frac: number;
  amp: number;
}

interface SideCall {
  child: string;
  edgeId: string;
  frac: number;
  fatal: boolean;
}

interface Plan {
  routes: Route[];
  calls: SideCall[];
  unrouted: number;
  async: boolean;
}

interface Link {
  child: string;
  edgeId: string;
  kind: ComponentKind;
}

const RESTART_SECONDS = 20;
const BOOT_SECONDS = 30;
const MANUAL_ADD_SECONDS = 3;
const CRASH_AFTER_SECONDS = 5;
const CRASH_UTILIZATION = 1.15;
const SCALE_EVAL_SECONDS = 15;
const DOWN_LATENCY = 0.5;
const SEARCH_AMPLIFICATION = 4;
const REPLAY_COST = 0.5;

const PASS_STATIC: ComponentKind[] = ['objectStorage', 'cdn', 'dns', 'gateway', 'lb', 'breaker', 'app'];
const PASS_DYNAMIC: ComponentKind[] = ['dns', 'gateway', 'lb', 'breaker', 'app', 'cdn', 'workers', 'queue'];
const READ_STORES: ComponentKind[] = ['replica', 'shard', 'db'];
const WRITE_STORES: ComponentKind[] = ['shard', 'db'];

export function trafficMultiplier(shape: TrafficShape, t: number): number {
  switch (shape) {
    case 'steady':
      return 1;
    case 'ramp':
      return 0.05 + 0.95 * Math.min(1, t / 90);
    case 'spike':
      return t % 40 < 8 ? 1 : 0.2;
    case 'wave':
      return 0.6 + 0.4 * Math.sin((2 * Math.PI * t) / 60 - Math.PI / 2);
  }
}

export class Simulation {
  t = 0;
  events: SimEvent[] = [];
  private design: Design = { nodes: [], edges: [] };
  private traffic: TrafficSettings = { peakRps: 100, shape: 'steady' };
  private states = new Map<string, NodeState>();
  private last: SimSnapshot | null = null;
  private script: ((t: number) => number) | null = null;
  private overrides = new Map<string, { params: NodeSpec['params']; until: number }>();

  setDesign(design: Design): void {
    this.design = design;
    const ids = new Set(design.nodes.map((n) => n.id));
    for (const id of [...this.states.keys()]) {
      if (!ids.has(id)) this.states.delete(id);
    }
    for (const node of design.nodes) {
      this.syncInstances(node, this.stateFor(node));
    }
  }

  setTraffic(traffic: TrafficSettings): void {
    this.traffic = traffic;
  }

  setScript(script: ((t: number) => number) | null): void {
    this.script = script;
  }

  overrideParams(nodeId: string, params: NodeSpec['params'], seconds: number): void {
    this.overrides.set(nodeId, { params, until: this.t + seconds });
  }

  reset(): void {
    this.t = 0;
    this.events = [];
    this.states.clear();
    this.overrides.clear();
    this.last = null;
    for (const node of this.design.nodes) {
      this.syncInstances(node, this.stateFor(node));
    }
  }

  get snapshot(): SimSnapshot | null {
    return this.last;
  }

  kill(nodeId: string, fraction = 1, downSeconds = BOOT_SECONDS): void {
    const node = this.design.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const st = this.stateFor(node);
    const up = st.instances.filter((i) => i.readyAt <= this.t);
    const victims = fraction >= 1 ? st.instances : up.slice(0, Math.max(1, Math.round(up.length * fraction)));
    for (const instance of victims) {
      instance.readyAt = this.t + downSeconds;
      instance.cause = 'restart';
    }
    st.warmth *= fraction >= 1 ? 0 : 1 - victims.length / Math.max(1, st.instances.length);
    if (fraction >= 1) st.backlog = 0;
    this.log(
      nodeId,
      'error',
      fraction >= 1 ? `${node.name} killed. Back in ${downSeconds}s.` : `${node.name}: lost ${victims.length} of ${st.instances.length} instances for ${downSeconds}s.`,
    );
  }

  flushCache(nodeId: string): void {
    const node = this.design.nodes.find((n) => n.id === nodeId);
    if (!node || node.kind !== 'cache') return;
    this.stateFor(node).warmth = 0;
    this.log(nodeId, 'warn', `${node.name} flushed. Every read is a miss until it warms up.`);
  }

  step(dt: number): SimSnapshot {
    this.t += dt;
    const t = this.t;
    for (const [id, override] of this.overrides) if (override.until <= t) this.overrides.delete(id);
    const nodes = this.design.nodes.map((n) => this.effective(n));
    const byId = new Map(nodes.map((n) => [n.id, n]));

    for (const node of nodes) {
      const st = this.stateFor(node);
      this.syncInstances(node, st);
      for (const instance of st.instances) {
        if (instance.readyAt > t - dt && instance.readyAt <= t && instance.cause === 'restart') {
          this.log(node.id, 'info', `${node.name}: an instance is back up.`);
        }
      }
    }

    const { order, links, parents } = this.graph(nodes, byId);
    const inflow = new Map<string, ClassFlow>();
    const edgeFlow = new Map<string, ClassFlow>();
    const plans = new Map<string, Record<TrafficClass, Plan>>();
    const metrics: Record<string, NodeMetrics> = {};
    const own = new Map<string, { success: number; latency: number; p99: number }>();

    const offered = this.script ? Math.max(0, this.script(t)) : this.traffic.peakRps * trafficMultiplier(this.traffic.shape, t);
    const clientNodes = nodes.filter((n) => n.kind === 'clients');
    let attempted = 0;

    for (const client of clientNodes) {
      const st = this.stateFor(client);
      const share = offered / clientNodes.length;
      const staticPct = numberParam(client.params, 'staticPct', 30) / 100;
      const writePct = numberParam(client.params, 'writePct', 10) / 100;
      const retries = numberParam(client.params, 'retries', 2);
      let amp = 0;
      for (let k = 0; k <= retries; k++) amp += Math.pow(st.lastAttemptFail, k);
      const flow: ClassFlow = {
        static: share * staticPct * amp,
        read: share * (1 - staticPct) * (1 - writePct) * amp,
        write: share * (1 - staticPct) * writePct * amp,
      };
      inflow.set(client.id, flow);
      attempted += totalFlow(flow);
    }

    const send = (route: Route | SideCall, cls: TrafficClass, amount: number): void => {
      if (route.child === null || route.edgeId === null || amount <= 0) return;
      const target = inflow.get(route.child) ?? zeroFlow();
      target[cls] += amount;
      inflow.set(route.child, target);
      const edge = edgeFlow.get(route.edgeId) ?? zeroFlow();
      edge[cls] += amount;
      edgeFlow.set(route.edgeId, edge);
    };

    for (const id of order) {
      const node = byId.get(id)!;
      const result = this.process(node, inflow.get(id) ?? zeroFlow(), links.get(id) ?? [], parents.get(id) ?? [], byId, links, dt);
      metrics[id] = result.metrics;
      own.set(id, result.own);
      plans.set(id, result.plans);
      for (const cls of TRAFFIC_CLASSES) {
        const plan = result.plans[cls];
        const forwarded = result.forwarded[cls];
        for (const route of plan.routes) send(route, cls, forwarded * route.frac * route.amp);
        for (const call of plan.calls) send(call, cls, forwarded * call.frac);
      }
      if (result.drain) {
        for (const [child, edgeId, amount] of result.drain) {
          send({ child, edgeId, frac: 1, amp: 1 }, 'write', amount);
        }
      }
    }

    const S = new Map<string, ClassFlow>();
    const L = new Map<string, ClassFlow>();
    const P = new Map<string, ClassFlow>();
    let asyncFailed = 0;

    for (const id of [...order].reverse()) {
      const self = own.get(id)!;
      const nodePlans = plans.get(id)!;
      const s = zeroFlow();
      const l = zeroFlow();
      const p = zeroFlow();
      const downstream = zeroFlow();
      for (const cls of TRAFFIC_CLASSES) {
        const plan = nodePlans[cls];
        let down = 0;
        let lat = 0;
        let worstRouteP99 = 0;
        for (const route of plan.routes) {
          if (route.child === null) {
            down += route.frac;
            continue;
          }
          down += route.frac * (S.get(route.child)?.[cls] ?? 0);
          const childLatency = L.get(route.child)?.[cls] ?? 0;
          lat += route.frac * childLatency;
          const childP99 = P.get(route.child)?.[cls] ?? 0;
          worstRouteP99 = Math.max(worstRouteP99, route.frac >= 0.05 ? childP99 : route.frac * childLatency);
        }
        if (plan.async) down = 1;
        let callSuccess = 1;
        let callP99 = 0;
        for (const call of plan.calls) {
          const childSuccess = S.get(call.child)?.[cls] ?? 0;
          if (call.fatal) callSuccess *= 1 - call.frac * (1 - childSuccess);
          const childLatency = L.get(call.child)?.[cls] ?? 0;
          lat += call.frac * childLatency;
          callP99 += call.frac >= 0.05 ? P.get(call.child)?.[cls] ?? 0 : call.frac * childLatency;
        }
        downstream[cls] = callSuccess * down;
        s[cls] = self.success * downstream[cls];
        l[cls] = self.latency + lat;
        p[cls] = self.p99 + callP99 + worstRouteP99;
      }
      S.set(id, s);
      L.set(id, l);
      P.set(id, p);

      const m = metrics[id];
      const inTotal = m.inRps;
      if (inTotal > 0) {
        m.successFrac = weighted(s, m.inByClass);
        m.pathLatency = weighted(l, m.inByClass);
        m.pathP99 = maxOverActive(p, m.inByClass);
      } else {
        m.successFrac = 1;
        m.pathLatency = self.latency;
        m.pathP99 = self.p99;
      }
      const st = this.states.get(id)!;
      st.pathLatency = { ...l };

      const node = byId.get(id)!;
      if (node.kind === 'workers') asyncFailed += m.servedRps * (1 - m.successFrac);
      if (node.kind === 'breaker' && m.servedRps > 0) st.downstreamFail = 1 - weighted(downstream, m.inByClass);
    }

    const edges: Record<string, EdgeMetrics> = {};
    for (const edge of this.design.edges) {
      const flow = edgeFlow.get(edge.id) ?? zeroFlow();
      const childSuccess = S.get(edge.to);
      edges[edge.id] = {
        flow,
        failFrac: childSuccess && totalFlow(flow) > 0 ? 1 - weighted(childSuccess, flow) : 0,
      };
    }

    let successRps = 0;
    let attemptFailWeighted = 0;
    let latencyWeighted = 0;
    let p99 = 0;
    let shed = 0;
    for (const node of nodes) if (node.kind === 'gateway') shed += metrics[node.id]?.shedRps ?? 0;

    for (const client of clientNodes) {
      const st = this.stateFor(client);
      const flow = inflow.get(client.id) ?? zeroFlow();
      const flowTotal = totalFlow(flow);
      const timeout = numberParam(client.params, 'timeoutMs', 5000) / 1000;
      const retries = numberParam(client.params, 'retries', 2);
      const s = S.get(client.id) ?? zeroFlow();
      const l = L.get(client.id) ?? zeroFlow();
      const p = P.get(client.id) ?? zeroFlow();
      let clientSuccess = 0;
      let clientLatency = 0;
      let clientP99 = 0;
      for (const cls of TRAFFIC_CLASSES) {
        if (flowTotal <= 0) break;
        const share = flow[cls] / flowTotal;
        let success = s[cls];
        let latency = l[cls];
        if (latency > timeout) {
          success *= timeout / latency;
          latency = timeout;
        }
        clientSuccess += share * success;
        clientLatency += share * latency;
        if (share > 0.01) clientP99 = Math.max(clientP99, Math.min(timeout, p[cls]));
      }
      const attemptFail = flowTotal > 0 ? 1 - clientSuccess : 0;
      st.lastAttemptFail = clamp(attemptFail, 0, 0.999);
      const userShare = offered / Math.max(1, clientNodes.length);
      successRps += userShare * (1 - Math.pow(attemptFail, retries + 1));
      attemptFailWeighted += attemptFail * flowTotal;
      latencyWeighted += clientLatency * flowTotal;
      p99 = Math.max(p99, clientP99);
      const m = metrics[client.id];
      m.successFrac = 1 - attemptFail;
      m.pathLatency = clientLatency;
      m.pathP99 = clientP99;
    }

    this.updateState(nodes, metrics, dt);

    let cost = 0;
    for (const node of nodes) cost += metrics[node.id]?.costPerMonth ?? 0;

    const global: GlobalMetrics = {
      t,
      offeredRps: offered,
      attemptedRps: attempted,
      retryAmplification: offered > 0 ? attempted / offered : 1,
      successRps,
      errorRate: attempted > 0 ? attemptFailWeighted / attempted : 0,
      shedRate: attempted > 0 ? Math.min(1, shed / attempted) : 0,
      p50: attempted > 0 ? latencyWeighted / attempted : 0,
      p99,
      costPerMonth: cost,
      asyncFailedRps: asyncFailed,
    };

    this.last = { global, nodes: metrics, edges };
    return this.last;
  }

  private process(
    node: NodeSpec,
    inF: ClassFlow,
    children: Link[],
    parents: NodeSpec[],
    byId: Map<string, NodeSpec>,
    links: Map<string, Link[]>,
    dt: number,
  ) {
    const prof = profileFor(node);
    const st = this.stateFor(node);
    const t = this.t;
    const inRps = totalFlow(inF);
    const total = st.instances.length;
    const healthy = st.instances.filter((i) => i.readyAt <= t).length;
    const booting = total - healthy;
    const plans = emptyPlans();
    const forwarded = zeroFlow();
    let drain: Array<[string, string, number]> | null = null;

    const metrics: NodeMetrics = {
      inRps,
      inByClass: { ...inF },
      servedRps: 0,
      droppedRps: 0,
      shedRps: 0,
      utilization: 0,
      concurrencyUtil: 0,
      ownLatency: prof.baseLatency,
      ownP99: prof.baseLatency,
      pathLatency: 0,
      pathP99: 0,
      successFrac: 1,
      backlog: 0,
      status: 'idle',
      reason: null,
      healthyInstances: healthy,
      bootingInstances: booting,
      totalInstances: total,
      costPerMonth: prof.monthlyPerUnit * Math.max(1, total) + (inRps * SECONDS_PER_MONTH * prof.perMillionRequests) / 1e6,
    };

    if (node.kind === 'shard') metrics.costPerMonth = prof.monthlyPerUnit + (inRps * SECONDS_PER_MONTH * prof.perMillionRequests) / 1e6;

    if (healthy === 0) {
      metrics.status = 'down';
      metrics.reason = 'down';
      metrics.droppedRps = inRps;
      metrics.ownLatency = DOWN_LATENCY;
      metrics.ownP99 = DOWN_LATENCY;
      st.capacityRps = 0;
      return { metrics, plans, forwarded, drain, own: { success: 0, latency: DOWN_LATENCY, p99: DOWN_LATENCY } };
    }

    if (node.kind === 'queue') {
      return this.processQueue(node, st, prof, inF, children, byId, metrics, plans, forwarded, dt);
    }

    const avgWeight = inRps > 0 ? weighted(prof.weights, inF) : 1;
    let load = inRps * avgWeight;
    let deadFrac = 0;
    let shedFrac = 0;
    let baselineFail = 0;

    if (prof.crashable && total > 1 && healthy < total && !this.healthChecked(parents)) {
      deadFrac = (total - healthy) / total;
    }

    if (node.kind === 'gateway' && boolParam(node.params, 'rateLimit', true)) {
      const limit = numberParam(node.params, 'rateLimitRps', 5000);
      if (inRps > limit) shedFrac = 1 - limit / inRps;
    }

    if (node.kind === 'breaker') {
      if (st.breaker === 'open') shedFrac = 1;
      if (st.breaker === 'half-open') shedFrac = 0.9;
      metrics.breakerState = st.breaker;
    }

    if (node.kind === 'external') {
      baselineFail = numberParam(node.params, 'failurePct', 1) / 100;
    }

    load *= (1 - deadFrac) * (1 - shedFrac);
    metrics.shedRps = inRps * (1 - deadFrac) * shedFrac;

    let capacityOps = prof.unitCapacity * healthy;
    if (node.kind === 'shard') {
      const shards = numberParam(node.params, 'shards', 4);
      const hotShare = Math.max(1 / shards, numberParam(node.params, 'hotKeyPct', 0) / 100);
      capacityOps = prof.unitCapacity / hotShare;
      metrics.hotShardShare = hotShare;
    }
    if (node.kind === 'replica') {
      const primary = this.primaryFor(node, byId);
      const primaryWrites = primary ? this.stateFor(primary).lastWriteRps : 0;
      load += primaryWrites * prof.weights.write * REPLAY_COST * healthy;
    }

    const cpuUtil = capacityOps > 0 ? load / capacityOps : Infinity;
    let effectiveOps = capacityOps;
    let concurrencyUtil = 0;
    let connectionUtil = 0;

    if (prof.threadsPerUnit !== null) {
      const maxConcurrent = prof.threadsPerUnit * healthy;
      const queuedBeforeWorker = st.ownLatency - prof.baseLatency;
      const pathLatency = inRps > 0 ? weighted(st.pathLatency, inF) : prof.baseLatency;
      const perRequest = Math.max(prof.baseLatency, pathLatency - queuedBeforeWorker);
      const concurrencyOps = (maxConcurrent / perRequest) * avgWeight;
      concurrencyUtil = (load / avgWeight) * perRequest / maxConcurrent;
      effectiveOps = Math.min(effectiveOps, concurrencyOps);
    }

    if (prof.connectionLimit !== null) {
      const held = Math.max(prof.baseLatency, st.ownLatency);
      const connectionOps = (prof.connectionLimit / held) * avgWeight;
      connectionUtil = ((load / avgWeight) * held) / prof.connectionLimit;
      effectiveOps = Math.min(effectiveOps, connectionOps);
    }

    const demand = st.backlog + load * dt;
    const processed = Math.min(demand, effectiveOps * dt);
    let backlog = demand - processed;
    const maxBacklog = effectiveOps * prof.maxQueueSeconds;
    const dropped = Math.max(0, backlog - maxBacklog);
    backlog -= dropped;
    st.backlog = backlog;

    const acceptedFrac = load > 0 ? clamp(1 - dropped / (load * dt), 0, 1) : 1;
    const forwardFrac = load > 0 ? processed / (load * dt) : 0;
    const rho = effectiveOps > 0 ? load / effectiveOps : Infinity;
    const wait = effectiveOps > 0 ? backlog / effectiveOps : 0;
    const servers = Math.max(1, prof.serversPerUnit * (node.kind === 'shard' ? 1 : healthy));
    const busy = Math.min(rho, 0.98);
    const queueing = (prof.baseLatency * Math.pow(busy, Math.sqrt(2 * (servers + 1)) - 1)) / (servers * (1 - busy));
    const ownLatency = prof.baseLatency + queueing + wait;
    const ownP99 = prof.baseLatency * 1.3 + queueing * 4.6 + wait * 1.1;
    st.ownLatency = ownLatency;
    st.capacityRps = effectiveOps / avgWeight;

    const successFrac = (1 - deadFrac) * (1 - shedFrac) * acceptedFrac * (1 - baselineFail);
    const passFrac = (1 - deadFrac) * (1 - shedFrac) * forwardFrac;
    for (const cls of TRAFFIC_CLASSES) forwarded[cls] = inF[cls] * passFrac;

    metrics.servedRps = totalFlow(forwarded);
    metrics.droppedRps = inRps * (1 - deadFrac) * (1 - shedFrac) * (1 - acceptedFrac) + inRps * deadFrac;
    metrics.utilization = Math.max(cpuUtil, concurrencyUtil, connectionUtil);
    metrics.concurrencyUtil = Math.max(concurrencyUtil, connectionUtil);
    metrics.ownLatency = ownLatency;
    metrics.ownP99 = ownP99;
    metrics.backlog = backlog;

    if (node.kind === 'cache') metrics.hitRatio = this.effectiveHit(node);
    if (node.kind === 'replica') metrics.replicationLag = st.lag;
    if (node.kind === 'db' || node.kind === 'shard') st.lastWriteRps = forwarded.write;

    this.buildPlans(node, children, links, byId, plans);

    metrics.status = statusFor(metrics.utilization, inRps);
    metrics.reason = this.reasonFor(node, metrics, cpuUtil, concurrencyUtil, connectionUtil, plans);
    if (node.kind === 'external' && inRps > numberParam(node.params, 'rateLimitRps', 200)) metrics.status = 'overloaded';

    return { metrics, plans, forwarded, drain, own: { success: successFrac, latency: ownLatency, p99: ownP99 } };
  }

  private processQueue(
    node: NodeSpec,
    st: NodeState,
    prof: Profile,
    inF: ClassFlow,
    children: Link[],
    byId: Map<string, NodeSpec>,
    metrics: NodeMetrics,
    plans: Record<TrafficClass, Plan>,
    forwarded: ClassFlow,
    dt: number,
  ) {
    const inRps = totalFlow(inF);
    const maxDepth = numberParam(node.params, 'maxDepth', 1_000_000);
    const accepted = Math.min(inRps, prof.unitCapacity);
    let depth = st.depth + accepted * dt;

    const workers = children.filter((c) => c.kind === 'workers');
    let workersCapacity = 0;
    for (const w of workers) workersCapacity += this.stateFor(byId.get(w.child)!).capacityRps;
    const drainRate = Math.min(workersCapacity, depth / dt);
    depth -= drainRate * dt;

    let overflow = 0;
    if (depth > maxDepth) {
      overflow = (depth - maxDepth) / dt;
      depth = maxDepth;
      if (!st.queueFullWarned) {
        this.log(node.id, 'error', `${node.name} is full. New writes are rejected.`);
        st.queueFullWarned = true;
      }
    } else if (depth < maxDepth * 0.9) {
      st.queueFullWarned = false;
    }
    st.depth = depth;

    const drain: Array<[string, string, number]> = [];
    for (const w of workers) {
      const wNode = byId.get(w.child)!;
      const wState = this.stateFor(wNode);
      const share = workersCapacity > 0 ? wState.capacityRps / workersCapacity : 1 / workers.length;
      drain.push([w.child, w.edgeId, drainRate * share]);
      wState.pullDemand = (accepted + depth / 30) * share;
    }

    const acceptedFrac = inRps > 0 ? clamp((accepted - overflow) / inRps, 0, 1) : 1;
    for (const cls of TRAFFIC_CLASSES) {
      plans[cls] = { routes: [], calls: [], unrouted: 0, async: true };
      forwarded[cls] = 0;
    }

    metrics.servedRps = drainRate;
    metrics.droppedRps = inRps - accepted + overflow;
    metrics.utilization = Math.max(inRps / prof.unitCapacity, depth / maxDepth);
    metrics.queueDepth = depth;
    metrics.queueLagSeconds = drainRate > 0 ? depth / drainRate : depth > 0 ? Infinity : 0;
    metrics.backlog = depth;
    metrics.status = statusFor(metrics.utilization, inRps);
    if (accepted > drainRate * 1.02 && depth > 100) {
      metrics.reason = 'backlog';
      if (metrics.status === 'healthy' || metrics.status === 'idle') metrics.status = 'warm';
    }
    if (workers.length === 0 && depth > 0) {
      metrics.reason = 'no-backend';
      metrics.status = 'hot';
    }
    st.capacityRps = prof.unitCapacity;

    return {
      metrics,
      plans,
      forwarded,
      drain,
      own: { success: Math.max(0, acceptedFrac), latency: prof.baseLatency, p99: prof.baseLatency * 1.5 },
    };
  }

  private buildPlans(
    node: NodeSpec,
    children: Link[],
    links: Map<string, Link[]>,
    byId: Map<string, NodeSpec>,
    plans: Record<TrafficClass, Plan>,
  ): void {
    const kind = node.kind;
    const toRoutes = (targets: Link[], frac: number, amp = 1): Route[] => {
      if (targets.length === 0 || frac <= 0) return [];
      const weights = this.splitWeights(node, targets, byId);
      return targets.map((target, i) => ({ child: target.child, edgeId: target.edgeId, frac: frac * weights[i], amp }));
    };

    if (kind === 'clients' || kind === 'dns' || kind === 'cdn' || kind === 'lb' || kind === 'gateway' || kind === 'breaker') {
      for (const cls of TRAFFIC_CLASSES) {
        let edgeServed = 0;
        if (kind === 'cdn' && cls === 'static') edgeServed = numberParam(node.params, 'hitRatio', 0.9);
        if (kind === 'cdn' && cls === 'read') edgeServed = numberParam(node.params, 'cacheDynamicPct', 0) / 100;
        const targets = pickGroup(children, cls === 'static' ? PASS_STATIC : PASS_DYNAMIC, true);
        const usable = kind === 'lb' && boolParam(node.params, 'healthChecks', true)
          ? targets.filter((target) => this.isUp(byId.get(target.child)!))
          : targets;
        const remaining = 1 - edgeServed;
        const routes: Route[] = [];
        if (edgeServed > 0) routes.push({ child: null, edgeId: null, frac: edgeServed, amp: 1 });
        routes.push(...toRoutes(usable, remaining));
        plans[cls] = { routes, calls: [], unrouted: usable.length === 0 ? remaining : 0, async: false };
      }
      return;
    }

    if (kind === 'app' || kind === 'workers') {
      const objectStores = children.filter((c) => c.kind === 'objectStorage');
      plans.static = objectStores.length
        ? { routes: toRoutes(objectStores, 1), calls: [], unrouted: 0, async: false }
        : terminalPlan();

      const readRoutes: Route[] = [];
      const readCalls: SideCall[] = [];
      const searchFrac = kind === 'app' ? numberParam(node.params, 'searchPct', 20) / 100 : 0;
      const searchNodes = children.filter((c) => c.kind === 'search');
      const readStores = pickGroup(children, READ_STORES, false);
      let plainReads = 1;
      if (searchFrac > 0) {
        if (searchNodes.length) {
          readRoutes.push(...toRoutes(searchNodes, searchFrac));
          plainReads -= searchFrac;
        } else if (readStores.length) {
          readRoutes.push(...toRoutes(readStores, searchFrac, SEARCH_AMPLIFICATION));
          plainReads -= searchFrac;
        }
      }
      const caches = children.filter((c) => c.kind === 'cache');
      if (caches.length) {
        const readThrough = caches.some((c) => pickGroup(links.get(c.child) ?? [], READ_STORES, false).length > 0);
        if (readThrough) {
          readRoutes.push(...toRoutes(caches, plainReads));
        } else {
          const hit = this.hitThrough(caches[0].child, byId, links);
          for (const c of caches) readCalls.push({ child: c.child, edgeId: c.edgeId, frac: plainReads / caches.length, fatal: false });
          readRoutes.push({ child: null, edgeId: null, frac: plainReads * hit, amp: 1 });
          const misses = plainReads * (1 - hit);
          if (readStores.length) readRoutes.push(...toRoutes(readStores, misses));
          else readRoutes.push({ child: null, edgeId: null, frac: misses, amp: 1 });
        }
      } else if (readStores.length) {
        readRoutes.push(...toRoutes(readStores, plainReads));
      } else {
        readRoutes.push({ child: null, edgeId: null, frac: plainReads, amp: 1 });
      }
      plans.read = { routes: readRoutes, calls: readCalls, unrouted: 0, async: false };

      const queues = children.filter((c) => c.kind === 'queue');
      const writeStores = pickGroup(children, WRITE_STORES, false);
      const writeRoutes = queues.length
        ? toRoutes(queues, 1)
        : writeStores.length
          ? toRoutes(writeStores, 1)
          : [{ child: null, edgeId: null, frac: 1, amp: 1 }];
      const externals = children.filter((c) => c.kind === 'external');
      const externalFrac = numberParam(node.params, 'externalCallPct', 30) / 100;
      const writeCalls: SideCall[] = externalFrac > 0
        ? externals.map((e) => ({ child: e.child, edgeId: e.edgeId, frac: externalFrac / externals.length, fatal: true }))
        : [];
      plans.write = { routes: writeRoutes, calls: writeCalls, unrouted: 0, async: false };
      return;
    }

    if (kind === 'cache') {
      const stores = pickGroup(children, READ_STORES, false);
      const hit = this.effectiveHit(node);
      plans.read = stores.length
        ? { routes: [{ child: null, edgeId: null, frac: hit, amp: 1 }, ...toRoutes(stores, 1 - hit)], calls: [], unrouted: 0, async: false }
        : terminalPlan();
      const writeStores = pickGroup(children, WRITE_STORES, false);
      plans.write = writeStores.length ? { routes: toRoutes(writeStores, 1), calls: [], unrouted: 0, async: false } : terminalPlan();
      plans.static = terminalPlan();
      return;
    }

    for (const cls of TRAFFIC_CLASSES) plans[cls] = terminalPlan();
  }

  private splitWeights(node: NodeSpec, targets: Link[], byId: Map<string, NodeSpec>): number[] {
    if (node.kind === 'lb' && node.params.algorithm === 'least-connections') {
      const caps = targets.map((target) => Math.max(0, this.stateFor(byId.get(target.child)!).capacityRps));
      const sum = caps.reduce((a, b) => a + b, 0);
      if (sum > 0) return caps.map((c) => c / sum);
    }
    return targets.map(() => 1 / targets.length);
  }

  private reasonFor(
    node: NodeSpec,
    m: NodeMetrics,
    cpuUtil: number,
    concurrencyUtil: number,
    connectionUtil: number,
    plans: Record<TrafficClass, Plan>,
  ): PressureReason | null {
    const unrouted = TRAFFIC_CLASSES.some((cls) => plans[cls].unrouted > 0 && m.inByClass[cls] > 0);
    if (unrouted && m.inRps > 0) return 'no-backend';
    if (node.kind === 'breaker' && m.breakerState !== 'closed') return 'breaker-open';
    if (node.kind === 'gateway' && m.shedRps > 0) return 'rate-limit';
    if (node.kind === 'external' && m.inRps > numberParam(node.params, 'rateLimitRps', 200)) return 'provider-limit';
    if (node.kind === 'replica' && (m.replicationLag ?? 0) > 2) return 'replication-lag';
    if (node.kind === 'cache' && (m.hitRatio ?? 1) < numberParam(node.params, 'hitRatio', 0.85) * 0.7 && m.inRps > 0) return 'cold-cache';
    if (m.utilization < 0.7) return null;
    if (node.kind === 'shard' && (m.hotShardShare ?? 0) > 1.5 / numberParam(node.params, 'shards', 4)) return 'hot-shard';
    if (connectionUtil >= cpuUtil && connectionUtil >= concurrencyUtil) return 'connections';
    if (concurrencyUtil > cpuUtil) return 'concurrency';
    if ((node.kind === 'db' || node.kind === 'shard') && m.inByClass.write * 4 > m.inByClass.read + m.inByClass.static) return 'write-ceiling';
    return 'cpu';
  }

  private updateState(nodes: NodeSpec[], metrics: Record<string, NodeMetrics>, dt: number): void {
    const t = this.t;
    for (const node of nodes) {
      const st = this.stateFor(node);
      const m = metrics[node.id];
      const prof = profileFor(node);
      const healthy = st.instances.filter((i) => i.readyAt <= t);

      if (prof.crashable && healthy.length > 0) {
        const cpu = m.reason === 'cpu' || m.reason === 'cold-cache' ? m.utilization : this.cpuOnly(node, m);
        if (cpu > CRASH_UTILIZATION) st.stress += dt;
        else st.stress = Math.max(0, st.stress - dt * 0.5);
        if (st.stress >= CRASH_AFTER_SECONDS) {
          const victim = healthy[healthy.length - 1];
          victim.readyAt = t + RESTART_SECONDS;
          victim.cause = 'restart';
          st.stress = CRASH_AFTER_SECONDS / 2;
          if (node.kind === 'cache') st.warmth *= (healthy.length - 1) / Math.max(1, st.instances.length);
          const left = healthy.length - 1;
          this.log(
            node.id,
            'error',
            left > 0
              ? `${node.name}: an instance crashed under load (${pct(cpu)} CPU). ${left} left to carry it.`
              : `${node.name} is DOWN. Every instance crashed.`,
          );
        }
      }

      if (isAutoscaled(node) && t >= st.nextScaleAt) {
        st.nextScaleAt = t + SCALE_EVAL_SECONDS;
        const min = numberParam(node.params, 'instances', 1);
        const max = Math.max(min, numberParam(node.params, 'maxInstances', 20));
        const demandOps = node.kind === 'workers'
          ? st.pullDemand
          : m.inRps * (m.inRps > 0 ? weighted(prof.weights, m.inByClass) : 1);
        const desired = clamp(Math.ceil(demandOps / (prof.unitCapacity * 0.65)), min, max);
        const current = st.instances.length;
        if (desired > current) {
          for (let i = current; i < desired; i++) st.instances.push({ readyAt: t + BOOT_SECONDS, cause: 'boot' });
          this.log(node.id, 'info', `${node.name}: autoscaling ${current} → ${desired}. New instances ready in ${BOOT_SECONDS}s.`);
        } else if (desired < current) {
          st.instances.pop();
          this.log(node.id, 'info', `${node.name}: scaling in ${current} → ${current - 1}.`);
        }
      }

      if (node.kind === 'cache' && healthy.length > 0 && m.inRps > 0) {
        const warmup = numberParam(node.params, 'warmupS', 30);
        st.warmth = Math.min(healthy.length / st.instances.length, st.warmth + dt / warmup);
      }

      if (node.kind === 'replica') {
        const util = m.utilization;
        if (util > 1) st.lag += dt * (util - 1) * 2;
        else st.lag = Math.max(0.05 + 0.5 * Math.pow(util, 4), st.lag - dt * 2);
        if (st.lag > 2 && !st.lagWarned) {
          this.log(node.id, 'warn', `${node.name}: replication lag ${st.lag.toFixed(1)}s. Users are reading stale data.`);
          st.lagWarned = true;
        }
        if (st.lag < 1) st.lagWarned = false;
      }

      if (node.kind === 'breaker') {
        const threshold = numberParam(node.params, 'errorThresholdPct', 50) / 100;
        const cooldown = numberParam(node.params, 'cooldownS', 10);
        if (st.breaker === 'closed' && m.servedRps > 0 && st.downstreamFail > threshold) {
          st.breaker = 'open';
          st.breakerUntil = t + cooldown;
          this.log(node.id, 'warn', `${node.name} OPEN: ${pct(st.downstreamFail)} downstream failures. Failing fast for ${cooldown}s.`);
        } else if (st.breaker === 'open' && t >= st.breakerUntil) {
          st.breaker = 'half-open';
          st.downstreamFail = 0;
        } else if (st.breaker === 'half-open' && m.servedRps > 0) {
          if (st.downstreamFail > threshold) {
            st.breaker = 'open';
            st.breakerUntil = t + cooldown;
          } else {
            st.breaker = 'closed';
            this.log(node.id, 'info', `${node.name} closed. Downstream recovered.`);
          }
        }
      }
    }
  }

  private effective(node: NodeSpec): NodeSpec {
    const override = this.overrides.get(node.id);
    return override ? { ...node, params: { ...node.params, ...override.params } } : node;
  }

  private cpuOnly(node: NodeSpec, m: NodeMetrics): number {
    const prof = profileFor(node);
    const healthy = m.healthyInstances;
    if (healthy === 0 || m.inRps === 0) return 0;
    return (m.inRps * weighted(prof.weights, m.inByClass)) / (prof.unitCapacity * healthy);
  }

  private hitThrough(id: string, byId: Map<string, NodeSpec>, links: Map<string, Link[]>): number {
    let node = byId.get(id)!;
    let passFrac = 1;
    for (let depth = 0; depth < 6 && (node.kind === 'breaker' || node.kind === 'lb'); depth++) {
      if (node.kind === 'breaker') {
        const state = this.stateFor(node).breaker;
        passFrac *= state === 'open' ? 0 : state === 'half-open' ? 0.1 : 1;
      }
      const next = links.get(node.id)?.[0];
      if (!next) return 0;
      node = byId.get(next.child)!;
    }
    return node.kind === 'cache' ? passFrac * this.effectiveHit(node) : 0;
  }

  private effectiveHit(cache: NodeSpec): number {
    const st = this.stateFor(cache);
    if (!this.isUp(cache)) return 0;
    return numberParam(cache.params, 'hitRatio', 0.85) * st.warmth;
  }

  private isUp(node: NodeSpec): boolean {
    return this.stateFor(node).instances.some((i) => i.readyAt <= this.t);
  }

  private healthChecked(parents: NodeSpec[]): boolean {
    const lbs = parents.filter((p) => p.kind === 'lb');
    return lbs.length > 0 && lbs.length === parents.length && lbs.every((lb) => boolParam(lb.params, 'healthChecks', true));
  }

  private primaryFor(replica: NodeSpec, byId: Map<string, NodeSpec>): NodeSpec | null {
    const edge = this.design.edges.find((e) => e.to === replica.id && ['db', 'shard'].includes(byId.get(e.from)?.kind ?? ''));
    if (edge) return byId.get(edge.from) ?? null;
    return this.design.nodes.find((n) => n.kind === 'db') ?? null;
  }

  private graph(nodes: NodeSpec[], byId: Map<string, NodeSpec>) {
    const outgoing = new Map<string, Array<{ to: string; edgeId: string }>>();
    const indegree = new Map<string, number>();
    for (const node of nodes) {
      outgoing.set(node.id, []);
      indegree.set(node.id, 0);
    }
    for (const edge of this.design.edges) {
      if (!byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) continue;
      outgoing.get(edge.from)!.push({ to: edge.to, edgeId: edge.id });
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }

    const order: string[] = [];
    const remaining = new Map(indegree);
    const ready = nodes.filter((n) => remaining.get(n.id) === 0).map((n) => n.id);
    const placed = new Set<string>();
    const acyclic = new Set<string>();
    while (order.length < nodes.length) {
      if (ready.length === 0) {
        const next = nodes.find((n) => !placed.has(n.id))!;
        ready.push(next.id);
      }
      const id = ready.shift()!;
      if (placed.has(id)) continue;
      placed.add(id);
      order.push(id);
      for (const out of outgoing.get(id)!) {
        if (placed.has(out.to)) continue;
        acyclic.add(out.edgeId);
        const left = (remaining.get(out.to) ?? 1) - 1;
        remaining.set(out.to, left);
        if (left === 0) ready.push(out.to);
      }
    }

    const links = new Map<string, Link[]>();
    const parents = new Map<string, NodeSpec[]>();
    for (const node of nodes) {
      links.set(node.id, []);
      parents.set(node.id, []);
    }
    const resolve = (id: string, depth: number): ComponentKind => {
      const node = byId.get(id)!;
      if ((node.kind === 'breaker' || node.kind === 'lb') && depth < 6) {
        const first = outgoing.get(id)!.find((o) => acyclic.has(o.edgeId));
        if (first) return resolve(first.to, depth + 1);
      }
      return node.kind;
    };
    for (const [from, outs] of outgoing) {
      for (const out of outs) {
        if (!acyclic.has(out.edgeId)) continue;
        links.get(from)!.push({ child: out.to, edgeId: out.edgeId, kind: resolve(out.to, 0) });
        parents.get(out.to)!.push(byId.get(from)!);
      }
    }
    return { order, links, parents };
  }

  private stateFor(node: NodeSpec): NodeState {
    let st = this.states.get(node.id);
    if (!st) {
      st = {
        instances: [],
        stress: 0,
        backlog: 0,
        warmth: 0,
        breaker: 'closed',
        breakerUntil: 0,
        downstreamFail: 0,
        lag: 0.05,
        depth: 0,
        nextScaleAt: 0,
        ownLatency: profileFor(node).baseLatency,
        pathLatency: zeroFlow(),
        capacityRps: profileFor(node).unitCapacity * Math.max(1, profileFor(node).units),
        lastWriteRps: 0,
        pullDemand: 0,
        lastAttemptFail: 0,
        queueFullWarned: false,
        lagWarned: false,
      };
      this.states.set(node.id, st);
    }
    return st;
  }

  private syncInstances(node: NodeSpec, st: NodeState): void {
    const prof = profileFor(node);
    let target = Math.max(1, Math.round(prof.units));
    if (isAutoscaled(node)) {
      const max = Math.max(target, numberParam(node.params, 'maxInstances', 20));
      target = clamp(st.instances.length || target, target, max);
    }
    const readyAt = this.t === 0 ? 0 : this.t + MANUAL_ADD_SECONDS;
    while (st.instances.length < target) st.instances.push({ readyAt, cause: 'manual' });
    while (st.instances.length > target) st.instances.pop();
  }

  private log(nodeId: string, level: SimEvent['level'], message: string): void {
    this.events.push({ t: this.t, nodeId, level, message });
    if (this.events.length > 200) this.events.shift();
  }
}

function emptyPlans(): Record<TrafficClass, Plan> {
  return { static: terminalPlan(), read: terminalPlan(), write: terminalPlan() };
}

function terminalPlan(): Plan {
  return { routes: [{ child: null, edgeId: null, frac: 1, amp: 1 }], calls: [], unrouted: 0, async: false };
}

function pickGroup(children: Link[], preference: ComponentKind[], fallbackToAll: boolean): Link[] {
  for (const kind of preference) {
    const matches = children.filter((c) => c.kind === kind);
    if (matches.length) return matches;
  }
  return fallbackToAll ? children : [];
}

function weighted(values: ClassFlow, by: ClassFlow): number {
  const sum = totalFlow(by);
  if (sum <= 0) return 0;
  return (values.static * by.static + values.read * by.read + values.write * by.write) / sum;
}

function maxOverActive(values: ClassFlow, by: ClassFlow): number {
  const sum = totalFlow(by);
  let max = 0;
  for (const cls of TRAFFIC_CLASSES) {
    if (by[cls] / sum > 0.01) max = Math.max(max, values[cls]);
  }
  return max;
}

function statusFor(utilization: number, inRps: number): NodeStatus {
  if (inRps <= 0) return 'idle';
  if (utilization < 0.6) return 'healthy';
  if (utilization < 0.85) return 'warm';
  if (utilization < 1) return 'hot';
  return 'overloaded';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
