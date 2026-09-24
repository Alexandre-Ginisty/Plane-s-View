/**
 * Scene synchronisation.
 *
 * Turns the selection the quadtree produced into the Three.js scene graph:
 * creates a mesh the first time a tile is drawn, feeds the material its two
 * textures and the UV transform that maps this tile into the ancestor it is
 * borrowing from, advances the two fades, and detaches everything that dropped
 * out of the set.
 *
 * Kept apart from selection because it is the half that must know about
 * Three.js, and selection is the half that must not — which is also what keeps
 * `metrics.ts` testable without a renderer.
 *
 * The one rule encoded here that is easy to undo by accident: **deeper tiles
 * draw after shallower ones** (`renderOrder = z`), so a child fading in always
 * composites over the parent it is replacing. Reverse it and every refinement
 * flashes the parent through the child.
 */

import { Color, Mesh, Scene, Vector3, Vector4 } from 'three';

import type { FloatingOrigin } from '@/core/frame';
import { TerrainMaterial } from '../terrainMaterial';
import { CLEAR_DAY_DENSITY } from '../atmosphere';
import { RELIEF, TEXTURE_FADE_SEC, TILE_FADE_SEC } from './constants';
import type { TileMap } from './eviction';
import type { TileNode } from './tileNode';

export class SceneSynchroniser {
  private readonly tmpUvA = new Vector4();
  private readonly tmpUvB = new Vector4();

  constructor(
    private readonly scene: Scene,
    private readonly nodes: TileMap,
    private readonly renderSet: readonly TileNode[],
    private readonly origin: FloatingOrigin,
  ) {}

  private sunDirection = new Vector3(1, 0, 0);
  private fogColor = new Color(0x8fb2d4);
  private fogDensity = CLEAR_DAY_DENSITY;
  /** Shadow floor handed to every terrain material. See `setAmbient`. */
  private ambient = RELIEF.standard.ambient;
  /** Planet centre in render space. Recomputed each frame: the origin moves. */
  private readonly planetCentre = new Vector3();

  setSun(direction: Vector3): void {
    this.sunDirection.copy(direction).normalize();
  }

  setAtmosphere(color: Color, density: number): void {
    this.fogColor = color;
    this.fogDensity = density;
  }

  applyRenderSet(dt: number): { triangles: number; deepestZoom: number; rendered: number } {
    // Render space is ECEF minus the origin, so the planet's centre sits at
    // minus the origin. Read once per frame rather than per tile.
    this.planetCentre.set(
      -this.origin.current[0],
      -this.origin.current[1],
      -this.origin.current[2],
    );

    const selected = new Set(this.renderSet);
    let triangles = 0;
    let deepest = 0;

    for (const node of this.renderSet) {
      this.ensureMesh(node);
      const mesh = node.mesh;
      const material = node.material;
      if (!mesh || !material) continue;

      node.opacity = Math.min(1, node.opacity + dt / TILE_FADE_SEC);

      // Rule 2: cross-fade inherited -> own imagery.
      if (node.texture) {
        node.textureBlend = Math.min(1, node.textureBlend + dt / TEXTURE_FADE_SEC);
      }

      const ancestor = node.textureAncestor();
      const inherited = node.texture ? node.parent?.textureAncestor() ?? null : ancestor;

      if (node.texture) {
        const base = inherited ?? node;
        material.setTextures(
          base.texture,
          node.uvInto(base, this.tmpUvA),
          node.texture,
          node.uvInto(node, this.tmpUvB),
        );
        material.blend = node.textureBlend;
      } else if (ancestor) {
        material.setTextures(
          ancestor.texture,
          node.uvInto(ancestor, this.tmpUvA),
          null,
          this.tmpUvB,
        );
        material.blend = 0;
      }

      material.setFade(node.opacity);
      material.setSun(this.sunDirection);
      material.setFog(this.fogColor, this.fogDensity, this.planetCentre);

      // Deeper tiles draw after shallower ones, so a fading child always
      // composites over the parent it is replacing.
      mesh.renderOrder = node.z;

      if (!node.attached) {
        this.scene.add(mesh);
        node.attached = true;
      }

      const index = node.geometry?.getIndex();
      if (index) triangles += index.count / 3;
      if (node.z > deepest) deepest = node.z;
    }

    // Detach everything that dropped out of the set this frame.
    //
    // The fade is *not* reset here, and that one line was a flicker generator.
    // Leaving the set is routine: a tile crosses the frustum edge as the
    // aircraft yaws, a parent steps aside for its children and is wanted again
    // a moment later when one child is evicted. Resetting the fade meant every
    // one of those re-entries started from fully transparent and spent 0.3 s
    // getting back — so the globe went momentarily see-through at the edges
    // whenever the camera moved, which is the opposite of what the fade is for.
    //
    // A tile that already has its imagery has nothing to fade in. The fade
    // exists to cover content *arriving*, and re-entering the render set is
    // not content arriving.
    for (const node of this.nodes.values()) {
      if (selected.has(node) || !node.attached) continue;
      if (node.mesh) this.scene.remove(node.mesh);
      node.attached = false;
    }

    return { triangles, deepestZoom: deepest, rendered: this.renderSet.length };
  }

  private ensureMesh(node: TileNode): void {
    if (node.mesh || !node.geometry) return;

    const material = new TerrainMaterial({
      fogColor: this.fogColor,
      fogDensity: this.fogDensity,
      ambient: this.ambient,
    });
    const mesh = new Mesh(node.geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false; // the quadtree already culled it, and better

    node.material = material;
    node.mesh = mesh;
    this.positionMesh(node);
  }

  private positionMesh(node: TileNode): void {
    if (!node.mesh) return;
    node.mesh.position.set(
      node.centerEcef[0] - this.origin.current[0],
      node.centerEcef[1] - this.origin.current[1],
      node.centerEcef[2] - this.origin.current[2],
    );
    node.mesh.updateMatrix();
  }

  /**
   * Shadow floor for the terrain, and for every tile already on screen.
   *
   * Applied to the live materials as well as remembered for the ones built
   * next, or changing the setting would relight the world one tile at a time
   * as the quadtree happened to replace them.
   */
  setAmbient(value: number): void {
    this.ambient = value;
    for (const node of this.nodes.values()) node.material?.setAmbient(value);
  }

  /** Re-place every mesh after the floating origin moved. */
  repositionAll(): void {
    for (const node of this.nodes.values()) this.positionMesh(node);
  }
}
