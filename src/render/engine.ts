/**
 * WebGL engine: renderer, camera, sky, and the frame loop.
 *
 * ## Depth
 *
 * The camera must see a runway 10 m below it and the horizon 400 km away in
 * the same frame. A conventional depth buffer cannot do that: with near = 0.5
 * and far = 500 000 the precision ratio is a million to one and everything
 * beyond a few kilometres z-fights into noise. `logarithmicDepthBuffer`
 * redistributes precision logarithmically and makes the range usable, at the
 * cost of writing `gl_FragDepth` — which is why the terrain shader includes
 * Three's `logdepthbuf` chunks rather than rolling its own.
 *
 * ## Adaptive resolution
 *
 * Frame time is measured continuously and the device pixel ratio is scaled to
 * hold the target. A steady 60 fps at 80% resolution reads as smooth; a
 * stuttering 35 fps at native resolution does not, and in a first-person view
 * the difference is the whole experience.
 */

import {
  ACESFilmicToneMapping,
  Color,
  Mesh,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import { createSkyMaterial } from './terrainMaterial';

export interface EngineOptions {
  /** Vertical field of view, degrees. */
  fov?: number;
  /** Frames per second to hold. */
  targetFps?: number;
  /** Bounds on the adaptive pixel ratio. */
  minPixelRatio?: number;
  maxPixelRatio?: number;
}

export interface FrameContext {
  dt: number;
  elapsed: number;
  frame: number;
}

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly camera: PerspectiveCamera;
  readonly scene = new Scene();

  private readonly skyMesh: Mesh;
  private readonly skyMaterial = createSkyMaterial();

  private rafHandle: number | null = null;
  private lastTime = 0;
  private elapsed = 0;
  private frameCount = 0;
  private running = false;

  private pixelRatio: number;
  /** Set by `resize`, consumed at the top of the next frame. */
  private resizeDirty = true;
  /** A pixel ratio `adaptQuality` chose, not yet committed. See `resize`. */
  private nextPixelRatio: number | null = null;
  private readonly minPixelRatio: number;
  private readonly maxPixelRatio: number;
  private readonly targetFrameMs: number;
  /** Time spent inside our own update + draw, ms. Drives quality. */
  private renderMsAverage = 4;
  /** Wall-clock interval between presented frames, ms. Drives `fps`. */
  private frameIntervalAverage = 16.7;

  private onFrame: ((ctx: FrameContext) => void) | null = null;
  private readonly resizeObserver: ResizeObserver;

  /**
   * Rolling frames per second, measured from the actual interval between
   * presented frames.
   *
   * Not from how long our draw takes: with vsync those are different numbers,
   * and reporting the second as the first is actively misleading. A 2 ms draw
   * on a 60 Hz display is 60 fps with 88% headroom — not "531 fps".
   */
  fps = 60;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: EngineOptions = {},
  ) {
    const contextAttributes: WebGLContextAttributes = {
      alpha: false,
      antialias: true,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      // The globe always covers the frame, so there is nothing to preserve and
      // letting the driver discard the buffer is free performance.
      preserveDrawingBuffer: false,
    };

    this.renderer = new WebGLRenderer({
      canvas,
      ...contextAttributes,
      logarithmicDepthBuffer: true,
    });

    this.maxPixelRatio = options.maxPixelRatio ?? Math.min(window.devicePixelRatio, 2);
    this.minPixelRatio = options.minPixelRatio ?? 0.65;
    this.pixelRatio = this.maxPixelRatio;
    this.targetFrameMs = 1000 / (options.targetFps ?? 60);

    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(new Color(0x05070d), 1);

    // near = 0.5 m so a cockpit view does not clip through the nose;
    // far = 500 km so the horizon from cruise altitude is inside the frustum.
    this.camera = new PerspectiveCamera(
      options.fov ?? 60,
      canvas.clientWidth / Math.max(1, canvas.clientHeight),
      0.5,
      500_000,
    );
    this.camera.up.set(0, 0, 1); // ECEF: +Z is the north pole
    this.scene.matrixAutoUpdate = false;

    // The sky is a shell that rides with the camera. Radius is arbitrary since
    // its depth is forced to the far plane; it only has to stay inside `far`.
    this.skyMesh = new Mesh(new SphereGeometry(1, 32, 16), this.skyMaterial);
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = -1000;
    this.skyMesh.matrixAutoUpdate = false;
    this.scene.add(this.skyMesh);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.applyResize();
  }

  get webgl2(): boolean {
    return this.renderer.capabilities.isWebGL2;
  }

  /**
   * Ask for a resize. It happens at the top of the next frame, never now.
   *
   * Reallocating the drawing buffer clears it, so a `setSize` issued *after*
   * `render` hands the compositor a blank canvas for that frame — and behind
   * this canvas, at a lower stacking level, sits the live 2D map. The symptom
   * is the map flashing through the cockpit for exactly one frame and then
   * vanishing, which is precisely what it looks like: a canvas with nothing
   * drawn in it yet.
   *
   * Two callers could do it. `adaptQuality` runs after the draw by
   * construction — it is measuring the draw — and it fires whenever the
   * adaptive pixel ratio crosses its threshold, which is exactly when a frame
   * cost more than usual: a burst of tiles landing, or the view being swung
   * round. The `ResizeObserver` is worse still, firing outside the loop
   * entirely. Deferring both to the top of a frame means the buffer is never
   * presented before something has been drawn into it.
   */
  resize(): void {
    this.resizeDirty = true;
  }

  /** Commit a pending pixel-ratio change and/or size. Frame top only. */
  private applyResize(): void {
    if (this.nextPixelRatio !== null) {
      this.pixelRatio = this.nextPixelRatio;
      this.nextPixelRatio = null;
      this.renderer.setPixelRatio(this.pixelRatio);
      this.resizeDirty = true;
    }
    if (!this.resizeDirty) return;
    this.resizeDirty = false;

    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;

    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  get viewportHeight(): number {
    return this.canvas.clientHeight || window.innerHeight;
  }

  /**
   * Sky colours. `elevation` is the sun's angle above the local horizon, so
   * the palette moves through day, golden hour, civil twilight and night the
   * way the real sky does.
   */
  setSky(sunDirection: Vector3, up: Vector3, elevationDeg: number): void {
    const u = this.skyMaterial.uniforms;
    (u['sunDirection']!.value as Vector3).copy(sunDirection);
    (u['upDirection']!.value as Vector3).copy(up);

    const day = Math.max(0, Math.min(1, (elevationDeg + 6) / 12));
    const dusk = Math.max(0, Math.min(1, (elevationDeg + 12) / 18));

    const horizon = new Color(0x0b1a2e).lerp(new Color(0xc4dcf2), day);
    // Warm the horizon through sunset rather than fading it straight to grey.
    if (elevationDeg > -8 && elevationDeg < 12) {
      const warmth = 1 - Math.abs(elevationDeg - 2) / 10;
      horizon.lerp(new Color(0xff9e5e), Math.max(0, warmth) * 0.55);
    }

    (u['horizonColor']!.value as Color).copy(horizon);
    (u['zenithColor']!.value as Color)
      .copy(new Color(0x02040a))
      .lerp(new Color(0x1b4a8f), dusk);
    (u['groundColor']!.value as Color)
      .copy(new Color(0x01030a))
      .lerp(new Color(0x152331), day);
    u['sunIntensity']!.value = Math.max(0, Math.min(1, (elevationDeg + 2) / 8));
  }

  /** Fraction of the frame budget consumed by our own work, 0-1. */
  get budgetUsed(): number {
    return this.renderMsAverage / this.targetFrameMs;
  }

  get renderMs(): number {
    return this.renderMsAverage;
  }

  /** Atmosphere colour the terrain should fade into. Matches the sky horizon. */
  get horizonColor(): Color {
    return (this.skyMaterial.uniforms['horizonColor']!.value as Color).clone();
  }

  start(onFrame: (ctx: FrameContext) => void): void {
    if (this.running) return;
    this.onFrame = onFrame;
    this.running = true;
    this.lastTime = performance.now();
    this.loop(this.lastTime);
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
  }

  private loop = (now: number): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.loop);

    // Clamp: a backgrounded tab returns with a multi-second delta, which would
    // teleport every aircraft and every animation.
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.elapsed += dt;
    this.frameCount++;

    const frameStart = performance.now();

    // Before anything is drawn: see `resize`.
    this.applyResize();

    this.skyMesh.position.copy(this.camera.position);
    this.skyMesh.scale.setScalar(this.camera.far * 0.5);
    this.skyMesh.updateMatrix();

    this.onFrame?.({ dt, elapsed: this.elapsed, frame: this.frameCount });
    this.renderer.render(this.scene, this.camera);

    this.adaptQuality(performance.now() - frameStart, dt);
  };

  /**
   * Nudge the pixel ratio towards the frame budget.
   *
   * Deliberately asymmetric and slow: dropping resolution quickly when frames
   * are late avoids a visible stall, while restoring it gradually prevents the
   * oscillation you get when raising resolution immediately re-blows the
   * budget.
   *
   * The decision uses *render* time rather than frame interval, because vsync
   * pins the interval at the refresh rate regardless of how much headroom is
   * left — so the interval can never reveal spare capacity to spend.
   */
  private adaptQuality(renderMs: number, dt: number): void {
    const k = 1 - Math.exp(-dt / 0.5);
    this.renderMsAverage += (renderMs - this.renderMsAverage) * k;
    this.frameIntervalAverage += (dt * 1000 - this.frameIntervalAverage) * k;
    this.fps = 1000 / Math.max(1, this.frameIntervalAverage);

    let next = this.pixelRatio;
    if (this.renderMsAverage > this.targetFrameMs * 0.8) {
      next = this.pixelRatio * 0.94;
    } else if (this.renderMsAverage < this.targetFrameMs * 0.45) {
      next = this.pixelRatio * 1.02;
    }

    next = Math.max(this.minPixelRatio, Math.min(this.maxPixelRatio, next));
    // Queued, not applied: this runs after `render`, and resizing the buffer
    // there is what makes the map flash through for a frame. See `resize`.
    if (Math.abs(next - this.pixelRatio) > 0.01) this.nextPixelRatio = next;
  }

  get currentPixelRatio(): number {
    return this.pixelRatio;
  }

  dispose(): void {
    this.stop();
    this.resizeObserver.disconnect();
    this.skyMesh.geometry.dispose();
    this.skyMaterial.dispose();
    this.renderer.dispose();
  }
}
