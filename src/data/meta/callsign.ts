/**
 * Why a flight has no route.
 *
 * Route databases are built from airline timetables: a scheduled flight
 * number (`EZY39MG`, `UAL848`) maps to the airports it flies between. A flight
 * under its registration (`FHSAB`, `N649SR`) is a private or club aircraft
 * with no timetable at all, and military, charter and business callsigns
 * (`BOXER44`, `NJE640L`) are filed with air traffic control but published by
 * nobody free to use. The flight-tracking sites that show those routes buy
 * the flight plans; the honest thing here is to say which case this is.
 */

export type RoutelessReason = 'registration' | 'unpublished';

/** A callsign that is the aircraft's registration, dash dropped. */
export function isRegistrationCallsign(callsign: string, registration: string | null = null): boolean {
  const cs = callsign.trim().toUpperCase();
  if (registration && cs === registration.replace(/-/g, '').toUpperCase()) return true;
  // US: N, then 1–5 characters starting with a digit.
  if (/^N[1-9][0-9A-Z]{0,4}$/.test(cs)) return true;
  // Elsewhere: a one- or two-letter prefix and letters only (F-HSAB, G-ABCD,
  // D-EABC, SE-MMK). Airline callsigns end in a number, so do not match.
  return /^[A-Z]{4,6}$/.test(cs);
}

export function routelessReason(callsign: string, registration: string | null = null): RoutelessReason {
  return isRegistrationCallsign(callsign, registration) ? 'registration' : 'unpublished';
}
