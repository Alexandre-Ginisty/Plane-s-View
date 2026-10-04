/**
 * Aircraft photographs from Wikimedia Commons.
 *
 * The photographs of the usual aviation sites are all-rights-reserved: showing
 * one in a product needs the photographer's permission. Commons holds
 * photographs that are free to reuse, each with its licence on record, and its
 * API answers cross-origin requests, so this is called straight from the page.
 *
 * Two rules keep it honest:
 *
 *  - **Only the right aircraft.** The search is for the registration, and a
 *    result counts only if the registration appears in the file's own name.
 *    A photograph of the wrong aeroplane is worse than none.
 *  - **Only licences that allow commercial use.** CC BY, CC BY-SA, CC0 and
 *    public domain. Anything else — non-commercial, GFDL, "all rights
 *    reserved" — is passed over, and the credit and the licence always travel
 *    with the picture (`AircraftPhoto.svelte`).
 */

import { fetchJson, httpsUrl } from '@/data/http';
import type { AircraftPhoto } from '@/data/types';

interface CommonsResponse {
  query?: {
    pages?: Record<
      string,
      {
        title?: string;
        imageinfo?: {
          thumburl?: string;
          descriptionurl?: string;
          extmetadata?: Record<string, { value?: string } | undefined>;
        }[];
      }
    >;
  };
}

const API = 'https://commons.wikimedia.org/w/api.php';

/** Where Wikimedia serves thumbnails from (the CSP's `img-src` must list the same). */
const IMAGE_HOSTS = ['upload.wikimedia.org', 'thumb.wikimedia.org'];

/** Licences that permit commercial use with credit (or none). */
const OK_LICENCE = /^(CC BY(?:-SA)? [0-9]\.[0-9]|CC0|Public domain|PD)/i;

const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * The text of an HTML fragment: the metadata's `Artist` field is markup. It is
 * rendered as text (Svelte escapes it), so stripping tags is a tidy-up and not
 * what keeps it safe.
 */
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|quot|lt|gt|#0?39|nbsp);/g, (_, e: string) => ({ amp: '&', quot: '"', lt: '<', gt: '>', nbsp: ' ' })[e] ?? "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchPhotoByRegistration(
  registration: string,
  signal?: AbortSignal,
): Promise<AircraftPhoto | null> {
  const reg = norm(registration);
  // Short strings match half the encyclopaedia; real registrations are 4+.
  if (reg.length < 4) return null;

  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrsearch: `"${registration}" filetype:bitmap`,
    gsrnamespace: '6',
    gsrlimit: '12',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: '640',
    iiextmetadatafilter: 'LicenseShortName|Artist',
  });

  const body = await fetchJson<CommonsResponse>(`${API}?${params}`, {
    timeoutMs: 8000,
    retries: 1,
    signal,
  });

  // Search ranks by relevance; keep that order among the files that qualify.
  const pages = Object.values(body.query?.pages ?? {});
  for (const page of pages) {
    if (!norm(page.title ?? '').includes(reg)) continue;
    const info = page.imageinfo?.[0];
    const licence = info?.extmetadata?.['LicenseShortName']?.value?.trim();
    // Only ever an https link to Wikimedia: what is set as an `<img src>` and
    // an `<a href>` comes from a response, so it is checked, not trusted.
    const thumb = httpsUrl(info?.thumburl);
    const link = httpsUrl(info?.descriptionurl);
    if (!info || !thumb || !link || !licence || !OK_LICENCE.test(licence)) continue;
    if (!IMAGE_HOSTS.some((h) => thumb.startsWith(`https://${h}/`))) continue;
    if (!link.startsWith('https://commons.wikimedia.org/')) continue;

    const artist = info.extmetadata?.['Artist']?.value;
    return {
      thumbnailUrl: thumb,
      largeUrl: thumb,
      photographer: artist ? plainText(artist).slice(0, 120) || null : null,
      license: licence,
      link,
    };
  }
  return null;
}
