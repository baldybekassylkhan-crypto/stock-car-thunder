import * as THREE from 'three';

/**
 * Floating nickname tags above cars (a camera-facing sprite parented to each car's model, so it
 * follows the car), plus a "WATCHING <name>" banner for spectators.
 */
export class NameTags {
  private tags = new Map<number, { sprite: THREE.Sprite; root: THREE.Object3D }>();

  /** Per frame: the cars to label (your own car is left out by the caller). */
  sync(cars: { slot: number; root: THREE.Object3D; name: string; color: string; number: number }[], camera: THREE.Camera, watching = -1) {
    const seen = new Set<number>();
    for (const c of cars) {
      seen.add(c.slot);
      let t = this.tags.get(c.slot);
      if (!t) {
        t = { sprite: makeTag(c.name, c.color, c.number), root: c.root };
        this.tags.set(c.slot, t);
        c.root.add(t.sprite);
      } else if (t.root !== c.root) {
        // the car was rebuilt (respawn, pit repair): move the tag to the new model
        t.sprite.removeFromParent();
        c.root.add(t.sprite);
        t.root = c.root;
      }
      const d = camera.position.distanceTo(c.root.getWorldPosition(_p));
      // hidden right next to the camera (it would cover the view) and far away
      t.sprite.visible = c.root.visible && d > 7 && d < 170;
      // small up close, growing with distance so far tags stay readable; the watched car's tag is bigger
      const s = THREE.MathUtils.clamp(d / 30, 0.6, 3) * (c.slot === watching ? 1.25 : 1);
      t.sprite.scale.set(2.6 * s, 0.65 * s, 1);
      const near = THREE.MathUtils.clamp((d - 7) / 8, 0, 1);
      (t.sprite.material as THREE.SpriteMaterial).opacity = near * (c.slot === watching ? 1 : THREE.MathUtils.clamp(1.2 - d / 170, 0.35, 0.9));
    }
    for (const [slot, t] of this.tags) if (!seen.has(slot)) { t.sprite.removeFromParent(); this.tags.delete(slot); }
  }

  dispose() {
    for (const t of this.tags.values()) { t.sprite.removeFromParent(); (t.sprite.material as THREE.SpriteMaterial).map?.dispose(); t.sprite.material.dispose(); }
    this.tags.clear();
  }
}

const _p = new THREE.Vector3();

function makeTag(name: string, color: string, number: number) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.font = '700 54px "Barlow Condensed", "Arial Narrow", sans-serif';
  const label = name.slice(0, 16);
  const tw = Math.min(380, ctx.measureText(label).width);
  const w = tw + 130, x0 = (512 - w) / 2;
  ctx.fillStyle = 'rgba(8,10,16,0.72)';
  ctx.beginPath(); ctx.roundRect(x0, 22, w, 84, 18); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.roundRect(x0 + 10, 32, 86, 64, 12); ctx.fill();
  ctx.fillStyle = luminance(color) > 0.6 ? '#111' : '#fff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '800 46px "Barlow Condensed", "Arial Narrow", sans-serif';
  ctx.fillText(String(number), x0 + 53, 66);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.font = '700 54px "Barlow Condensed", "Arial Narrow", sans-serif';
  ctx.fillText(label, x0 + 112, 66, 380);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.position.set(0, 2.4, 0);
  sprite.renderOrder = 10;
  return sprite;
}

function luminance(hex: string) {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Big "WATCHING <name>" banner at the top of the screen while spectating. */
export class WatchBanner {
  private el: HTMLDivElement;
  private shown = '';
  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'watch-banner';
    this.el.style.display = 'none';
    root.appendChild(this.el);
  }
  set(name: string | null, color = '#888', number = 0, hint = 'Space / C: next car') {
    const key = name ? `${name}|${color}|${number}` : '';
    if (key === this.shown) return;
    this.shown = key;
    if (!name) { this.el.style.display = 'none'; return; }
    this.el.style.display = '';
    const esc = (s: string) => s.replace(/[<>&"]/g, '');
    this.el.innerHTML = `<span class="wb-eye">👁 WATCHING</span><span class="wb-num" style="background:${esc(color)}">${number}</span><b>${esc(name)}</b><small>${hint}</small>`;
  }
  dispose() { this.el.remove(); }
}
