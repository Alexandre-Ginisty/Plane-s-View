/**
 * Surface conditions from MET Norway's Locationforecast (CC BY 4.0, NLOD).
 *
 * Chosen over Open-Meteo, whose free tier forbids commercial use; MET Norway's
 * terms permit it with credit. It is called through the relay because it asks
 * for a `User-Agent` identifying the project, which a page cannot send.
 *
 * This is the *fallback* weather source. ADS-B version 2 transponders
 * broadcast wind and temperature measured by the aircraft itself (`wd`, `ws`,
 * `oat`), which is both more accurate and exactly at the aircraft's altitude —
 * a forecast model interpolated to the surface is not the same thing. The UI
 * prefers the aircraft's own data and falls back here when the transponder
 * does not send it.
 */

import { relayUrl } from '@/data/endpoints';
import { fetchJson } from '@/data/http';
import { LruCache } from '@/core/lru';
import type { CurrentWeather } from '@/data/types';

interface MetnoResponse {
  properties?: {
    timeseries?: {
      data?: {
        instant?: {
          details?: {
            air_temperature?: number;
            wind_speed?: number;
            wind_from_direction?: number;
            cloud_area_fraction?: number;
            cloud_area_fraction_low?: number;
            cloud_area_fraction_medium?: number;
            cloud_area_fraction_high?: number;
            dew_point_temperature?: number;
            air_pressure_at_sea_level?: number;
            fog_area_fraction?: number;
          };
        };
      };
    }[];
  };
}

/** Their terms: don't re-ask inside the `Expires` window, and spread the load. */
const TTL_MS = 10 * 60_000;
/**
 * Quantise to 0.25°. A moving aircraft reuses one cell instead of thrashing,
 * and every visitor over the same cell asks the relay for the *same URL*, so
 * the edge cache answers for all of them and MET Norway sees one request.
 */
const GRID = 4;

const cache = new LruCache<string, { at: number; value: CurrentWeather }>({ maxEntries: 256 });
const inFlight = new Map<string, Promise<CurrentWeather | null>>();

const n = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * MET Norway reports no visibility. Fog is the one thing that dominates it, so
 * haze is estimated from the fog fraction and left unknown otherwise (which the
 * sky treats as clear).
 */
function visibilityFromFog(fogPct: number | null): number | null {
  if (fogPct === null) return null;
  if (fogPct >= 80) return 1_500;
  if (fogPct >= 50) return 4_000;
  if (fogPct >= 20) return 8_000;
  return null;
}

export async function fetchCurrentWeather(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<CurrentWeather | null> {
  const cellLat = Math.round(lat * GRID);
  const cellLon = Math.round(lon * GRID);
  const key = `${cellLat}:${cellLon}`;
  const now = Date.now();

  const cached = cache.get(key);
  if (cached && now - cached.at < TTL_MS) return cached.value;

  const existing = inFlight.get(key);
  if (existing) return existing;

  // The cell's centre, never the caller's own position: fewer than four
  // decimals, as the terms require, and one URL per cell.
  const params = new URLSearchParams({
    lat: (cellLat / GRID).toFixed(2),
    lon: (cellLon / GRID).toFixed(2),
  });

  const p = (async (): Promise<CurrentWeather | null> => {
    try {
      const body = await fetchJson<MetnoResponse>(
        relayUrl('metno', `/weatherapi/locationforecast/2.0/complete?${params}`),
        { timeoutMs: 8000, retries: 1, signal },
      );
      const d = body.properties?.timeseries?.[0]?.data?.instant?.details;
      if (!d) return null;

      const value: CurrentWeather = {
        temperatureC: n(d.air_temperature),
        windSpeedMs: n(d.wind_speed),
        windDirectionDeg: n(d.wind_from_direction),
        cloudCoverPct: n(d.cloud_area_fraction),
        cloudLowPct: n(d.cloud_area_fraction_low),
        cloudMidPct: n(d.cloud_area_fraction_medium),
        cloudHighPct: n(d.cloud_area_fraction_high),
        dewPointC: n(d.dew_point_temperature),
        pressureMslHpa: n(d.air_pressure_at_sea_level),
        visibilityM: visibilityFromFog(n(d.fog_area_fraction)),
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
