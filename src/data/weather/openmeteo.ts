/**
 * Open-Meteo current conditions. Free, keyless, and CORS-open, so it is called
 * directly from the page.
 *
 * This is the *fallback* weather source. ADS-B version 2 transponders
 * broadcast wind and temperature measured by the aircraft itself (`wd`, `ws`,
 * `oat`), which is both more accurate and exactly at the aircraft's altitude —
 * a forecast model interpolated to the surface is not the same thing. The UI
 * prefers the aircraft's own data and falls back here when the transponder
 * does not send it.
 */

import { DIRECT } from '@/data/endpoints';
import { fetchJson } from '@/data/http';
import { LruCache } from '@/core/lru';
import type { AloftLevel, CurrentWeather } from '@/data/types';

interface OpenMeteoResponse {
  current?: {
    time?: string;
    temperature_2m?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
    cloud_cover?: number;
    pressure_msl?: number;
    visibility?: number;
    is_day?: number;
    [level: string]: number | string | undefined;
  };
}

/**
 * Pressure levels read for the air aloft, hPa: from about FL240 to FL450,
 * where contrails form. The feed's own temperature is better where an
 * aircraft broadcasts it; humidity nothing on board reports.
 */
const ALOFT_HPA = [400, 300, 250, 200, 150] as const;

const CURRENT_FIELDS = [
  'temperature_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'dew_point_2m',
  'pressure_msl',
  'visibility',
  'is_day',
  ...ALOFT_HPA.flatMap((hPa) => [`temperature_${hPa}hPa`, `relative_humidity_${hPa}hPa`]),
].join(',');

const TTL_MS = 10 * 60_000;
/** Quantise to ~0.25° so a moving aircraft reuses one cell instead of thrashing. */
const GRID = 4;

const cache = new LruCache<string, { at: number; value: CurrentWeather }>({ maxEntries: 256 });
const inFlight = new Map<string, Promise<CurrentWeather | null>>();

const n = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

function aloftOf(c: NonNullable<OpenMeteoResponse['current']>): CurrentWeather['aloft'] {
  const out: AloftLevel[] = [];
  for (const hPa of ALOFT_HPA) {
    const tempC = n(c[`temperature_${hPa}hPa`]);
    const rhPct = n(c[`relative_humidity_${hPa}hPa`]);
    if (tempC !== null && rhPct !== null) out.push({ hPa, tempC, rhPct });
  }
  return out.length ? out : null;
}

export async function fetchCurrentWeather(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<CurrentWeather | null> {
  const key = `${Math.round(lat * GRID)}:${Math.round(lon * GRID)}`;
  const now = Date.now();

  const cached = cache.get(key);
  if (cached && now - cached.at < TTL_MS) return cached.value;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const params = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    current: CURRENT_FIELDS,
    wind_speed_unit: 'ms',
    timezone: 'UTC',
  });

  const p = (async (): Promise<CurrentWeather | null> => {
    try {
      const body = await fetchJson<OpenMeteoResponse>(
        `${DIRECT.openMeteo}/v1/forecast?${params}`,
        { timeoutMs: 8000, retries: 1, signal },
      );
      const c = body.current;
      if (!c) return null;

      const value: CurrentWeather = {
        temperatureC: n(c.temperature_2m),
        windSpeedMs: n(c.wind_speed_10m),
        windDirectionDeg: n(c.wind_direction_10m),
        cloudCoverPct: n(c.cloud_cover),
        cloudLowPct: n(c.cloud_cover_low),
        cloudMidPct: n(c.cloud_cover_mid),
        cloudHighPct: n(c.cloud_cover_high),
        dewPointC: n(c.dew_point_2m),
        pressureMslHpa: n(c.pressure_msl),
        visibilityM: n(c.visibility),
        isDay: c.is_day === undefined ? null : c.is_day === 1,
        aloft: aloftOf(c),
        observedAt: Date.now(),
      };

      cache.set(key, { at: Date.now(), value });
      return value;
    } catch {
      // Weather is decoration; a failure must never surface as an error.
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, p);
  return p;
}
