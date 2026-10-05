/**
 * ICAO type designators to the names people know them by.
 *
 * The feed carries the designator (`A20N`, `B38M`, `E295`) with every
 * position; the registry lookup that turns it into "Airbus A320neo" is a
 * network round trip that can fail, be slow, or not know the airframe. This
 * table answers at once, offline, for the types that make up almost all of
 * the traffic, so the panel never shows a bare code — or nothing — while a
 * lookup is out or after it has failed.
 */

const NAMES: Record<string, string> = {
  // Airbus
  A306: 'Airbus A300-600', A30B: 'Airbus A300', A310: 'Airbus A310',
  A318: 'Airbus A318', A319: 'Airbus A319', A320: 'Airbus A320', A321: 'Airbus A321',
  A19N: 'Airbus A319neo', A20N: 'Airbus A320neo', A21N: 'Airbus A321neo',
  A332: 'Airbus A330-200', A333: 'Airbus A330-300', A337: 'Airbus BelugaXL', A338: 'Airbus A330-800neo', A339: 'Airbus A330-900neo',
  A342: 'Airbus A340-200', A343: 'Airbus A340-300', A345: 'Airbus A340-500', A346: 'Airbus A340-600',
  A359: 'Airbus A350-900', A35K: 'Airbus A350-1000', A388: 'Airbus A380-800',
  A3ST: 'Airbus Beluga', A400: 'Airbus A400M Atlas',
  BCS1: 'Airbus A220-100', BCS3: 'Airbus A220-300',
  // Boeing
  B712: 'Boeing 717', B721: 'Boeing 727-100', B722: 'Boeing 727-200',
  B731: 'Boeing 737-100', B732: 'Boeing 737-200', B733: 'Boeing 737-300', B734: 'Boeing 737-400', B735: 'Boeing 737-500',
  B736: 'Boeing 737-600', B737: 'Boeing 737-700', B738: 'Boeing 737-800', B739: 'Boeing 737-900',
  B37M: 'Boeing 737 MAX 7', B38M: 'Boeing 737 MAX 8', B39M: 'Boeing 737 MAX 9', B3XM: 'Boeing 737 MAX 10',
  B741: 'Boeing 747-100', B742: 'Boeing 747-200', B743: 'Boeing 747-300', B744: 'Boeing 747-400', B748: 'Boeing 747-8', B74S: 'Boeing 747SP',
  B752: 'Boeing 757-200', B753: 'Boeing 757-300',
  B762: 'Boeing 767-200', B763: 'Boeing 767-300', B764: 'Boeing 767-400',
  B772: 'Boeing 777-200', B77L: 'Boeing 777-200LR', B773: 'Boeing 777-300', B77W: 'Boeing 777-300ER', B778: 'Boeing 777-8', B779: 'Boeing 777-9',
  B788: 'Boeing 787-8', B789: 'Boeing 787-9', B78X: 'Boeing 787-10',
  // McDonnell Douglas
  DC10: 'McDonnell Douglas DC-10', MD11: 'McDonnell Douglas MD-11',
  MD81: 'McDonnell Douglas MD-81', MD82: 'McDonnell Douglas MD-82', MD83: 'McDonnell Douglas MD-83', MD87: 'McDonnell Douglas MD-87', MD88: 'McDonnell Douglas MD-88', MD90: 'McDonnell Douglas MD-90',
  // Embraer
  E135: 'Embraer ERJ-135', E145: 'Embraer ERJ-145', E35L: 'Embraer Legacy 600',
  E170: 'Embraer E170', E75L: 'Embraer E175', E75S: 'Embraer E175', E190: 'Embraer E190', E195: 'Embraer E195',
  E290: 'Embraer E190-E2', E295: 'Embraer E195-E2',
  E50P: 'Embraer Phenom 100', E55P: 'Embraer Phenom 300', E545: 'Embraer Praetor 500', E550: 'Embraer Praetor 600',
  // Bombardier / Canadair / de Havilland Canada
  CRJ1: 'Bombardier CRJ100', CRJ2: 'Bombardier CRJ200', CRJ7: 'Bombardier CRJ700', CRJ9: 'Bombardier CRJ900', CRJX: 'Bombardier CRJ1000',
  CL30: 'Bombardier Challenger 300', CL35: 'Bombardier Challenger 350', CL60: 'Bombardier Challenger 600',
  GLEX: 'Bombardier Global Express', GL5T: 'Bombardier Global 5000', GL7T: 'Bombardier Global 7500',
  DH8A: 'Dash 8-100', DH8B: 'Dash 8-200', DH8C: 'Dash 8-300', DH8D: 'Dash 8-400',
  DHC6: 'DHC-6 Twin Otter', DHC7: 'DHC-7 Dash 7', DHC2: 'DHC-2 Beaver',
  // ATR, Fokker, BAe, Saab, others
  AT43: 'ATR 42-300', AT45: 'ATR 42-500', AT46: 'ATR 42-600', AT72: 'ATR 72', AT75: 'ATR 72-500', AT76: 'ATR 72-600',
  F50: 'Fokker 50', F70: 'Fokker 70', F100: 'Fokker 100', F27: 'Fokker F27 Friendship', F28: 'Fokker F28 Fellowship',
  B461: 'BAe 146-100', B462: 'BAe 146-200', B463: 'BAe 146-300', RJ85: 'Avro RJ85', RJ1H: 'Avro RJ100',
  SF34: 'Saab 340', SB20: 'Saab 2000', JS41: 'BAe Jetstream 41', JS32: 'BAe Jetstream 32',
  D228: 'Dornier 228', D328: 'Dornier 328', J328: 'Dornier 328JET',
  L410: 'Let L-410 Turbolet', MRJ9: 'Mitsubishi SpaceJet', SU95: 'Sukhoi Superjet 100',
  C919: 'COMAC C919', AJ27: 'COMAC ARJ21',
  A148: 'Antonov An-148', A124: 'Antonov An-124 Ruslan', A225: 'Antonov An-225 Mriya', AN26: 'Antonov An-26', AN12: 'Antonov An-12',
  IL76: 'Ilyushin Il-76', IL96: 'Ilyushin Il-96', T154: 'Tupolev Tu-154', T204: 'Tupolev Tu-204',
  // Business jets
  C25A: 'Cessna Citation CJ2', C25B: 'Cessna Citation CJ3', C25C: 'Cessna Citation CJ4', C510: 'Cessna Citation Mustang',
  C525: 'Cessna CitationJet', C550: 'Cessna Citation II', C560: 'Cessna Citation V', C56X: 'Cessna Citation Excel',
  C650: 'Cessna Citation III', C680: 'Cessna Citation Sovereign', C68A: 'Cessna Citation Latitude', C700: 'Cessna Citation Longitude', C750: 'Cessna Citation X',
  F2TH: 'Dassault Falcon 2000', F900: 'Dassault Falcon 900', FA7X: 'Dassault Falcon 7X', FA8X: 'Dassault Falcon 8X', FA50: 'Dassault Falcon 50', FA6X: 'Dassault Falcon 6X',
  GLF4: 'Gulfstream IV', GLF5: 'Gulfstream V', GLF6: 'Gulfstream G650', G280: 'Gulfstream G280', GA5C: 'Gulfstream G500', GA6C: 'Gulfstream G600', GA7C: 'Gulfstream G700',
  LJ35: 'Learjet 35', LJ45: 'Learjet 45', LJ60: 'Learjet 60', LJ75: 'Learjet 75',
  H25B: 'Hawker 800', HDJT: 'HondaJet', PC24: 'Pilatus PC-24', SF50: 'Cirrus Vision Jet',
  // Turboprops and light aircraft
  B190: 'Beechcraft 1900', BE20: 'Beechcraft King Air 200', B350: 'Beechcraft King Air 350', BE9L: 'Beechcraft King Air 90',
  BE36: 'Beechcraft Bonanza', BE58: 'Beechcraft Baron', PC12: 'Pilatus PC-12', PC6T: 'Pilatus PC-6 Porter', TBM7: 'Daher TBM 700', TBM8: 'Daher TBM 850', TBM9: 'Daher TBM 900',
  C150: 'Cessna 150', C152: 'Cessna 152', C172: 'Cessna 172 Skyhawk', C182: 'Cessna 182 Skylane', C206: 'Cessna 206 Stationair', C208: 'Cessna 208 Caravan', C210: 'Cessna 210 Centurion', C310: 'Cessna 310', C414: 'Cessna 414', C421: 'Cessna 421',
  P28A: 'Piper Cherokee', P28R: 'Piper Arrow', P32R: 'Piper Saratoga', PA34: 'Piper Seneca', PA44: 'Piper Seminole', PA46: 'Piper Malibu', P46T: 'Piper Malibu Meridian', PA31: 'Piper Navajo',
  SR20: 'Cirrus SR20', SR22: 'Cirrus SR22', S22T: 'Cirrus SR22T', DA40: 'Diamond DA40', DA42: 'Diamond DA42', DA62: 'Diamond DA62', DV20: 'Diamond DV20',
  M20P: 'Mooney M20', AA5: 'Grumman Tiger', RV7: "Van's RV-7", RV8: "Van's RV-8", C77R: 'Cessna Cardinal',
  // Helicopters
  EC35: 'Airbus H135', EC45: 'Airbus H145', EC30: 'Airbus H130', EC55: 'Airbus H155', EC75: 'Airbus H175', AS50: 'Airbus H125 (AS350)', AS55: 'Airbus AS355', AS32: 'Airbus Super Puma', AS65: 'Airbus Dauphin',
  H160: 'Airbus H160', BK17: 'MBB/Kawasaki BK 117', B105: 'MBB Bo 105',
  A109: 'Leonardo AW109', A139: 'Leonardo AW139', A169: 'Leonardo AW169', A189: 'Leonardo AW189',
  S76: 'Sikorsky S-76', S92: 'Sikorsky S-92', H60: 'Sikorsky Black Hawk', B06: 'Bell 206 JetRanger', B407: 'Bell 407', B412: 'Bell 412', B429: 'Bell 429', R22: 'Robinson R22', R44: 'Robinson R44', R66: 'Robinson R66',
  // Military transports and tankers
  C130: 'Lockheed C-130 Hercules', C30J: 'Lockheed C-130J Super Hercules', C17: 'Boeing C-17 Globemaster III', C5M: 'Lockheed C-5M Galaxy',
  K35R: 'Boeing KC-135 Stratotanker', KC2: 'Kawasaki C-2', A310M: 'Airbus A310 MRTT', A332M: 'Airbus A330 MRTT', E3TF: 'Boeing E-3 Sentry', P8: 'Boeing P-8 Poseidon',
  F16: 'General Dynamics F-16', F18: 'Boeing F/A-18 Hornet', F15: 'McDonnell Douglas F-15', F35: 'Lockheed Martin F-35', EUFI: 'Eurofighter Typhoon', RFAL: 'Dassault Rafale', M2KP: 'Dassault Mirage 2000',
};

/** A readable name for an ICAO type designator, or null if the table does not know it. */
export function typeName(code: string | null | undefined): string | null {
  if (!code) return null;
  return NAMES[code.trim().toUpperCase()] ?? null;
}

export interface TypeChoice {
  /** ICAO type designator, the way the feed spells it. */
  code: string;
  name: string;
}

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * The models that match what has been typed, best first: by designator
 * ("A388"), or by any part of the name people say ("a380", "737", "king air").
 * Whole designator, then start of designator, then start of the name, then
 * start of a later word; between equals the table's own order, which lists the
 * airliners first.
 */
export function searchTypes(query: string, limit = 8): TypeChoice[] {
  const q = fold(query).trim();
  if (q.length < 1) return [];
  const scored: { choice: TypeChoice; score: number; at: number }[] = [];
  let at = 0;
  for (const [code, name] of Object.entries(NAMES)) {
    at++;
    const c = code.toLowerCase();
    const n = fold(name);
    let score = 0;
    if (c === q) score = 100;
    else if (c.startsWith(q)) score = 80;
    else if (n.startsWith(q)) score = 70;
    else if (new RegExp(`(^|[\\s\\-/(])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(n)) score = 55;
    else if (q.length >= 3 && n.includes(q)) score = 30;
    if (score > 0) scored.push({ choice: { code, name }, score, at });
  }
  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  return scored.slice(0, limit).map((s) => s.choice);
}
