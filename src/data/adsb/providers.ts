/**
 * ADS-B provider adapters.
 *
 * Each provider is described declaratively so the client can reason about
 * radius caps and politeness floors without special-casing anyone. All of them
 * are reached through the relay (see `data/endpoints.ts`).
 */

import { fetchJson } from '@/data/http';
import { relayUrl } from '@/data/endpoints';
import { clamp, wrapLongitude } from '@/core/math/geo';
import type { AircraftState, ProviderId, TrafficQuery } from '@/data/types';
import {
  normalizeReadsbResponse,
  type InlineAirframeHint,
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
  /**
   * Asked only when every other provider is out of action, never as part of
   * a sweep. For metered services whose daily allowance a sweep would spend
   * in minutes.
   */
  readonly fallbackOnly?: boolean;
  fetchTraffic(query: TrafficQuery, signal?: AbortSignal): Promise<ProviderResult>;
  /** Track one aircraft worldwide, outside the current viewport query. */
  fetchByHex?(hex: string, signal?: AbortSignal): Promise<ProviderResult>;
}

const TIMEOUT_MS = 9000;
/** Pause before retrying a request that got no response at all. */
const NETWORK_RETRY_MS = 600;

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

  const once = async (path: string, signal?: AbortSignal): Promise<ProviderResult> => {
    const body = await fetchJson<ReadsbResponse>(relayUrl(opts.target, path), {
      timeoutMs: TIMEOUT_MS,
      retries: 0, // the chain is the retry; don't stall it on one slow provider
      signal,
    });
    return normalizeReadsbResponse(body, opts.id, Date.now());
  };

  /*
   * One quick second try, for a network error only.
   *
   * `fetch` rejects with a bare TypeError ("Failed to fetch") when no
   * response arrived at all: Wi-Fi or VPN switching networks, a laptop
   * waking, a dropped keep-alive socket. Those last a fraction of a second,
   * and every provider hits the same one at the same moment, so without this
   * a single blip failed the whole chain. An HTTP error is a real answer
   * and is not retried here: a 429 in particular must reach the breaker.
   */
  const run = async (path: string, signal?: AbortSignal): Promise<ProviderResult> => {
    try {
      return await once(path, signal);
    } catch (err) {
      if (!(err instanceof TypeError) || signal?.aborted) throw err;
      await new Promise((resolve) => setTimeout(resolve, NETWORK_RETRY_MS * (0.5 + Math.random())));
      if (signal?.aborted) throw err;
      return once(path, signal);
    }
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
  // Measured: answers every request, one a second, in about 60 ms.
  minIntervalMs: 2000,
  // Not `/v2/point/...`: adsb.fi spells the query out.
  pointPath: (lat, lon, r) => `/api/v2/lat/${lat}/lon/${lon}/dist/${r}`,
  hexPath: (hex) => `/api/v2/hex/${hex}/`,
});

/**
 * Fallback order. Disabled entries are skipped.
 *
 * adsb.fi first: adsb.lol answers 429 to most requests from a single address
 * (measured: one in three at a request a second), so asking it first spent a
 * request and, after three refusals, a thirty-second lockout before the feed
 * that works was tried. It stays in the chain, where its ODbL data is the one
 * a commercial product may keep once adsb.fi's personal-use terms rule it out.
 */
export const PROVIDERS: readonly AdsbProvider[] = [adsbFi, adsbLol];
