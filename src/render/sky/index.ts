/**
 * The atmosphere, driven: rebuilds the sky table when the conditions move,
 * packs the shared uniforms every frame, and draws the dome.
 *
 * The table is cheap (a few milliseconds) but not free, so it is rebuilt only
 * when the sun has moved or the camera has climbed enough to change what it
 * shows, and never more than a few times a second. Between rebuilds the dome
 * and the haze read the same table, so they cannot disagree however stale it
 * is.
 */

import {
  BackSide,
  DataUtils,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type PerspectiveCamera,
} from 'three';

import {
  EARTH_RADIUS_M,
  LUT_HEIGHT,
  LUT_WIDTH,
  MIE_H,
  RAYLEIGH_BETA,
  RAYLEIGH_H,
  buildSkyLut,
  grade,
  horizonDip,
  mieExtinction,
  sceneLight,
  sunTransmittance,
  type Rgb,
  type SceneLight,
  type SkyConditions,
} from './model';
import { ATMO_GLSL, ATMO_UNIFORMS, atmoData, installAtmosphere, skyLut } from './shader';

installAtmosphere();

/** Seconds between table rebuilds, at most. */
const MIN_REBUILD_S = 0.12;
/** Sun movement that warrants a rebuild, degrees. */
const SUN_STEP_DEG = 0.06;

const SKY_VERTEX = /* glsl */ `
varying vec3 vDirection;
void main() {
  vDirection = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // On the far plane, so the dome never occludes anything.
  gl_Position.z = gl_Position.w;
}
`;

const SKY_FRAGMENT = /* glsl */ `
#include <common>
${ATMO_GLSL}
uniform vec3 sunDisc;
uniform float starlight;
varying vec3 vDirection;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 dir = normalize(vDirection);
  vec3 up = normalize(cameraPosition - atmo[0].xyz);
  float elevation = asin(clamp(dot(dir, up), -1.0, 1.0));
  // Below the true horizon the dome shows only where terrain has not loaded:
  // there it is the haze the terrain would have faded into, so the edge of
  // the loaded world has no colour of its own.
  bool below = elevation + atmo[2].z < 0.0;
  vec3 color = below ? atmoHaze(dir) : atmoSky(dir);

  if (!below) {
    float mu = dot(dir, atmo[3].xyz);
    // Limb-darkened disc, half a degree across, and a tight glare around it.
    float disc = smoothstep(0.999955, 0.999972, mu);
    float limb = sqrt(max(0.0, 1.0 - (1.0 - mu) / (1.0 - 0.999955)));
    color += sunDisc * disc * (0.55 + 0.45 * limb) * 2.5;
    color += sunDisc * (pow(max(mu, 0.0), 1400.0) * 0.5 + pow(max(mu, 0.0), 90.0) * 0.07);

    // Stars, once the sky is dark enough to show them. Fixed to the Earth
    // frame rather than the celestial sphere: nobody times a star's rise from
    // a cockpit, and a single hash per pixel is the whole cost.
    if (starlight > 0.0) {
      vec3 p = dir * 420.0;
      vec3 cell = floor(p);
      float h = hash13(cell);
      if (h > 0.9965) {
        vec3 centre = cell + 0.5 + (vec3(hash13(cell + 7.1), hash13(cell + 3.7), hash13(cell + 1.3)) - 0.5) * 0.6;
        float d = length(p - centre);
        float twinkle = 0.75 + 0.25 * hash13(cell + 11.0);
        float brightness = smoothstep(0.5, 0.0, d) * (h - 0.9965) / 0.0035 * twinkle;
        float sky = dot(color, vec3(0.2126, 0.7152, 0.0722));
        float horizonFade = smoothstep(0.0, 0.12, elevation + atmo[2].z);
        color += vec3(0.85, 0.9, 1.0) * brightness * starlight * horizonFade * smoothstep(0.12, 0.02, sky);
      }
    }
  }

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

export class Atmosphere {
  readonly dome: Mesh;
  private readonly material: ShaderMaterial;
  private readonly lutData = new Float32Array(LUT_WIDTH * LUT_HEIGHT * 4);
  private readonly lutHalf = skyLut.image.data as Uint16Array;

  private readonly conditions: SkyConditions = { altitudeM: 0, sunElevationDeg: 0, haze: 1 };
  private built: SkyConditions | null = null;
  private sinceBuild = Infinity;

  /** Light at the camera, for the models and the terrain. Updated with the table. */
  readonly light: SceneLight = { sunColor: [1, 1, 1], sunStrength: 1, skyColor: [1, 1, 1], skyStrength: 1 };
  private readonly noonSun: Rgb;
  private readonly disc: Rgb = [1, 1, 1];
  private readonly up = new Vector3();
  private haze = 1;

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      uniforms: {
        ...ATMO_UNIFORMS,
        sunDisc: { value: new Vector3(1, 1, 1) },
        starlight: { value: 0 },
      },
      side: BackSide,
      depthWrite: false,
    });
    this.dome = new Mesh(new SphereGeometry(1, 48, 24), this.material);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.dome.matrixAutoUpdate = false;

    const noon = sunTransmittance(0, 60, 1);
    const max = Math.max(...noon);
    this.noonSun = [noon[0] / max, noon[1] / max, noon[2] / max];

    atmoData[0] = 0;
    atmoData[1] = 0;
    atmoData[2] = -EARTH_RADIUS_M;
    atmoData[3] = EARTH_RADIUS_M;
    atmoData[7] = RAYLEIGH_H;
    atmoData[9] = MIE_H;
    atmoData[11] = 0; // disabled until the first update places the planet
    // Midday light until the first table says otherwise, never black.
    atmoData[16] = atmoData[17] = atmoData[18] = atmoData[19] = 1;
    this.packExtinction();
  }

  /**
   * Aerosol multiplier from the weather: 1 on a clear day. See
   * `hazeForVisibility`.
   */
  setHaze(haze: number): void {
    const h = Number.isFinite(haze) ? Math.max(0.5, Math.min(150, haze)) : 1;
    if (Math.abs(h - this.haze) < 0.02) return;
    this.haze = h;
    this.packExtinction();
  }

  /**
   * @param planetCentre Centre of the Earth in render space: the negated
   * floating origin. It moves on every rebase, and an altitude measured from
   * a stale centre puts the whole world at the wrong density.
   * @param sunDirection Unit vector towards the sun, render (ECEF) axes.
   */
  update(camera: PerspectiveCamera, planetCentre: Vector3, sunDirection: Vector3, dt: number): void {
    this.dome.position.copy(camera.position);
    this.dome.scale.setScalar(camera.far * 0.5);
    this.dome.updateMatrix();

    this.up.copy(camera.position).sub(planetCentre);
    const altitude = this.up.length() - EARTH_RADIUS_M;
    this.up.normalize();
    const sunElevation = (Math.asin(Math.max(-1, Math.min(1, this.up.dot(sunDirection)))) * 180) / Math.PI;

    atmoData[0] = planetCentre.x;
    atmoData[1] = planetCentre.y;
    atmoData[2] = planetCentre.z;
    atmoData[10] = horizonDip(altitude);
    atmoData[11] = 1;
    atmoData[12] = sunDirection.x;
    atmoData[13] = sunDirection.y;
    atmoData[14] = sunDirection.z;

    this.conditions.altitudeM = Math.max(0, altitude);
    this.conditions.sunElevationDeg = sunElevation;
    this.conditions.haze = this.haze;

    this.sinceBuild += dt;
    if (this.needsRebuild()) this.rebuild();
  }

  private needsRebuild(): boolean {
    const b = this.built;
    if (!b) return true;
    if (this.sinceBuild < MIN_REBUILD_S) return false;
    const c = this.conditions;
    return (
      Math.abs(c.sunElevationDeg - b.sunElevationDeg) > SUN_STEP_DEG ||
      Math.abs(c.altitudeM - b.altitudeM) > Math.max(30, b.altitudeM * 0.03) ||
      c.haze !== b.haze
    );
  }

  private rebuild(): void {
    const c = this.conditions;
    buildSkyLut(c, this.lutData);
    const half = this.lutHalf;
    const data = this.lutData;
    for (let i = 0; i < data.length; i++) half[i] = DataUtils.toHalfFloat(data[i]!);
    skyLut.needsUpdate = true;
    this.built = { ...c };
    this.sinceBuild = 0;

    // Light for the models and the terrain.
    sceneLight(c, this.light);
    const l = this.light;
    // The disc: the colour of the sunlight that reaches the eye.
    this.disc[0] = l.sunColor[0];
    this.disc[1] = l.sunColor[1];
    this.disc[2] = l.sunColor[2];
    grade(this.disc);
    const visible = Math.min(1, Math.max(0, (c.sunElevationDeg + 1) / 1.5));
    (this.material.uniforms['sunDisc']!.value as Vector3).set(this.disc[0] * visible, this.disc[1] * visible, this.disc[2] * visible);
    this.material.uniforms['starlight']!.value = Math.min(1, Math.max(0, (-c.sunElevationDeg - 4) / 8));

    // Sunlight on surfaces, relative to noon so midday stays as tuned.
    for (let ch = 0; ch < 3; ch++) {
      const tint = Math.min(1.1, l.sunColor[ch]! / this.noonSun[ch]!);
      atmoData[16 + ch] = tint * l.sunStrength;
    }
    // The terrain keeps some legibility at night: satellite imagery with no
    // lights of its own would otherwise go black.
    atmoData[19] = 0.4 + 0.6 * l.skyStrength;
  }

  private packExtinction(): void {
    atmoData[4] = RAYLEIGH_BETA[0];
    atmoData[5] = RAYLEIGH_BETA[1];
    atmoData[6] = RAYLEIGH_BETA[2];
    atmoData[8] = mieExtinction(this.haze);
  }

  dispose(): void {
    this.dome.geometry.dispose();
    this.material.dispose();
  }
}
