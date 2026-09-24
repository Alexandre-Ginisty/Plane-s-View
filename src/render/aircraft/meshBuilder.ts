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
    this.tubeShaped(
      sections.map(([y, r]) => [y, r, offsetZ] as const),
      segments,
    );
  }

  /**
   * A tube whose axis is allowed to bend in Z.
   *
   * Which is what a fuselage does: the nose droops and the tail sweeps up, and
   * a body built as a straight cylinder with a cone on each end is exactly the
   * "plain capsule" silhouette this replaces. Each section carries its own
   * centreline height, so the axis is a curve rather than a line.
   */
  tubeShaped(
    sections: ReadonlyArray<readonly [y: number, radius: number, z: number]>,
    segments: number,
  ): void {
    for (let s = 0; s < sections.length - 1; s++) {
      const [y0, r0, z0] = sections[s]!;
      const [y1, r1, z1] = sections[s + 1]!;

      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        const b = ((i + 1) / segments) * Math.PI * 2;

        const p00 = [Math.cos(a) * r0, y0, Math.sin(a) * r0 + z0] as const;
        const p01 = [Math.cos(b) * r0, y0, Math.sin(b) * r0 + z0] as const;
        const p10 = [Math.cos(a) * r1, y1, Math.sin(a) * r1 + z1] as const;
        const p11 = [Math.cos(b) * r1, y1, Math.sin(b) * r1 + z1] as const;

        if (r0 < 1e-6) this.tri(...p00, ...p11, ...p10);
        else if (r1 < 1e-6) this.tri(...p00, ...p01, ...p11);
        else this.quad(p00, p01, p11, p10);
      }
    }
  }

  /**
   * Index of the next vertex component, for use with `translateFrom`.
   *
   * The builder has no notion of a transform stack, and it does not need one:
   * the only thing ever wanted is "build that where it belongs", which is a
   * translation applied to the run of vertices just written. Every call site
   * used to open-code the same loop over `positions` with a saved length, and
   * two of them got the stride wrong.
   */
  mark(): number {
    return this.positions.length;
  }

  /** Move everything written since `mark` by a fixed offset. */
  translateFrom(mark: number, dx: number, dy: number, dz: number): void {
    for (let i = mark; i < this.positions.length; i += 3) {
      this.positions[i] = this.positions[i]! + dx;
      this.positions[i + 1] = this.positions[i + 1]! + dy;
      this.positions[i + 2] = this.positions[i + 2]! + dz;
    }
  }

  /**
   * Rotate everything written since `mark` about the +Y axis.
   *
   * Propeller blades and rotor blades are one blade built once and repeated at
   * a set of azimuths, which is far less error-prone than parameterising the
   * blade outline by its angle — the rotorcraft builder does the latter and is
   * the reason this exists.
   */
  rotateYFrom(mark: number, radians: number): void {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    for (let i = mark; i < this.positions.length; i += 3) {
      const x = this.positions[i]!;
      const z = this.positions[i + 2]!;
      this.positions[i] = x * cos - z * sin;
      this.positions[i + 2] = x * sin + z * cos;
    }
  }

  /** An axis-aligned box, given opposite corners. */
  box(
    min: readonly [number, number, number],
    max: readonly [number, number, number],
  ): void {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;

    // +Z and -Z
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
    // +X and -X
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
    this.quad([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]);
    // +Y and -Y
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  }

  /**
   * A tube whose axis runs along +X rather than +Y.
   *
   * Undercarriage axles and rotor shafts, which is the whole of its use. The
   * alternative is building along +Y and rotating, and a rotation helper that
   * exists for two call sites is more code than this.
   */
  tubeX(
    sections: ReadonlyArray<readonly [x: number, radius: number]>,
    segments: number,
  ): void {
    const mark = this.mark();
    this.tube(sections.map(([x, r]) => [x, r] as const), segments);
    // Built along +Y, then rotated a quarter turn about +Z so the axis lands
    // on +X. A rotation, not a swap of the two axes: swapping them mirrors the
    // geometry, which reverses every winding and leaves the tube inside out.
    for (let i = mark; i < this.positions.length; i += 3) {
      const x = this.positions[i]!;
      const y = this.positions[i + 1]!;
      this.positions[i] = y;
      this.positions[i + 1] = -x;
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
