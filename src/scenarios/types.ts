import type { ComponentKind, Design, ParamValue } from '../sim/types';

export type CriterionRole = 'core' | 'budget' | 'bonus';

export type Criterion =
  | { type: 'availability'; min: number }
  | { type: 'p99'; maxMs: number; withinPct: number }
  | { type: 'cost'; max: number }
  | { type: 'shed'; maxPct: number }
  | { type: 'queueLag'; maxS: number }
  | { type: 'replicationLag'; maxS: number }
  | { type: 'retryAmplification'; max: number }
  | { type: 'chaosAvailability'; min: number; from: number; to: number };

export interface GradedCriterion {
  criterion: Criterion;
  role: CriterionRole;
}

export type ChaosEvent =
  | { at: number; action: 'kill'; target: ComponentKind; seconds: number; fraction?: number; message: string }
  | { at: number; action: 'flush'; target: 'cache'; message: string }
  | { at: number; action: 'degrade'; target: ComponentKind; seconds: number; params: Record<string, ParamValue>; message: string };

export interface Spike {
  at: number;
  length: number;
  multiplier: number;
}

export interface Scenario {
  id: string;
  title: string;
  difficulty: 1 | 2 | 3;
  tagline: string;
  brief: string[];
  facts: string[];
  duration: number;
  keyframes: Array<[t: number, rps: number]>;
  spikes?: Spike[];
  clients: Record<string, ParamValue>;
  lockedParams?: Partial<Record<ComponentKind, Record<string, ParamValue>>>;
  start: () => Design;
  criteria: GradedCriterion[];
  chaos: ChaosEvent[];
  hints: string[];
  curriculum: string[];
}

export interface Sample {
  t: number;
  offered: number;
  success: number;
  errorRate: number;
  shedRate: number;
  p99: number;
  cost: number;
  retryAmplification: number;
  queueLag: number;
  replicationLag: number;
  binding: { nodeId: string; name: string; reason: string | null } | null;
}

export interface CriterionResult {
  label: string;
  target: string;
  measured: string;
  pass: boolean;
  role: CriterionRole;
}

export interface Wall {
  t: number;
  rps: number;
  nodeId: string;
  name: string;
  reason: string | null;
}

export interface Tradeoff {
  text: string;
  curriculum: string;
}

export interface ChaosLogEntry {
  t: number;
  message: string;
  applied: boolean;
}

export interface RunResult {
  scenarioId: string;
  passed: boolean;
  stars: number;
  criteria: CriterionResult[];
  walls: Wall[];
  tradeoffs: Tradeoff[];
  samples: Sample[];
  chaos: ChaosLogEntry[];
  averageCost: number;
}
