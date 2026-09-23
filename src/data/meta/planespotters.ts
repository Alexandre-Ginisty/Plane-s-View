/**
 * Planespotters public photo API.
 *
 * Goes through the relay for one reason: the service requires a descriptive
 * `User-Agent` identifying the project, and `User-Agent` is on the fetch
 * spec's forbidden-header list, so page JavaScript physically cannot set it.
 * The relay adds it. (Its CORS policy is otherwise fully permissive.)
 *
 * Attribution is not optional — the photographer credit and the link back to
 * the photo page are a condition of use, so `AircraftPhoto` keeps both and the
 * UI always renders them.
 */

import { relayUrl } from '@/data/endpoints';
import { fetchJson, HttpError } from '@/data/http';
import type { AircraftPhoto } from '@/data/types';

interface PlanespottersPhoto {
  id?: string;
  thumbnail?: { src?: string };
  thumbnail_large?: { src?: string };
  link?: string;
  photographer?: string;
}

interface PlanespottersResponse {
  photos?: PlanespottersPhoto[];
  error?: string;
}

export async function fetchPhotoByHex(
  hex: string,
  signal?: AbortSignal,
): Promise<AircraftPhoto | null> {
  let body: PlanespottersResponse;
  try {
    body = await fetchJson<PlanespottersResponse>(
      relayUrl('planespotters', `/pub/photos/hex/${encodeURIComponent(hex)}`),
      { timeoutMs: 8000, retries: 1, signal },
    );
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }

  // The API reports its own refusals in-band with a 200.
  if (body.error) throw new Error(`Planespotters: ${body.error}`);

  const photo = body.photos?.[0];
  const thumb = photo?.thumbnail?.src;
  if (!photo || !thumb) return null;

  return {
    thumbnailUrl: thumb,
    largeUrl: photo.thumbnail_large?.src ?? thumb,
    photographer: photo.photographer?.trim() || null,
    link: photo.link ?? null,
  };
}
