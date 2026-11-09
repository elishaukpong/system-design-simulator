import type { SavedState } from '../state/store';
import type { Design, SimEvent, SimSnapshot, TrafficSettings } from '../sim/types';

export interface LearnContext {
  snap: SimSnapshot | null;
  design: Design;
  traffic: TrafficSettings;
  events: SimEvent[];
}

export interface Check {
  label: string;
  test: (ctx: LearnContext) => boolean;
  holdS?: number;
}

export interface Focus {
  node?: string;
  element?: string;
}

export interface LessonStep {
  title: string;
  body: string;
  setup?: () => SavedState;
  run?: boolean;
  speed?: number;
  focus?: Focus;
  task?: Check;
}

export interface Exercise {
  id: string;
  title: string;
  brief: string[];
  start: () => SavedState;
  checks: Check[];
  speed?: number;
}

export interface Lesson {
  id: string;
  days: number[];
  topic: string;
  title: string;
  essence: string;
  steps: LessonStep[];
  exercises: Exercise[];
}
