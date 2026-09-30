/**
 * What the sandbox lets you fly.
 *
 * The combat hangar — real airframes converted from FlightGear
 * (`tools/fgmodel/combat.mjs`), armed — then every model in the civil hangar:
 * "any aircraft we have", which is the point: flying an A380 at treetop height
 * with missiles under the wings is exactly the kind of thing a sandbox is for.
 * Each entry says how it flies when it has no flight model (an arcade spec)
 * and what it shoots.
 */

export type SandboxGroup = 'combat' | 'airliner' | 'regional' | 'light' | 'helicopter';
export type Weapon = 'missile' | 'rockets';

/** How an airframe handles. Knots, degrees, feet per minute. */
export interface FlightSpec {
  cruiseKt: number;
  minKt: number;
  boostKt: number;
  /** Turn rate at full bank, degrees per second. */
  turnDegS: number;
  maxBankDeg: number;
  maxPitchDeg: number;
  /** Hovers, yaws on the spot and climbs straight up. */
  heli: boolean;
  /** How quickly speed follows the throttle, knots per second. */
  accelKt: number;
}

export interface SandboxAircraft {
  id: string;
  /** Type designator the model library knows it by. */
  type: string;
  name: string;
  group: SandboxGroup;
  weapon: Weapon;
  flight: FlightSpec;
  /** One line for the hangar card. */
  blurb?: string;
}

export const GROUP_LABELS: Record<SandboxGroup, string> = {
  combat: 'Combat',
  airliner: 'Airliners',
  regional: 'Regional',
  light: 'Light & business',
  helicopter: 'Helicopters',
};

const FIGHTER: FlightSpec = { cruiseKt: 420, minKt: 180, boostKt: 760, turnDegS: 24, maxBankDeg: 80, maxPitchDeg: 38, heli: false, accelKt: 90 };
const ATTACK: FlightSpec = { cruiseKt: 330, minKt: 150, boostKt: 470, turnDegS: 17, maxBankDeg: 70, maxPitchDeg: 28, heli: false, accelKt: 60 };
const WARBIRD: FlightSpec = { cruiseKt: 280, minKt: 110, boostKt: 390, turnDegS: 19, maxBankDeg: 75, maxPitchDeg: 30, heli: false, accelKt: 50 };
const AIRLINER: FlightSpec = { cruiseKt: 320, minKt: 150, boostKt: 500, turnDegS: 9, maxBankDeg: 45, maxPitchDeg: 18, heli: false, accelKt: 35 };
const REGIONAL: FlightSpec = { cruiseKt: 260, minKt: 120, boostKt: 380, turnDegS: 12, maxBankDeg: 50, maxPitchDeg: 20, heli: false, accelKt: 40 };
const LIGHT: FlightSpec = { cruiseKt: 150, minKt: 65, boostKt: 230, turnDegS: 18, maxBankDeg: 60, maxPitchDeg: 22, heli: false, accelKt: 30 };
const HELI: FlightSpec = { cruiseKt: 120, minKt: 0, boostKt: 175, turnDegS: 45, maxBankDeg: 25, maxPitchDeg: 14, heli: true, accelKt: 45 };

const COMBAT: SandboxAircraft[] = [
  { id: 'viper', type: 'F16', name: 'F-16 Fighting Falcon', group: 'combat', weapon: 'missile', flight: FIGHTER, blurb: 'Fly-by-wire fighter · afterburner · heat-seekers' },
  { id: 'hornet', type: 'F18', name: 'F/A-18 Hornet', group: 'combat', weapon: 'missile', flight: FIGHTER, blurb: 'Carrier fighter · twin afterburners' },
  { id: 'eagle', type: 'F15', name: 'F-15C Eagle', group: 'combat', weapon: 'missile', flight: FIGHTER, blurb: 'Air-superiority fighter · big and fast' },
  { id: 'tomcat', type: 'F14', name: 'F-14B Tomcat', group: 'combat', weapon: 'missile', flight: FIGHTER, blurb: 'Swing-wing interceptor' },
  { id: 'mirage', type: 'MIR2', name: 'Mirage 2000-5', group: 'combat', weapon: 'missile', flight: FIGHTER, blurb: 'Delta-wing fighter · afterburner' },
  { id: 'gripen', type: 'GRIF', name: 'JAS 39 Gripen', group: 'combat', weapon: 'missile', flight: FIGHTER, blurb: 'Light canard-delta fighter' },
  { id: 'fulcrum', type: 'MG29', name: 'MiG-29 Fulcrum', group: 'combat', weapon: 'missile', flight: FIGHTER, blurb: 'Twin-engine agile fighter' },
  { id: 'fishbed', type: 'MG21', name: 'MiG-21bis', group: 'combat', weapon: 'missile', flight: FIGHTER, blurb: 'Cold-War delta interceptor' },
  { id: 'warthog', type: 'A10', name: 'A-10 Thunderbolt II', group: 'combat', weapon: 'rockets', flight: ATTACK, blurb: 'Ground-attack jet · rocket salvos' },
  { id: 'frogfoot', type: 'SU25', name: 'Su-25 Frogfoot', group: 'combat', weapon: 'rockets', flight: ATTACK, blurb: 'Armoured attack jet · rockets' },
  { id: 'striker', type: 'H64', name: 'AH-64 Apache', group: 'combat', weapon: 'rockets', flight: HELI, blurb: 'Attack helicopter · hovers · rockets' },
  { id: 'corsair', type: 'F4U', name: 'F4U Corsair', group: 'combat', weapon: 'missile', flight: WARBIRD, blurb: 'Gull-wing propeller fighter' },
  { id: 'mustang', type: 'P51', name: 'P-51D Mustang', group: 'combat', weapon: 'missile', flight: WARBIRD, blurb: 'Propeller fighter · Merlin V-12' },
];

/** The converted hangar: model id → a type it answers to, its name, its group. */
const HANGAR: readonly [string, string, string, SandboxGroup][] = [
  ['a388', 'A388', 'Airbus A380', 'airliner'],
  ['b748', 'B748', 'Boeing 747-8', 'airliner'],
  ['b742', 'B742', 'Boeing 747-200', 'airliner'],
  ['b77w', 'B77W', 'Boeing 777-300ER', 'airliner'],
  ['b788', 'B788', 'Boeing 787', 'airliner'],
  ['a346', 'A346', 'Airbus A340-600', 'airliner'],
  ['a306', 'A306', 'Airbus A300-600', 'airliner'],
  ['b763', 'B763', 'Boeing 767-300', 'airliner'],
  ['md11', 'MD11', 'McDonnell Douglas MD-11', 'airliner'],
  ['dc10', 'DC10', 'McDonnell Douglas DC-10', 'airliner'],
  ['il76', 'IL76', 'Ilyushin Il-76', 'airliner'],
  ['b752', 'B752', 'Boeing 757-200', 'airliner'],
  ['a320', 'A320', 'Airbus A320', 'airliner'],
  ['b738', 'B738', 'Boeing 737-800', 'airliner'],
  ['b733', 'B733', 'Boeing 737-300', 'airliner'],
  ['b732', 'B732', 'Boeing 737-200', 'airliner'],
  ['b712', 'B712', 'Boeing 717', 'airliner'],
  ['md80', 'MD82', 'McDonnell Douglas MD-80', 'airliner'],
  ['b463', 'B463', 'BAe 146', 'regional'],
  ['f100', 'F100', 'Fokker 100', 'regional'],
  ['f70', 'F70', 'Fokker 70', 'regional'],
  ['mrj9', 'E190', 'Regional jet (E-Jet class)', 'regional'],
  ['crj7', 'CRJ7', 'Bombardier CRJ700', 'regional'],
  ['e145', 'E145', 'Embraer ERJ 145', 'regional'],
  ['dh8d', 'DH8D', 'Dash 8 Q400', 'regional'],
  ['at72', 'AT72', 'ATR 72', 'regional'],
  ['f50', 'F50', 'Fokker 50', 'regional'],
  ['f27', 'F27', 'Fokker F27', 'regional'],
  ['d228', 'D228', 'Dornier 228', 'regional'],
  ['l410', 'L410', 'Let L-410', 'regional'],
  ['b190', 'B190', 'Beech 1900D', 'regional'],
  ['c750', 'C750', 'Cessna Citation X', 'light'],
  ['be20', 'BE20', 'Beech King Air', 'light'],
  ['pc12', 'PC12', 'Pilatus PC-12', 'light'],
  ['c208', 'C208', 'Cessna Caravan', 'light'],
  ['da40', 'DA40', 'Diamond DA40', 'light'],
  ['c172', 'C172', 'Cessna 172', 'light'],
  ['as32', 'AS32', 'Super Puma', 'helicopter'],
  ['s76c', 'S76', 'Sikorsky S-76', 'helicopter'],
  ['ec35', 'EC35', 'Airbus H135', 'helicopter'],
  ['bo05', 'BO05', 'Bölkow Bo 105', 'helicopter'],
];

const SPEC: Record<SandboxGroup, FlightSpec> = {
  combat: FIGHTER,
  airliner: AIRLINER,
  regional: REGIONAL,
  light: LIGHT,
  helicopter: HELI,
};

export const SANDBOX_AIRCRAFT: readonly SandboxAircraft[] = [
  ...COMBAT,
  ...HANGAR.map(([id, type, name, group]): SandboxAircraft => ({
    id,
    type,
    name,
    group,
    weapon: group === 'helicopter' ? 'rockets' : 'missile',
    flight: SPEC[group],
  })),
];

export function sandboxAircraft(id: string): SandboxAircraft {
  return SANDBOX_AIRCRAFT.find((a) => a.id === id) ?? SANDBOX_AIRCRAFT[0]!;
}
