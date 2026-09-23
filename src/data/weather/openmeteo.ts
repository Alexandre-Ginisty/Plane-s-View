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
import type { CurrentWeather } from '@/data/types';

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
  };
}

const CURRENT_FIELDS = [
  'temperature_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'cloud_cover',
  'pressure_msl',
  'is_day',
].join(',');

const TTL_MS = 10 * 60_000;
/** Quantise to ~0.25° so a moving aircraft reuses one cell instead of thrashing. */
const GRID = 4;

const cache = new LruCache<string, { at: number; value: CurrentWeather }>({ maxEntries: 256 });
const inFlight = new Map<string, Promise<CurrentWeather | null>>();

const n = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

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
        pressureMslHpa: n(c.pressure_msl),
        visibilityM: n(c.visibility),
        isDay: c.is_day === undefined ? null : c.is_day === 1,
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
