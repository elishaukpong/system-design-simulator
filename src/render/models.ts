import * as THREE from 'three';
import { CATALOG } from '../sim/catalog';
import type { ComponentKind, NodeStatus } from '../sim/types';

export interface ComponentModel {
  kind: ComponentKind;
  root: THREE.Group;
  body: THREE.Group;
  tile: THREE.Mesh;
  ring: THREE.Mesh;
  hitbox: THREE.Mesh;
  units: THREE.Mesh[];
  segments: THREE.Mesh[];
  accents: THREE.Mesh[];
  lever: THREE.Object3D | null;
}

export const STATUS_COLOR: Record<NodeStatus, number> = {
  idle: 0x475569,
  healthy: 0x22c55e,
  warm: 0xeab308,
  hot: 0xf97316,
  overloaded: 0xef4444,
  down: 0x991b1b,
};

export const TILE = 3.2;

const geometryCache = new Map<string, THREE.BufferGeometry>();

function geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = geometryCache.get(key);
  if (!g) {
    g = make();
    geometryCache.set(key, g);
  }
  return g as T;
}

function mat(color: number, emissive = 0x000000, emissiveIntensity = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.55, metalness: 0.15, emissive, emissiveIntensity });
}

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function gridPositions(count: number, spacing: number, maxCols: number): Array<[number, number]> {
  const cols = Math.min(maxCols, Math.max(1, Math.ceil(Math.sqrt(count))));
  const rows = Math.ceil(count / cols);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push([(c - (cols - 1) / 2) * spacing, (r - (rows - 1) / 2) * spacing]);
  }
  return out;
}

export function visibleUnits(kind: ComponentKind, units: number): number {
  const caps: Partial<Record<ComponentKind, number>> = { app: 9, workers: 9, cache: 4, replica: 4, shard: 9, search: 4 };
  const cap = caps[kind];
  return cap ? Math.max(1, Math.min(cap, units)) : 1;
}

export function buildModel(kind: ComponentKind, unitCount: number): ComponentModel {
  const color = CATALOG[kind].color;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const tile = mesh(geo('tile', () => new THREE.BoxGeometry(TILE, 0.22, TILE)), mat(0x1e293b, STATUS_COLOR.idle, 0.15), 0, 0.11, 0);
  tile.castShadow = false;
  root.add(tile);

  const ring = new THREE.Mesh(
    geo('ring', () => new THREE.RingGeometry(TILE * 0.62, TILE * 0.72, 40).rotateX(-Math.PI / 2)),
    new THREE.MeshBasicMaterial({ color: STATUS_COLOR.idle, transparent: true, opacity: 0.0, depthWrite: false }),
  );
  ring.position.y = 0.24;
  root.add(ring);

  const hitbox = new THREE.Mesh(
    geo('hitbox', () => new THREE.BoxGeometry(TILE, 3, TILE)),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hitbox.position.y = 1.5;
  root.add(hitbox);

  const model: ComponentModel = { kind, root, body, tile, ring, hitbox, units: [], segments: [], accents: [], lever: null };
  const n = visibleUnits(kind, unitCount);
  const base = 0.22;

  switch (kind) {
    case 'clients': {
      const globe = mesh(geo('ico', () => new THREE.IcosahedronGeometry(0.95, 1)), mat(color, color, 0.25), 0, base + 1.2, 0);
      body.add(globe);
      model.accents.push(globe);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const device = mesh(geo('device', () => new THREE.BoxGeometry(0.22, 0.38, 0.06)), mat(0xe0f2fe), Math.cos(a) * 1.35, base + 0.5, Math.sin(a) * 1.35);
        device.rotation.y = -a;
        body.add(device);
      }
      break;
    }
    case 'dns': {
      body.add(mesh(geo('pole', () => new THREE.CylinderGeometry(0.08, 0.1, 1.4, 6)), mat(0x94a3b8), 0, base + 0.7, 0));
      const sign = mesh(geo('octa', () => new THREE.OctahedronGeometry(0.7, 0)), mat(color, color, 0.2), 0, base + 1.8, 0);
      body.add(sign);
      model.accents.push(sign);
      break;
    }
    case 'cdn': {
      const dome = mesh(geo('dome', () => new THREE.SphereGeometry(1.2, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)), mat(color, color, 0.15), 0, base, 0);
      body.add(dome);
      const halo = mesh(geo('halo', () => new THREE.TorusGeometry(1.35, 0.07, 6, 24).rotateX(Math.PI / 2)), mat(0xecfeff, color, 0.6), 0, base + 0.25, 0);
      body.add(halo);
      model.accents.push(halo);
      break;
    }
    case 'lb': {
      body.add(mesh(geo('hex', () => new THREE.CylinderGeometry(1.3, 1.3, 0.55, 6)), mat(color), 0, base + 0.28, 0));
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
        const arrow = mesh(geo('arrow', () => new THREE.ConeGeometry(0.22, 0.5, 4).rotateZ(-Math.PI / 2)), mat(0xf5f3ff, color, 0.4), Math.cos(a) * 0.7, base + 0.75, Math.sin(a) * 0.7);
        arrow.rotation.y = -a;
        body.add(arrow);
        model.accents.push(arrow);
      }
      break;
    }
    case 'gateway': {
      const pillar = geo('pillar', () => new THREE.BoxGeometry(0.35, 1.9, 0.35));
      body.add(mesh(pillar, mat(color), -0.95, base + 0.95, 0));
      body.add(mesh(pillar, mat(color), 0.95, base + 0.95, 0));
      const beam = mesh(geo('beam', () => new THREE.BoxGeometry(2.6, 0.3, 0.5)), mat(0xfdf4ff, color, 0.35), 0, base + 2.0, 0);
      body.add(beam);
      model.accents.push(beam);
      const bar = mesh(geo('gatebar', () => new THREE.BoxGeometry(1.6, 0.12, 0.12)), mat(0xfacc15, 0xfacc15, 0.3), 0, base + 0.9, 0);
      body.add(bar);
      model.lever = bar;
      break;
    }
    case 'app':
    case 'workers': {
      const rack = kind === 'app'
        ? geo('rack', () => new THREE.BoxGeometry(0.62, 1.7, 0.8))
        : geo('workerbox', () => new THREE.BoxGeometry(0.7, 0.7, 0.7));
      const spacing = kind === 'app' ? 0.85 : 0.9;
      for (const [x, z] of gridPositions(n, spacing, 3)) {
        const unit = mesh(rack, mat(color, color, 0.1), x, base + (kind === 'app' ? 0.85 : 0.35), z);
        body.add(unit);
        model.units.push(unit);
        if (kind === 'workers') {
          const gear = mesh(geo('gear', () => new THREE.TorusGeometry(0.22, 0.08, 4, 8).rotateX(Math.PI / 2)), mat(0x365314), x, base + 0.78, z);
          body.add(gear);
        } else {
          const stripe = mesh(geo('stripe', () => new THREE.BoxGeometry(0.64, 0.06, 0.82)), mat(0x052e16, 0x4ade80, 0.6), x, base + 1.35, z);
          body.add(stripe);
        }
      }
      break;
    }
    case 'cache': {
      for (const [x, z] of gridPositions(n, 1.15, 2)) {
        const shell = mesh(geo('cacheshell', () => new THREE.BoxGeometry(0.95, 0.95, 0.95)), new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.55, flatShading: true }), x, base + 0.6, z);
        const core = mesh(geo('cachecore', () => new THREE.OctahedronGeometry(0.32, 0)), mat(0xffe4e6, 0xf43f5e, 0.8), x, base + 0.6, z);
        body.add(shell, core);
        model.units.push(shell);
        model.accents.push(core);
      }
      break;
    }
    case 'db': {
      const disc = geo('dbdisc', () => new THREE.CylinderGeometry(1.1, 1.1, 0.5, 14));
      for (let i = 0; i < 3; i++) {
        const level = mesh(disc, mat(color), 0, base + 0.3 + i * 0.6, 0);
        body.add(level);
        model.units.push(level);
      }
      const cap = mesh(geo('dbcap', () => new THREE.CylinderGeometry(1.12, 1.12, 0.06, 14)), mat(0xffedd5, color, 0.5), 0, base + 1.6, 0);
      body.add(cap);
      model.accents.push(cap);
      break;
    }
    case 'replica':
    case 'shard':
    case 'search': {
      const small = geo('smalldisc', () => new THREE.CylinderGeometry(0.42, 0.42, 0.32, 10));
      const spacing = kind === 'shard' ? 0.95 : 1.15;
      for (const [x, z] of gridPositions(n, spacing, kind === 'shard' ? 3 : 2)) {
        if (kind === 'search') {
          const lens = mesh(geo('lens', () => new THREE.TorusGeometry(0.32, 0.08, 6, 14)), mat(color, color, 0.25), x, base + 0.75, z);
          const handle = mesh(geo('handle', () => new THREE.CylinderGeometry(0.06, 0.06, 0.5, 6)), mat(0x831843), x + 0.25, base + 0.3, z);
          handle.rotation.z = Math.PI / 5;
          body.add(lens, handle);
          model.units.push(lens);
          continue;
        }
        const levels = kind === 'shard' ? 2 : 3;
        for (let i = 0; i < levels; i++) {
          const level = mesh(small, mat(color), x, base + 0.2 + i * 0.38, z);
          body.add(level);
          if (i === levels - 1) model.units.push(level);
        }
      }
      break;
    }
    case 'objectStorage': {
      body.add(mesh(geo('bucket', () => new THREE.CylinderGeometry(1.15, 0.85, 1.5, 8, 1, true)), new THREE.MeshStandardMaterial({ color, flatShading: true, side: THREE.DoubleSide }), 0, base + 0.75, 0));
      const rim = mesh(geo('rim', () => new THREE.TorusGeometry(1.15, 0.08, 4, 16).rotateX(Math.PI / 2)), mat(0xccfbf1, color, 0.4), 0, base + 1.5, 0);
      body.add(rim);
      model.accents.push(rim);
      const fill = mesh(geo('bucketfill', () => new THREE.CylinderGeometry(0.95, 0.85, 0.9, 8)), mat(0x134e4a), 0, base + 0.45, 0);
      body.add(fill);
      break;
    }
    case 'queue': {
      body.add(mesh(geo('belt', () => new THREE.BoxGeometry(2.8, 0.25, 1.1)), mat(0x1e3a8a), 0, base + 0.25, 0));
      const rollers = geo('roller', () => new THREE.CylinderGeometry(0.2, 0.2, 1.2, 8).rotateX(Math.PI / 2));
      body.add(mesh(rollers, mat(0x93c5fd), -1.4, base + 0.25, 0), mesh(rollers, mat(0x93c5fd), 1.4, base + 0.25, 0));
      for (let i = 0; i < 8; i++) {
        const box = mesh(geo('msg', () => new THREE.BoxGeometry(0.26, 0.3, 0.7)), mat(color, color, 0.5), -1.15 + i * 0.33, base + 0.53, 0);
        body.add(box);
        model.segments.push(box);
      }
      break;
    }
    case 'breaker': {
      body.add(mesh(geo('breakerbox', () => new THREE.BoxGeometry(1.5, 1.1, 1.0)), mat(0x3f3f46), 0, base + 0.55, 0));
      const pivot = new THREE.Group();
      pivot.position.set(0, base + 1.1, 0);
      const handle = mesh(geo('lever', () => new THREE.BoxGeometry(0.18, 0.9, 0.18).translate(0, 0.45, 0)), mat(color, color, 0.4));
      pivot.add(handle);
      body.add(pivot);
      model.lever = pivot;
      model.accents.push(handle);
      break;
    }
    case 'external': {
      const puff = geo('puff', () => new THREE.IcosahedronGeometry(0.6, 1));
      const cloudMat = mat(color, 0xffffff, 0.08);
      const spots: Array<[number, number, number, number]> = [[-0.6, 1.0, 0, 1], [0.1, 1.25, 0.1, 1.25], [0.75, 1.0, -0.1, 0.95], [0, 0.85, 0.5, 0.9], [0.1, 0.9, -0.5, 0.9]];
      for (const [x, y, z, s] of spots) {
        const p = mesh(puff, cloudMat, x, base + y, z);
        p.scale.setScalar(s);
        body.add(p);
        model.accents.push(p);
      }
      break;
    }
  }

  return model;
}

export function disposeModel(model: ComponentModel): void {
  model.root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of materials) m.dispose();
    }
  });
}
