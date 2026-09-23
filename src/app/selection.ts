/**
 * Filling in everything known about the selected aircraft.
 *
 * The ADS-B feed gives a position and a callsign; the registration, the type,
 * the operator, the route and the weather at that point all come from three
 * more services that answer at their own pace. Separated from the orchestrator
 * because it is the one place in the app with a genuine *race*, and races
 * deserve to be read on their own.
 *
 * ## The token
 *
 * A user clicking through a busy map produces overlapping lookups, and they do
 * not return in the order they were made. Every write here is guarded by the
 * token the request was issued under, compared against the one that is current
 * *now* — so a slow answer for an aircraft the user has already moved past is
 * dropped rather than painted over the one they are looking at.
 */

import { registry } from '@/data/meta/registry';
import { fetchCurrentWeather } from '@/data/weather/openmeteo';
import type { SelectionMap } from '@/map2d/map';
import { app } from '@/state/appStore.svelte';
import type { SampledAircraft } from '@/state/traffic';

/** Reset everything the panel and the map show for a selection. */
export function clearSelection(map: SelectionMap | null): void {
  app.dossier = null;
  app.selected = null;
  // Cleared with the rest of the selection, not left to be overwritten when
  // the next Open-Meteo call returns. That call takes seconds, and until it
  // did the panel showed the previous aircraft's wind and temperature under
  // the new aircraft's name — a plausible-looking number for the wrong place.
  app.weather = null;
  map?.updateTrail([]);
  map?.updateRoute(null, null);
}

/**
 * @param token The token this call was issued under.
 * @param current Reads the token that is current now — a function, not a
 * value, because the whole point is that it may have changed while awaiting.
 */
export async function loadSelection(
  hex: string,
  sample: SampledAircraft | null,
  token: number,
  current: () => number,
  map: SelectionMap | null,
): Promise<void> {
  app.dossierLoading = true;

  try {
    const dossier = await registry.dossier(hex, sample?.latest.callsign ?? null);
    if (token !== current()) return; // superseded by a newer selection
    app.dossier = dossier;

    const at = sample ? { lat: sample.lat, lon: sample.lon } : null;
    map?.updateRoute(dossier.route, at);
  } finally {
    if (token === current()) app.dossierLoading = false;
  }

  if (!sample) return;
  // Not awaited: the weather is a nice-to-have and the panel must not wait on
  // a fourth service before it can show the three that already answered.
  void fetchCurrentWeather(sample.lat, sample.lon).then((weather) => {
    if (token === current()) app.weather = weather;
  });
}
