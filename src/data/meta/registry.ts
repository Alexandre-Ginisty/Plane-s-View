/**
 * Dossier registry — assembles everything known about one aircraft.
 *
 * Nothing here comes from a registry service. Identity is free: readsb feeds
 * carry the registration and type code with every position (`r` and `t`), they
 * arrive as "hints" the moment an aircraft is first heard, and opening the
 * panel on an airliner shows its identity instantly. The rest is local or
 * free to reuse:
 *
 *  - **Route and airline** — static files built from CC0 data (`routes.ts`).
 *  - **Photograph** — Wikimedia Commons, licence-filtered (`commons.ts`); the
 *    one lookup that crosses the network, so it is cached, misses included
 *    (a registration with no free photograph will still have none in ten
 *    minutes), and de-duplicated while in flight.
 *
 * Partial results are results: each part is settled independently, and a
 * failed photograph lookup must not cost the user the route.
 */

import { t as translate, type MessageKey } from '@/i18n/index.svelte';
import { LruCache } from '@/core/lru';
import type { AircraftDossier, AircraftMeta, AircraftPhoto, FlightRoute } from '@/data/types';
import type { InlineAirframeHint } from '@/data/adsb/normalize';
import { fetchPhotoByRegistration } from './commons';
import { fetchRoute, lookupAirline } from './routes';
import { typeName } from './typeNames';

/** A resolved value, or a remembered miss. */
type Slot<T> = { state: 'hit'; value: T; at: number } | { state: 'miss'; at: number };

const MISS_TTL_MS = 10 * 60_000;
const ROUTE_TTL_MS = 30 * 60_000;

function fresh<T>(slot: Slot<T> | undefined, now: number): T | null | undefined {
  if (!slot) return undefined;
  const ttl = slot.state === 'hit' ? ROUTE_TTL_MS : MISS_TTL_MS;
  if (now - slot.at >= ttl) return undefined;
  return slot.state === 'hit' ? slot.value : null;
}

class MetadataRegistry {
  private readonly routes = new LruCache<string, Slot<FlightRoute>>({ maxEntries: 3000 });
  private readonly photos = new LruCache<string, Slot<AircraftPhoto>>({ maxEntries: 1500 });

  /** Registration and type learned from the position feed. */
  private readonly hints = new LruCache<string, InlineAirframeHint>({ maxEntries: 8000 });

  private readonly inFlight = new Map<string, Promise<unknown>>();

  /** Feed the identity data that rides along with positions. */
  ingestHints(hints: readonly InlineAirframeHint[]): void {
    for (const h of hints) {
      if (!h.registration && !h.typeCode) continue;
      this.hints.set(h.hex, h);
    }
  }

  /** Registration known right now. */
  knownRegistration(hex: string): string | null {
    return this.hints.peek(hex)?.registration ?? null;
  }

  /** Type code known right now. */
  knownTypeCode(hex: string): string | null {
    return this.hints.peek(hex)?.typeCode ?? null;
  }

  /** Collapse concurrent callers onto one request per key. */
  private share<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const p = run().finally(() => {
      if (this.inFlight.get(key) === p) this.inFlight.delete(key);
    });
    this.inFlight.set(key, p);
    return p;
  }

  async route(callsign: string, signal?: AbortSignal): Promise<FlightRoute | null> {
    const key = callsign.trim().toUpperCase();
    if (!key) return null;

    const cached = fresh(this.routes.get(key), Date.now());
    if (cached !== undefined) return cached;

    return this.share(`rte:${key}`, async () => {
      const route = await fetchRoute(key, signal);
      const at = Date.now();
      this.routes.set(key, route ? { state: 'hit', value: route, at } : { state: 'miss', at });
      return route;
    });
  }

  async photo(registration: string, signal?: AbortSignal): Promise<AircraftPhoto | null> {
    const key = registration.trim().toUpperCase();
    const cached = fresh(this.photos.get(key), Date.now());
    if (cached !== undefined) return cached;

    return this.share(`pic:${key}`, async () => {
      const photo = await fetchPhotoByRegistration(key, signal);
      const at = Date.now();
      this.photos.set(key, photo ? { state: 'hit', value: photo, at } : { state: 'miss', at });
      return photo;
    });
  }

  /**
   * Everything for the detail panel. The lookups run concurrently and are
   * settled independently, so one failing source degrades that one field
   * instead of the whole dossier.
   */
  async dossier(
    hex: string,
    callsign: string | null,
    signal?: AbortSignal,
  ): Promise<AircraftDossier> {
    const warnings: string[] = [];
    const hint = this.hints.peek(hex);
    const registration = hint?.registration ?? null;

    const [routeR, airlineR, photoR] = await Promise.allSettled([
      callsign ? this.route(callsign, signal) : Promise.resolve(null),
      callsign ? lookupAirline(callsign, signal) : Promise.resolve(null),
      registration ? this.photo(registration, signal) : Promise.resolve(null),
    ]);

    const unwrap = <T>(r: PromiseSettledResult<T | null>, what: MessageKey): T | null => {
      if (r.status === 'fulfilled') return r.value;
      warnings.push(
        translate('dossier.unavailable', {
          what: translate(what),
          reason: r.reason instanceof Error ? r.reason.message : String(r.reason),
        }),
      );
      return null;
    };

    const route = unwrap(routeR, 'dossier.whatRoute');
    const airline = unwrap(airlineR, 'dossier.whatAirline');
    const photo = unwrap(photoR, 'dossier.whatPhoto');

    const typeCode = hint?.typeCode ?? null;
    const meta: AircraftMeta | null =
      registration || typeCode
        ? { hex, registration, icaoTypeCode: typeCode, typeName: typeName(typeCode), owner: airline?.name ?? null }
        : null;

    return { hex, meta, route, photo, warnings };
  }
}

/** One registry for the whole app; caching is only useful if it is shared. */
export const registry = new MetadataRegistry();
