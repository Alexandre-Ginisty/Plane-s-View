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
import { TEXTURE_FADE_SEC, TILE_FADE_SEC } from './constants';
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
  private fogDensity = 1.2e-6;

  setSun(direction: Vector3): void {
    this.sunDirection.copy(direction).normalize();
  }

  setAtmosphere(color: Color, density: number): void {
    this.fogColor = color;
    this.fogDensity = density;
  }

  applyRenderSet(dt: number): { triangles: number; deepestZoom: number; rendered: number } {
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
      material.setFog(this.fogColor, this.fogDensity);

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
    for (const node of this.nodes.values()) {
      if (selected.has(node) || !node.attached) continue;
      node.opacity = 0;
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

  /** Re-place every mesh after the floating origin moved. */
  repositionAll(): void {
    for (const node of this.nodes.values()) this.positionMesh(node);
  }
}
