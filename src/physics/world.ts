import RAPIER from '@dimforge/rapier3d-compat';
import type { ColliderMesh, SurfaceKind } from '../tracks/build';

export { RAPIER };

let ready: Promise<void> | null = null;
export function initPhysics() {
  ready ??= RAPIER.init();
  return ready;
}

export const SURFACE_GRIP: Record<SurfaceKind, number> = {
  asphalt: 1.0,
  concrete: 0.95,
  wall: 0.6,
  grass: 0.5,
  sand: 0.45,
  gravel: 0.5,
  curb: 0.9,
};
export const SURFACE_DRAG: Record<SurfaceKind, number> = {
  asphalt: 0,
  concrete: 0,
  wall: 0,
  grass: 0.9,
  sand: 1.4,
  gravel: 1.8,
  curb: 0,
};

/** Collision groups: (membership << 16) | filter. */
export const GROUP_TRACK = (0x0001 << 16) | 0xffff;
export const GROUP_CAR = (0x0002 << 16) | 0xffff;
export const GROUP_DEBRIS_EARLY = (0x0004 << 16) | 0x0005; // track + debris only (just after spawning)
export const GROUP_DEBRIS = (0x0004 << 16) | 0xffff;
export const RAY_TRACK_ONLY = (0xffff << 16) | 0x0001;

export class PhysicsWorld {
  readonly world: RAPIER.World;
  readonly surfaces = new Map<number, SurfaceKind>();
  static readonly DT = 1 / 120;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = PhysicsWorld.DT;
    this.world.numSolverIterations = 6;
  }

  addTrack(meshes: ColliderMesh[], groundY = -0.03) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const m of meshes) {
      // fix internal-edge "ghost bumps" so sliding/scraping cars don't get launched
      const flags = RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES_TWO_SIDED | RAPIER.TriMeshFlags.MERGE_DUPLICATE_VERTICES;
      const desc = RAPIER.ColliderDesc.trimesh(m.vertices, m.indices, flags)
        .setFriction(m.kind === 'wall' ? 0.18 : 0.9)
        .setRestitution(m.kind === 'wall' ? 0.15 : 0.0)
        .setCollisionGroups(GROUP_TRACK);
      const c = this.world.createCollider(desc, body);
      this.surfaces.set(c.handle, m.kind);
    }
    // the endless desert / infield floor
    const g = this.world.createCollider(RAPIER.ColliderDesc.cuboid(8000, 1, 8000).setTranslation(0, groundY - 1, 0).setFriction(0.7).setCollisionGroups(GROUP_TRACK), body);
    this.surfaces.set(g.handle, 'grass');
  }

  step() {
    this.world.step();
  }
}
