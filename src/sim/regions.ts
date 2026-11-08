export type RegionId = 'us-east' | 'eu-west' | 'ap-south';

export interface Region {
  id: RegionId;
  label: string;
  zMin: number;
  zMax: number;
  color: number;
}

export const REGIONS: Region[] = [
  { id: 'ap-south', label: 'ap-south · Mumbai', zMin: -138, zMax: -54, color: 0x1e1b3a },
  { id: 'us-east', label: 'us-east · Virginia', zMin: -42, zMax: 42, color: 0x0f1d33 },
  { id: 'eu-west', label: 'eu-west · Ireland', zMin: 54, zMax: 138, color: 0x0f2a2a },
];

export const HOME_REGION: RegionId = 'us-east';

const RTT_MS: Record<string, number> = {
  'us-east|eu-west': 75,
  'us-east|ap-south': 200,
  'eu-west|ap-south': 120,
};

export const SAME_REGION_RTT = 0.001;
export const LAST_MILE_RTT = 0.03;
export const EDGE_POP_RTT = 0.01;

export function regionAt(z: number): RegionId {
  let best = REGIONS[1];
  let bestDistance = Infinity;
  for (const region of REGIONS) {
    if (z >= region.zMin && z <= region.zMax) return region.id;
    const distance = Math.min(Math.abs(z - region.zMin), Math.abs(z - region.zMax));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = region;
    }
  }
  return best.id;
}

export function regionRtt(a: RegionId, b: RegionId): number {
  if (a === b) return SAME_REGION_RTT;
  const ms = RTT_MS[`${a}|${b}`] ?? RTT_MS[`${b}|${a}`];
  return ms / 1000;
}

export function regionLabel(id: RegionId): string {
  return REGIONS.find((r) => r.id === id)?.label ?? id;
}
