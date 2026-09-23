/**
 * Triangle-soup builder.
 *
 * Positions only, normals computed at the end. The aircraft models are a few
 * hundred triangles each and are never edited after construction, so an index
 * buffer and a vertex-welding pass would cost more code than they save.
 *
 * The helpers exist because the two mistakes this file is prone to are both
 * silent: winding a face backwards (invisible under back-face culling until
 * you fly round the other side) and building a surface out of a flat outline
 * that is then bent, which leaves a second surface floating beside the first.
 * `panel` and `slabYZ` exist specifically so neither has to be done by hand.
 */

import { BufferAttribute, BufferGeometry } from 'three';

export class MeshBuilder {
  readonly positions: number[] = [];

  tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
  ): void {
    this.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  }

  /** Two triangles, wound consistently, for a planar quad a-b-c-d. */
  quad(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
  ): void {
    this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
  }

  /** A thin slab: a flat outline given a small thickness in Z. */
  slab(outline: ReadonlyArray<readonly [number, number]>, z: number, thickness: number): void {
    const half = thickness / 2;
    const top = outline.map((p) => [p[0], p[1], z + half] as const);
    const bottom = outline.map((p) => [p[0], p[1], z - half] as const);

    // Faces, fanned from the first vertex.
    for (let i = 1; i < outline.length - 1; i++) {
      this.tri(...top[0]!, ...top[i]!, ...top[i + 1]!);
      this.tri(...bottom[0]!, ...bottom[i + 1]!, ...bottom[i]!);
    }
    // Rim.
    for (let i = 0; i < outline.length; i++) {
      const j = (i + 1) % outline.length;
      this.quad(top[i]!, bottom[i]!, bottom[j]!, top[j]!);
    }
  }

  /**
   * A tapered panel between a root edge and a tip edge, each given in 3D.
   *
   * This is what a wing actually is: two edges at different span stations,
   * different chords, and different heights. Building it from a flat outline
   * and patching the dihedral on afterwards — the obvious shortcut — leaves a
   * second surface floating beside the first, which is plainly visible from
   * behind.
   */
  panel(
    rootFore: readonly [number, number, number],
    rootAft: readonly [number, number, number],
    tipFore: readonly [number, number, number],
    tipAft: readonly [number, number, number],
    thickness: number,
    flip: boolean,
  ): void {
    const h = thickness / 2;
    const up = (p: readonly [number, number, number]) => [p[0], p[1], p[2] + h] as const;
    const dn = (p: readonly [number, number, number]) => [p[0], p[1], p[2] - h] as const;

    const corners = flip
      ? [rootAft, rootFore, tipFore, tipAft]
      : [rootFore, rootAft, tipAft, tipFore];
    const [a, b, c, d] = corners as [
      readonly [number, number, number],
      readonly [number, number, number],
      readonly [number, number, number],
      readonly [number, number, number],
    ];

    this.quad(up(a), up(b), up(c), up(d));
    this.quad(dn(d), dn(c), dn(b), dn(a));
    for (const [p, q] of [[a, b], [b, c], [c, d], [d, a]] as const) {
      this.quad(up(p), dn(p), dn(q), up(q));
    }
  }

  /**
   * A thin slab standing in the Y-Z plane at a given X.
   *
   * The counterpart of `slab`, which can only lie flat. Fins, tail rotors and
   * anything else standing upright need this one, and building them out of
   * `slab` plus a rotation afterwards is what produced the detached surfaces
   * the wing code already learned to avoid.
   */
  slabYZ(outline: ReadonlyArray<readonly [number, number]>, x: number, thickness: number): void {
    const half = thickness / 2;
    const near = outline.map((p) => [x + half, p[0], p[1]] as const);
    const far = outline.map((p) => [x - half, p[0], p[1]] as const);

    for (let i = 1; i < outline.length - 1; i++) {
      this.tri(...near[0]!, ...near[i]!, ...near[i + 1]!);
      this.tri(...far[0]!, ...far[i + 1]!, ...far[i]!);
    }
    for (let i = 0; i < outline.length; i++) {
      const j = (i + 1) % outline.length;
      this.quad(near[i]!, far[i]!, far[j]!, near[j]!);
    }
  }

  /** A tube of circular sections along +Y, given a radius profile. */
  tube(
    sections: ReadonlyArray<readonly [y: number, radius: number]>,
    segments: number,
    offsetZ = 0,
  ): void {
    for (let s = 0; s < sections.length - 1; s++) {
      const [y0, r0] = sections[s]!;
      const [y1, r1] = sections[s + 1]!;

      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        const b = ((i + 1) / segments) * Math.PI * 2;

        const p00 = [Math.cos(a) * r0, y0, Math.sin(a) * r0 + offsetZ] as const;
        const p01 = [Math.cos(b) * r0, y0, Math.sin(b) * r0 + offsetZ] as const;
        const p10 = [Math.cos(a) * r1, y1, Math.sin(a) * r1 + offsetZ] as const;
        const p11 = [Math.cos(b) * r1, y1, Math.sin(b) * r1 + offsetZ] as const;

        if (r0 < 1e-6) this.tri(...p00, ...p11, ...p10);
        else if (r1 < 1e-6) this.tri(...p00, ...p01, ...p11);
        else this.quad(p00, p01, p11, p10);
      }
    }
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(this.positions), 3),
    );
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
}
