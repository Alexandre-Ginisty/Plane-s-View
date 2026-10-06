/**
 * Sharing a view, and saving what the camera sees.
 *
 * A phone gets its own share sheet — that is where people expect to send a
 * link or a photo from. A desktop gets the link on the clipboard and the file
 * in its downloads folder, because a share sheet there is a small dialog that
 * offers three apps nobody uses.
 */

import { app } from '@/state/appStore.svelte';
import { t } from '@/i18n/index.svelte';
import type { SampledAircraft } from '@/state/traffic';
import type { AircraftDossier } from '@/data/types';
import { shareableUrl, type DeepLink } from './deepLink';

/** The view the app is showing, as a link. */
export function currentLink(): DeepLink | null {
  if (app.selectedHex) {
    return { kind: 'aircraft', hex: app.selectedHex, cam: app.view === 'pov' ? app.cameraMode : null };
  }
  const where = app.mapView;
  return where ? { kind: 'map', ...where } : null;
}

/** One line naming the flight: callsign, type and route, as far as they are known. */
export function describeFlight(sample: SampledAircraft | null, dossier: AircraftDossier | null): string {
  if (!sample) return 'PlanesView';
  const callsign = sample.latest.callsign ?? dossier?.meta?.registration ?? sample.hex.toUpperCase();
  const type = dossier?.meta?.icaoTypeCode;
  const from = dossier?.route?.origin;
  const to = dossier?.route?.destination;
  const route = from || to ? `${from?.iata ?? from?.icao ?? '···'} → ${to?.iata ?? to?.icao ?? '···'}` : null;
  return [callsign, type, route].filter(Boolean).join(' · ');
}

const prefersShareSheet = (): boolean =>
  typeof navigator.share === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;

const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError';

export async function shareView(): Promise<void> {
  const url = shareableUrl(currentLink());
  const text = app.selectedHex ? t('share.text', { flight: describeFlight(app.selected, app.dossier) }) : 'PlanesView';
  if (prefersShareSheet()) {
    try {
      await navigator.share({ title: 'PlanesView', text, url });
      return;
    } catch (err) {
      if (isAbort(err)) return;
      // Refused for another reason (no user gesture left, say): fall through to the clipboard.
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    app.notify(t('share.copied'), 'info', 3500);
  } catch {
    app.notify(t('share.failed', { url }), 'warn', 12_000);
  }
}

/** A file name that sorts by date and says what is in it. */
export function captureName(flight: string, ext: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const what = flight.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'view';
  return `planesview-${what}-${stamp}.${ext}`;
}

/** Hand a finished photo or clip to the visitor. Resolves true when it was saved or shared. */
export async function deliverFile(blob: Blob, name: string): Promise<boolean> {
  const file = new File([blob], name, { type: blob.type });
  if (prefersShareSheet() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'PlanesView' });
      return true;
    } catch (err) {
      if (isAbort(err)) return false;
    }
  }
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // After the browser has had the click: revoking at once can cancel it.
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
  return true;
}
