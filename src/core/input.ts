/** Keyboard + Gamepad input, smoothed into analog driver controls. */
export interface DriverInput {
  steer: number; // -1 (left) .. 1 (right)
  throttle: number; // 0..1
  brake: number; // 0..1
  shiftUp: boolean; // edge-triggered
  shiftDown: boolean; // edge-triggered
  /** Open the drag-reduction flap (only works inside a zone when eligible). */
  drs?: boolean;
  /** Deploy the energy boost (held). */
  boost?: boolean;
}

const keys = new Set<string>();
const pressed = new Set<string>(); // edge-triggered this frame

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  if (!keys.has(e.code)) pressed.add(e.code);
  keys.add(e.code);
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

export const isDown = (code: string) => keys.has(code);
/** True once per key press; consumed on read. */
export function wasPressed(code: string): boolean {
  if (pressed.has(code)) {
    pressed.delete(code);
    return true;
  }
  return false;
}
export function clearPressed() {
  pressed.clear();
}

// ---------------- mouse look (hold a mouse button and drag) ----------------
let mouseDown = false;
let mouseDX = 0;
let mouseDY = 0;
const canvas = document.getElementById('game');
if (canvas) {
  canvas.addEventListener('pointerdown', (e) => {
    mouseDown = true;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!mouseDown) return;
    mouseDX += e.movementX;
    mouseDY += e.movementY;
  });
  const release = () => { mouseDown = false; canvas.style.cursor = ''; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}
window.addEventListener('blur', () => { mouseDown = false; });

/** Mouse drag since the last call (pixels) and whether a button is held. */
export function readMouseLook(): { held: boolean; dx: number; dy: number } {
  const r = { held: mouseDown, dx: mouseDX, dy: mouseDY };
  mouseDX = mouseDY = 0;
  return r;
}

let prevPadButtons: boolean[] = [];
let padResetHeld = false;

/** Reset button is being held (R key or gamepad X). */
export const resetHeld = () => isDown('KeyR') || padResetHeld;
/** How long the reset button must be held (seconds). */
export const RESET_HOLD = 3;
let kbSteer = 0;

export function readDriverInput(dt: number, speed: number): DriverInput {
  // Keyboard: ramp steering so keyboard driving is smooth; faster return-to-center.
  const left = isDown('KeyA') || isDown('ArrowLeft');
  const right = isDown('KeyD') || isDown('ArrowRight');
  const target = (right ? 1 : 0) - (left ? 1 : 0);
  const rate = target === 0 ? 6 : Math.sign(target) !== Math.sign(kbSteer) && kbSteer !== 0 ? 7 : 2.6 - Math.min(speed / 80, 1) * 1.1;
  kbSteer += Math.max(-rate * dt, Math.min(rate * dt, target - kbSteer));

  let steer = kbSteer;
  let throttle = isDown('KeyW') || isDown('ArrowUp') ? 1 : 0;
  let brake = isDown('KeyS') || isDown('ArrowDown') ? 1 : 0;
  let shiftUp = wasPressed('KeyE');
  let shiftDown = wasPressed('KeyQ');
  let drs = wasPressed('KeyF');
  let boost = isDown('ShiftLeft') || isDown('ShiftRight');

  const pad = navigator.getGamepads?.().find((p) => p && p.connected);
  if (pad) {
    const ax = pad.axes[0] ?? 0;
    const dz = 0.08;
    const sx = Math.abs(ax) < dz ? 0 : (ax - Math.sign(ax) * dz) / (1 - dz);
    if (Math.abs(sx) > Math.abs(steer)) steer = Math.sign(sx) * Math.pow(Math.abs(sx), 1.6);
    throttle = Math.max(throttle, pad.buttons[7]?.value ?? 0);
    brake = Math.max(brake, pad.buttons[6]?.value ?? 0);
    const b = pad.buttons.map((x) => x.pressed);
    if (b[5] && !prevPadButtons[5]) shiftUp = true;
    if (b[4] && !prevPadButtons[4]) shiftDown = true;
    if (b[0] && !prevPadButtons[0]) drs = true; // A: drag flap
    if (b[1]) boost = true; // B: hold for boost
    if (b[3] && !prevPadButtons[3]) pressed.add('KeyC'); // Y: camera
    padResetHeld = !!b[2]; // X: hold to reset
    if (b[9] && !prevPadButtons[9]) pressed.add('Escape'); // Start: pause
    prevPadButtons = b;
  }
  return { steer, throttle, brake, shiftUp, shiftDown, drs, boost };
}
