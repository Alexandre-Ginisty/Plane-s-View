/**
 * Real cockpits: modelled, textured flight decks from FlightGear, converted
 * by `tools/fgmodel/cockpit.mjs` together with the airframe about them — the
 * walls, floor, roof and window frames — so the only way to see out is
 * through the windows.
 *
 * The file is already in the cockpit pass's frame — eye at the origin, +X
 * right, +Y up, −Z forward, metres — so it is dropped in as it is. The
 * procedural cockpit is then reduced to the live displays (`CockpitFit`),
 * laid over the model's own HUD glass and screen faces.
 *
 * ## Which one
 *
 * A type's own model's cockpit where it has one; otherwise the cockpit of its
 * kind's stand-in, with that aircraft's airframe about it (see `aircraft`).
 * A real flight deck of a near relative is a far better seat than a drawn one
 * floating over the ground.
 *
 * ## The window seat
 *
 * The other interior view: a passenger's, at a window. Airliners, regional
 * jets, turboprops and business jets have their cabin converted the same way
 * (`<id>-cabin.pvm`); a freighter gets its hold instead. An aircraft with no
 * cabin behind the flight deck — a light aircraft, a helicopter, a fighter —
 * puts the eye in the other front seat (or, single-seat, the pilot's) turned
 * to the side window.
 */

import { Group, Mesh } from 'three';

import { loadModelById, modelIdFor } from '@/render/aircraft/library';
import type { CockpitFit, CockpitKind } from './build';

/** Where the eye is inside: the flight deck, or a passenger's seat. */
export type Seat = 'cockpit' | 'cabin';

interface Entry {
  /** The converted file, `public/models/<file>.pvm`. */
  file: string;
  /** The exterior model it was built in, drawn about it. */
  aircraft: string;
  /** What its live displays are. */
  kind: CockpitKind;
  fit: CockpitFit;
  /** Metres from the file's eye to the seat's, cockpit axes (+X right, +Y up, +Z aft). */
  offset?: readonly [number, number, number];
  /** Where the view rests, radians, over the file's own: yaw left of the nose, pitch up. */
  look?: { yaw: number; pitch: number };
}

/*
 * Display faces measured from each converted model. The HUD rectangle is
 * square to the boresight at the combiner's nearest point, spanning the angle
 * the glass covers seen from the eye.
 */
const F16: Entry = {
  file: 'f16-cockpit',
  aircraft: 'f16',
  kind: 'fighter',
  fit: {
    hud: { z: -0.42, y: -0.064, w: 0.132, h: 0.134 },
    screens: [
      { id: 'radar', w: 0.106, h: 0.106, x: -0.156, y: -0.377, z: -0.649, tilt: -0.24 },
      { id: 'systems', w: 0.106, h: 0.106, x: 0.158, y: -0.377, z: -0.649, tilt: -0.24 },
    ],
  },
};

/** A flight deck with its displays in its own texture: nothing is laid over it. */
const deck = (aircraft: string, kind: CockpitKind): Entry => ({ file: `${aircraft}-cockpit`, aircraft, kind, fit: { hud: null, screens: [] } });

const C750 = deck('c750', 'airliner');
const B738 = deck('b738', 'airliner');
const A320 = deck('a320', 'airliner');
const AT72 = deck('at72', 'airliner');
const CRJ7 = deck('crj7', 'airliner');
const E145 = deck('e145', 'airliner');
const DA40 = deck('da40', 'light');
const EC35 = deck('ec35', 'heli');
const B748 = deck('b748', 'airliner');
const B77W = deck('b77w', 'airliner');
const MD80 = deck('md80', 'airliner');

/*
 * By the exterior model a type is drawn with: its own deck, or the nearest
 * one converted — an Airbus deck in an Airbus, a Boeing's in the other
 * airliners and regional jets, a twin turboprop's in the twin turboprops, a
 * light aircraft's in the singles, a helicopter's in the helicopters.
 */
const FIGHTERS = ['a10', 'f15', 'f18', 'm2k', 'jas39'].map((id) => deck(id, 'fighter'));
const WARBIRDS = ['f4u', 'p51'].map((id) => deck(id, 'warbird'));
const AH64 = deck('ah64', 'heli');

const BY_MODEL: Record<string, Entry> = {
  f16: F16,
  ...Object.fromEntries([...FIGHTERS, ...WARBIRDS].map((e) => [e.aircraft, e])),
  c750: C750,
  b738: B738, b733: B738, b732: B738, md80: MD80, md11: B77W, dc10: B77W, crj7: CRJ7, e145: E145, mrj9: E145,
  f100: B738, f70: B738, b752: B738, b763: B77W, b77w: B77W, b788: B77W, b748: B748, b742: B748, b463: B738, il76: B738,
  a320: A320, a346: A320, a388: A320, a306: A320,
  at72: AT72, dh8d: AT72, f27: AT72, f50: AT72, b190: AT72, be20: AT72, d228: AT72, l410: AT72,
  da40: DA40, c172: DA40, c208: DA40, pc12: DA40,
  ec35: EC35, ah64: AH64, bo05: EC35, s76c: EC35, as32: EC35,
};

/*
 * Cabins. A stand-in's cabin, like its flight deck, comes with its own
 * airframe about it. The regional 2-2 cabin is drawn in the regional jet's
 * and in the ATR's, so those and their relatives see their own kind of wing
 * and engine out of the window.
 * Freighters, whatever the type, get the MD-11F's main deck: rollers, rails
 * and the cargo net, empty between loads.
 */
const cabin = (file: string, aircraft: string): Entry => ({ file, aircraft, kind: 'airliner', fit: { hud: null, screens: [] } });
const RJ_CABIN = cabin('r22-cabin', 'crj7');
const RJ_IN_ATR = cabin('r22-cabin', 'at72');
/*
 * Generated cabins (`tools/cabin`), by what the passenger sits in: the
 * regional 2-2, the single-aisle 3-3, the twin-aisle 2-4-2 and the 3-4-3 of
 * the big twins and the jumbo. Each is drawn in an airframe of its own family, its eye over the
 * wing there.
 */
const SINGLE_AISLE_A320 = cabin('n33-cabin', 'a320');
const SINGLE_AISLE_737 = cabin('n33-cabin', 'b738');
const TWIN_AISLE_MD11 = cabin('w242-cabin', 'md11');
const BIG_TWIN_777 = cabin('w343-cabin', 'b77w');
const JUMBO_747 = cabin('w343-cabin', 'b748');
const BIZJET_CABIN = cabin('c750-cabin', 'c750');
const JET_HOLD = cabin('md11-cargo', 'md11');

/** A front seat's side window, for aircraft with no cabin behind the deck. */
const sideSeat = (entry: Entry, offset: readonly [number, number, number], yaw: number, pitch: number): Entry => ({ ...entry, offset, look: { yaw, pitch } });
const RIGHT_SEAT = sideSeat(DA40, [0.51, 0, 0], -1.25, -0.2);
// The EC135 is flown from the right: the passenger is on the left.
const LEFT_SEAT_HELI = sideSeat(EC35, [-0.84, 0, 0], 1.3, -0.3);

const TURBOPROPS = ['at72', 'dh8d', 'f27', 'f50', 'b190', 'be20', 'd228', 'l410'];

const CABIN_BY_MODEL: Record<string, Entry> = {
  crj7: RJ_CABIN, e145: RJ_CABIN, mrj9: RJ_CABIN, f70: RJ_CABIN, f100: RJ_CABIN, b463: RJ_CABIN,
  a320: SINGLE_AISLE_A320,
  b738: SINGLE_AISLE_737, b733: SINGLE_AISLE_737, b732: SINGLE_AISLE_737, md80: SINGLE_AISLE_737, b752: SINGLE_AISLE_737,
  md11: TWIN_AISLE_MD11, dc10: TWIN_AISLE_MD11, a346: TWIN_AISLE_MD11, a306: TWIN_AISLE_MD11, b763: TWIN_AISLE_MD11, b788: TWIN_AISLE_MD11, il76: TWIN_AISLE_MD11,
  b77w: BIG_TWIN_777,
  b748: JUMBO_747, b742: JUMBO_747, a388: JUMBO_747,
  ...Object.fromEntries(TURBOPROPS.map((id) => [id, RJ_IN_ATR])),
  c750: BIZJET_CABIN,
  da40: RIGHT_SEAT, c172: RIGHT_SEAT, c208: RIGHT_SEAT, pc12: RIGHT_SEAT,
  ec35: LEFT_SEAT_HELI, bo05: LEFT_SEAT_HELI, s76c: LEFT_SEAT_HELI, as32: LEFT_SEAT_HELI,
};

/** By kind, for a type with no model at all. */
const BY_KIND: Record<CockpitKind, Entry> = {
  fighter: F16,
  warbird: F16,
  airliner: B738,
  light: DA40,
  heli: EC35,
};

export interface Modelled {
  group: Group;
  seat: Seat;
  fit: CockpitFit;
  kind: CockpitKind;
  /** The exterior model to draw about it. */
  aircraft: string;
  /** The eye in that model: normalised, nose +Y, up +Z, about its centre. */
  shellEye: readonly [number, number, number] | null;
  /** Metres from the file's eye to the seat's, cockpit axes. */
  offset: readonly [number, number, number];
  /** Where the view rests, radians. */
  look: { yaw: number; pitch: number } | null;
}

/** The entry for the eye asked for. */
function entryFor(id: string | null, kind: CockpitKind, seat: Seat, freighter: boolean): Entry {
  const deck = (id ? BY_MODEL[id] : undefined) ?? BY_KIND[kind];
  if (seat === 'cockpit') return deck;
  const own = id ? CABIN_BY_MODEL[id] : undefined;
  if (freighter && (own ? own.kind === 'airliner' : kind === 'airliner')) return JET_HOLD;
  if (own) return own;
  switch (kind) {
    case 'airliner':
      return SINGLE_AISLE_737;
    case 'light':
      return RIGHT_SEAT;
    case 'heli':
      return deck === EC35 ? LEFT_SEAT_HELI : sideSeat(deck, [0, 0, 0], 1.3, -0.3);
    default:
      // Single-seat: the pilot's head, turned over the shoulder to look down the wing.
      return sideSeat(deck, [0, 0, 0], 2.05, -0.42);
  }
}

/** The cockpit for a type, or null when it will not load. */
export async function loadModelledCockpit(typeCode: string | null, kind: CockpitKind, seat: Seat = 'cockpit', freighter = false): Promise<Modelled | null> {
  const id = await modelIdFor(typeCode);
  const entry = entryFor(id, kind, seat, freighter);
  const model = await loadModelById(entry.file);
  if (!model) return null;

  const group = new Group();
  group.name = 'modelled-cockpit';
  for (const part of model.parts) {
    const mesh = new Mesh(part.geometry, part.material);
    mesh.name = part.name;
    mesh.matrixAutoUpdate = false;
    if (part.material.transparent) {
      // Windows: seen through, drawn after everything behind them, and never
      // a shadow across the panel.
      part.material.depthWrite = false;
      mesh.renderOrder = 5;
    } else {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    group.add(mesh);
  }
  // Display faces measured by the converter, where the entry does not place its own.
  const fit: CockpitFit = entry.fit.screens.length || entry.fit.hud ? entry.fit : { hud: null, screens: model.displays.map((d) => ({ ...d })) };
  return {
    group,
    seat,
    fit,
    kind: entry.kind,
    aircraft: entry.aircraft,
    shellEye: entry.aircraft in model.shellEyes ? (model.shellEyes[entry.aircraft] ?? null) : model.shellEye,
    offset: entry.offset ?? [0, 0, 0],
    look: entry.look ?? model.look,
  };
}
