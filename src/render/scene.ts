import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { numberParam } from '../sim/catalog';
import { REGIONS, regionAt, regionRtt } from '../sim/regions';
import { isAutoscaled, profileFor } from '../sim/profiles';
import type { Selection } from '../state/store';
import type { ComponentKind, Design, EdgeSpec, NodeMetrics, NodeSpec, SimSnapshot, TrafficClass } from '../sim/types';
import { TRAFFIC_CLASSES, totalFlow } from '../sim/types';
import { buildModel, disposeModel, STATUS_COLOR, TILE, visibleUnits, type ComponentModel } from './models';

export const GRID = 4;

const CLASS_COLOR: Record<TrafficClass | 'error', THREE.Color> = {
  static: new THREE.Color(0xa78bfa),
  read: new THREE.Color(0x38bdf8),
  write: new THREE.Color(0xfb923c),
  error: new THREE.Color(0xef4444),
};

const MAX_PARTICLES = 4000;
const MAX_SMOKE = 160;
const PARTICLE_SPEED = 7;

interface NodeView {
  spec: NodeSpec;
  model: ComponentModel;
  signature: string;
  label: CSS2DObject;
  labelName: HTMLElement;
  labelStat: HTMLElement;
  shake: number;
  smokeAccumulator: number;
}

interface EdgeView {
  spec: EdgeSpec;
  curve: THREE.QuadraticBezierCurve3;
  length: number;
  tube: THREE.Mesh;
  arrow: THREE.Mesh;
  hit: THREE.Mesh;
  rttLabel: CSS2DObject | null;
  shareLabel: CSS2DObject | null;
  spawn: Record<TrafficClass, number>;
  index: number;
}

export class SceneView {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  readonly scene = new THREE.Scene();
  private labels: CSS2DRenderer;
  private nodes = new Map<string, NodeView>();
  private edges = new Map<string, EdgeView>();
  private edgeList: EdgeView[] = [];
  private raycaster = new THREE.Raycaster();
  private ground: THREE.Mesh;
  private ghost: ComponentModel | null = null;
  private ghostKind: ComponentKind | null = null;
  private preview: THREE.Line;
  private selection: Selection = null;
  private particles: THREE.InstancedMesh;
  private pEdge = new Int32Array(MAX_PARTICLES).fill(-1);
  private pU = new Float32Array(MAX_PARTICLES);
  private pSpeed = new Float32Array(MAX_PARTICLES);
  private pCount = 0;
  private smoke: THREE.Sprite[] = [];
  private smokeLife = new Float32Array(MAX_SMOKE);
  private smokeNext = 0;
  private dummy = new THREE.Object3D();
  private labelTimer = 0;
  private time = 0;
  private hoverTarget: string | null = null;
  private edgeSignature = '';
  private regionLabels: THREE.Mesh[] = [];

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'label-layer';
    container.appendChild(this.labels.domElement);

    this.scene.background = new THREE.Color(0x0a0f1e);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500, 1000);
    this.camera.position.set(40, 40, 40);
    this.camera.zoom = 1;
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.minZoom = 0.25;
    this.controls.maxZoom = 4;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = 1.25;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };

    this.scene.add(new THREE.HemisphereLight(0xc7d2fe, 0x0f172a, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(25, 50, 15);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = sun.shadow.camera as THREE.OrthographicCamera;
    s.left = -80;
    s.right = 80;
    s.top = 80;
    s.bottom = -80;
    s.near = 1;
    s.far = 200;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x60a5fa, 0.6);
    rim.position.set(-30, 20, -25);
    this.scene.add(rim);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.95 }),
    );
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    for (const region of REGIONS) {
      const depth = region.zMax - region.zMin;
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(420, depth).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: region.color, roughness: 0.9 }),
      );
      plate.position.set(0, 0.004, (region.zMin + region.zMax) / 2);
      plate.receiveShadow = true;
      this.scene.add(plate);
      const border = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(420, depth).rotateX(-Math.PI / 2)),
        new THREE.LineBasicMaterial({ color: 0x334155 }),
      );
      border.position.copy(plate.position).setY(0.02);
      this.scene.add(border);
      const label = makeGroundLabel(region.label.toUpperCase());
      label.position.set(0, 0.03, region.zMin + 5);
      this.regionLabels.push(label);
      this.scene.add(label);
    }

    const grid = new THREE.GridHelper(600, 600 / GRID, 0x1e293b, 0x151e33);
    grid.position.y = 0.01;
    this.scene.add(grid);

    this.preview = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({ color: 0xfacc15, dashSize: 0.6, gapSize: 0.35 }),
    );
    this.preview.visible = false;
    this.scene.add(this.preview);

    this.particles = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.16, 6, 4),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
      MAX_PARTICLES,
    );
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particles.count = 0;
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);

    const smokeTexture = makeSmokeTexture();
    for (let i = 0; i < MAX_SMOKE; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTexture, color: 0x52525b, transparent: true, depthWrite: false, opacity: 0 }));
      sprite.visible = false;
      this.smoke.push(sprite);
      this.scene.add(sprite);
    }

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    const viewHeight = 60;
    const aspect = w / h;
    this.camera.left = (-viewHeight * aspect) / 2;
    this.camera.right = (viewHeight * aspect) / 2;
    this.camera.top = viewHeight / 2;
    this.camera.bottom = -viewHeight / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  fit(design: Design): void {
    if (design.nodes.length === 0) return;
    const xs = design.nodes.map((n) => n.x);
    const zs = design.nodes.map((n) => n.z);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) + 16;
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.controls.target.set(cx, 0, cz);
    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.zoom = THREE.MathUtils.clamp(60 / (span * 0.95), 0.4, 2);
    this.camera.updateProjectionMatrix();
  }

  syncDesign(design: Design): void {
    const minX = design.nodes.length ? Math.min(...design.nodes.map((n) => n.x)) : 0;
    for (const label of this.regionLabels) label.position.x = minX + 22;
    const ids = new Set(design.nodes.map((n) => n.id));
    for (const [id, view] of this.nodes) {
      if (!ids.has(id)) {
        this.removeNodeView(view);
        this.nodes.delete(id);
      }
    }
    for (const spec of design.nodes) {
      const units = profileFor(spec).units;
      const signature = `${spec.kind}:${visibleUnits(spec.kind, spec.kind === 'shard' ? numberParam(spec.params, 'shards', 4) : units)}`;
      let view = this.nodes.get(spec.id);
      if (view && view.signature !== signature) {
        this.removeNodeView(view);
        view = undefined;
      }
      if (!view) {
        view = this.createNodeView(spec, signature);
        this.nodes.set(spec.id, view);
      }
      view.spec = spec;
      view.model.root.position.set(spec.x, 0, spec.z);
      view.labelName.textContent = spec.name;
    }

    const edgeSignature = design.edges
      .map((e) => {
        const from = this.nodes.get(e.from)?.spec;
        const to = this.nodes.get(e.to)?.spec;
        return from && to ? `${e.id}:${from.x},${from.z}>${to.x},${to.z}:${e.latencyMs ?? 0}:${e.sharePct ?? ''}` : '';
      })
      .join('|');
    if (edgeSignature === this.edgeSignature) {
      this.applySelection();
      return;
    }
    this.edgeSignature = edgeSignature;
    for (const view of this.edges.values()) this.removeEdgeView(view);
    this.edges.clear();
    this.edgeList = [];
    for (const spec of design.edges) {
      const from = this.nodes.get(spec.from);
      const to = this.nodes.get(spec.to);
      if (!from || !to) continue;
      const view = this.createEdgeView(spec, from.spec, to.spec, this.edgeList.length);
      if (from.spec.kind === 'gateway') view.shareLabel = this.shareLabel(view, design);
      this.edges.set(spec.id, view);
      this.edgeList.push(view);
    }
    this.pCount = 0;
    this.pEdge.fill(-1);
    this.applySelection();
  }

  setSelection(selection: Selection): void {
    this.selection = selection;
    this.applySelection();
  }

  setHoverTarget(id: string | null): void {
    this.hoverTarget = id;
  }

  pickNode(clientX: number, clientY: number): string | null {
    this.setRay(clientX, clientY);
    const hits = this.raycaster.intersectObjects([...this.nodes.values()].map((v) => v.model.hitbox), false);
    if (!hits.length) return null;
    for (const [id, view] of this.nodes) if (view.model.hitbox === hits[0].object) return id;
    return null;
  }

  pickEdge(clientX: number, clientY: number): string | null {
    this.setRay(clientX, clientY);
    const hits = this.raycaster.intersectObjects(this.edgeList.map((e) => e.hit), false);
    if (!hits.length) return null;
    return this.edgeList.find((e) => e.hit === hits[0].object)?.spec.id ?? null;
  }

  groundPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    this.setRay(clientX, clientY);
    const hit = this.raycaster.intersectObject(this.ground, false)[0];
    return hit ? hit.point : null;
  }

  snap(point: THREE.Vector3): { x: number; z: number } {
    return { x: Math.round(point.x / GRID) * GRID, z: Math.round(point.z / GRID) * GRID };
  }

  showGhost(kind: ComponentKind | null, x = 0, z = 0, blocked = false): void {
    if (kind !== this.ghostKind) {
      if (this.ghost) {
        this.scene.remove(this.ghost.root);
        disposeModel(this.ghost);
        this.ghost = null;
      }
      this.ghostKind = kind;
      if (kind) {
        this.ghost = buildModel(kind, 1);
        this.ghost.root.traverse((obj) => {
          if (obj instanceof THREE.Mesh && obj.material instanceof THREE.Material) {
            obj.material.transparent = true;
            obj.material.opacity = 0.5;
            obj.castShadow = false;
          }
        });
        this.scene.add(this.ghost.root);
      }
    }
    if (this.ghost) {
      this.ghost.root.position.set(x, 0, z);
      (this.ghost.tile.material as THREE.MeshStandardMaterial).emissive.setHex(blocked ? 0xef4444 : 0x38bdf8);
      (this.ghost.tile.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.6;
    }
  }

  moveNodeVisual(id: string, x: number, z: number): void {
    const view = this.nodes.get(id);
    if (view) view.model.root.position.set(x, 0, z);
  }

  showPreview(fromId: string | null, to?: THREE.Vector3): void {
    if (!fromId || !to) {
      this.preview.visible = false;
      return;
    }
    const from = this.nodes.get(fromId);
    if (!from) return;
    const a = new THREE.Vector3(from.spec.x, 0.8, from.spec.z);
    const b = new THREE.Vector3(to.x, 0.8, to.z);
    this.preview.geometry.setFromPoints([a, b]);
    this.preview.computeLineDistances();
    this.preview.visible = true;
  }

  update(snap: SimSnapshot | null, frameDt: number, running: boolean): void {
    this.time += frameDt;
    this.labelTimer -= frameDt;
    const refreshLabels = this.labelTimer <= 0;
    if (refreshLabels) this.labelTimer = 0.2;

    for (const [id, current] of this.nodes) {
      const m = snap?.nodes[id] ?? null;
      const view = this.matchLiveInstances(current, m);
      this.animateNode(view, m, frameDt, running);
      if (refreshLabels) this.updateLabel(view, m);
    }

    for (const edge of this.edgeList) {
      const em = snap?.edges[edge.spec.id];
      const flow = em ? totalFlow(em.flow) : 0;
      const material = edge.tube.material as THREE.MeshStandardMaterial;
      const selected = this.selection?.type === 'edge' && this.selection.id === edge.spec.id;
      const base = new THREE.Color(flow > 0 ? 0x64748b : 0x334155);
      if (em && em.failFrac > 0.01) base.lerp(CLASS_COLOR.error, Math.min(1, em.failFrac * 1.5));
      if (selected) base.set(0xf8fafc);
      material.color.copy(base);
      material.emissive.copy(base);
      material.emissiveIntensity = selected ? 0.6 : flow > 0 ? 0.25 : 0.05;
      (edge.arrow.material as THREE.MeshStandardMaterial).color.copy(base);
      if (running && em) this.spawnParticles(edge, em.flow, em.failFrac, frameDt);
    }

    this.stepParticles(frameDt, running);
    this.stepSmoke(frameDt);
    this.controls.update();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  capture(snap: SimSnapshot | null, caption: string, scale = 2): HTMLCanvasElement {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const ratio = this.renderer.getPixelRatio();
    const selection = this.selection;
    const hover = this.hoverTarget;
    this.selection = null;
    this.hoverTarget = null;
    this.update(snap, 0, false);

    this.renderer.setPixelRatio(scale);
    this.renderer.setSize(width, height);
    this.renderer.render(this.scene, this.camera);

    const out = document.createElement('canvas');
    out.width = width * scale;
    out.height = height * scale;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(this.renderer.domElement, 0, 0, out.width, out.height);
    ctx.scale(scale, scale);

    const project = (point: THREE.Vector3) => {
      const p = point.clone().project(this.camera);
      return { x: ((p.x + 1) / 2) * width, y: ((1 - p.y) / 2) * height, visible: p.z < 1 && Math.abs(p.x) <= 1.1 && Math.abs(p.y) <= 1.1 };
    };

    for (const edge of this.edgeList) {
      if (edge.shareLabel) {
        const share = project(edge.shareLabel.position);
        if (share.visible) drawPill(ctx, edge.shareLabel.element.textContent ?? '', share.x, share.y, { text: '#f5d0fe', fill: 'rgba(7,11,22,0.85)', stroke: '#a21caf', dashed: false });
      }
      if (!edge.rttLabel) continue;
      const at = project(edge.rttLabel.position);
      if (at.visible) drawPill(ctx, edge.rttLabel.element.textContent ?? '', at.x, at.y, { text: '#fde68a', fill: 'rgba(7,11,22,0.85)', stroke: '#a16207', dashed: true });
    }

    for (const view of this.nodes.values()) {
      const at = project(view.model.root.position.clone().add(new THREE.Vector3(0, 3.4, 0)));
      if (!at.visible) continue;
      ctx.font = '600 11.5px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.shadowColor = '#000';
      ctx.shadowBlur = 6;
      ctx.fillStyle = '#f1f5f9';
      ctx.fillText(view.labelName.textContent ?? '', at.x, at.y - 8);
      ctx.shadowBlur = 0;
      const status = view.label.element.dataset.status ?? 'idle';
      drawPill(ctx, view.labelStat.textContent ?? '', at.x, at.y + 1, PILL_STYLE[status] ?? PILL_STYLE.idle);
    }

    ctx.fillStyle = 'rgba(7, 11, 22, 0.88)';
    ctx.fillRect(0, height - 30, width, 30);
    ctx.font = '600 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText('System Design Simulator', 12, height - 15);
    ctx.font = '11.5px JetBrains Mono, ui-monospace, monospace';
    ctx.fillStyle = '#8b9ab8';
    ctx.textAlign = 'right';
    ctx.fillText(caption, width - 12, height - 15);

    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height);
    this.selection = selection;
    this.hoverTarget = hover;
    this.applySelection();
    this.update(snap, 0, false);
    this.render();
    return out;
  }

  private animateNode(view: NodeView, m: NodeMetrics | null, dt: number, running: boolean): void {
    const model = view.model;
    const status = m?.status ?? 'idle';
    const color = STATUS_COLOR[status];
    const tileMat = model.tile.material as THREE.MeshStandardMaterial;
    tileMat.emissive.setHex(color);
    const pulse = status === 'overloaded' || status === 'down' ? 0.5 + 0.4 * Math.sin(this.time * 8) : 0.35;
    tileMat.emissiveIntensity = status === 'idle' ? 0.12 : pulse;

    const ringMat = model.ring.material as THREE.MeshBasicMaterial;
    const selected = this.selection?.type === 'node' && this.selection.id === view.spec.id;
    const hovered = this.hoverTarget === view.spec.id;
    ringMat.color.setHex(selected ? 0xf8fafc : hovered ? 0xfacc15 : color);
    ringMat.opacity = selected || hovered ? 0.9 : status === 'idle' || status === 'healthy' ? 0 : 0.55;

    const utilization = m?.utilization ?? 0;
    const targetShake = running && status !== 'down' && utilization > 0.9 ? Math.min(1, (utilization - 0.9) * 1.5) : 0;
    view.shake += (targetShake - view.shake) * Math.min(1, dt * 6);
    const amp = view.shake * 0.12;
    model.body.position.set((Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp * 0.4, (Math.random() - 0.5) * amp);
    model.body.rotation.z = status === 'down' ? THREE.MathUtils.lerp(model.body.rotation.z, 0.18, dt * 3) : THREE.MathUtils.lerp(model.body.rotation.z, 0, dt * 3);

    if (m && (model.kind === 'app' || model.kind === 'workers' || model.kind === 'cache' || model.kind === 'replica' || model.kind === 'search')) {
      const shown = model.units.length;
      const scale = m.totalInstances > 0 ? shown / Math.max(shown, m.totalInstances) : 1;
      const healthyShown = Math.round(m.healthyInstances * (m.totalInstances > shown ? scale : 1));
      const bootingShown = Math.round(m.bootingInstances * (m.totalInstances > shown ? scale : 1));
      model.units.forEach((unit, i) => {
        const mat = unit.material as THREE.MeshStandardMaterial;
        if (i < healthyShown) {
          mat.color.setHex(colorFor(model.kind));
          mat.emissive.setHex(colorFor(model.kind));
          mat.emissiveIntensity = 0.12 + Math.min(0.5, utilization * 0.3);
        } else if (i < healthyShown + bootingShown) {
          mat.color.setHex(0x334155);
          mat.emissive.setHex(colorFor(model.kind));
          mat.emissiveIntensity = 0.08 + 0.08 * Math.sin(this.time * 4 + i);
        } else {
          mat.color.setHex(0x3f1d1d);
          mat.emissive.setHex(0x7f1d1d);
          mat.emissiveIntensity = 0.3 + 0.3 * Math.sin(this.time * 6 + i);
        }
      });
    }

    if (model.kind === 'shard' && m) {
      const hot = (m.hotShardShare ?? 0) > 1.5 / Math.max(1, model.units.length) && m.utilization > 0.7;
      model.units.forEach((unit, i) => {
        const mat = unit.material as THREE.MeshStandardMaterial;
        const isHot = hot && i === 0;
        mat.emissive.setHex(isHot ? 0xef4444 : colorFor('shard'));
        mat.emissiveIntensity = isHot ? 0.6 + 0.3 * Math.sin(this.time * 9) : 0.1;
      });
    }

    if (model.kind === 'cache') {
      const hit = m?.hitRatio ?? 0;
      for (const core of model.accents) {
        (core.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.15 + hit * 1.2;
        core.rotation.y += dt * (0.5 + hit * 2);
      }
    }

    if (model.kind === 'queue') {
      const depth = m?.queueDepth ?? 0;
      const filled = depth <= 0 ? 0 : Math.min(model.segments.length, Math.ceil(Math.log10(depth + 1) * 1.3));
      model.segments.forEach((seg, i) => {
        seg.visible = i < filled || (running && (m?.servedRps ?? 0) > 0 && i === Math.floor((this.time * 4) % model.segments.length));
        (seg.material as THREE.MeshStandardMaterial).emissive.setHex(filled > 6 ? 0xef4444 : 0x3b82f6);
      });
    }

    if (model.kind === 'breaker' && model.lever) {
      const state = m?.breakerState ?? 'closed';
      const target = state === 'closed' ? -1.2 : state === 'open' ? 1.2 : 0;
      model.lever.rotation.z = THREE.MathUtils.lerp(model.lever.rotation.z, target, dt * 6);
      const handle = model.accents[0];
      const c = state === 'closed' ? 0x22c55e : state === 'open' ? 0xef4444 : 0xfacc15;
      (handle.material as THREE.MeshStandardMaterial).color.setHex(c);
      (handle.material as THREE.MeshStandardMaterial).emissive.setHex(c);
    }

    if (model.kind === 'gateway' && model.lever) {
      const shedding = (m?.shedRps ?? 0) > 0;
      model.lever.position.y = THREE.MathUtils.lerp(model.lever.position.y, shedding ? 0.22 + 0.9 : 0.22 + 1.6, dt * 5);
      ((model.lever as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive.setHex(shedding ? 0xef4444 : 0xfacc15);
    }

    if (model.kind === 'clients' && running) model.accents[0].rotation.y += dt * 0.6;
    if (model.kind === 'cdn' && running) model.accents[0].rotation.z += dt * 0.8;

    if (status === 'down' || (status === 'overloaded' && utilization > 1.3)) {
      view.smokeAccumulator += dt * (status === 'down' ? 10 : 5);
      while (view.smokeAccumulator >= 1) {
        view.smokeAccumulator -= 1;
        this.emitSmoke(view.spec.x, view.spec.z, status === 'down');
      }
    }
  }

  private updateLabel(view: NodeView, m: NodeMetrics | null): void {
    if (!m || m.inRps <= 0) {
      view.labelStat.textContent = m?.status === 'down' ? 'DOWN' : 'idle';
      view.label.element.dataset.status = m?.status ?? 'idle';
      return;
    }
    const parts = [`${formatRps(m.inRps)} rps`];
    if (view.spec.kind !== 'clients') parts.push(`${Math.round(m.utilization * 100)}%`);
    if (view.spec.kind === 'queue' && m.queueDepth) parts.push(`${formatCount(m.queueDepth)} queued`);
    if (view.spec.kind === 'cache' && m.hitRatio !== undefined) parts.push(`hit ${Math.round(m.hitRatio * 100)}%`);
    if ((view.spec.kind === 'app' || view.spec.kind === 'workers') && m.totalInstances > 0) parts.push(`${m.healthyInstances}/${m.totalInstances}`);
    if (m.status === 'down') parts.splice(0, parts.length, 'DOWN');
    view.labelStat.textContent = parts.join(' · ');
    view.label.element.dataset.status = m.status;
  }

  private spawnParticles(edge: EdgeView, flow: Record<TrafficClass, number>, failFrac: number, dt: number): void {
    for (const cls of TRAFFIC_CLASSES) {
      const rps = flow[cls];
      if (rps <= 0) continue;
      const rate = Math.min(28, 1.5 + Math.log10(rps + 1) * 5);
      edge.spawn[cls] += rate * dt;
      while (edge.spawn[cls] >= 1) {
        edge.spawn[cls] -= 1;
        if (this.pCount >= MAX_PARTICLES) return;
        const i = this.pCount++;
        this.pEdge[i] = edge.index;
        this.pU[i] = 0;
        this.pSpeed[i] = (PARTICLE_SPEED / edge.length) * (0.85 + Math.random() * 0.3);
        this.particles.setColorAt(i, Math.random() < failFrac ? CLASS_COLOR.error : CLASS_COLOR[cls]);
      }
    }
  }

  private stepParticles(dt: number, running: boolean): void {
    let i = 0;
    while (i < this.pCount) {
      const edge = this.edgeList[this.pEdge[i]];
      if (running) this.pU[i] += this.pSpeed[i] * dt;
      if (!edge || this.pU[i] >= 1) {
        const last = --this.pCount;
        this.pEdge[i] = this.pEdge[last];
        this.pU[i] = this.pU[last];
        this.pSpeed[i] = this.pSpeed[last];
        const c = new THREE.Color();
        this.particles.getColorAt(last, c);
        this.particles.setColorAt(i, c);
        continue;
      }
      edge.curve.getPointAt(this.pU[i], this.dummy.position);
      this.dummy.updateMatrix();
      this.particles.setMatrixAt(i, this.dummy.matrix);
      i++;
    }
    this.particles.count = this.pCount;
    this.particles.instanceMatrix.needsUpdate = true;
    if (this.particles.instanceColor) this.particles.instanceColor.needsUpdate = true;
  }

  private emitSmoke(x: number, z: number, heavy: boolean): void {
    const sprite = this.smoke[this.smokeNext];
    this.smokeLife[this.smokeNext] = 1;
    this.smokeNext = (this.smokeNext + 1) % MAX_SMOKE;
    sprite.visible = true;
    sprite.position.set(x + (Math.random() - 0.5) * 1.6, 2 + Math.random(), z + (Math.random() - 0.5) * 1.6);
    sprite.scale.setScalar(heavy ? 1.4 : 0.9);
    sprite.material.color.setHex(heavy ? 0x3f3f46 : 0x78716c);
  }

  private stepSmoke(dt: number): void {
    for (let i = 0; i < MAX_SMOKE; i++) {
      if (this.smokeLife[i] <= 0) continue;
      const sprite = this.smoke[i];
      this.smokeLife[i] -= dt / 2.2;
      sprite.position.y += dt * 1.6;
      sprite.position.x += dt * 0.4;
      sprite.scale.multiplyScalar(1 + dt * 0.6);
      sprite.material.opacity = Math.max(0, this.smokeLife[i]) * 0.65;
      if (this.smokeLife[i] <= 0) sprite.visible = false;
    }
  }

  private applySelection(): void {
    const div = this.labels.domElement;
    div.querySelectorAll('.node-label.selected').forEach((el) => el.classList.remove('selected'));
    if (this.selection?.type === 'node') this.nodes.get(this.selection.id)?.label.element.classList.add('selected');
  }

  private matchLiveInstances(view: NodeView, m: NodeMetrics | null): NodeView {
    if (!m || !isAutoscaled(view.spec) || m.totalInstances <= 0) return view;
    if (view.model.units.length === visibleUnits(view.spec.kind, m.totalInstances)) return view;
    this.removeNodeView(view);
    const rebuilt = this.createNodeView(view.spec, view.signature, m.totalInstances);
    rebuilt.model.root.position.set(view.spec.x, 0, view.spec.z);
    rebuilt.labelName.textContent = view.spec.name;
    rebuilt.labelStat.textContent = view.labelStat.textContent;
    this.nodes.set(view.spec.id, rebuilt);
    this.applySelection();
    return rebuilt;
  }

  private createNodeView(spec: NodeSpec, signature: string, liveUnits?: number): NodeView {
    const unitCount = liveUnits ?? (spec.kind === 'shard' ? numberParam(spec.params, 'shards', 4) : profileFor(spec).units);
    const model = buildModel(spec.kind, unitCount);
    this.scene.add(model.root);
    const element = document.createElement('div');
    element.className = 'node-label';
    const labelName = document.createElement('div');
    labelName.className = 'node-label-name';
    const labelStat = document.createElement('div');
    labelStat.className = 'node-label-stat';
    element.append(labelName, labelStat);
    const label = new CSS2DObject(element);
    label.position.set(0, 3.4, 0);
    model.root.add(label);
    return { spec, model, signature, label, labelName, labelStat, shake: 0, smokeAccumulator: 0 };
  }

  private removeNodeView(view: NodeView): void {
    view.label.element.remove();
    view.model.root.remove(view.label);
    this.scene.remove(view.model.root);
    disposeModel(view.model);
  }

  private createEdgeView(spec: EdgeSpec, from: NodeSpec, to: NodeSpec, index: number): EdgeView {
    const a = new THREE.Vector3(from.x, 0.9, from.z);
    const b = new THREE.Vector3(to.x, 0.9, to.z);
    const dir = b.clone().sub(a);
    const distance = dir.length();
    dir.normalize();
    const start = a.clone().addScaledVector(dir, Math.min(TILE * 0.45, distance * 0.3));
    const end = b.clone().addScaledVector(dir, -Math.min(TILE * 0.55, distance * 0.3));
    const mid = start.clone().lerp(end, 0.5);
    mid.y += 0.6 + distance * 0.09;
    const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.07, 6), new THREE.MeshStandardMaterial({ color: 0x334155, emissive: 0x334155 }));
    const hit = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, 0.45, 5), new THREE.MeshBasicMaterial({ visible: false }));
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.7, 8), new THREE.MeshStandardMaterial({ color: 0x334155 }));
    const tip = curve.getPointAt(0.97);
    const tangent = curve.getTangentAt(0.97);
    arrow.position.copy(tip);
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
    this.scene.add(tube, hit, arrow);
    let rttLabel: CSS2DObject | null = null;
    const fromRegion = regionAt(from.z);
    const toRegion = regionAt(to.z);
    if (from.kind !== 'clients' && from.kind !== 'dns' && to.kind !== 'dns' && fromRegion !== toRegion) {
      const el = document.createElement('div');
      el.className = 'rtt-label';
      el.textContent = `${Math.round(regionRtt(fromRegion, toRegion) * 1000 + (spec.latencyMs ?? 0))}ms`;
      rttLabel = new CSS2DObject(el);
      rttLabel.position.copy(curve.getPointAt(0.5));
      this.scene.add(rttLabel);
    }
    return { spec, curve, length: curve.getLength(), tube, arrow, hit, rttLabel, shareLabel: null, spawn: { static: 0, read: 0, write: 0 }, index };
  }

  private shareLabel(view: EdgeView, design: Design): CSS2DObject | null {
    const siblings = design.edges.filter((e) => e.from === view.spec.from);
    if (siblings.length < 2) return null;
    const total = siblings.reduce((sum, e) => sum + (e.sharePct ?? 100), 0);
    const el = document.createElement('div');
    el.className = 'share-label';
    el.textContent = `${total > 0 ? Math.round(((view.spec.sharePct ?? 100) / total) * 100) : 0}%`;
    const label = new CSS2DObject(el);
    label.position.copy(view.curve.getPointAt(view.rttLabel ? 0.3 : 0.62));
    this.scene.add(label);
    return label;
  }

  private removeEdgeView(view: EdgeView): void {
    for (const label of [view.rttLabel, view.shareLabel]) {
      if (!label) continue;
      label.element.remove();
      this.scene.remove(label);
    }
    for (const m of [view.tube, view.hit, view.arrow]) {
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }

  private setRay(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
  }
}

function colorFor(kind: ComponentKind): number {
  const colors: Partial<Record<ComponentKind, number>> = {
    app: 0x86efac,
    workers: 0xbef264,
    cache: 0xfca5a5,
    replica: 0xfcd34d,
    shard: 0xfb923c,
    search: 0xf9a8d4,
  };
  return colors[kind] ?? 0xffffff;
}

interface PillStyle {
  text: string;
  fill: string;
  stroke: string;
  dashed?: boolean;
}

const PILL_STYLE: Record<string, PillStyle> = {
  idle: { text: '#8b9ab8', fill: 'rgba(7,11,22,0.8)', stroke: '#23304d' },
  healthy: { text: '#86efac', fill: 'rgba(7,11,22,0.8)', stroke: '#23304d' },
  warm: { text: '#fde047', fill: 'rgba(7,11,22,0.8)', stroke: '#574b12' },
  hot: { text: '#fdba74', fill: 'rgba(7,11,22,0.8)', stroke: '#6b3410' },
  overloaded: { text: '#fecaca', fill: 'rgba(127,29,29,0.85)', stroke: '#ef4444' },
  down: { text: '#ffffff', fill: '#7f1d1d', stroke: '#ef4444' },
};

function drawPill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, style: PillStyle): void {
  if (!text) return;
  ctx.font = '10.5px JetBrains Mono, ui-monospace, monospace';
  const w = ctx.measureText(text).width + 12;
  const h = 16;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y, w, h, 6);
  ctx.fillStyle = style.fill;
  ctx.fill();
  ctx.setLineDash(style.dashed ? [3, 2] : []);
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = style.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + h / 2 + 0.5);
}

function makeGroundLabel(text: string): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '600 64px Inter, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(
    new THREE.PlaneGeometry(64, 8).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
}

function makeSmokeTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

export function formatRps(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(0)}k`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  if (value >= 10) return value.toFixed(0);
  return value.toFixed(1);
}

export function formatCount(value: number): string {
  return formatRps(value);
}
