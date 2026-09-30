/**
 * Whether a flight carries freight rather than passengers.
 *
 * The feed says nothing of the kind, but the callsign does: an ICAO callsign
 * begins with its operator's three-letter designator, and the all-cargo
 * operators are a short, stable list. A passenger airline's cargo arm flies
 * under its own designator (Lufthansa Cargo is GEC, not DLH), so a match here
 * is a freighter, and a miss is — nearly always — a passenger aircraft.
 */

const CARGO_OPERATORS = new Set([
  // Integrators and their contractors.
  'FDX', 'UPS', 'DHK', 'DHX', 'BCS', 'DAE', 'BOX', 'ABX', 'ATN', 'GTI', 'SOO', 'PAC', 'TAY', 'ABR', 'NPT', 'SWN', 'SWT',
  // All-cargo airlines.
  'CLX', 'ICV', 'ABW', 'CKS', 'GEC', 'CAO', 'CKK', 'CSS', 'NCA', 'SQC', 'MPH', 'AJT', 'WGN', 'KYE', 'MNB', 'CLU', 'SWQ',
  'TGX', 'CTJ', 'LCO', 'QAC', 'CHC', 'AHK', 'HKC', 'YZR', 'TPA', 'EIA',
]);

/** True when the callsign is an all-cargo operator's. */
export function isFreighter(callsign: string | null | undefined): boolean {
  const code = (callsign ?? '').trim().toUpperCase().slice(0, 3);
  if (!/^[A-Z]{3}$/.test(code)) return false;
  return CARGO_OPERATORS.has(code);
}
