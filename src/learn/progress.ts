const KEY = 'sds:learn:progress:v1';

export interface LearnProgress {
  lessons: Record<string, true>;
  exercises: Record<string, true>;
}

export function loadLearnProgress(): LearnProgress {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { lessons: parsed.lessons ?? {}, exercises: parsed.exercises ?? {} };
  } catch {
    return { lessons: {}, exercises: {} };
  }
}

export function markLearned(kind: keyof LearnProgress, id: string): void {
  const progress = loadLearnProgress();
  progress[kind][id] = true;
  try {
    localStorage.setItem(KEY, JSON.stringify(progress));
  } catch {
    // Progress ticks are a convenience; the lessons work without them.
  }
}
