/**
 * A 2D canvas over the 3D view, for text that has to follow the scene.
 *
 * Pin names and the labels on nearby traffic are both projected from 3D
 * positions every frame and drawn here, in real text, at device resolution.
 * One canvas for both, so they are cleared and sized in one place and can
 * never disagree about which frame they belong to.
 *
 * ## Colours come from the stylesheet
 *
 * The HUD's colours are CSS custom properties that change with the theme (see
 * `ui/theme.css`). A canvas cannot use `var(--hud-text)`, so the values are
 * read once and re-read only when the theme attribute on `<html>` changes —
 * never per frame, because `getComputedStyle` forces a style recalculation.
 */

export interface OverlayPalette {
  text: string;
  dim: string;
  bg: string;
  accent: string;
  warm: string;
  danger: string;
  /** Stroke drawn under text so it survives any background. */
  halo: string;
  light: boolean;
}

export interface OverlayFrame {
  ctx: CanvasRenderingContext2D;
  /** CSS pixels. */
  width: number;
  height: number;
  palette: OverlayPalette;
  /** Seconds, monotonic: for anything that animates. */
  time: number;
  /** Set by whoever draws, so the next frame knows there is something to clear. */
  drew: boolean;
}

const DARK_FALLBACK: OverlayPalette = {
  text: '#eef7ff',
  dim: '#b4d2e6',
  bg: 'rgba(3, 8, 14, 0.55)',
  accent: '#7fdfff',
  warm: '#ffb02e',
  danger: '#ff3b4e',
  halo: 'rgba(0, 0, 0, 0.65)',
  light: false,
};

function readPalette(): OverlayPalette {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return DARK_FALLBACK;
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
  const light = document.documentElement.dataset['theme'] === 'light';
  return {
    text: read('--hud-text', DARK_FALLBACK.text),
    dim: read('--hud-dim', DARK_FALLBACK.dim),
    bg: read('--hud-bg', DARK_FALLBACK.bg),
    accent: read('--hud-accent', DARK_FALLBACK.accent),
    warm: read('--hud-warm', DARK_FALLBACK.warm),
    danger: read('--error', DARK_FALLBACK.danger),
    halo: light ? 'rgba(255, 255, 255, 0.85)' : DARK_FALLBACK.halo,
    light,
  };
}

export class ViewOverlay {
  private readonly ctx: CanvasRenderingContext2D;
  private palette: OverlayPalette = readPalette();
  private readonly observer: MutationObserver | null = null;
  /** Whether the last frame put anything on the canvas. See `begin`. */
  private dirty = true;
  private last: OverlayFrame | null = null;
  private readonly started = performance.now();

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    if (typeof MutationObserver !== 'undefined') {
      this.observer = new MutationObserver(() => (this.palette = readPalette()));
      this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
  }

  /** Size to the element, clear, and hand back a context in CSS pixels. */
  begin(): OverlayFrame {
    const { canvas, ctx } = this;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      this.dirty = true;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // A clear of a full-screen canvas is not free; most frames over open sky
    // have nothing on them, and a canvas that was left empty is still empty.
    if (this.dirty || this.last?.drew) ctx.clearRect(0, 0, width, height);
    this.dirty = false;
    this.last = {
      ctx,
      width,
      height,
      palette: this.palette,
      time: (performance.now() - this.started) / 1000,
      drew: false,
    };
    return this.last;
  }

  clear(): void {
    this.dirty = true;
    this.begin();
  }

  dispose(): void {
    this.observer?.disconnect();
  }
}
