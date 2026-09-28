// The 3D vat: build plate with a UV underglow, print volume, models, supports, drain holes and cavity previews.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const COLORS = {
  vat: 0x12161c, plate: 0x3a3f45, grid: 0x5a616a, volume: 0x3d444d, uv: 0x7a3ff2,
  model: 0xb6bcc3, modelSel: 0xc4c2d8, out: 0xe45f4e, support: 0x4fc79a, hole: 0xe45f4e, cavity: 0x8d63ff,
};

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 20, 128, 128, 128);
  g.addColorStop(0, 'rgba(140,92,255,0.9)');
  g.addColorStop(0.55, 'rgba(122,63,242,0.35)');
  g.addColorStop(1, 'rgba(122,63,242,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Viewport {
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.h = handlers;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.localClippingEnabled = true;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(COLORS.vat);
    this.scene.fog = new THREE.Fog(COLORS.vat, 900, 1800);
    this.camera = new THREE.PerspectiveCamera(36, 1, 1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(140, -320, 210);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 30);
    this.controls.maxPolarAngle = Math.PI * 0.56;
    this.controls.minDistance = 25;
    this.controls.maxDistance = 1500;
    this.controls.addEventListener('change', () => this.invalidate());

    const hemi = new THREE.HemisphereLight(0xe3e8ee, 0x3c2d6a, 1.6);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(120, -220, 260);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xc9d4ff, 0.9);
    fill.position.set(-200, 120, 90);
    this.scene.add(fill);
    const under = new THREE.PointLight(COLORS.uv, 9000, 700, 1.8);
    under.position.set(0, 0, -16);
    this.scene.add(under);

    this.plateGroup = new THREE.Group();
    this.scene.add(this.plateGroup);
    this.modelRoot = new THREE.Group();
    this.supportRoot = new THREE.Group();
    this.cavityRoot = new THREE.Group();
    this.scene.add(this.modelRoot, this.supportRoot, this.cavityRoot);
    this.entries = new Map(); // id -> { group, mesh, material, supports, cavity, holes: [] }
    this.selectedId = null;
    this.tool = 'move';
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
    this.clipping = false;
    this.xray = false;

    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSpace('world');
    this.gizmo.setSize(0.85);
    this.gizmoHelper = this.gizmo.getHelper();
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      this.dragging = e.value;
      if (!e.value && this.selectedId) this.h.onTransformEnd?.(this.selectedId, this.gizmo.mode);
    });
    this.gizmo.addEventListener('objectChange', () => {
      if (this.selectedId) this.h.onTransformChange?.(this.selectedId);
      this.updateBox();
      this.invalidate();
    });
    this.gizmo.addEventListener('change', () => this.invalidate());

    this.boxHelper = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0x9d7bff));
    this.boxHelper.visible = false;
    this.scene.add(this.boxHelper);

    this.ray = new THREE.Raycaster();
    this.ray.firstHitOnly = false;
    canvas.addEventListener('pointerdown', (e) => { this.down = { x: e.clientX, y: e.clientY, b: e.button }; });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || d.b !== 0 || this.dragging || this.gizmo.dragging) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      this.h.onClick?.(this.pickAt(e.clientX, e.clientY), e);
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas.parentElement);
    this.resize();
    this.needsRender = true;
    const loop = () => {
      if (this.needsRender && !this.canvas.hidden) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  invalidate() { this.needsRender = true; }

  resize() {
    const el = this.canvas.parentElement;
    const w = Math.max(1, el.clientWidth), hgt = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, hgt, false);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  // ---------------------------------------------------------------- plate

  setMachine(m) {
    this.machine = m;
    this.plateGroup.clear();
    const W = m.width, D = m.depth, H = m.height, T = 5;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(W, D, T), new THREE.MeshStandardMaterial({ color: COLORS.plate, metalness: 0.75, roughness: 0.42 }));
    plate.position.z = -T / 2;
    this.plateGroup.add(plate);
    const pts = [];
    for (let x = Math.ceil(-W / 2 / 10) * 10; x <= W / 2; x += 10) pts.push(x, -D / 2, 0.03, x, D / 2, 0.03);
    for (let y = Math.ceil(-D / 2 / 10) * 10; y <= D / 2; y += 10) pts.push(-W / 2, y, 0.03, W / 2, y, 0.03);
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)),
      new THREE.LineBasicMaterial({ color: COLORS.grid, transparent: true, opacity: 0.55 }),
    );
    this.plateGroup.add(grid);
    const axes = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-W / 2, 0, 0.05, W / 2, 0, 0.05, 0, -D / 2, 0.05, 0, D / 2, 0.05], 3)),
      new THREE.LineBasicMaterial({ color: 0x8a92a0, transparent: true, opacity: 0.8 }),
    );
    this.plateGroup.add(axes);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.9, D * 2.6), new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false }));
    glow.position.z = -T - 0.6;
    this.plateGroup.add(glow);
    const volume = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, D, H)), new THREE.LineBasicMaterial({ color: COLORS.volume }));
    volume.position.z = H / 2;
    this.plateGroup.add(volume);
    // front-edge marker so you know which way the printer faces
    const front = new THREE.Mesh(new THREE.BoxGeometry(W * 0.3, 1.2, 0.3), new THREE.MeshBasicMaterial({ color: 0x9d7bff }));
    front.position.set(0, -D / 2 - 2.5, 0);
    this.plateGroup.add(front);
    this.controls.target.set(0, 0, H * 0.2);
    this.invalidate();
  }

  // ---------------------------------------------------------------- objects

  addModel(id, positions) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    const material = new THREE.MeshStandardMaterial({ color: COLORS.model, metalness: 0.05, roughness: 0.62, flatShading: true, clippingPlanes: [] });
    const mesh = new THREE.Mesh(geo, material);
    mesh.userData = { id, kind: 'model' };
    const group = new THREE.Group();
    group.add(mesh);
    this.modelRoot.add(group);
    const entry = { group, mesh, material, supports: null, cavity: null, holes: [] };
    this.entries.set(id, entry);
    this.invalidate();
    return group;
  }

  removeModel(id) {
    const e = this.entries.get(id);
    if (!e) return;
    if (this.selectedId === id) this.select(null);
    this.modelRoot.remove(e.group);
    e.mesh.geometry.dispose();
    e.material.dispose();
    this.setSupports(id, null);
    this.setCavity(id, null);
    this.entries.delete(id);
    this.invalidate();
  }

  setSupports(id, tris, ranges) {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.supports) {
      this.supportRoot.remove(e.supports);
      e.supports.geometry.dispose();
      e.supports.material.dispose();
      e.supports = null;
    }
    if (tris && tris.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(tris, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: COLORS.support, metalness: 0.05, roughness: 0.5, flatShading: true, clippingPlanes: [] }));
      mesh.userData = { id, kind: 'support', ranges };
      this.supportRoot.add(mesh);
      e.supports = mesh;
    }
    this.applyClip();
    this.invalidate();
  }

  setCavity(id, positions, offset = [0, 0, 0]) {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.cavity) {
      this.cavityRoot.remove(e.cavity);
      e.cavity.geometry.dispose();
      e.cavity.material.dispose();
      e.cavity = null;
    }
    if (positions && positions.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: COLORS.cavity, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, roughness: 0.4, clippingPlanes: [] }));
      mesh.position.set(offset[0], offset[1], offset[2]);
      mesh.visible = this.xray;
      this.cavityRoot.add(mesh);
      e.cavity = mesh;
    }
    this.applyXray();
    this.invalidate();
  }

  moveCavity(id, offset) {
    const e = this.entries.get(id);
    if (e?.cavity) { e.cavity.position.set(offset[0], offset[1], offset[2]); this.invalidate(); }
  }

  /** holes: [{ p:[x,y,z] local, n:[nx,ny,nz] local, d, depth }] rendered as children of the group. */
  setHoles(id, holes) {
    const e = this.entries.get(id);
    if (!e) return;
    for (const h of e.holes) { e.group.remove(h); h.geometry.dispose(); }
    e.holes = [];
    holes.forEach((hole, index) => {
      const geo = new THREE.CylinderGeometry(hole.d / 2, hole.d / 2, hole.depth + 0.6, 20);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: COLORS.hole, roughness: 0.5, clippingPlanes: [] }));
      const n = new THREE.Vector3(...hole.n).normalize();
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
      mesh.position.set(hole.p[0] - n.x * (hole.depth / 2 - 0.3), hole.p[1] - n.y * (hole.depth / 2 - 0.3), hole.p[2] - n.z * (hole.depth / 2 - 0.3));
      mesh.userData = { id, kind: 'hole', index };
      e.group.add(mesh);
      e.holes.push(mesh);
    });
    this.applyClip();
    this.invalidate();
  }

  setOutOfBounds(id, out) {
    const e = this.entries.get(id);
    if (!e) return;
    e.out = out;
    this.restyle(e, id === this.selectedId);
  }

  restyle(e, selected) {
    e.material.color.set(e.out ? COLORS.out : selected ? COLORS.modelSel : COLORS.model);
    e.material.emissive.set(selected ? 0x2a1466 : 0x000000);
    e.material.emissiveIntensity = selected ? 0.9 : 0;
    e.material.needsUpdate = true;
    this.invalidate();
  }

  select(id) {
    if (this.selectedId && this.entries.has(this.selectedId)) this.restyle(this.entries.get(this.selectedId), false);
    this.selectedId = id;
    const e = id ? this.entries.get(id) : null;
    if (e) {
      this.restyle(e, true);
      this.gizmo.attach(e.group);
    } else this.gizmo.detach();
    this.setTool(this.tool);
    this.updateBox();
    this.invalidate();
  }

  updateBox() {
    const e = this.selectedId ? this.entries.get(this.selectedId) : null;
    if (!e) { this.boxHelper.visible = false; return; }
    this.boxHelper.box.copy(this.worldBounds(this.selectedId));
    this.boxHelper.visible = true;
  }

  setTool(tool) {
    this.tool = tool;
    const gizmoMode = tool === 'move' ? 'translate' : tool === 'rotate' ? 'rotate' : tool === 'scale' ? 'scale' : null;
    const show = !!gizmoMode && !!this.selectedId;
    this.gizmoHelper.visible = show;
    this.gizmo.enabled = show;
    if (gizmoMode) this.gizmo.setMode(gizmoMode);
    if (tool === 'move') { this.gizmo.showX = this.gizmo.showY = this.gizmo.showZ = true; }
    this.canvas.style.cursor = tool === 'support' || tool === 'hole' ? 'crosshair' : '';
    this.invalidate();
  }

  worldBounds(id) {
    const e = this.entries.get(id);
    const box = new THREE.Box3();
    if (!e) return box;
    e.group.updateMatrixWorld(true);
    return box.setFromObject(e.mesh, true);
  }

  pickAt(clientX, clientY, kinds = ['model', 'support', 'hole']) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const targets = [];
    for (const e of this.entries.values()) {
      if (kinds.includes('model')) targets.push(e.mesh);
      if (kinds.includes('support') && e.supports) targets.push(e.supports);
      if (kinds.includes('hole')) targets.push(...e.holes);
    }
    const hits = this.ray.intersectObjects(targets, false);
    if (!hits.length) return null;
    const hit = hits[0];
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize() : new THREE.Vector3(0, 0, 1);
    return { ...hit.object.userData, point: hit.point.clone(), normal: n, faceIndex: hit.faceIndex, object: hit.object };
  }

  // ---------------------------------------------------------------- view modes

  setXray(on) {
    this.xray = on;
    this.applyXray();
    this.invalidate();
  }

  applyXray() {
    for (const e of this.entries.values()) {
      e.material.transparent = this.xray;
      e.material.opacity = this.xray ? 0.4 : 1;
      e.material.depthWrite = !this.xray;
      e.material.needsUpdate = true;
      if (e.cavity) e.cavity.visible = this.xray;
    }
  }

  /** Clip everything above z (mm) or pass null to disable. */
  setClip(z) {
    this.clipping = z != null;
    this.clipPlane.constant = z ?? 0;
    this.applyClip();
    this.invalidate();
  }

  applyClip() {
    const planes = this.clipping ? [this.clipPlane] : [];
    for (const e of this.entries.values()) {
      e.material.clippingPlanes = planes;
      if (e.supports) e.supports.material.clippingPlanes = planes;
      if (e.cavity) e.cavity.material.clippingPlanes = planes;
      for (const h of e.holes) h.material.clippingPlanes = planes;
    }
  }

  fit() {
    const box = new THREE.Box3();
    let any = false;
    for (const id of this.entries.keys()) { box.union(this.worldBounds(id)); any = true; }
    const m = this.machine;
    if (!any) box.set(new THREE.Vector3(-m.width / 2, -m.depth / 2, 0), new THREE.Vector3(m.width / 2, m.depth / 2, m.height * 0.5));
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    const dist = Math.max(60, (size / 2) / Math.tan((this.camera.fov * Math.PI) / 360) * 1.15);
    const dir = new THREE.Vector3(0.45, -1, 0.62).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.controls.update();
    this.invalidate();
  }

  /** Renders a square snapshot (RGBA bytes) for the file's thumbnails. */
  snapshot(size) {
    const el = this.canvas.parentElement;
    const pr = this.renderer.getPixelRatio();
    const gizmoVisible = this.gizmoHelper.visible, boxVisible = this.boxHelper.visible;
    this.gizmoHelper.visible = false;
    this.boxHelper.visible = false;
    const savedPos = this.camera.position.clone(), savedTarget = this.controls.target.clone();
    this.fit();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(size, size, false);
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.drawImage(this.canvas, 0, 0, size, size, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(Math.max(1, el.clientWidth), Math.max(1, el.clientHeight), false);
    this.camera.aspect = Math.max(1, el.clientWidth) / Math.max(1, el.clientHeight);
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(savedPos);
    this.controls.target.copy(savedTarget);
    this.controls.update();
    this.gizmoHelper.visible = gizmoVisible;
    this.boxHelper.visible = boxVisible;
    this.invalidate();
    return data;
  }
}
