import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { projectAhead } from './projection';

/** The engine's lens; `reversed` is what three sets once it draws into a reversed depth buffer. */
function camera(reversed: boolean): PerspectiveCamera {
  const cam = new PerspectiveCamera(60, 1.6, 0.5, 500_000);
  (cam as unknown as { _reversedDepth: boolean })._reversedDepth = reversed;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return cam;
}

describe.each([false, true])('projectAhead, reversed depth = %s', (reversed) => {
  it('puts a point above the view above the centre of the screen', () => {
    const p = new Vector3(0, 50, -100);
    expect(projectAhead(p, camera(reversed))).toBe(true);
    expect(p.y).toBeGreaterThan(0);
  });

  it('rejects a point behind the eye instead of mirroring it', () => {
    // Behind and above: the old `z > 1` test let this through with x and y
    // flipped, which drew its marker below the horizon.
    expect(projectAhead(new Vector3(0, 50, 100), camera(reversed))).toBe(false);
    expect(projectAhead(new Vector3(30, -20, 1e6), camera(reversed))).toBe(false);
  });
});
