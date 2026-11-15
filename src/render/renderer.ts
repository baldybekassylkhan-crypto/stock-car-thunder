import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import type { Atmosphere } from '../tracks/maps';
import type { Quality } from '../core/profile';

const QUALITY = {
  low: { pixelRatio: 0.75, shadows: false, shadowSize: 1024, post: false, bloom: false },
  medium: { pixelRatio: 1, shadows: true, shadowSize: 2048, post: true, bloom: false },
  high: { pixelRatio: 1.25, shadows: true, shadowSize: 2048, post: true, bloom: false },
  ultra: { pixelRatio: 2, shadows: true, shadowSize: 4096, post: true, bloom: true },
};

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 9000);
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
  private composer?: EffectComposer;
  private bloom?: UnrealBloomPass;
  private sky = new Sky();
  private sunDir = new THREE.Vector3();
  private envRT?: THREE.WebGLRenderTarget;
  private quality: Quality = 'high';
  /** Night maps turn on bloom so the light banks glow. */
  night = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.sky.scale.setScalar(8000);
    this.scene.add(this.sky, this.sun, this.sun.target, this.hemi);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 1200;
    const s = 90;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    window.addEventListener('resize', () => this.resize());
  }

  setQuality(q: Quality) {
    this.quality = q;
    const cfg = QUALITY[q];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, cfg.pixelRatio));
    this.renderer.shadowMap.enabled = cfg.shadows;
    this.sun.castShadow = cfg.shadows;
    this.sun.shadow.mapSize.set(cfg.shadowSize, cfg.shadowSize);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (m) (Array.isArray(m) ? m : [m]).forEach((mm) => (mm.needsUpdate = true));
    });
    this.composer?.dispose();
    this.composer = undefined;
    const bloom = cfg.bloom || (this.night && q !== 'low');
    if (cfg.post || bloom) {
      const c = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: q === 'ultra' ? 4 : 0 }));
      c.addPass(new RenderPass(this.scene, this.camera));
      if (bloom) {
        this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.18, 0.35, 3.0);
        c.addPass(this.bloom);
      }
      c.addPass(new OutputPass());
      if (q !== 'ultra') c.addPass(new SMAAPass());
      this.composer = c;
    }
    this.resize();
  }

  applyAtmosphere(a: Atmosphere) {
    const u = this.sky.material.uniforms;
    u.turbidity.value = a.turbidity;
    u.rayleigh.value = a.rayleigh;
    u.mieCoefficient.value = a.mie;
    u.mieDirectionalG.value = 0.85;
    const phi = THREE.MathUtils.degToRad(90 - a.sunElevation);
    const theta = THREE.MathUtils.degToRad(a.sunAzimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(this.sunDir);
    this.sun.color.set(a.sunColor);
    this.sun.intensity = a.sunIntensity;
    this.hemi.color.set(a.hemiSky);
    this.hemi.groundColor.set(a.hemiGround);
    this.hemi.intensity = a.hemiIntensity;
    this.scene.fog = new THREE.FogExp2(a.fogColor, a.fogDensity);
    this.renderer.toneMappingExposure = a.exposure;
    this.night = a.mode === 'night';
    const custom = !!a.mode && a.mode !== 'sky';
    this.sky.visible = !custom;
    this.scene.background = custom ? new THREE.Color(a.background ?? 0x05070d) : null;
    if (a.envScene) {
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.envRT?.dispose();
      this.envRT = pm.fromScene(a.envScene(), 0, 0.1, 2000);
      this.scene.environment = this.envRT.texture;
      this.scene.environmentIntensity = a.envIntensity;
      pm.dispose();
      return;
    }

    // environment map from the sky for reflections / IBL
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const sky2 = new Sky();
    sky2.scale.setScalar(1000);
    Object.entries(u).forEach(([k, v]) => ((sky2.material.uniforms as Record<string, THREE.IUniform>)[k].value = (v as THREE.IUniform).value));
    envScene.add(sky2);
    // warm ground bounce in the env map
    const g = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshBasicMaterial({ color: a.hemiGround, side: THREE.BackSide }));
    envScene.add(g);
    this.envRT?.dispose();
    this.envRT = pmrem.fromScene(envScene, 0, 0.1, 2000);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = a.envIntensity;
    pmrem.dispose();
  }

  /** Keep the shadow frustum centered on the player so shadows stay crisp. */
  followShadow(focus: THREE.Vector3) {
    const snap = 2;
    const fx = Math.round(focus.x / snap) * snap, fz = Math.round(focus.z / snap) * snap;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 500);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  get currentQuality() {
    return this.quality;
  }
}
