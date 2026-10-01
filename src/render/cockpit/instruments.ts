/**
 * The cockpit's displays, drawn into 2D canvases that the 3D cockpit shows as
 * textures: the fighter's head-up display and its two multi-function screens,
 * the airliner's glass (PFD, ND, engine page), and the classic round gauges.
 *
 * Every function draws one whole display from the readings and nothing else,
 * so a display can never disagree with another about the same number.
 *
 * ## The HUD is conformal
 *
 * Its symbols are drawn where the things they stand for are: the horizon line
 * lies on the horizon, the flight path marker on the point the aircraft is
 * actually going to. The combiner is a plane a
 * known distance in front of the eye, so a direction at angle a off the
 * boresight lands `distance · tan(a)` from its centre — which is what
 * `HudGeometry.pxPerTan` converts to pixels. Looking around does not break
 * it: the eye turns, it does not move.
 */

import type { CockpitReadings } from './readings';

type Ctx = CanvasRenderingContext2D;

const DEG = Math.PI / 180;
const wrap360 = (d: number) => ((d % 360) + 360) % 360;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const HUD_GREEN = '#46ff7e';
const MFD_GREEN = '#5dff8a';
const MFD_AMBER = '#ffb640';
const MFD_CYAN = '#56e0ff';
const MFD_MAGENTA = '#ff5fe8';
const WHITE = '#f2f5f7';

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

export interface HudGeometry {
  /** Canvas pixels for a direction whose tangent off the boresight is 1. */
  pxPerTan: number;
  /** Where the boresight falls on the canvas. */
  cx: number;
  cy: number;
}

function hudLine(ctx: Ctx, x0: number, y0: number, x1: number, y1: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/**
 * The head-up display. The canvas is black where nothing is drawn: it is
 * shown with additive blending, so black is clear glass.
 */
export function drawHud(ctx: Ctx, w: number, h: number, r: CockpitReadings, g: HudGeometry): void {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.strokeStyle = HUD_GREEN;
  ctx.fillStyle = HUD_GREEN;
  ctx.lineWidth = Math.max(1.5, w / 380);
  ctx.shadowColor = 'rgba(70, 255, 126, 0.7)';
  ctx.shadowBlur = w / 150;
  const fs = Math.round(w / 38);
  ctx.font = `600 ${fs}px "JetBrains Mono", "SFMono-Regular", Menlo, monospace`;
  ctx.textBaseline = 'middle';
  const { cx, cy, pxPerTan: k } = g;
  const px = (rad: number) => Math.tan(clamp(rad, -1.3, 1.3)) * k;

  // --- Pitch ladder and horizon, about the boresight, rolled with the world.
  ctx.save();
  ctx.beginPath();
  ctx.rect(w * 0.08, h * 0.12, w * 0.84, h * 0.7);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-r.rollDeg * DEG);
  const pitch = r.pitchDeg * DEG;
  for (let deg = -90; deg <= 90; deg += 5) {
    const y = px(pitch - deg * DEG);
    if (Math.abs(y) > h) continue;
    if (deg === 0) {
      ctx.setLineDash([]);
      hudLine(ctx, -w * 0.46, y, -w * 0.07, y);
      hudLine(ctx, w * 0.07, y, w * 0.46, y);
      continue;
    }
    const half = w * 0.1;
    const gap = w * 0.045;
    ctx.setLineDash(deg < 0 ? [w / 60, w / 90] : []);
    hudLine(ctx, -half - gap, y, -gap, y);
    hudLine(ctx, gap, y, gap + half, y);
    ctx.setLineDash([]);
    // The ends point at the horizon.
    const tick = (deg > 0 ? 1 : -1) * w * 0.018;
    hudLine(ctx, -half - gap, y, -half - gap, y + tick);
    hudLine(ctx, gap + half, y, gap + half, y + tick);
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.abs(deg)), -half - gap - w * 0.012, y);
    ctx.textAlign = 'left';
    ctx.fillText(String(Math.abs(deg)), gap + half + w * 0.012, y);
  }
  ctx.restore();
  ctx.setLineDash([]);

  // --- Boresight (gun cross / waterline).
  const s = w * 0.022;
  hudLine(ctx, cx - s * 2, cy, cx - s, cy);
  hudLine(ctx, cx - s, cy, cx - s * 0.5, cy + s * 0.6);
  hudLine(ctx, cx - s * 0.5, cy + s * 0.6, cx, cy);
  hudLine(ctx, cx, cy, cx + s * 0.5, cy + s * 0.6);
  hudLine(ctx, cx + s * 0.5, cy + s * 0.6, cx + s, cy);
  hudLine(ctx, cx + s, cy, cx + s * 2, cy);

  // --- Flight path marker: where the aircraft is actually going.
  if (r.aoaDeg !== null) {
    const fx = cx + px((r.betaDeg ?? 0) * DEG);
    const fy = cy + px(r.aoaDeg * DEG);
    const rad = w * 0.016;
    ctx.beginPath();
    ctx.arc(fx, fy, rad, 0, Math.PI * 2);
    ctx.stroke();
    hudLine(ctx, fx - rad * 3, fy, fx - rad, fy);
    hudLine(ctx, fx + rad, fy, fx + rad * 3, fy);
    hudLine(ctx, fx, fy - rad, fx, fy - rad * 2.2);
  }

  // --- Speed and altitude boxes with their tapes.
  const boxY = cy;
  const bw = w * 0.13;
  const bh = fs * 1.5;
  drawTapeBox(ctx, w * 0.09, boxY, bw, bh, Math.round(r.iasKt).toString(), 'left');
  drawTapeBox(ctx, w * 0.91 - bw, boxY, bw, bh, Math.round(r.altFt).toLocaleString('en'), 'right');
  drawHudTape(ctx, w * 0.09 + bw + w * 0.01, boxY, h * 0.34, r.iasKt, 10, 50, 'left', fs);
  drawHudTape(ctx, w * 0.91 - bw - w * 0.01, boxY, h * 0.34, r.altFt, 100, 500, 'right', fs);

  // --- Heading tape along the bottom.
  const tapeY = h * 0.88;
  const span = 30;
  const hdg = r.headingDeg;
  ctx.textAlign = 'center';
  for (let d = Math.ceil((hdg - span / 2) / 5) * 5; d <= hdg + span / 2; d += 5) {
    const x = cx + ((d - hdg) / span) * w * 0.5;
    const major = wrap360(d) % 10 === 0;
    hudLine(ctx, x, tapeY, x, tapeY - (major ? h * 0.025 : h * 0.013));
    if (major) ctx.fillText(String(Math.round(wrap360(d) / 10)).padStart(2, '0'), x, tapeY - h * 0.05);
  }
  hudLine(ctx, cx, tapeY + h * 0.005, cx - w * 0.012, tapeY + h * 0.03);
  hudLine(ctx, cx, tapeY + h * 0.005, cx + w * 0.012, tapeY + h * 0.03);
  ctx.fillText(String(Math.round(wrap360(hdg))).padStart(3, '0'), cx, tapeY + h * 0.06);

  // --- Data blocks.
  ctx.textAlign = 'left';
  const lx = w * 0.09;
  let ly = cy + h * 0.2;
  if (r.g !== null) {
    ctx.fillText(`G ${r.g.toFixed(1)}`, lx, h * 0.17);
  }
  if (r.mach !== null) {
    ctx.fillText(`M ${r.mach.toFixed(2)}`, lx, ly);
    ly += fs * 1.2;
  }
  if (r.aoaDeg !== null) {
    ctx.fillText(`α ${r.aoaDeg.toFixed(1)}`, lx, ly);
    ly += fs * 1.2;
  }
  ctx.textAlign = 'right';
  const rx = w * 0.91;
  let ry = cy + h * 0.2;
  ctx.fillText(`VS ${Math.round(r.vsFpm / 10) * 10}`, rx, ry);
  ry += fs * 1.2;
  if (r.aglFt !== null && r.aglFt < 5000) {
    ctx.fillText(`R ${Math.round(r.aglFt / 10) * 10}`, rx, ry);
    ry += fs * 1.2;
  }
  if (r.throttle !== null) {
    ctx.fillText(r.afterburner > 0.02 ? `AB ${Math.round(r.afterburner * 100)}%` : `THR ${Math.round(r.throttle * 100)}%`, rx, h * 0.17);
  }

  // --- Warnings.
  ctx.textAlign = 'center';
  const blink = Math.floor(performance.now() / 250) % 2 === 0;
  if ((r.stall || r.stallWarning) && blink) ctx.fillText('STALL', cx, cy + h * 0.12);
  else if (r.overspeed && blink) ctx.fillText('OVERSPEED', cx, cy + h * 0.12);
  else if (r.aglFt !== null && r.aglFt < 500 && r.vsFpm < -1500 && blink) ctx.fillText('PULL UP', cx, cy + h * 0.12);
  ctx.restore();
}

function drawTapeBox(ctx: Ctx, x: number, cy: number, w: number, h: number, text: string, side: 'left' | 'right'): void {
  ctx.strokeRect(x, cy - h / 2, w, h);
  ctx.textAlign = side === 'left' ? 'right' : 'left';
  ctx.fillText(text, side === 'left' ? x + w - w * 0.08 : x + w * 0.08, cy + 1);
}

function drawHudTape(ctx: Ctx, x: number, cy: number, height: number, value: number, minor: number, major: number, side: 'left' | 'right', fs: number): void {
  const range = major * 2;
  const dir = side === 'left' ? 1 : -1;
  ctx.textAlign = side === 'left' ? 'left' : 'right';
  for (let v = Math.ceil((value - range) / minor) * minor; v <= value + range; v += minor) {
    const y = cy - ((v - value) / range) * (height / 2);
    if (Math.abs(y - cy) < fs * 1.1) continue;
    const isMajor = Math.round(v) % major === 0;
    hudLine(ctx, x, y, x + dir * (isMajor ? fs * 0.8 : fs * 0.4), y);
    if (isMajor && v >= 0) ctx.fillText(Math.round(v).toLocaleString('en'), x + dir * fs * 1.1, y);
  }
}

// ---------------------------------------------------------------------------
// Fighter MFDs
// ---------------------------------------------------------------------------

function screenFrame(ctx: Ctx, w: number, h: number, title: string, labels: readonly string[]): void {
  ctx.fillStyle = '#020604';
  ctx.fillRect(0, 0, w, h);
  ctx.font = `600 ${Math.round(w / 26)}px "JetBrains Mono", Menlo, monospace`;
  ctx.fillStyle = MFD_GREEN;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  // Option-select labels along the top, the way the real pages are framed.
  labels.forEach((l, i) => ctx.fillText(l, ((i + 0.5) / labels.length) * w, h * 0.025));
  ctx.textBaseline = 'bottom';
  ctx.fillText(title, w / 2, h * 0.985);
}

/** Air-to-air radar, B-scope: azimuth across, range up, every contact a return. */
export function drawRadar(ctx: Ctx, w: number, h: number, r: CockpitReadings): void {
  screenFrame(ctx, w, h, 'FCR', ['CRM', 'RWS', '40', 'A4', 'CNTL']);
  const x0 = w * 0.1;
  const x1 = w * 0.9;
  const y0 = h * 0.12;
  const y1 = h * 0.88;
  const rangeM = 40 * 1852;
  ctx.strokeStyle = 'rgba(93,255,138,0.35)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = y1 - ((y1 - y0) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }
  for (const az of [-30, 0, 30]) {
    const x = x0 + ((az + 60) / 120) * (x1 - x0);
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
  }
  ctx.strokeStyle = MFD_GREEN;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  // Horizon line and own-ship bank, as on the real page.
  ctx.save();
  ctx.translate(w / 2, (y0 + y1) / 2);
  ctx.rotate(-r.rollDeg * DEG);
  ctx.strokeStyle = 'rgba(93,255,138,0.5)';
  ctx.beginPath();
  ctx.moveTo(-w * 0.12, 0);
  ctx.lineTo(-w * 0.04, 0);
  ctx.moveTo(w * 0.04, 0);
  ctx.lineTo(w * 0.12, 0);
  ctx.stroke();
  ctx.restore();
  // The antenna sweep.
  {
    const sweep = Math.sin(performance.now() / 700);
    const sx = w / 2 + sweep * (x1 - x0) * 0.42;
    ctx.strokeStyle = 'rgba(93,255,138,0.8)';
    ctx.beginPath();
    ctx.moveTo(sx, y1);
    ctx.lineTo(sx, y1 + h * 0.03);
    ctx.stroke();
  }
  ctx.fillStyle = MFD_GREEN;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const c of r.contacts) {
    if (Math.abs(c.az) > 60 * DEG || c.rangeM > rangeM) continue;
    const x = x0 + ((c.az / DEG + 60) / 120) * (x1 - x0);
    const y = y1 - (c.rangeM / rangeM) * (y1 - y0);
    const b = w * 0.018;
    ctx.fillRect(x - b * 0.8, y - b * 0.8, b * 1.6, b * 1.6);
  }
  ctx.textAlign = 'right';
  ctx.fillText('40', x0 - w * 0.01, y0 + h * 0.02);
  ctx.fillText('20', x0 - w * 0.01, (y0 + y1) / 2);
}

/** Engine and systems page: core speed dial, nozzle, fuel flow, configuration. */
export function drawSystems(ctx: Ctx, w: number, h: number, r: CockpitReadings): void {
  screenFrame(ctx, w, h, 'SYS', ['ENG', 'FUEL', 'HYD', 'ELEC', 'FLCS']);
  const rpm = r.rpm ?? 0;
  const pct = r.jet ? rpm / 100 : rpm / 2700;
  dial(ctx, w * 0.3, h * 0.36, w * 0.17, clamp(pct / 1.05, 0, 1), r.jet ? `${Math.round(rpm)}%` : `${Math.round(rpm)}`, r.jet ? 'RPM' : 'RPM', MFD_GREEN);
  dial(ctx, w * 0.72, h * 0.36, w * 0.17, r.throttle ?? 0, `${Math.round((r.throttle ?? 0) * 100)}`, 'THR', MFD_CYAN);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.round(w / 22)}px "JetBrains Mono", Menlo, monospace`;
  const rows: [string, string, string][] = [
    ['A/B', r.afterburner > 0.02 ? `ZONE ${Math.max(1, Math.ceil(r.afterburner * 5))}` : 'OFF', r.afterburner > 0.02 ? MFD_AMBER : MFD_GREEN],
    ['GEAR', r.gear === 'down' ? 'DN  3 GRN' : r.gear === 'transit' ? 'TRANSIT' : 'UP', r.gear === 'transit' ? MFD_AMBER : MFD_GREEN],
    ['FLAPS', r.flapsDeg === null ? '--' : `${Math.round(r.flapsDeg)}°`, MFD_GREEN],
    ['SPD BRK', r.speedBrake ? 'OPEN' : 'CLOSED', r.speedBrake ? MFD_AMBER : MFD_GREEN],
    ['G', r.g === null ? '--' : r.g.toFixed(1), (r.g ?? 1) > 8 ? MFD_AMBER : MFD_GREEN],
  ];
  rows.forEach(([k, v, c], i) => {
    const y = h * 0.64 + i * h * 0.062;
    ctx.fillStyle = 'rgba(93,255,138,0.6)';
    ctx.fillText(k, w * 0.1, y);
    ctx.fillStyle = c;
    ctx.fillText(v, w * 0.46, y);
  });
}

function dial(ctx: Ctx, x: number, y: number, radius: number, frac: number, value: string, label: string, color: string): void {
  const a0 = Math.PI * 0.75;
  const a1 = Math.PI * 2.25;
  ctx.lineWidth = radius * 0.08;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  ctx.arc(x, y, radius, a0, a1);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, a0, a0 + (a1 - a0) * clamp(frac, 0, 1));
  ctx.stroke();
  ctx.lineWidth = radius * 0.05;
  const a = a0 + (a1 - a0) * clamp(frac, 0, 1);
  ctx.strokeStyle = WHITE;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + Math.cos(a) * radius * 0.85, y + Math.sin(a) * radius * 0.85);
  ctx.stroke();
  ctx.fillStyle = WHITE;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.round(radius * 0.38)}px "JetBrains Mono", Menlo, monospace`;
  ctx.fillText(value, x, y + radius * 0.55);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = `600 ${Math.round(radius * 0.24)}px "JetBrains Mono", Menlo, monospace`;
  ctx.fillText(label, x, y + radius * 0.95);
}

// ---------------------------------------------------------------------------
// Airliner glass
// ---------------------------------------------------------------------------

/** Primary flight display: attitude, speed and altitude tapes, vertical speed, heading. */
export function drawPfd(ctx: Ctx, w: number, h: number, r: CockpitReadings): void {
  ctx.fillStyle = '#050608';
  ctx.fillRect(0, 0, w, h);
  const cx = w * 0.5;
  const cy = h * 0.46;
  const ppd = h * 0.012; // pixels per degree of pitch
  // Attitude sphere.
  ctx.save();
  ctx.beginPath();
  ctx.rect(w * 0.2, h * 0.13, w * 0.6, h * 0.66);
  ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate(-r.rollDeg * DEG);
  const off = r.pitchDeg * ppd;
  ctx.fillStyle = '#2a6fd1';
  ctx.fillRect(-w, -h * 2 + off, w * 2, h * 2);
  ctx.fillStyle = '#7a4a22';
  ctx.fillRect(-w, off, w * 2, h * 2);
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-w, off);
  ctx.lineTo(w, off);
  ctx.stroke();
  ctx.fillStyle = WHITE;
  ctx.font = `600 ${Math.round(h / 34)}px "JetBrains Mono", Menlo, monospace`;
  ctx.textBaseline = 'middle';
  for (let d = -30; d <= 30; d += 2.5) {
    if (d === 0) continue;
    const y = off - d * ppd;
    const len = d % 10 === 0 ? w * 0.09 : d % 5 === 0 ? w * 0.05 : w * 0.025;
    ctx.beginPath();
    ctx.moveTo(-len, y);
    ctx.lineTo(len, y);
    ctx.stroke();
    if (d % 10 === 0) {
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.abs(d)), -len - 4, y);
      ctx.textAlign = 'left';
      ctx.fillText(String(Math.abs(d)), len + 4, y);
    }
  }
  ctx.restore();
  // Roll scale and pointer.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 2;
  const rr = h * 0.3;
  ctx.beginPath();
  ctx.arc(0, 0, rr, -Math.PI / 2 - Math.PI / 3, -Math.PI / 2 + Math.PI / 3);
  ctx.stroke();
  for (const d of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const a = -Math.PI / 2 + d * DEG;
    const l = Math.abs(d) % 30 === 0 ? 14 : 8;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    ctx.lineTo(Math.cos(a) * (rr + l), Math.sin(a) * (rr + l));
    ctx.stroke();
  }
  ctx.rotate(-r.rollDeg * DEG);
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  ctx.moveTo(0, -rr);
  ctx.lineTo(-8, -rr + 14);
  ctx.lineTo(8, -rr + 14);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // Aircraft symbol.
  ctx.fillStyle = '#ffd24a';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1.5;
  for (const side of [-1, 1]) {
    ctx.fillRect(cx + side * w * 0.16 - (side < 0 ? 0 : w * 0.1), cy - 4, w * 0.1, 8);
  }
  ctx.fillRect(cx - 5, cy - 5, 10, 10);
  // Tapes.
  tape(ctx, w * 0.02, h * 0.13, w * 0.15, h * 0.66, r.iasKt, 10, 20, 'left');
  tape(ctx, w * 0.83, h * 0.13, w * 0.14, h * 0.66, r.altFt, 100, 500, 'right');
  // Vertical speed.
  ctx.fillStyle = WHITE;
  ctx.textAlign = 'center';
  ctx.font = `600 ${Math.round(h / 30)}px "JetBrains Mono", Menlo, monospace`;
  ctx.fillText(`${r.vsFpm >= 0 ? '+' : ''}${Math.round(r.vsFpm / 50) * 50}`, w * 0.9, h * 0.84);
  // Heading.
  ctx.fillStyle = '#111';
  ctx.fillRect(w * 0.25, h * 0.85, w * 0.5, h * 0.13);
  ctx.fillStyle = WHITE;
  ctx.textBaseline = 'middle';
  for (let d = Math.ceil((r.headingDeg - 30) / 5) * 5; d <= r.headingDeg + 30; d += 5) {
    const x = cx + ((d - r.headingDeg) / 60) * w * 0.5;
    ctx.fillRect(x - 1, h * 0.85, 2, wrap360(d) % 10 === 0 ? h * 0.03 : h * 0.015);
    if (wrap360(d) % 30 === 0) ctx.fillText(String(Math.round(wrap360(d) / 10)), x, h * 0.915);
  }
  ctx.fillStyle = '#ffd24a';
  ctx.fillText(String(Math.round(wrap360(r.headingDeg))).padStart(3, '0'), cx, h * 0.955);
  // Mode annunciators.
  ctx.fillStyle = '#35e05b';
  ctx.font = `600 ${Math.round(h / 32)}px "JetBrains Mono", Menlo, monospace`;
  ctx.fillText('SPEED', w * 0.3, h * 0.05);
  ctx.fillText('HDG', w * 0.5, h * 0.05);
  ctx.fillText(r.vsFpm > 300 ? 'CLB' : r.vsFpm < -300 ? 'DES' : 'ALT', w * 0.7, h * 0.05);
  if (r.stall || r.stallWarning) {
    ctx.fillStyle = '#ff3b30';
    ctx.fillText('STALL', cx, h * 0.2);
  }
}

function tape(ctx: Ctx, x: number, y: number, w: number, h: number, value: number, minor: number, major: number, side: 'left' | 'right'): void {
  ctx.fillStyle = 'rgba(80,90,110,0.55)';
  ctx.fillRect(x, y, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const cy = y + h / 2;
  const range = major * 3;
  ctx.fillStyle = WHITE;
  ctx.strokeStyle = WHITE;
  ctx.font = `600 ${Math.round(h / 16)}px "JetBrains Mono", Menlo, monospace`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = side === 'left' ? 'right' : 'left';
  for (let v = Math.ceil((value - range) / minor) * minor; v <= value + range; v += minor) {
    const yy = cy - ((v - value) / range) * (h / 2);
    const isMajor = Math.round(v) % major === 0;
    const tx = side === 'left' ? x + w : x;
    const len = isMajor ? w * 0.18 : w * 0.1;
    ctx.fillRect(side === 'left' ? tx - len : tx, yy - 1, len, 2);
    if (isMajor && v >= 0) ctx.fillText(Math.round(v).toString(), side === 'left' ? tx - len - 4 : tx + len + 4, yy);
  }
  ctx.restore();
  // The readout window.
  ctx.fillStyle = '#000';
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 2;
  const bh = h * 0.1;
  ctx.fillRect(x, cy - bh / 2, w, bh);
  ctx.strokeRect(x, cy - bh / 2, w, bh);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.font = `700 ${Math.round(h / 13)}px "JetBrains Mono", Menlo, monospace`;
  ctx.fillText(Math.round(value).toString(), x + w / 2, cy + 1);
}

/** Navigation display, arc mode: heading, track, wind, traffic. */
export function drawNd(ctx: Ctx, w: number, h: number, r: CockpitReadings): void {
  ctx.fillStyle = '#040507';
  ctx.fillRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h * 0.82;
  const R = h * 0.68;
  const rangeM = 40 * 1852;
  ctx.strokeStyle = WHITE;
  ctx.fillStyle = WHITE;
  ctx.lineWidth = 2;
  ctx.font = `600 ${Math.round(h / 28)}px "JetBrains Mono", Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.beginPath();
  ctx.arc(cx, cy, R, Math.PI * 1.17, Math.PI * 1.83);
  ctx.stroke();
  ctx.setLineDash([6, 8]);
  ctx.beginPath();
  ctx.arc(cx, cy, R / 2, Math.PI * 1.17, Math.PI * 1.83);
  ctx.stroke();
  ctx.setLineDash([]);
  for (let d = Math.ceil((r.headingDeg - 60) / 5) * 5; d <= r.headingDeg + 60; d += 5) {
    const a = (d - r.headingDeg) * DEG - Math.PI / 2;
    const l = wrap360(d) % 10 === 0 ? 14 : 7;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.lineTo(cx + Math.cos(a) * (R + l), cy + Math.sin(a) * (R + l));
    ctx.stroke();
    if (wrap360(d) % 30 === 0) ctx.fillText(String(Math.round(wrap360(d) / 10)), cx + Math.cos(a) * (R + 30), cy + Math.sin(a) * (R + 30));
  }
  // Track line.
  const ta = (r.trackDeg - r.headingDeg) * DEG - Math.PI / 2;
  ctx.strokeStyle = '#35e05b';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(ta) * R, cy + Math.sin(ta) * R);
  ctx.stroke();
  // Own ship.
  ctx.strokeStyle = '#ffd24a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 18);
  ctx.lineTo(cx, cy + 12);
  ctx.moveTo(cx - 14, cy - 4);
  ctx.lineTo(cx + 14, cy - 4);
  ctx.moveTo(cx - 6, cy + 10);
  ctx.lineTo(cx + 6, cy + 10);
  ctx.stroke();
  // Traffic.
  for (const c of r.contacts) {
    if (c.rangeM > rangeM || Math.abs(c.az) > 70 * DEG) continue;
    const d = (c.rangeM / rangeM) * R;
    const x = cx + Math.sin(c.az) * d;
    const y = cy - Math.cos(c.az) * d;
    const near = c.rangeM < 6 * 1852 && Math.abs(c.relAltFt) < 1200;
    ctx.fillStyle = near ? MFD_AMBER : MFD_CYAN;
    ctx.beginPath();
    ctx.moveTo(x, y - 7);
    ctx.lineTo(x + 7, y);
    ctx.lineTo(x, y + 7);
    ctx.lineTo(x - 7, y);
    ctx.closePath();
    ctx.fill();
    ctx.font = `600 ${Math.round(h / 40)}px "JetBrains Mono", Menlo, monospace`;
    const rel = Math.round(c.relAltFt / 100);
    ctx.fillText(`${rel >= 0 ? '+' : ''}${String(rel).padStart(2, '0')}`, x, y - 16);
  }
  // Speeds and wind, top left.
  ctx.textAlign = 'left';
  ctx.fillStyle = WHITE;
  ctx.font = `600 ${Math.round(h / 28)}px "JetBrains Mono", Menlo, monospace`;
  ctx.fillText(`GS ${Math.round(r.gsKt)}`, w * 0.04, h * 0.06);
  if (r.windFromDeg !== null && r.windKt !== null) {
    ctx.fillText(`${String(Math.round(r.windFromDeg)).padStart(3, '0')}°/${Math.round(r.windKt)}`, w * 0.04, h * 0.12);
    const wa = (r.windFromDeg - r.headingDeg + 180) * DEG;
    const ax = w * 0.08;
    const ay = h * 0.2;
    ctx.strokeStyle = WHITE;
    ctx.beginPath();
    ctx.moveTo(ax - Math.sin(wa) * 16, ay + Math.cos(wa) * 16);
    ctx.lineTo(ax + Math.sin(wa) * 16, ay - Math.cos(wa) * 16);
    ctx.stroke();
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = MFD_MAGENTA;
  ctx.fillText('TFC  40', w * 0.96, h * 0.06);
}

/** Engine and alerting display: fan speed dials, configuration. */
export function drawEicas(ctx: Ctx, w: number, h: number, r: CockpitReadings): void {
  ctx.fillStyle = '#040507';
  ctx.fillRect(0, 0, w, h);
  const n1 = r.rpm !== null ? (r.jet ? r.rpm / 100 : r.rpm / 2700) : 0.85;
  for (const [i, x] of [w * 0.28, w * 0.72].entries()) {
    dial(ctx, x, h * 0.26, w * 0.16, clamp(n1, 0, 1.05), (n1 * 100).toFixed(1), `N1 ${i + 1}`, WHITE);
  }
  ctx.font = `600 ${Math.round(h / 22)}px "JetBrains Mono", Menlo, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const lines: [string, string][] = [
    ['FLAPS', r.flapsDeg === null ? '--' : `${Math.round(r.flapsDeg)}`],
    ['GEAR', r.gear === 'down' ? 'DOWN' : r.gear === 'transit' ? '···' : r.gear === 'up' ? 'UP' : '--'],
    ['THR', r.throttle === null ? '--' : `${Math.round(r.throttle * 100)}%`],
    ['SPD BRK', r.speedBrake ? 'EXT' : 'RET'],
  ];
  lines.forEach(([k, v], i) => {
    const y = h * 0.62 + i * h * 0.08;
    ctx.fillStyle = MFD_CYAN;
    ctx.fillText(k, w * 0.12, y);
    ctx.fillStyle = r.gear === 'transit' && k === 'GEAR' ? MFD_AMBER : '#35e05b';
    ctx.fillText(v, w * 0.55, y);
  });
  if (r.stall || r.overspeed) {
    ctx.fillStyle = '#ff3b30';
    ctx.textAlign = 'center';
    ctx.fillText(r.stall ? 'STALL' : 'OVERSPEED', w / 2, h * 0.52);
  }
}

// ---------------------------------------------------------------------------
// Round gauges
// ---------------------------------------------------------------------------

function bezel(ctx: Ctx, x: number, y: number, R: number): void {
  const g = ctx.createRadialGradient(x, y - R * 0.3, R * 0.2, x, y, R * 1.12);
  g.addColorStop(0, '#3a3d42');
  g.addColorStop(1, '#101114');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, R * 1.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0b0c0e';
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fill();
}

function needle(ctx: Ctx, x: number, y: number, R: number, a: number, len = 0.82, width = 0.05): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  ctx.moveTo(-R * width, R * 0.1);
  ctx.lineTo(0, -R * len);
  ctx.lineTo(R * width, R * 0.1);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(x, y, R * 0.07, 0, Math.PI * 2);
  ctx.fill();
}

function scale(ctx: Ctx, x: number, y: number, R: number, a0: number, a1: number, n: number, labels: (i: number) => string | null, major = 1): void {
  ctx.strokeStyle = WHITE;
  ctx.fillStyle = WHITE;
  ctx.font = `600 ${Math.round(R * 0.2)}px "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    const big = i % major === 0;
    ctx.lineWidth = big ? R * 0.035 : R * 0.018;
    ctx.beginPath();
    ctx.moveTo(x + Math.sin(a) * R * (big ? 0.78 : 0.86), y - Math.cos(a) * R * (big ? 0.78 : 0.86));
    ctx.lineTo(x + Math.sin(a) * R * 0.95, y - Math.cos(a) * R * 0.95);
    ctx.stroke();
    const l = labels(i);
    if (l) ctx.fillText(l, x + Math.sin(a) * R * 0.6, y - Math.cos(a) * R * 0.6);
  }
}

/** Airspeed indicator, 40–200 kt (or up to 500 for the fast ones). */
function asi(ctx: Ctx, x: number, y: number, R: number, kt: number, max: number): void {
  bezel(ctx, x, y, R);
  const a0 = -Math.PI * 0.85;
  const a1 = Math.PI * 0.85;
  // The coloured arcs: green normal, white flaps, yellow caution.
  const arc = (from: number, to: number, color: string, r: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = R * 0.06;
    ctx.beginPath();
    ctx.arc(x, y, R * r, a0 + (a1 - a0) * (from / max) - Math.PI / 2, a0 + (a1 - a0) * (to / max) - Math.PI / 2);
    ctx.stroke();
  };
  arc(max * 0.24, max * 0.64, '#29c24a', 0.93);
  arc(max * 0.2, max * 0.43, '#e8e8e8', 0.86);
  arc(max * 0.64, max * 0.8, '#f2c230', 0.93);
  scale(ctx, x, y, R, a0, a1, 16, (i) => (i % 2 === 0 && i > 0 ? String(Math.round((max * i) / 16)) : null), 2);
  ctx.fillStyle = WHITE;
  ctx.font = `600 ${Math.round(R * 0.14)}px Arial`;
  ctx.fillText('KNOTS', x, y + R * 0.35);
  needle(ctx, x, y, R, a0 + (a1 - a0) * clamp(kt / max, 0, 1));
}

/** Attitude indicator: the ball behind a fixed aircraft symbol. */
function adi(ctx: Ctx, x: number, y: number, R: number, pitchDeg: number, rollDeg: number): void {
  bezel(ctx, x, y, R);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, R * 0.96, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(x, y);
  ctx.rotate(-rollDeg * DEG);
  const off = clamp(pitchDeg, -40, 40) * R * 0.03;
  ctx.fillStyle = '#2f7fd4';
  ctx.fillRect(-R * 2, -R * 3 + off, R * 4, R * 3);
  ctx.fillStyle = '#7b4b25';
  ctx.fillRect(-R * 2, off, R * 4, R * 3);
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = R * 0.03;
  ctx.beginPath();
  ctx.moveTo(-R, off);
  ctx.lineTo(R, off);
  ctx.stroke();
  for (const d of [-20, -10, 10, 20]) {
    const yy = off - d * R * 0.03;
    const l = Math.abs(d) === 10 ? R * 0.22 : R * 0.34;
    ctx.beginPath();
    ctx.moveTo(-l, yy);
    ctx.lineTo(l, yy);
    ctx.stroke();
  }
  // Bank pointer on the rotating ring.
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  ctx.moveTo(0, -R * 0.93);
  ctx.lineTo(-R * 0.06, -R * 0.8);
  ctx.lineTo(R * 0.06, -R * 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // Fixed aircraft.
  ctx.strokeStyle = '#f5a623';
  ctx.lineWidth = R * 0.06;
  ctx.beginPath();
  ctx.moveTo(x - R * 0.55, y);
  ctx.lineTo(x - R * 0.18, y);
  ctx.lineTo(x, y + R * 0.1);
  ctx.lineTo(x + R * 0.18, y);
  ctx.lineTo(x + R * 0.55, y);
  ctx.stroke();
  scale(ctx, x, y, R, -Math.PI / 3, Math.PI / 3, 4, () => null, 1);
}

/** Altimeter: hundreds and thousands hands, a drum for the ten-thousands. */
function altimeter(ctx: Ctx, x: number, y: number, R: number, ft: number): void {
  bezel(ctx, x, y, R);
  scale(ctx, x, y, R, 0, Math.PI * 2, 50, (i) => (i % 5 === 0 && i < 50 ? String(i / 5) : null), 5);
  ctx.fillStyle = '#000';
  ctx.fillRect(x - R * 0.28, y + R * 0.18, R * 0.56, R * 0.2);
  ctx.fillStyle = WHITE;
  ctx.font = `600 ${Math.round(R * 0.16)}px monospace`;
  ctx.fillText(String(Math.max(0, Math.round(ft))).padStart(5, '0'), x, y + R * 0.285);
  needle(ctx, x, y, R, ((ft / 10000) % 1) * Math.PI * 2, 0.5, 0.08);
  needle(ctx, x, y, R, ((ft / 1000) % 1) * Math.PI * 2, 0.86, 0.045);
}

/** Vertical speed indicator, ±2000 fpm. */
function vsi(ctx: Ctx, x: number, y: number, R: number, fpm: number): void {
  bezel(ctx, x, y, R);
  const a = (f: number) => -Math.PI / 2 + clamp(f / 2000, -1, 1) * Math.PI * 0.88;
  scale(ctx, x, y, R, -Math.PI / 2 - Math.PI * 0.88, -Math.PI / 2 + Math.PI * 0.88, 8, (i) => (i % 2 === 0 ? String(Math.abs((i - 4) * 5)) : null), 2);
  needle(ctx, x, y, R, a(fpm));
}

/** Heading indicator: the card turns under a fixed lubber line. */
function headingIndicator(ctx: Ctx, x: number, y: number, R: number, hdg: number): void {
  bezel(ctx, x, y, R);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-hdg * DEG);
  scale(ctx, 0, 0, R, 0, Math.PI * 2, 72, (i) => (i % 6 === 0 && i < 72 ? (['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'][i / 6] ?? null) : null), 2);
  ctx.restore();
  ctx.strokeStyle = '#f5a623';
  ctx.lineWidth = R * 0.05;
  ctx.beginPath();
  ctx.moveTo(x, y - R * 0.95);
  ctx.lineTo(x, y - R * 0.7);
  ctx.moveTo(x, y - R * 0.3);
  ctx.lineTo(x, y + R * 0.3);
  ctx.moveTo(x - R * 0.25, y - R * 0.05);
  ctx.lineTo(x + R * 0.25, y - R * 0.05);
  ctx.stroke();
}

/** Turn coordinator: the little aircraft banks with the rate of turn. */
function turnCoordinator(ctx: Ctx, x: number, y: number, R: number, rollDeg: number): void {
  bezel(ctx, x, y, R);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(clamp(rollDeg, -35, 35) * DEG * 0.8);
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = R * 0.06;
  ctx.beginPath();
  ctx.moveTo(-R * 0.62, 0);
  ctx.lineTo(R * 0.62, 0);
  ctx.moveTo(0, -R * 0.16);
  ctx.lineTo(0, R * 0.05);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = WHITE;
  ctx.font = `600 ${Math.round(R * 0.14)}px Arial`;
  ctx.fillText('L', x - R * 0.7, y + R * 0.3);
  ctx.fillText('R', x + R * 0.7, y + R * 0.3);
  ctx.fillStyle = '#222';
  ctx.fillRect(x - R * 0.4, y + R * 0.45, R * 0.8, R * 0.14);
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  ctx.arc(x, y + R * 0.52, R * 0.06, 0, Math.PI * 2);
  ctx.fill();
}

/** Tachometer. */
function tach(ctx: Ctx, x: number, y: number, R: number, rpm: number, jet: boolean): void {
  bezel(ctx, x, y, R);
  const max = jet ? 110 : 3500;
  const a0 = -Math.PI * 0.75;
  const a1 = Math.PI * 0.75;
  scale(ctx, x, y, R, a0, a1, jet ? 11 : 7, (i) => (jet ? String(i * 10) : String(i * 5)), 1);
  ctx.fillStyle = WHITE;
  ctx.font = `600 ${Math.round(R * 0.13)}px Arial`;
  ctx.fillText(jet ? '% RPM' : 'RPM ×100', x, y + R * 0.4);
  needle(ctx, x, y, R, a0 + (a1 - a0) * clamp(rpm / max, 0, 1));
}

/**
 * The classic panel: six-pack in front of the pilot, a tachometer beside it,
 * on a dark grey face with the switches and placards of a real one.
 */
export function drawSixPack(ctx: Ctx, w: number, h: number, r: CockpitReadings, maxKt: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#2c2f33');
  g.addColorStop(1, '#1d1f22');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Screw heads and panel seams, so the face reads as metal.
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(w * 0.01, h * 0.02, w * 0.98, h * 0.96);
  const R = h * 0.2;
  const col = [w * 0.14, w * 0.33, w * 0.52];
  const row = [h * 0.28, h * 0.72];
  asi(ctx, col[0]!, row[0]!, R, r.iasKt, maxKt);
  adi(ctx, col[1]!, row[0]!, R, r.pitchDeg, r.rollDeg);
  altimeter(ctx, col[2]!, row[0]!, R, r.altFt);
  turnCoordinator(ctx, col[0]!, row[1]!, R, r.rollDeg);
  headingIndicator(ctx, col[1]!, row[1]!, R, r.headingDeg);
  vsi(ctx, col[2]!, row[1]!, R, r.vsFpm);
  tach(ctx, w * 0.73, row[0]!, R * 0.9, r.rpm ?? 0, r.jet);
  // Engine strip and annunciators.
  ctx.fillStyle = '#0c0d0f';
  ctx.fillRect(w * 0.64, h * 0.53, w * 0.3, h * 0.4);
  ctx.font = `600 ${Math.round(h / 20)}px "JetBrains Mono", Menlo, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const lines: [string, string, string][] = [
    ['THR', r.throttle === null ? '--' : `${Math.round(r.throttle * 100)}%`, '#e9e9e9'],
    ['FLAPS', r.flapsDeg === null ? '--' : `${Math.round(r.flapsDeg)}°`, '#e9e9e9'],
    ['GEAR', r.gear === 'down' ? 'DOWN' : r.gear === 'transit' ? 'TRANSIT' : r.gear === 'up' ? 'UP' : 'FIXED', r.gear === 'down' ? '#35e05b' : '#e9e9e9'],
    ['TRIM', '', '#e9e9e9'],
  ];
  lines.slice(0, 3).forEach(([k, v, c], i) => {
    const y = h * 0.62 + i * h * 0.1;
    ctx.fillStyle = '#9aa0a8';
    ctx.fillText(k, w * 0.66, y);
    ctx.fillStyle = c;
    ctx.fillText(v, w * 0.8, y);
  });
  if (r.stall || r.stallWarning) {
    ctx.fillStyle = Math.floor(performance.now() / 250) % 2 ? '#ff3b30' : '#5a1410';
    ctx.fillRect(w * 0.66, h * 0.08, w * 0.12, h * 0.08);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText('STALL', w * 0.72, h * 0.12);
  }
}
