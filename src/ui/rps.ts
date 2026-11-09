export const MIN_RPS = 1;
export const MAX_RPS = 1_000_000;

const MULTIPLIER: Record<string, number> = { '': 1, k: 1_000, m: 1_000_000 };

export function parseRps(input: string): number | null {
  const match = input.trim().toLowerCase().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([km]?)\s*(?:rps)?$/);
  if (!match) return null;
  const value = Number(match[1]) * MULTIPLIER[match[2]];
  if (!isFinite(value) || value < MIN_RPS) return null;
  return Math.min(MAX_RPS, Math.round(value));
}
