/**
 * Where to point the app before the user has said.
 *
 * Geolocation is asked for but never waited on: the old boot sequence blocked
 * on it for up to four seconds before the map appeared, which is four seconds
 * of blank screen to answer a question the fallback answers well enough. The
 * map now opens immediately over a reliably busy piece of airspace and
 * re-centres if and when the browser grants a position.
 */

/** Heathrow: there is always something in the air within 120 nm of it. */
export const FALLBACK_VIEW = { lat: 51.47, lon: -0.454 };

/** Geolocation if granted, otherwise a reliably busy piece of airspace. */
export async function initialView(): Promise<{ lat: number; lon: number }> {
  if (!navigator.geolocation) return FALLBACK_VIEW;

  return new Promise((resolve) => {
    const done = (value: { lat: number; lon: number }): void => resolve(value);
    const timer = setTimeout(() => done(FALLBACK_VIEW), 6000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        done({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        done(FALLBACK_VIEW);
      },
      { enableHighAccuracy: false, timeout: 4000, maximumAge: 600_000 },
    );
  });
}
