/**
 * ADS-B provider adapters.
 *
 * Each provider is described declaratively so the client can reason about
 * radius caps and politeness floors without special-casing anyone. All of them
 * are reached through the relay (see `data/endpoints.ts`).
 */

import { fetchJson } from '@/data/http';
import { relayUrl } from '@/data/endpoints';
import { clamp, metresPerDegree, NM_TO_METRES, wrapLongitude } from '@/core/math/geo';
import type { AircraftState, ProviderId, TrafficQuery } from '@/data/types';
import {
  normalizeOpenSkyResponse,
  normalizeReadsbResponse,
  type InlineAirframeHint,
  type OpenSkyResponse,
  type ReadsbResponse,
} from './normalize';

interface ProviderResult {
  states: AircraftState[];
  hints: InlineAirframeHint[];
}

export interface AdsbProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Homepage, shown in the attribution panel. */
  readonly homepage: string;
  /** Disabled providers are skipped entirely but stay visible in the UI. */
  readonly enabled: boolean;
  /** Shown to the user when `enabled` is false. */
  readonly disabledReason?: string;
  /** Largest radius the endpoint accepts, nautical miles. */
  readonly maxRadiusNm: number;
  /**
   * Minimum spacing between our own requests, ms. These are donated services;
   * polling faster than the data updates is pure waste.
   */
  readonly minIntervalMs: number;
  fetchTraffic(query: TrafficQuery, signal?: AbortSignal): Promise<ProviderResult>;
  /** Track one aircraft worldwide, outside the current viewport query. */
  fetchByHex?(hex: string, signal?: AbortSignal): Promise<ProviderResult>;
}

const TIMEOUT_MS = 9000;

/** readsb-family providers differ only in how they spell the URL. */
function readsbProvider(opts: {
  id: ProviderId;
  label: string;
  homepage: string;
  target: Parameters<typeof relayUrl>[0];
  enabled?: boolean;
  disabledReason?: string;
  maxRadiusNm?: number;
  minIntervalMs?: number;
  pointPath(lat: string, lon: string, radius: number): string;
  hexPath?(hex: string): string;
}): AdsbProvider {
  const maxRadiusNm = opts.maxRadiusNm ?? 250;

  const run = async (path: string, signal?: AbortSignal): Promise<ProviderResult> => {
    const body = await fetchJson<ReadsbResponse>(relayUrl(opts.target, path), {
      timeoutMs: TIMEOUT_MS,
      retries: 0, // the chain is the retry; don't stall it on one slow provider
      signal,
    });
    return normalizeReadsbResponse(body, opts.id, Date.now());
  };

  const provider: AdsbProvider = {
    id: opts.id,
    label: opts.label,
    homepage: opts.homepage,
    enabled: opts.enabled ?? true,
    maxRadiusNm,
    minIntervalMs: opts.minIntervalMs ?? 2000,
    async fetchTraffic(query, signal) {
      const radius = Math.round(clamp(query.radiusNm, 1, maxRadiusNm));
      // 5 decimals ~= 1 m; more just defeats any upstream caching.
      return run(opts.pointPath(query.lat.toFixed(5), wrapLongitude(query.lon).toFixed(5), radius), signal);
    },
  };

  if (opts.disabledReason !== undefined) {
    (provider as { disabledReason?: string }).disabledReason = opts.disabledReason;
  }
  if (opts.hexPath) {
    const hexPath = opts.hexPath;
    provider.fetchByHex = (hex, signal) => run(hexPath(hex), signal);
  }

  return provider;
}

const adsbLol = readsbProvider({
  id: 'adsb.lol',
  label: 'adsb.lol',
  homepage: 'https://adsb.lol',
  target: 'adsb-lol',
  // Measured: adsb.lol answers 429 under sustained sub-3 s polling from one
  // client. Positions are dead-reckoned between fixes anyway, so a slower poll
  // costs nothing visible and keeps us inside what a donated service offers.
  minIntervalMs: 3000,
  pointPath: (lat, lon, r) => `/v2/point/${lat}/${lon}/${r}`,
  hexPath: (hex) => `/v2/hex/${hex}`,
});

const adsbFi = readsbProvider({
  id: 'adsb.fi',
  label: 'adsb.fi (OpenData)',
  homepage: 'https://adsb.fi',
  target: 'adsb-fi',
  minIntervalMs: 2000,
  // Not `/v2/point/...` as the brief states — adsb.fi spells the query out.
  pointPath: (lat, lon, r) => `/api/v2/lat/${lat}/lon/${lon}/dist/${r}/`,
  hexPath: (hex) => `/api/v2/hex/${hex}/`,
});

const airplanesLive = readsbProvider({
  id: 'airplanes.live',
  label: 'airplanes.live',
  homepage: 'https://airplanes.live',
  target: 'airplanes-live',
  // Verified 2026-09: the public v2 API answers 403 to unapproved clients,
  // asking that projects email contact@airplanes.live first. Left in the chain
  // so it can be switched on once approved, but off by default — hammering an
  // endpoint that is telling us to ask permission is not acceptable.
  enabled: false,
  disabledReason:
    'Requires prior approval from airplanes.live (email contact@airplanes.live). Enable once granted.',
  minIntervalMs: 2000,
  pointPath: (lat, lon, r) => `/v2/point/${lat}/${lon}/${r}`,
  hexPath: (hex) => `/v2/hex/${hex}`,
});

/**
 * OpenSky takes a bounding box rather than a radius, and its anonymous tier is
 * both slow (10 s resolution) and credit-metered — hence last in the chain.
 */
const openSky: AdsbProvider = {
  id: 'opensky',
  label: 'OpenSky Network',
  homepage: 'https://opensky-network.org',
  enabled: true,
  maxRadiusNm: 400,
  // The anonymous tier grants ~400 credits/day. One request per 15 s is about
  // 5 700/day, so the client's budget guard (not this floor) does the limiting;
  // this just stops bursts.
  minIntervalMs: 10_000,
  async fetchTraffic(query, signal) {
    const radiusM = clamp(query.radiusNm, 1, 400) * NM_TO_METRES;
    const per = metresPerDegree(query.lat);
    const dLat = radiusM / per.lat;
    // Guard the cosine collapsing near the poles.
    const dLon = per.lon > 1 ? radiusM / per.lon : 180;

    const lamin = clamp(query.lat - dLat, -90, 90);
    const lamax = clamp(query.lat + dLat, -90, 90);
    const lomin = clamp(query.lon - dLon, -180, 180);
    const lomax = clamp(query.lon + dLon, -180, 180);

    const qs = new URLSearchParams({
      lamin: lamin.toFixed(4),
      lomin: lomin.toFixed(4),
      lamax: lamax.toFixed(4),
      lomax: lomax.toFixed(4),
      extended: '1', // adds the category field
    });

    const body = await fetchJson<OpenSkyResponse>(
      relayUrl('opensky', `/api/states/all?${qs}`),
      { timeoutMs: 14_000, retries: 0, signal },
    );

    return { states: normalizeOpenSkyResponse(body, Date.now()), hints: [] };
  },
};

/** Fallback order, exactly as the brief specifies. Disabled entries are skipped. */
export const PROVIDERS: readonly AdsbProvider[] = [
  adsbLol,
  airplanesLive,
  adsbFi,
  openSky,
];
