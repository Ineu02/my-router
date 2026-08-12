import * as THREE from 'three';
import type { HealthStatus, TopologyNode, TopologyView } from '@router/shared';
import type { SceneCallbacks, TopologyRenderer } from './renderer';

/**
 * The 3D topology: CLIENT → ROUTER → PROVIDERS.
 *
 * Nothing here is decorative — every visual maps to live data:
 *   • node colour   → health status (ONLINE/DEGRADED/RATE_LIMITED/OFFLINE/DISABLED)
 *   • node size     → provider priority
 *   • latency ring  → avg latency (larger = slower)
 *   • edge weight   → share of recent traffic; brightness → on the active ladder
 *   • traffic pulse → a real request routed / attempted (driven by SSE)
 *
 * Providers orbit the router on a horizontal ring; the client feeds it from
 * above. A lightweight custom orbit (drag / wheel) avoids pulling in an addon.
 */

const HEALTH_COLOR: Record<HealthStatus, number> = {
  ONLINE: 0x46c08a,
  DEGRADED: 0xd4af37,
  RATE_LIMITED: 0xe0913a,
  OFFLINE: 0xd1495b,
  DISABLED: 0x565663,
};

const GOLD = 0xd4af37;
const VIOLET = 0x8b7bd8;

const PROVIDER_RADIUS = 8.5;
const CLIENT_POS = new THREE.Vector3(0, 7.6, 0);
const ROUTER_POS = new THREE.Vector3(0, 0, 0);
const AUTOSPIN = 0.06; // rad/s

interface NodeVisual {
  id: string;
  group: THREE.Group;
  body: THREE.Mesh;
  shell: THREE.Mesh;
  ring: THREE.Mesh;
  glow: THREE.Sprite;
  label: THREE.Sprite;
  data: TopologyNode;
  basePos: THREE.Vector3;
  hover: number; // 0..1 eased hover/selection lift
  selected: boolean;
}

interface EdgeVisual {
  to: string;
  mesh: THREE.Mesh;
  base: number; // resting opacity from share
  active: boolean;
  boost: number; // transient highlight 0..1
}

interface Pulse {
  sprite: THREE.Sprite;
  from: THREE.Vector3 | NodeVisual;
  to: THREE.Vector3 | NodeVisual;
  t: number;
  speed: number;
}

export class TopologyScene implements TopologyRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly spinGroup = new THREE.Group(); // providers + their edges
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2(-2, -2);

  private nodes = new Map<string, NodeVisual>();
  private edges = new Map<string, EdgeVisual>();
  private readonly pulses: Pulse[] = [];
  private readonly pool: THREE.Sprite[] = [];
  private router!: THREE.Mesh;
  private routerGlow!: THREE.Sprite;

  private readonly glowTex: THREE.Texture;
  private readonly bodyGeo = new THREE.IcosahedronGeometry(1, 1);
  private readonly ringGeo = new THREE.TorusGeometry(1.5, 0.05, 8, 48);

  private raf = 0;
  private spin = 0;
  private disposed = false;

  // orbit state (spherical around target)
  private theta = 0.6;
  private phi = 1.15;
  private radius = 19;
  private dragging = false;
  private moved = false;
  private lastX = 0;
  private lastY = 0;
  private hovered: string | null = null;

  private readonly ro: ResizeObserver;

  constructor(
    private readonly host: HTMLElement,
    private readonly cb: SceneCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    host.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.1, 200);
    this.scene.fog = new THREE.FogExp2(0x050505, 0.021);
    this.glowTex = makeGlowTexture();

    this.buildStaticScene();
    this.scene.add(this.spinGroup);

    this.bindInput();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();

    this.loop();
  }

  /* ── scaffolding that never changes ─────────────────────────────────── */

  private buildStaticScene(): void {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.PointLight(GOLD, 60, 80);
    key.position.set(6, 10, 12);
    this.scene.add(key);
    const rim = new THREE.PointLight(VIOLET, 30, 90);
    rim.position.set(-12, -4, -8);
    this.scene.add(rim);

    // Router — a gold octahedron at the centre.
    this.router = new THREE.Mesh(
      new THREE.OctahedronGeometry(1.5, 0),
      new THREE.MeshStandardMaterial({
        color: 0x1a1608,
        emissive: GOLD,
        emissiveIntensity: 0.9,
        metalness: 0.6,
        roughness: 0.3,
      }),
    );
    this.router.position.copy(ROUTER_POS);
    this.scene.add(this.router);

    this.routerGlow = this.makeGlow(GOLD, 7);
    this.routerGlow.position.copy(ROUTER_POS);
    this.scene.add(this.routerGlow);
    this.scene.add(this.makeLabel('ROUTER', GOLD, ROUTER_POS.clone().add(new THREE.Vector3(0, 2.6, 0)), 0.62));

    // Client — a violet node above, feeding the router.
    const client = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.5, 1.5),
      new THREE.MeshStandardMaterial({ color: 0x14121f, emissive: VIOLET, emissiveIntensity: 0.7, metalness: 0.4, roughness: 0.4 }),
    );
    client.position.copy(CLIENT_POS);
    client.rotation.set(0.5, 0.5, 0);
    this.scene.add(client);
    this.scene.add(this.makeGlow(VIOLET, 5).translateX(CLIENT_POS.x).translateY(CLIENT_POS.y).translateZ(CLIENT_POS.z));
    this.scene.add(this.makeLabel('CLIENT', VIOLET, CLIENT_POS.clone().add(new THREE.Vector3(0, 2, 0)), 0.55));

    // Client → Router trunk (static).
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 1, 6),
      new THREE.MeshBasicMaterial({ color: VIOLET, transparent: true, opacity: 0.4 }),
    );
    orientCylinder(trunk, CLIENT_POS, ROUTER_POS);
    this.scene.add(trunk);
  }

  /* ── topology → meshes ──────────────────────────────────────────────── */

  setTopology(view: TopologyView): void {
    const seen = new Set<string>();

    view.nodes.forEach((node, i) => {
      seen.add(node.id);
      const angle = (i / Math.max(1, view.nodes.length)) * Math.PI * 2;
      const basePos = new THREE.Vector3(Math.cos(angle) * PROVIDER_RADIUS, 0, Math.sin(angle) * PROVIDER_RADIUS);
      const existing = this.nodes.get(node.id);
      if (existing) {
        existing.data = node;
        existing.basePos.copy(basePos);
        existing.group.position.copy(basePos);
        this.styleNode(existing);
      } else {
        this.nodes.set(node.id, this.createNode(node, basePos));
      }
    });

    // Drop providers that no longer exist.
    for (const [id, node] of this.nodes) {
      if (!seen.has(id)) {
        this.spinGroup.remove(node.group);
        disposeObject(node.group);
        this.nodes.delete(id);
      }
    }

    // Edges follow the node set.
    const edgeSeen = new Set<string>();
    for (const edge of view.edges) {
      edgeSeen.add(edge.to);
      const target = this.nodes.get(edge.to);
      if (!target) continue;
      const opacity = 0.12 + Math.min(0.6, edge.share * 0.7);
      let ev = this.edges.get(edge.to);
      if (!ev) {
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(1, 1, 1, 6),
          new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity }),
        );
        this.spinGroup.add(mesh);
        ev = { to: edge.to, mesh, base: opacity, active: edge.active, boost: 0 };
        this.edges.set(edge.to, ev);
      }
      ev.base = opacity;
      ev.active = edge.active;
      const radius = 0.03 + Math.min(0.14, edge.share * 0.18);
      orientCylinder(ev.mesh, ROUTER_POS, target.basePos, radius);
      (ev.mesh.material as THREE.MeshBasicMaterial).color.setHex(edge.active ? GOLD : 0x4a4636);
    }
    for (const [id, ev] of this.edges) {
      if (!edgeSeen.has(id)) {
        this.spinGroup.remove(ev.mesh);
        disposeObject(ev.mesh);
        this.edges.delete(id);
      }
    }
  }

  private createNode(node: TopologyNode, basePos: THREE.Vector3): NodeVisual {
    const group = new THREE.Group();
    group.position.copy(basePos);

    const color = HEALTH_COLOR[node.status];
    const body = new THREE.Mesh(
      this.bodyGeo,
      new THREE.MeshStandardMaterial({ color: 0x0c0c10, emissive: color, emissiveIntensity: 0.85, metalness: 0.5, roughness: 0.35 }),
    );
    const shell = new THREE.Mesh(
      this.bodyGeo,
      new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.22 }),
    );
    shell.scale.setScalar(1.35);
    const ring = new THREE.Mesh(
      this.ringGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 }),
    );
    ring.rotation.x = Math.PI / 2;
    const glow = this.makeGlow(color, 4.5);
    const label = this.makeLabel(node.label, color, new THREE.Vector3(0, 2.3, 0), 0.5);

    group.add(body, shell, ring, glow, label);
    this.spinGroup.add(group);

    const visual: NodeVisual = { id: node.id, group, body, shell, ring, glow, label, data: node, basePos: basePos.clone(), hover: 0, selected: false };
    this.styleNode(visual);
    return visual;
  }

  private styleNode(v: NodeVisual): void {
    const { data } = v;
    const color = HEALTH_COLOR[data.status];
    const size = 0.62 + (data.priority / 100) * 0.7;
    v.group.scale.setScalar(size);

    (v.body.material as THREE.MeshStandardMaterial).emissive.setHex(color);
    (v.shell.material as THREE.MeshBasicMaterial).color.setHex(color);
    (v.ring.material as THREE.MeshBasicMaterial).color.setHex(color);
    v.glow.material.color.setHex(color);

    const dim = data.status === 'DISABLED';
    (v.body.material as THREE.MeshStandardMaterial).emissiveIntensity = dim ? 0.25 : 0.85;
    v.glow.material.opacity = dim ? 0.15 : 0.6;

    // Latency ring grows with slowness.
    const ringScale = 1 + Math.min(1.4, data.latencyMs / 1400);
    v.ring.scale.setScalar(ringScale);
  }

  /* ── live activity ──────────────────────────────────────────────────── */

  /** A request has been routed — pulse client → router, then light the ladder. */
  routePulse(ladder: string[]): void {
    this.spawnPulse(CLIENT_POS, ROUTER_POS, GOLD, 3.4);
    for (const spec of ladder) {
      const id = spec.split('/')[0];
      if (id) {
        const ev = this.edges.get(id);
        if (ev) ev.boost = Math.max(ev.boost, 0.6);
      }
    }
  }

  /** An attempt hit a provider — pulse router → provider, colour by outcome. */
  attemptPulse(providerId: string, ok: boolean): void {
    const node = this.nodes.get(providerId);
    if (!node) return;
    this.spawnPulse(ROUTER_POS, node, ok ? 0x46c08a : 0xd1495b, 4.2);
    const ev = this.edges.get(providerId);
    if (ev) ev.boost = 1;
  }

  /** A fallback deflected traffic away from a provider. */
  fallbackPulse(fromId: string): void {
    const ev = this.edges.get(fromId);
    if (ev) ev.boost = 1;
    const node = this.nodes.get(fromId);
    if (node) this.spawnPulse(node, ROUTER_POS, 0xe0913a, 4);
  }

  select(providerId: string | null): void {
    for (const node of this.nodes.values()) node.selected = node.id === providerId;
  }

  private spawnPulse(from: THREE.Vector3 | NodeVisual, to: THREE.Vector3 | NodeVisual, color: number, speed: number): void {
    const sprite = this.pool.pop() ?? this.makeGlow(color, 1.1);
    sprite.material.color.setHex(color);
    sprite.material.opacity = 1;
    sprite.visible = true;
    if (!sprite.parent) this.scene.add(sprite);
    this.pulses.push({ sprite, from, to, t: 0, speed });
  }

  /* ── render loop ────────────────────────────────────────────────────── */

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    const now = this.clock.elapsedTime;

    if (!this.dragging) this.spin += dt * AUTOSPIN;
    this.spinGroup.rotation.y = this.spin;
    this.router.rotation.y += dt * 0.4;
    this.router.rotation.x += dt * 0.15;

    // Node idle motion, hover lift, rate-limit ring pulse.
    for (const node of this.nodes.values()) {
      const target = node.selected ? 1 : node.id === this.hovered ? 0.6 : 0;
      node.hover += (target - node.hover) * Math.min(1, dt * 10);
      node.group.position.y = node.basePos.y + Math.sin(now * 1.3 + node.basePos.x) * 0.12 + node.hover * 0.6;
      node.body.rotation.y += dt * 0.6;
      const pulse = node.data.status === 'RATE_LIMITED' ? 0.5 + Math.abs(Math.sin(now * 4)) * 0.5 : node.data.status === 'ONLINE' ? 0.5 + Math.sin(now * 2 + node.basePos.z) * 0.12 : 0.5;
      (node.ring.material as THREE.MeshBasicMaterial).opacity = 0.2 + pulse * 0.5;
      const sel = 1 + node.hover * 0.18;
      node.shell.scale.setScalar(1.35 * sel);
    }

    // Router glow breathes.
    this.routerGlow.material.opacity = 0.55 + Math.sin(now * 1.6) * 0.15;

    // Edge highlight decay.
    for (const ev of this.edges.values()) {
      if (ev.boost > 0) ev.boost = Math.max(0, ev.boost - dt * 1.2);
      const mat = ev.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = ev.base + ev.boost * 0.4;
    }

    this.advancePulses(dt);
    this.updateCamera();
    this.updateHover();
    this.renderer.render(this.scene, this.camera);
  };

  private advancePulses(dt: number): void {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i];
      if (!p) continue;
      p.t += dt * (p.speed / worldDistance(p.from, p.to, a, b));
      resolvePoint(p.from, a);
      resolvePoint(p.to, b);
      p.sprite.position.lerpVectors(a, b, Math.min(1, p.t));
      const mat = p.sprite.material;
      mat.opacity = p.t > 0.8 ? Math.max(0, (1 - p.t) / 0.2) : 1;
      if (p.t >= 1) {
        p.sprite.visible = false;
        this.pool.push(p.sprite);
        this.pulses.splice(i, 1);
      }
    }
  }

  private updateCamera(): void {
    const sinPhi = Math.sin(this.phi);
    this.camera.position.set(
      this.radius * sinPhi * Math.sin(this.theta),
      this.radius * Math.cos(this.phi) + 1.5,
      this.radius * sinPhi * Math.cos(this.theta),
    );
    this.camera.lookAt(0, 0.6, 0);
  }

  private updateHover(): void {
    if (this.pointer.x < -1) return;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const entries = [...this.nodes.values()];
    const hit = this.raycaster.intersectObjects(entries.map((n) => n.body), false)[0];
    const id = hit ? (entries.find((n) => n.body === hit.object)?.id ?? null) : null;
    if (id !== this.hovered) {
      this.hovered = id;
      this.host.style.cursor = id ? 'pointer' : 'grab';
      this.cb.onHover(id);
    }
  }

  /* ── input ──────────────────────────────────────────────────────────── */

  private bindInput(): void {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.moved = false;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
      this.host.style.cursor = 'grabbing';
    });
    el.addEventListener('pointermove', (e) => {
      const rect = el.getBoundingClientRect();
      this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.moved = true;
      this.theta -= dx * 0.006;
      this.phi = Math.min(Math.PI - 0.25, Math.max(0.25, this.phi - dy * 0.006));
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    const end = (e: PointerEvent): void => {
      if (this.dragging && !this.moved) this.cb.onSelect(this.hovered);
      this.dragging = false;
      this.host.style.cursor = this.hovered ? 'pointer' : 'grab';
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointerleave', () => {
      this.pointer.set(-2, -2);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.radius = Math.min(38, Math.max(9, this.radius + Math.sign(e.deltaY) * 1.4));
      },
      { passive: false },
    );
    this.host.style.cursor = 'grab';
  }

  /* ── factories / lifecycle ──────────────────────────────────────────── */

  private makeGlow(color: number, scale: number): THREE.Sprite {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.glowTex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.6 }),
    );
    sprite.scale.setScalar(scale);
    return sprite;
  }

  private makeLabel(text: string, color: number, offset: THREE.Vector3, scale: number): THREE.Sprite {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: makeLabelTexture(text, color), transparent: true, depthWrite: false }),
    );
    sprite.position.copy(offset);
    sprite.scale.set(scale * 4, scale, 1);
    return sprite;
  }

  resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.renderer.dispose();
    this.bodyGeo.dispose();
    this.ringGeo.dispose();
    this.glowTex.dispose();
    this.renderer.domElement.remove();
  }
}

/* ── free helpers ─────────────────────────────────────────────────────── */

function resolvePoint(p: THREE.Vector3 | NodeVisual, out: THREE.Vector3): void {
  if (p instanceof THREE.Vector3) out.copy(p);
  else p.group.getWorldPosition(out);
}

function worldDistance(from: THREE.Vector3 | NodeVisual, to: THREE.Vector3 | NodeVisual, a: THREE.Vector3, b: THREE.Vector3): number {
  resolvePoint(from, a);
  resolvePoint(to, b);
  return Math.max(1, a.distanceTo(b));
}

/** Position and orient a Y-aligned cylinder so it spans a→b. */
function orientCylinder(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, radius?: number): void {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  if (radius !== undefined) mesh.scale.set(radius / 1, len, radius / 1);
  else mesh.scale.set(1, len, 1);
}

function makeGlowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.2, 'rgba(255,255,255,0.7)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function makeLabelTexture(text: string, color: number): THREE.Texture {
  const w = 256;
  const h = 64;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, w, h);
    ctx.font = '600 30px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const hex = `#${color.toString(16).padStart(6, '0')}`;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = hex;
    const clipped = text.length > 16 ? `${text.slice(0, 15)}…` : text;
    ctx.fillText(clipped.toUpperCase(), w / 2, h / 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.Sprite) {
      const mesh = obj as THREE.Mesh & { material: THREE.Material | THREE.Material[] };
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
  });
}
