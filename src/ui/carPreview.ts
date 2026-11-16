import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildCarModel } from '../vehicle/models';
import type { CarSpec } from '../vehicle/catalog';

/**
 * Small rotating 3D car preview for the car picker. Uses its own WebGL renderer on the given
 * canvas (the game renderer is busy with the menu backdrop / race), so call dispose() when the
 * screen goes away.
 */
export class CarPreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 2, 0.1, 50);
  private turntable = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private raf = 0;
  private last = performance.now();
  private key = '';
  private disposed = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.85;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(4, 6, 3);
    this.scene.add(sun, new THREE.HemisphereLight(0xdfe8ff, 0x20242c, 0.6));
    const pad = new THREE.Mesh(new THREE.CircleGeometry(3.6, 48), new THREE.MeshStandardMaterial({ color: 0x15181f, roughness: 0.6, metalness: 0.3 }));
    pad.rotation.x = -Math.PI / 2;
    this.turntable.add(pad);
    this.scene.add(this.turntable);
    this.camera.position.set(0, 2.1, 7.6);
    this.camera.lookAt(0, 0.45, 0);
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Show a car (rebuilds the model only when the car, colour or number changed). */
  setCar(spec: CarSpec, color: string, number: number) {
    const key = `${spec.id}|${color}|${number}`;
    if (key === this.key || this.disposed) return;
    this.key = key;
    if (this.model) { this.turntable.remove(this.model); disposeTree(this.model); }
    this.model = buildCarModel({ number, color, seed: number }, spec).root;
    this.turntable.add(this.model);
    this.render();
  }

  private resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    const pr = this.renderer.getPixelRatio();
    if (this.canvas.width !== Math.round(w * pr) || this.canvas.height !== Math.round(h * pr)) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Draw one frame now (also used by tests while the page is hidden). */
  render() {
    if (this.disposed) return;
    this.resize();
    this.renderer.render(this.scene, this.camera);
  }

  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (!this.canvas.isConnected) { this.dispose(); return; }
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.turntable.rotation.y += dt * 0.6;
    this.render();
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.model) disposeTree(this.model);
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

function disposeTree(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const map = (mat as THREE.MeshStandardMaterial).map;
      map?.dispose();
      mat.dispose();
    }
  });
}
