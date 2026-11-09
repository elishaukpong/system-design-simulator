export type ComponentKind =
  | 'clients'
  | 'dns'
  | 'cdn'
  | 'lb'
  | 'gateway'
  | 'app'
  | 'workers'
  | 'cache'
  | 'db'
  | 'replica'
  | 'shard'
  | 'objectStorage'
  | 'search'
  | 'queue'
  | 'breaker'
  | 'external';

export type TrafficClass = 'static' | 'read' | 'write';

export const TRAFFIC_CLASSES: TrafficClass[] = ['static', 'read', 'write'];

export type ClassFlow = Record<TrafficClass, number>;

export type ParamValue = number | boolean | string;

export interface NodeSpec {
  id: string;
  kind: ComponentKind;
  name: string;
  x: number;
  z: number;
  params: Record<string, ParamValue>;
  locked?: boolean;
}

export interface EdgeSpec {
  id: string;
  from: string;
  to: string;
  latencyMs?: number;
  sharePct?: number;
  locked?: boolean;
}

export interface Design {
  nodes: NodeSpec[];
  edges: EdgeSpec[];
}

export type TrafficShape = 'steady' | 'ramp' | 'spike' | 'wave';

export interface TrafficSettings {
  peakRps: number;
  shape: TrafficShape;
}

export type NodeStatus = 'idle' | 'healthy' | 'warm' | 'hot' | 'overloaded' | 'down';

export type PressureReason =
  | 'cpu'
  | 'concurrency'
  | 'connections'
  | 'backlog'
  | 'down'
  | 'rate-limit'
  | 'hot-shard'
  | 'replication-lag'
  | 'no-backend'
  | 'cold-cache'
  | 'provider-limit'
  | 'breaker-open'
  | 'write-ceiling';

export interface NodeMetrics {
  region: string;
  inRps: number;
  inByClass: ClassFlow;
  servedRps: number;
  droppedRps: number;
  shedRps: number;
  utilization: number;
  concurrencyUtil: number;
  ownLatency: number;
  ownP99: number;
  pathLatency: number;
  pathP99: number;
  successFrac: number;
  backlog: number;
  status: NodeStatus;
  reason: PressureReason | null;
  healthyInstances: number;
  bootingInstances: number;
  totalInstances: number;
  hitRatio?: number;
  replicationLag?: number;
  queueDepth?: number;
  queueLagSeconds?: number;
  dlqDepth?: number;
  inFlight?: number;
  retryRps?: number;
  breakerState?: BreakerState;
  hotShardShare?: number;
  costPerMonth: number;
}

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface EdgeMetrics {
  flow: ClassFlow;
  failFrac: number;
  rtt: number;
  crossRegion: boolean;
}

export interface SimEvent {
  t: number;
  nodeId: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface GlobalMetrics {
  t: number;
  offeredRps: number;
  attemptedRps: number;
  retryAmplification: number;
  successRps: number;
  errorRate: number;
  shedRate: number;
  p50: number;
  p99: number;
  costPerMonth: number;
  asyncFailedRps: number;
  deadLetteredTotal: number;
  lostTotal: number;
  duplicatesTotal: number;
}

export interface SimSnapshot {
  global: GlobalMetrics;
  nodes: Record<string, NodeMetrics>;
  edges: Record<string, EdgeMetrics>;
}

export const zeroFlow = (): ClassFlow => ({ static: 0, read: 0, write: 0 });

export const totalFlow = (f: ClassFlow): number => f.static + f.read + f.write;
