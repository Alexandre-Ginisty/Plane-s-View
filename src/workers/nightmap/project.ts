/** Putting a vector tile's features onto a level's canvas. */

export interface Bounds {
  south: number;
  north: number;
  west: number;
  east: number;
}

export interface Projector {
  /** Tile units to canvas pixels. */
  toPx: (path: Float64Array) => number[];
  /** Whether a projected path touches the canvas at all. */
  visible: (p: number[]) => boolean;
  /** A path of closed rings (outer and holes), ready to fill. */
  trace: (ctx: OffscreenCanvasRenderingContext2D, rings: number[][]) => void;
}

export function makeProjector(extent: number, zoom: number, tile: { x: number; y: number }, bounds: Bounds, px: number): Projector {
  const n = 2 ** zoom;
  const lonSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;
  return {
    toPx(path) {
      const out = new Array<number>(path.length);
      for (let i = 0; i < path.length; i += 2) {
        const lon = ((tile.x + path[i]! / extent) / n) * 360 - 180;
        const my = (tile.y + path[i + 1]! / extent) / n;
        const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
        out[i] = ((lon - bounds.west) / lonSpan) * px;
        out[i + 1] = ((bounds.north - lat) / latSpan) * px;
      }
      return out;
    },
    visible(p) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) {
        if (p[i]! < x0) x0 = p[i]!;
        if (p[i]! > x1) x1 = p[i]!;
        if (p[i + 1]! < y0) y0 = p[i + 1]!;
        if (p[i + 1]! > y1) y1 = p[i + 1]!;
      }
      return x1 >= 0 && x0 <= px && y1 >= 0 && y0 <= px;
    },
    trace(ctx, rings) {
      ctx.beginPath();
      for (const r of rings) {
        ctx.moveTo(r[0]!, r[1]!);
        for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i]!, r[i + 1]!);
        ctx.closePath();
      }
    },
  };
}
