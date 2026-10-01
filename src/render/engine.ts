/**
 * WebGL engine: renderer, camera, sky, and the frame loop.
 *
 * ## Depth
 *
 * The camera must see a runway 10 m below it and the horizon 400 km away in
 * the same frame. A conventional depth buffer cannot do that: with near = 0.5
 * and far = 500 000 the precision ratio is a million to one and everything
 * beyond a few kilometres z-fights into noise.
 *
 * Where the browser allows it, the scene is drawn into a float depth buffer
 * with the depth range reversed (see `@/render/post`), which keeps precision
 * proportional to distance at no cost per pixel. Elsewhere
 * `logarithmicDepthBuffer` makes the range usable, at the cost of writing
 * `gl_FragDepth` and so of the GPU's early depth test — which is why every
 * custom shader includes three's `logdepthbuf` chunks: they compile to
 * nothing in the first mode.
 *
 * ## Adaptive resolution
 *
 * Frame time is measured continuously and the device pixel ratio is scaled to
 * hold the target. A steady 60 fps at 80% resolution reads as smooth; a
 * stuttering 35 fps at native resolution does not, and in a first-person view
 * the difference is the whole experience. Both halves of the frame count:
 * the CPU's time in the draw, and — where the browser can time it — the
 * GPU's, so a scene that is cheap to submit and expensive to shade still
 * brings the resolution down.
 */

import {
  ACESFilmicToneMapping,
  Vector2,
  Color,
  FogExp2,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { FloatingOrigin } from '@/core/frame';
import { Atmosphere } from './sky';
import { PostPipeline, probePost } from './post';
import { CloudLayers } from './clouds';

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

  /** Sky, haze and sunlight, from one model. See `@/render/sky`. */
  readonly atmosphere = new Atmosphere();
  /** The real cloud layers, from the weather. See `@/render/clouds`. */
  readonly clouds = new CloudLayers();
  private readonly planetCentre = new Vector3(0, 0, -6_371_000);
  private readonly sunDirection = new Vector3(1, 0, 0);

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

  /** GPU time per frame, ms, where the browser can measure it; else 0. */
  private gpuMsAverage = 0;
  private readonly timer: {
    ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
    query: WebGLQuery | null;
    running: boolean;
  } | null;
  /** Bloom, flare and the float depth buffer; null where the device cannot. */
  readonly post: PostPipeline | null;
  private readonly drawingSize = new Vector2();

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
    const caps = probePost();
    const contextAttributes: WebGLContextAttributes = {
      alpha: false,
      // With the post pipeline the scene is multisampled offscreen and the
      // canvas only receives the finished picture: no samples, no depth.
      antialias: !caps.post,
      depth: !caps.post,
      stencil: false,
      powerPreference: 'high-performance',
      // The globe always covers the frame, so there is nothing to preserve and
      // letting the driver discard the buffer is free performance.
      preserveDrawingBuffer: false,
    };

    this.renderer = new WebGLRenderer({
      canvas,
      ...contextAttributes,
      logarithmicDepthBuffer: !caps.reversedDepth,
      reversedDepthBuffer: caps.reversedDepth,
    });
    this.post = caps.post ? new PostPipeline(this.renderer) : null;

    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    this.timer = timerExt ? { ext: timerExt, query: null, running: false } : null;

    this.maxPixelRatio = options.maxPixelRatio ?? Math.min(window.devicePixelRatio, 2);
    this.minPixelRatio = options.minPixelRatio ?? 0.65;
    this.pixelRatio = this.maxPixelRatio;
    this.targetFrameMs = 1000 / (options.targetFps ?? 60);

    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // Only the cockpit casts shadows (its frame across its own panel); the
    // world's lights never do, so the world pays nothing for this.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
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
    this.scene.add(this.atmosphere.dome);
    this.scene.add(this.clouds.group);
    // Only switches three's fog code on for every material; what it computes
    // is the atmosphere's (see `installAtmosphere`), so colour and density
    // here are never read.
    this.scene.fog = new FogExp2(0x000000, 0);

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
    if (this.post) {
      this.renderer.getDrawingBufferSize(this.drawingSize);
      this.post.setSize(this.drawingSize.x, this.drawingSize.y);
    }
  }

  get viewportHeight(): number {
    return this.canvas.clientHeight || window.innerHeight;
  }

  /**
   * The floating origin the scene is drawn relative to. The atmosphere needs
   * the planet's centre in render space, which is minus the origin, read at
   * draw time: a rebase can happen anywhere in the frame's work, and an
   * altitude measured from a stale centre puts the whole world at the wrong
   * air density for a frame.
   */
  origin: FloatingOrigin | null = null;

  /**
   * A second scene drawn after the world with its own camera and a cleared
   * depth buffer: the cockpit, which lives centimetres from the eye.
   */
  overlay: { scene: Scene; camera: PerspectiveCamera; visible: boolean } | null = null;

  /** Where the sun is, for the atmosphere. Unit vector, ECEF axes. */
  setSky(sunDirection: Vector3): void {
    this.sunDirection.copy(sunDirection);
  }

  /** Fraction of the frame budget consumed by our own work, 0-1. */
  get budgetUsed(): number {
    return Math.max(this.renderMsAverage, this.gpuMsAverage) / this.targetFrameMs;
  }

  /** GPU time per frame, ms; 0 where the browser cannot measure it. */
  get gpuMs(): number {
    return this.gpuMsAverage;
  }

  get renderMs(): number {
    return this.renderMsAverage;
  }

  /**
   * Whether frames are drawn at all. The loop keeps running either way — the
   * app's own per-frame work lives in it — but while the 3D view is hidden
   * behind the map there is nothing to draw it for, and drawing a globe,
   * a sky and a fleet sixty times a second into an invisible canvas was the
   * single largest cost of simply having the map open.
   */
  renderEnabled = true;

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

    this.onFrame?.({ dt, elapsed: this.elapsed, frame: this.frameCount });
    if (this.renderEnabled) {
      // After the frame's work, so the camera it reads is the one about to draw.
      if (this.origin) {
        const o = this.origin.current;
        this.planetCentre.set(-o[0], -o[1], -o[2]);
      }
      this.atmosphere.update(this.camera, this.planetCentre, this.sunDirection, dt);
      if (this.origin) {
        this.clouds.setLight(this.atmosphere.light);
        this.clouds.update(this.camera, this.origin.current, this.sunDirection, dt);
      }
      const timing = this.beginGpuTimer();
      if (this.post) this.renderer.setRenderTarget(this.post.scene);
      this.renderer.render(this.scene, this.camera);
      // The cockpit, over the world, into a cleared depth buffer (see `@/render/cockpit`).
      const overlay = this.overlay;
      if (overlay?.visible) {
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
        this.renderer.render(overlay.scene, overlay.camera);
        this.renderer.autoClear = true;
      }
      if (this.post) {
        const light = this.atmosphere.light;
        this.post.finish(this.camera, this.sunDirection, light.sunColor, light.sunStrength);
      }
      if (timing) this.endGpuTimer();
    }

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
  /** Start timing the frame on the GPU, unless the last measurement is still out. */
  private beginGpuTimer(): boolean {
    const t = this.timer;
    if (!t) return false;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (t.query) {
      if (!gl.getQueryParameter(t.query, gl.QUERY_RESULT_AVAILABLE)) return false;
      const disjoint = gl.getParameter(t.ext.GPU_DISJOINT_EXT) as boolean;
      if (!disjoint) {
        const ms = (gl.getQueryParameter(t.query, gl.QUERY_RESULT) as number) / 1e6;
        this.gpuMsAverage = this.gpuMsAverage === 0 ? ms : this.gpuMsAverage + (ms - this.gpuMsAverage) * 0.15;
      }
      gl.deleteQuery(t.query);
      t.query = null;
    }
    t.query = gl.createQuery();
    if (!t.query) return false;
    gl.beginQuery(t.ext.TIME_ELAPSED_EXT, t.query);
    t.running = true;
    return true;
  }

  private endGpuTimer(): void {
    const t = this.timer;
    if (!t?.running) return;
    (this.renderer.getContext() as WebGL2RenderingContext).endQuery(t.ext.TIME_ELAPSED_EXT);
    t.running = false;
  }

  private adaptQuality(cpuMs: number, dt: number): void {
    const k = 1 - Math.exp(-dt / 0.5);
    // Whichever half of the frame is the bottleneck sets the resolution.
    const renderMs = Math.max(cpuMs, this.gpuMsAverage);
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
    this.atmosphere.dispose();
    this.post?.dispose();
    this.clouds.dispose();
    this.renderer.dispose();
  }
}
