/**
 * Display formatting.
 *
 * Aviation conventions throughout, because the audience for a flight tracker
 * already reads them: altitudes as flight levels above the transition
 * altitude, speeds in knots, vertical rate in feet per minute, headings as
 * three digits. Guessing at "friendlier" units would only make it harder to
 * cross-check against any other source.
 */

import { i18n, t } from '@/i18n/index.svelte';

const MISSING = '—';

const formats = new Map<string, Intl.NumberFormat>();

/**
 * A number in the language's own grouping and decimal mark, but always in Latin
 * digits: an altitude or a speed reads the same in every cockpit, and in every
 * other tracker the visitor may cross-check against.
 */
function numberFormat(digits: number): Intl.NumberFormat {
  const key = `${i18n.locale}/${digits}`;
  let nf = formats.get(key);
  if (!nf) {
    try {
      nf = new Intl.NumberFormat(`${i18n.locale}-u-nu-latn`, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    } catch {
      nf = new Intl.NumberFormat('en', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }
    formats.set(key, nf);
  }
  return nf;
}

export function num(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return numberFormat(digits).format(value);
}

/**
 * Altitude. Above 18 000 ft it becomes a flight level, which is what the
 * aircraft is actually flying and what every other tracker shows.
 */
export function altitude(ft: number | null, onGround = false): string {
  if (onGround) return t('unit.ground');
  if (ft === null || !Number.isFinite(ft)) return MISSING;
  if (ft >= 18_000) return `FL${Math.round(ft / 100).toString().padStart(3, '0')}`;
  return `${num(Math.round(ft / 25) * 25)} ft`;
}

export function speed(knots: number | null): string {
  return knots === null || !Number.isFinite(knots) ? MISSING : `${num(knots)} kt`;
}

/**
 * Mach in the conventional leading-point form: M.786, but M1.200 supersonic.
 *
 * Dropping the first character assumed the value always starts with `0`, so
 * anything at or above Mach 1 lost its integer digit and rendered as M.200.
 */
export function mach(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return MISSING;
  const text = value.toFixed(3);
  return `M${text.startsWith('0.') ? text.slice(1) : text}`;
}

/** Headings are always three digits: 007, not 7. */
export function heading(deg: number | null): string {
  if (deg === null || !Number.isFinite(deg)) return MISSING;
  const d = Math.round(((deg % 360) + 360) % 360) % 360;
  return `${d.toString().padStart(3, '0')}°`;
}

export function verticalRate(fpm: number | null): string {
  if (fpm === null || !Number.isFinite(fpm)) return MISSING;
  const rounded = Math.round(fpm / 50) * 50;
  if (Math.abs(rounded) < 100) return t('unit.level');
  const arrow = rounded > 0 ? '↑' : '↓';
  return `${arrow} ${num(Math.abs(rounded))} fpm`;
}

export function temperature(celsius: number | null): string {
  return celsius === null || !Number.isFinite(celsius) ? MISSING : `${num(celsius)} °C`;
}

export function distanceNm(nm: number | null): string {
  return nm === null || !Number.isFinite(nm) ? MISSING : `${num(nm, 1)} NM`;
}

/** Compact relative age: "3 s", "2 min", "1 h". */
export function age(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return MISSING;
  if (seconds < 60) return t('unit.s', { n: Math.max(0, Math.round(seconds)) });
  if (seconds < 3600) return t('unit.min', { n: Math.round(seconds / 60) });
  return t('unit.h', { n: num(seconds / 3600, 1) });
}

export function wind(directionDeg: number | null, speedKt: number | null): string {
  if (directionDeg === null || speedKt === null) return MISSING;
  return `${heading(directionDeg)} / ${num(speedKt)} kt`;
}

/** Squawk codes that mean something specific. */
export function squawkMeaning(code: string | null): string | null {
  switch (code) {
    case '7500': return t('squawk.7500');
    case '7600': return t('squawk.7600');
    case '7700': return t('squawk.7700');
    default: return null;
  }
}

export function airportLabel(
  airport: { iata: string | null; icao: string | null; municipality: string | null; name: string | null } | null,
): string {
  if (!airport) return MISSING;
  return airport.iata ?? airport.icao ?? airport.municipality ?? airport.name ?? MISSING;
}

export function bytes(mb: number): string {
  return mb >= 1024 ? t('unit.gb', { n: num(mb / 1024, 1) }) : t('unit.mb', { n: num(mb) });
}

