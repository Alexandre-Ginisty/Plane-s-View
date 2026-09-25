/**
 * Dossier registry — assembles everything known about one aircraft.
 *
 * Three concerns, all of which matter for a page that may be looking at a
 * thousand aircraft:
 *
 *  1. **Free information first.** readsb feeds already carry the registration
 *     and type code alongside the position (`r` and `t`). Those arrive as
 *     "hints" and populate the registry for nothing, so opening the panel on a
 *     typical airliner shows its identity instantly and the network lookup
 *     only fills in the rest.
 *  2. **Never ask twice.** Requests are deduplicated while in flight, results
 *     are cached, and *misses are cached too* — a hex that is not in adsbdb
 *     will still not be there in thirty seconds.
 *  3. **Partial results are results.** A failed photo lookup must not cost the
 *     user the route, so each source is settled independently and problems are
 *     surfaced as `warnings` rather than thrown away or blown up into an error.
 */

import { LruCache } from '@/core/lru';
import type {
  AircraftDossier,
  AircraftMeta,
  AircraftPhoto,
  FlightRoute,
} from '@/data/types';
import type { InlineAirframeHint } from '@/data/adsb/normalize';
import { fetchAirframe, fetchRoute } from './adsbdb';
import { fetchPhotoByHex } from './planespotters';

/** A resolved value, or a remembered miss. */
type Slot<T> = { state: 'hit'; value: T } | { state: 'miss'; at: number };

const MISS_TTL_MS = 10 * 60_000;
const ROUTE_TTL_MS = 30 * 60_000;

function isFresh<T>(slot: Slot<T> | undefined, ttl: number, now: number): boolean {
  if (!slot) return false;
  return slot.state === 'hit' || now - slot.at < ttl;
}

class MetadataRegistry {
  private readonly airframes = new LruCache<string, Slot<AircraftMeta>>({ maxEntries: 4000 });
  private readonly routes = new LruCache<string, Slot<FlightRoute> & { at: number }>({
    maxEntries: 3000,
  });
  private readonly photos = new LruCache<string, Slot<AircraftPhoto>>({ maxEntries: 1500 });

  /** Registration/type learned from the position feed, before any lookup. */
  private readonly hints = new LruCache<string, InlineAirframeHint>({ maxEntries: 8000 });

  private readonly inFlight = new Map<string, Promise<unknown>>();

  /** Feed the free identity data that rides along with positions. */
  ingestHints(hints: readonly InlineAirframeHint[]): void {
    for (const h of hints) {
      if (!h.registration && !h.typeCode) continue;
      this.hints.set(h.hex, h);
    }
  }

  /** Registration known right now, without touching the network. */
  knownRegistration(hex: string): string | null {
    const cached = this.airframes.peek(hex);
    if (cached?.state === 'hit' && cached.value.registration) return cached.value.registration;
    return this.hints.peek(hex)?.registration ?? null;
  }

  /** Type code known right now, without touching the network. */
  knownTypeCode(hex: string): string | null {
    const cached = this.airframes.peek(hex);
    if (cached?.state === 'hit' && cached.value.icaoTypeCode) return cached.value.icaoTypeCode;
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

  async airframe(hex: string, signal?: AbortSignal): Promise<AircraftMeta | null> {
    const now = Date.now();
    const cached = this.airframes.get(hex);
    if (isFresh(cached, MISS_TTL_MS, now)) {
      return cached?.state === 'hit' ? cached.value : null;
    }

    return this.share(`air:${hex}`, async () => {
      const meta = await fetchAirframe(hex, signal);
      if (meta) {
        this.airframes.set(hex, { state: 'hit', value: meta });
        return meta;
      }

      // adsbdb has no record, but the feed may still have told us who this is.
      const hint = this.hints.peek(hex);
      if (hint && (hint.registration || hint.typeCode)) {
        const partial: AircraftMeta = {
          hex,
          registration: hint.registration,
          typeCode: hint.typeCode,
          typeName: null,
          manufacturer: null,
          owner: null,
          registeredCountry: null,
          registeredCountryIso: null,
          icaoTypeCode: hint.typeCode,
          operatorFlagCode: null,
          photoUrl: null,
          photoThumbnailUrl: null,
        };
        this.airframes.set(hex, { state: 'hit', value: partial });
        return partial;
      }

      this.airframes.set(hex, { state: 'miss', at: Date.now() });
      return null;
    });
  }

  async route(callsign: string, signal?: AbortSignal): Promise<FlightRoute | null> {
    const key = callsign.trim().toUpperCase();
    if (!key) return null;

    const now = Date.now();
    const cached = this.routes.get(key);
    // Routes are reused across days for the same flight number, so even hits
    // expire — an airline can retime or retarget a flight.
    if (cached && (cached.state === 'hit' ? now - cached.at < ROUTE_TTL_MS : now - cached.at < MISS_TTL_MS)) {
      return cached.state === 'hit' ? cached.value : null;
    }

    return this.share(`rte:${key}`, async () => {
      const route = await fetchRoute(key, signal);
      const at = Date.now();
      this.routes.set(
        key,
        route ? { state: 'hit', value: route, at } : { state: 'miss', at },
      );
      return route;
    });
  }

  async photo(hex: string, signal?: AbortSignal): Promise<AircraftPhoto | null> {
    const now = Date.now();
    const cached = this.photos.get(hex);
    if (isFresh(cached, MISS_TTL_MS, now)) {
      return cached?.state === 'hit' ? cached.value : null;
    }

    return this.share(`pic:${hex}`, async () => {
      const photo = await fetchPhotoByHex(hex, signal);
      this.photos.set(
        hex,
        photo ? { state: 'hit', value: photo } : { state: 'miss', at: Date.now() },
      );
      return photo;
    });
  }

  /**
   * Everything for the detail panel. The three lookups run concurrently and
   * are settled independently, so one failing source degrades that one field
   * instead of the whole dossier.
   */
  async dossier(
    hex: string,
    callsign: string | null,
    signal?: AbortSignal,
  ): Promise<AircraftDossier> {
    const warnings: string[] = [];

    const [metaR, routeR, photoR] = await Promise.allSettled([
      this.airframe(hex, signal),
      callsign ? this.route(callsign, signal) : Promise.resolve(null),
      this.photo(hex, signal),
    ]);

    const unwrap = <T>(r: PromiseSettledResult<T | null>, label: string): T | null => {
      if (r.status === 'fulfilled') return r.value;
      warnings.push(`${label} unavailable: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      return null;
    };

    const meta = unwrap(metaR, 'Airframe registry');
    const route = unwrap(routeR, 'Route lookup');
    let photo = unwrap(photoR, 'Photo');

    // adsbdb bundles an airport-data.com image; a weaker source, but far
    // better than an empty frame when Planespotters has nothing.
    if (!photo && meta?.photoUrl) {
      photo = {
        thumbnailUrl: meta.photoThumbnailUrl ?? meta.photoUrl,
        largeUrl: meta.photoUrl,
        photographer: null,
        link: null,
      };
    }

    return { hex, meta, route, photo, warnings };
  }
}

/** One registry for the whole app; caching is only useful if it is shared. */
export const registry = new MetadataRegistry();
