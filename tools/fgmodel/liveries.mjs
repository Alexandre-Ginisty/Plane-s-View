/**
 * Operator liveries, discovered rather than listed.
 *
 * Build-time only. The first version of the livery pipeline took a hand-kept
 * list of the busiest 777 operators and nothing else, so a 767, a 757 or an
 * A340 always flew in whichever single airline's paint its author had
 * modelled — and even the 777 used 26 of the 49 schemes upstream offers.
 *
 * FlightGear describes each livery in a small XML file under
 * `Models/Liveries/`, naming the texture it swaps in. Those files are listed,
 * each is read, and its file name is turned into the ICAO airline designator
 * the client looks up from the callsign. Every scheme that maps to a real
 * operator is kept; the rest (military serials, fictional airlines, test
 * registrations) are reported and skipped.
 */

/**
 * Airline names as FlightGear authors spell them, to ICAO designators.
 *
 * Needed only where a livery is filed under a name rather than a code — the
 * BAe 146, the Tu-134 and a few others. Keys are normalised: lower case,
 * letters and digits only, and a trailing `new`/`old` removed.
 */
const NAME_TO_ICAO = {
  aeroflot: 'AFL',
  aerlingus: 'EIN',
  airchina: 'CCA',
  airfrance: 'AFR',
  airkoryo: 'KOR',
  airzimbabwe: 'AZW',
  americanairlines: 'AAL',
  britishairways: 'BAW',
  csa: 'CSA',
  czechairlines: 'CSA',
  deltaairlines: 'DAL',
  easyjet: 'EZY',
  emirates: 'UAE',
  flybe: 'BEE',
  iberia: 'IBE',
  interflug: 'IFL',
  klm: 'KLM',
  lot: 'LOT',
  lufthansa: 'DLH',
  malev: 'MAH',
  nordavia: 'NRD',
  pulkovo: 'PLK',
  qantas: 'QFA',
  rossiya: 'SDM',
  ryanair: 'RYR',
  sas: 'SAS',
  swiss: 'SWR',
  swissair: 'SWR',
  turkishairlines: 'THY',
  unitedairlines: 'UAL',
  utair: 'UTA',
  wizzair: 'WZZ',
};

/** IATA two-letter codes that turn up as livery names, to ICAO. */
const IATA_TO_ICAO = {
  AF: 'AFR',
  BA: 'BAW',
  KL: 'KLM',
  LH: 'DLH',
  UA: 'UAL',
  DL: 'DAL',
  AA: 'AAL',
};

/**
 * Three-letter file names that are not airlines in this sense: the
 * manufacturer's own house colours, which belong to the aircraft's default
 * look rather than to any operator a callsign would name.
 */
const NOT_OPERATORS = new Set(['AIR', 'MIA', 'RAF']);

/** Plain schemes suitable as the honest "operator unknown" fallback. */
const NEUTRAL = /^(white|blank|plain|733_?white|bare)$/i;

/**
 * The manufacturer's own colours: the next best fallback after plain white,
 * because they name no operator a callsign could belong to.
 */
export function isHouseScheme(stem) {
  return /^(boe\d?|boeing.*|airbus\d*|prototype|bae|fokker|house|demo)$/i.test(stem);
}

/**
 * The ICAO designator a livery file name stands for, and how current that
 * variant is (lower is preferred), or null.
 *
 *   `AFR`, `AFR-New-livery`, `733AFR`, `DAL2`, `BAW-old`, `Lufthansa`,
 *   `aeroflot_new`, `733LH`
 */
function operatorOf(stem) {
  if (NEUTRAL.test(stem)) return { code: 'NEUTRAL', rank: 0 };

  // `733AFR` — the type prefix the 737-300's author put on every file.
  const bare = stem.replace(/^\d{3}(?=[A-Za-z])/, '');
  const rest = (code) => bare.slice(code.length);
  const rankOf = (tail) => {
    if (tail === '') return 1;
    if (/new|current/i.test(tail)) return 0;
    if (/old|retro|classic/i.test(tail)) return 3;
    return 2;
  };

  const icao = /^([A-Z]{3})(?=$|[^A-Za-z]|New|new|Old|old|one)/.exec(bare)?.[1];
  if (icao && !NOT_OPERATORS.has(icao)) return { code: icao, rank: rankOf(rest(icao)) };

  const iata = /^([A-Z]{2})$/.exec(bare)?.[1];
  if (iata && IATA_TO_ICAO[iata]) return { code: IATA_TO_ICAO[iata], rank: 1 };

  const key = bare.toLowerCase().replace(/[^a-z0-9]/g, '');
  const trimmed = key.replace(/(new|old|livery)+$/, '');
  const named = NAME_TO_ICAO[trimmed];
  if (named) return { code: named, rank: rankOf(key.slice(trimmed.length)) };

  return null;
}

/** Links in an SVN directory listing: files, and folders with a trailing `/`. */
export function listingEntries(html) {
  return [...html.matchAll(/<li><a href="([^"?]+)">/g)]
    .map((m) => decodeURIComponent(m[1]))
    .filter((name) => name !== '../');
}

/**
 * The exterior texture a livery XML swaps in: the first `<texture>`, or the
 * A320 family's `<texture-fuselage>`.
 */
export function liveryTexture(xml) {
  return /<(texture(?:-fuselage)?)(?:\s[^>]*)?>\s*([^<\s][^<]*?)\s*<\/\1>/.exec(xml)?.[2] ?? null;
}

/**
 * Keep the best file per operator.
 *
 * `candidates` is `[{ stem, texture }]`; the result maps each operator code to
 * the texture path of its most current scheme.
 */
export function pickPerOperator(candidates) {
  const best = new Map();
  const skipped = [];
  for (const candidate of candidates) {
    const op = operatorOf(candidate.stem);
    if (!op) {
      skipped.push(candidate.stem);
      continue;
    }
    const current = best.get(op.code);
    if (!current || op.rank < current.rank) best.set(op.code, { ...candidate, rank: op.rank });
  }
  return {
    chosen: Object.fromEntries([...best].map(([code, c]) => [code, c.texture])),
    skipped,
  };
}
