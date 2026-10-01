import { describe, expect, it } from 'vitest';
import { BufferAttribute, Vector3 } from 'three';

import { FloatingOrigin } from '@/core/frame';
import { FEET_TO_METRES, geodeticToEcef } from '@/core/math/geo';
import { WindField } from '@/data/weather/wind';
import type { SampledAircraft } from '@/state/traffic';
import type { TrailPoint } from '@/state/track';
import { DEFAULT_SHAPE } from '@/render/aircraft/typeTable';
import { Contrails, type ContrailInputs } from '.';

const NOW = 1_700_000_000_000;

/** An airliner at FL370 flying east at 250 m/s, with two minutes of fixes behind it. */
function cruising(oatC: number): { sample: SampledAircraft; trail: TrailPoint[] } {
  const lat = 48;
  const mPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const trail: TrailPoint[] = [];
  for (let age = 120; age >= 2; age -= 4) trail.push({ lat, lon: 2 - (250 * age) / mPerDegLon, altFt: 37_000, t: NOW - age * 1000 });
  const sample = {
    hex: 'abc123',
    lat,
    lon: 2,
    altFt: 37_000,
    trackDeg: 90,
    headingDeg: 90,
    rollDeg: 0,
    pitchDeg: 0,
    groundSpeedKt: 486,
    verticalRateFpm: 0,
    ageSec: 0,
    stale: false,
    uncertaintyM: 10,
    latest: { onGround: false, oatC, category: 'A3' },
  } as unknown as SampledAircraft;
  return { sample, trail };
}

function setup(oatC: number) {
  const origin = new FloatingOrigin();
  const { sample, trail } = cruising(oatC);
  const eye = geodeticToEcef(48.02, 1.9, 37_000 * FEET_TO_METRES);
  origin.rebase(eye);
  const contrails = new Contrails(origin);
  const input: ContrailInputs = {
    trailOf: () => trail,
    shapeOf: () => DEFAULT_SHAPE,
    wind: new WindField(),
    aloft: [{ hPa: 250, tempC: -56, rhPct: 75 }],
    nowMs: NOW,
  };
  contrails.update([sample], new Vector3(0, 0, 0), input);
  return contrails;
}

describe('contrails', () => {
  it('draws a finite ribbon behind a cruising airliner in cold air', () => {
    const c = setup(-57);
    expect(c.mesh.visible).toBe(true);
    const count = c.mesh.geometry.drawRange.count;
    expect(count).toBeGreaterThan(0);
    const pos = c.mesh.geometry.getAttribute('position') as BufferAttribute;
    const shape = c.mesh.geometry.getAttribute('shape') as BufferAttribute;
    let visible = 0;
    let maxHalf = 0;
    for (let i = 0; i < 150 * 2; i++) {
      expect(Number.isFinite(pos.getX(i)) && Number.isFinite(pos.getY(i)) && Number.isFinite(pos.getZ(i))).toBe(true);
      if (shape.getW(i) > 0.05) visible++;
      maxHalf = Math.max(maxHalf, shape.getY(i));
    }
    expect(visible).toBeGreaterThan(20);
    // A trail two minutes old is tens of metres wide, not kilometres.
    expect(maxHalf).toBeGreaterThan(15);
    expect(maxHalf).toBeLessThan(400);
    // It starts behind the aircraft, not on it: the first point is transparent.
    expect(shape.getW(0)).toBe(0);
  });

  it('draws nothing in warm air', () => {
    const c = setup(-25);
    expect(c.mesh.visible).toBe(false);
    expect(c.mesh.geometry.drawRange.count).toBe(0);
  });
});
