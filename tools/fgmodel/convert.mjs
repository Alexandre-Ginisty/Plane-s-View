/**
 * FlightGear aircraft -> PlanesView model (.pvm).
 *
 * Build-time only, run by hand when the model set changes. Nothing here ships.
 *
 *   node tools/fgmodel/convert.mjs [id ...]
 *
 * ## What it does, and why each step is needed
 *
 * **Axes.** FlightGear models are +X aft, +Y up, +Z port, in metres from an
 * arbitrary datum. This app is +Y nose, +X starboard, +Z up, normalised to
 * length 1 so one geometry can be scaled to the real airframe. The mapping is
 * x = -z, y = -x, z = y, which is a rotation rather than a reflection — its
 * determinant is +1. That matters: a reflection would look almost right and
 * silently mirror every piece of lettering on the livery.
 *
 * **Roles.** A FlightGear model is one file containing the exterior, the
 * cabin, the flight deck, the ground equipment and the pushback tug. Most of
 * that is invisible from outside and all of it costs download. The object
 * names are semantic — `fuselage`, `fuselage.int`, `propL`, `gearF`,
 * `WheelN` — so the parts are sorted by name into what the renderer already
 * distinguishes: hull, retractable gear, and spinners that turn.
 *
 * **Validation.** Each entry declares the real aircraft's length, and the
 * converter refuses a model whose bounding box disagrees by more than a few
 * percent. A model that parsed cleanly but came out at half scale, or with the
 * span read as the length, is the failure this catches — and it is invisible
 * in a viewer, because everything in the file is wrong together.
 */

import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { packPvm } from './pvmpack.mjs';
import { decodeSgi, isSgi } from './sgi.mjs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyTransform, flatten, parseAc3d } from './ac3d.mjs';
import { isHouseScheme, listingEntries, liveryTexture, pickPerOperator } from './liveries.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CACHE = join(HERE, '.cache');

/**
 * Texture ceiling, pixels on the long edge.
 *
 * Simulator liveries are authored at 4096 for a cockpit walk-around. This app
 * draws the aeroplane at a few hundred pixels — the widest it is ever seen is
 * the front page, and the model is normalised to unit length even there — so
 * everything above 2048 is detail that is downsampled on the GPU on every
 * frame after being downloaded once. The raw set came to 88 MB, which is not a
 * thing to put in a repository or in front of a phone tether.
 */
const MAX_TEXTURE_PX = 2048;
/** `PVM_OUT` converts elsewhere, to update a few airframes without clearing the shipped set. */
const OUT = process.env.PVM_OUT ?? join(ROOT, 'public', 'models');

export const FGADDON = 'https://svn.code.sf.net/p/flightgear/fgaddon/trunk/Aircraft';

/**
 * Objects that exist in the file but never appear in this app's shots.
 *
 * Two families, for two different reasons.
 *
 * The **interior** is the big one by size: a FlightGear airliner carries a
 * full cabin and flight deck, which is most of the vertex count and is only
 * ever seen from a seat this app does not put you in.
 *
 * The **cabin** is the other half of it, and the harder half to name. An
 * airliner's interior is modelled because the simulator flies from inside it,
 * and it is invisible from outside — until it is not. The 737-300 shipped with
 * its bulkheads, floor, sidewalls and carpet, and one of those panels poked
 * through the fuselage as a flat white plate beside the wing root. Nothing
 * catches that but naming the parts, because from any other angle they are
 * hidden and the model looks perfect.
 *
 * Some of it has to be judged by **texture** rather than by name. A landing
 * light's halo is a card painted with a dedicated sprite sheet, and the 737's
 * is called `Llightl` — no name rule reaches it, and it renders as a flat white
 * plate beside the wing root, which is what was reported.
 *
 * That is the opposite conclusion to the one the undercarriage rule reached,
 * and the difference is worth stating: a *livery* sheet is shared by unrelated
 * surfaces, so `txt_hstab_gear` says nothing about what a part is. A sheet of
 * halos is shared only by halos. The test is whether the texture names an
 * effect or a material.
 *
 * The **light beams** are the big one by consequence. Landing and taxi lights
 * are modelled as long translucent cones projecting from the airframe, and on
 * the 777 they reach sixty metres ahead of the nose — so the bounding box came
 * out at 128 m for a 73.9 m aeroplane, and scaling to that box would have
 * shrunk the actual aircraft to half size. The validation below caught it;
 * this is the fix.
 */
const DISCARD =
  /\.int$|interior|cabin|cockpit|flightdeck|panel|seat|yoke|pedestal|instrument|jack|tug|pushback|stair|chock|cone$|service|crew|human|pilot|shadow|\.hide|\.spot$|beam|halo|flare|bulkhead|sidewall|^wall|floor|carpet|ceiling|galley|lavatory|overhead|curtain|divider|partition|luggage|locker|handrail|armrest|tray|trolley/i;

/**
 * Undercarriage, hidden above circuit height.
 *
 * Deliberately *not* anchored, which the first version was. Model authors put
 * the side before the part far more often than after it, so `^gear` misses
 * `rightgear.hyd2` and `^wheel` misses `NoseWheel` — and on the 787 that is
 * every gear part there is. The result was an airliner whose wheels were
 * welded to the fuselage: down at cruise, and no longer retractable, in the
 * app as well as anywhere else the model is drawn.
 *
 * Judged on the object's name and *only* its name.
 *
 * A rule keyed on the texture was tried — "a part painted with the
 * undercarriage sheet is undercarriage" — and it is wrong for a reason worth
 * recording: authors pack unrelated surfaces onto one sheet to save a texture
 * unit. The MD-80's is called `txt_hstab_gear`, so that rule classified the
 * whole horizontal stabiliser as gear and the renderer duly retracted the
 * tailplane above circuit height. The aeroplane flew with no tail.
 *
 * It bought nothing, either: every gear part it found on the 787 —
 * `NoseWheel`, `rightgear.hyd2`, `lhgearibdoor` — the name catches now that
 * the anchor is gone. A texture sheet says what a part is painted with, not
 * what it is.
 */
/*
 * Undercarriage by name. Authors abbreviate — `MLGTorqueLinkL1`, `NLGFitting`,
 * `mglhlowerstrut`, `lhngdoor` — or write in French (`roueG`, `axeGB`); a leg
 * the pattern misses is classed as airframe and flown down at cruise, which
 * from behind turns an airliner into something standing on skids.
 *
 * Also `mgouterstrut`, `ngrimlh` and `collar` (the 737's main-gear legs, rims
 * and nose-gear collar), `central.scissor.down` (the MD-11's torque links),
 * `Lbrake1a` and `LBdamper` (the 777's wheel brakes and bogie damper),
 * `bouterstrut` (the A380's body gear), `UC-NoseStrutTop`, `right_main_strut`,
 * `LHstrut` — legs left hanging under the fuselage in the cruise until named
 * here.
 */
export const GEAR =
  /(gear(?!ed|box|ing)|wheel|bogie|tyre|tire|oleo|mlg|nlg|(^|[^a-z])[mn]lg|(drag|side|lower|upper|shock|outer|inner|main|arm|nose|aft)[ _.-]?strut|^[lr]h[ _.-]?strut|torque.?link|scissor|damper|axle|mgl[hr]|^mg[a-z]|^ng(?!ww)[a-z]|(^|[^t])rim(lh|rh)?$|^collar$|^uc[-_].*(strut|whell|nfd)|^[lr]brake\d|barng$|(^|[^i])ng.?door|^roue|^train|^axe[adg][bh]?$)/i;

/** Sprite sheets that only ever paint a special effect. See `DISCARD`. */
const EFFECT_TEXTURE = /(halo|flare|glow|corona|lightbeam|light_beam)/i;

/*
 * `gear` as a noun, not as an adjective.
 *
 * A *geared* elevator tab is a control surface, and the MD-80 has one called
 * `ElTabGearedL`. Matched as undercarriage, it was retracted with the wheels —
 * so the aeroplane lost part of its tail above circuit height. The same trap
 * waits in `gearbox` on any helicopter and `gearing` on anything.
 */

/** Turning parts, emitted as spinners the renderer drives. */
const PROP = /^prop(?!disc)/i;
const PROPDISC = /^propdisc/i;
const ROTOR = /^(mainrotor|rotor|blade)(?!.*tail)/i;
const TAILROTOR = /^(tailrotor|rotortail)/i;

/*
 * Rotor names are only rotor names on a rotorcraft.
 *
 * A turbofan's fan is made of blades, and the 737-300 calls them exactly that
 * — `Blades`, `Blades.001`. Read as a main rotor, they were handed to the
 * spinner animator to be turned about a vertical axis through the aircraft's
 * centre, which is not where a fan is or which way it turns. The aircraft
 * declares whether it is a helicopter; nothing else needs to be guessed.
 */

export const AIRCRAFT = [
  {
    id: 'dh8d',
    path: 'DHC-8',
    model: 'Models/DH8D.ac',
    types: ['DH8D', 'DH8C', 'DH8B', 'DH8A'],
    lengthM: 32.8,
    credit: 'DHC-8 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'b788',
    path: '787-8',
    model: 'Models/787-8.ac',
    types: ['B788', 'B789', 'B78X'],
    lengthM: 56.7,
    credit: '787-8 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'a388',
    path: 'A380',
    model: 'Models/a380.ac',
    types: ['A388'],
    lengthM: 72.7,
    credit: 'A380 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'b77w',
    path: '777',
    model: 'Models/777-300ER.ac',
    types: ['B77W', 'B77L', 'B773', 'B772', 'B77F'],
    lengthM: 73.9,
    credit: '777 — FlightGear FGAddon, GPL-2.0',
    /*
     * Operator liveries are discovered for every aircraft (`liveries.mjs`).
     * The 777 is the one that needs telling where: its schemes live in a
     * folder of their own and its paint sheet is not named after any of them.
     *
     * The plain white scheme becomes the fallback, and it matters more than
     * any single airline. Falling back to *another* operator's livery would
     * be worse than having none — a plain white aircraft is honest about not
     * knowing, and a Qatar 777 painted as Emirates is not.
     */
    liveries: {
      dirs: ['Models/Liveries-300ER'],
      /** The texture in the base model that a livery replaces. */
      replaces: 'paint1.png',
    },
  },
  {
    id: 'b763',
    path: '767-300',
    model: 'Models/767-300.ac',
    types: ['B763', 'B762', 'B764', 'B76F'],
    lengthM: 54.9,
    credit: '767-300 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'b752',
    path: '757-200',
    model: 'Models/757-200.ac',
    types: ['B752', 'B753'],
    lengthM: 47.3,
    credit: '757-200 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'crj7',
    path: 'CRJ700-family',
    model: 'Models/CRJ700.ac',
    types: ['CRJ7', 'CRJ9', 'CRJX', 'CRJ2', 'CRJ1'],
    lengthM: 32.3,
    credit: 'CRJ700 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'e145',
    path: 'Embraer-ERJ-145',
    model: 'Models/erj145.ac',
    types: ['E145', 'E135', 'E140', 'E45X'],
    lengthM: 29.9,
    credit: 'ERJ-145 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'at72',
    path: 'ATR-72-500',
    model: 'Models/ATR-72-500.ac',
    types: ['AT72', 'AT75', 'AT76', 'AT73', 'AT45', 'AT46', 'AT43'],
    lengthM: 27.2,
    credit: 'ATR 72-500 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'md80',
    path: 'MD-80',
    model: 'Models/mesh_airframe.ac',
    types: ['MD82', 'MD83', 'MD88', 'MD81', 'MD90'],
    lengthM: 45.1,
    credit: 'MD-80 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'b190',
    path: 'b1900d',
    model: 'Models/b1900d.ac',
    types: ['B190', 'BE19'],
    lengthM: 17.6,
    credit: 'Beechcraft 1900D — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'be20',
    path: 'Beechcraft-King-Air',
    model: 'Models/kingair.ac',
    types: ['BE20', 'BE9L', 'BE10', 'B350'],
    lengthM: 14.2,
    credit: 'King Air — FlightGear FGAddon, GPL-2.0',
    // Its schemes are air forces, coastguards and private owners; the two
    // that parse as designators are coincidences, not airlines.
    liveries: false,
  },
  {
    id: 'c208',
    path: 'Cessna-208-Caravan',
    model: 'Models/caravan.ac',
    types: ['C208', 'C20T'],
    lengthM: 12.6,
    credit: 'Cessna 208 Caravan — FlightGear FGAddon, GPL-2.0',
    // `FAB` is the Brazilian Air Force scheme, not an airline.
    liveries: false,
  },
  {
    id: 'pc12',
    path: 'Pilatus-PC-12',
    model: 'Models/pc12.ac',
    types: ['PC12'],
    lengthM: 14.4,
    credit: 'Pilatus PC-12 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'd228',
    path: 'do228',
    model: 'Models/do228.ac',
    types: ['D228'],
    lengthM: 16.6,
    credit: 'Dornier 228 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'l410',
    path: 'Let-L410',
    model: 'Models/l410.ac',
    types: ['L410'],
    lengthM: 14.4,
    credit: 'Let L-410 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'c750',
    path: 'CitationX',
    model: 'Models/CitationX.ac',
    types: ['C750', 'C56X', 'C68A', 'C525', 'C510'],
    lengthM: 22.0,
    credit: 'Citation X — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'c172',
    path: 'c172r',
    model: 'Models/c172-dpm.ac',
    types: ['C172', 'C182', 'C152', 'C150', 'C177'],
    lengthM: 8.28,
    credit: 'Cessna 172 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'da40',
    path: 'DA40',
    model: 'Models/da40.ac',
    types: ['DA40', 'DA42', 'DV20'],
    lengthM: 8.06,
    credit: 'Diamond DA40 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'ec35',
    path: 'ec135',
    model: 'Models/ec135.ac',
    types: ['EC35', 'EC45', 'H135', 'H145'],
    lengthM: 10.9,
    rotorcraft: true,
    credit: 'Eurocopter EC135 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'bo05',
    path: 'bo105',
    model: 'Models/bo105.ac',
    types: ['BO05', 'EC20', 'H120'],
    lengthM: 11.9,
    rotorcraft: true,
    credit: 'Bo 105 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 's76c',
    path: 'Sikorsky-76C',
    model: 'Models/s76c.ac',
    types: ['S76', 'S92', 'A139', 'AW39'],
    lengthM: 16.0,
    rotorcraft: true,
    credit: 'Sikorsky S-76C — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'as32',
    path: 'as332',
    model: 'Models/as332.ac',
    types: ['AS32', 'H225', 'EC25', 'S61'],
    lengthM: 19.5,
    rotorcraft: true,
    credit: 'Aerospatiale AS332 — FlightGear FGAddon, GPL-2.0',
  },
  {
    /*
     * The 737-300, not the -800.
     *
     * FGAddon's 737-800 keeps its wings, stabilisers and engines in separate
     * `.ac` files that the simulator assembles from XML offsets, so converting
     * the main file yields a fuselage: correctly scaled, correctly lit, and
     * nine per cent as wide as it is long. The -300 is one self-contained
     * file, and as the generic narrowbody that stands in for every unmatched
     * jet, being an aeroplane matters more than being the right variant.
     */
    id: 'b733',
    path: '737-300',
    model: 'Models/737-300.ac',
    types: ['B733', 'B734', 'B735'],
    lengthM: 33.4,
    credit: '737-300 — FlightGear FGAddon, GPL-2.0',
    // The schemes are painted on the white sheet, which is named for none
    // of them.
    liveries: { replaces: '733_white.png' },
  },
  {
    id: 'b712',
    path: '717',
    model: 'Models/717-200.ac',
    types: ['B712', 'MD95'],
    lengthM: 37.8,
    credit: '717-200 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'a346',
    path: 'A340-600',
    model: 'Models/A340.ac',
    types: ['A346', 'A343', 'A342', 'A345'],
    lengthM: 75.4,
    credit: 'A340-600 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'mrj9',
    path: 'MRJ',
    model: 'Models/MRJ90.ac',
    types: ['MRJ', 'E170', 'E75L', 'E75S', 'E190', 'E195', 'E290', 'E295'],
    lengthM: 35.8,
    credit: 'MRJ90 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'f27',
    path: 'Fokker-F.27',
    model: 'Models/f27.ac',
    types: ['F27'],
    lengthM: 25.1,
    credit: 'Fokker F.27 — FlightGear FGAddon, GPL-2.0',
  },
  {
    /*
     * The A320 family: the most common airliner in the sky, so the one whose
     * absence cost the most. Every A319/A320/A321 used to be drawn as a
     * 737-300.
     *
     * The airframe file carries the fuselage, wings and gear; the engines are
     * a file of their own. `A320-200-CFM.xml` raises the engines by 0.83 m,
     * but the fuselage is raised by the same amount elsewhere in the chain:
     * measured, applying it alone puts the pylon fairing inside the wing,
     * while at zero the nacelle hangs just under the lower skin where it
     * belongs. Both wingtip styles are modelled in the one file and the
     * simulator shows one at a time — here the fence stays and the sharklet
     * goes, since drawing both puts two wingtips on each wing.
     */
    id: 'a320',
    path: 'A320-family',
    parts: [
      { model: 'Models/Fuselage/res/A320-216.ac' },
      { model: 'Models/Fuselage/res/CFM56.ac' },
    ],
    discard: /sharklet/i,
    types: ['A320', 'A319', 'A321', 'A318', 'A20N', 'A19N', 'A21N'],
    lengthM: 37.57,
    credit: 'A320 family — FlightGear FGAddon, GPL-2.0',
    liveries: {
      dirs: [
        'Models/Liveries/CFM',
        'Models/Liveries/IAE',
        'Models/Liveries/CFM-NEO',
        'Models/Liveries/PW-NEO',
      ],
      replaces: 'Fuse-Main.png',
    },
  },
  {
    /*
     * The 737-800, assembled.
     *
     * Its wings, stabilisers, winglets and nose gear are separate files —
     * which is why the -300 stood in for it until the converter could join
     * them. Every part shares the fuselage's origin (the XML offsets are all
     * zero), so no placement is needed, only the join.
     */
    id: 'b738',
    path: '737-800',
    parts: [
      { model: 'Models/737-800.ac' },
      { model: 'Models/LWing.ac' },
      { model: 'Models/RWing.ac' },
      { model: 'Models/HorzStab.ac' },
      { model: 'Models/VertStab.ac' },
      { model: 'Models/winglet.ac' },
      { model: 'Models/nosegear.ac' },
    ],
    types: ['B738', 'B739', 'B737', 'B736', 'B38M', 'B39M', 'B37M', 'B3XM', 'B73H'],
    lengthM: 39.5,
    credit: '737-800 — FlightGear FGAddon, GPL-2.0',
    liveries: { dirs: ['Models/Liveries-800'], replaces: '737-800.png' },
  },
  {
    id: 'b732',
    path: '737-200',
    model: 'Models/737-200.ac',
    types: ['B732', 'B731'],
    lengthM: 30.5,
    credit: '737-200 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'b748',
    path: '747-8i',
    model: 'Models/747-8i.ac',
    types: ['B748', 'B744', 'B74F'],
    lengthM: 76.3,
    credit: '747-8 Intercontinental — FlightGear FGAddon, GPL-2.0',
    liveries: { dirs: ['Models/Liveries/748I', 'Models/Liveries'] },
  },
  {
    id: 'b742',
    path: '747-200',
    model: 'Models/boeing747-200.ac',
    types: ['B742', 'B741', 'B743', 'B74S', 'B74R'],
    lengthM: 70.6,
    credit: '747-200 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'md11',
    path: 'MD-11',
    model: 'Models/MD-11-GE.ac',
    types: ['MD11'],
    lengthM: 61.6,
    credit: 'MD-11 — FlightGear FGAddon, GPL-2.0',
    liveries: { dirs: ['Models/Liveries/MD-11', 'Models/Liveries/MD-11F'] },
  },
  {
    id: 'dc10',
    path: 'DC-10',
    model: 'Models/DC-10-30.ac',
    types: ['DC10'],
    lengthM: 55.5,
    credit: 'DC-10 — FlightGear FGAddon, GPL-2.0',
    liveries: { dirs: ['Models/Liveries/DC-10-30', 'Models/Liveries/DC-10-30F'] },
  },
  {
    id: 'b463',
    path: 'BAe-146',
    model: 'Models/bae146.ac',
    types: ['B461', 'B462', 'B463', 'RJ70', 'RJ85', 'RJ1H'],
    // The upstream model is the short -100.
    lengthM: 26.2,
    credit: 'BAe 146 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'f100',
    path: 'fokker100',
    model: 'Models/f100/fokker100.ac',
    types: ['F100'],
    lengthM: 35.5,
    credit: 'Fokker 100 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'f70',
    path: 'fokker100',
    model: 'Models/f70/fokker70.ac',
    types: ['F70'],
    lengthM: 30.9,
    credit: 'Fokker 70 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'f50',
    path: 'fokker50',
    model: 'Models/fokker50.ac',
    types: ['F50'],
    lengthM: 25.25,
    credit: 'Fokker 50 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'il76',
    path: 'IL-76',
    model: 'Models/il76.ac',
    types: ['IL76'],
    lengthM: 46.6,
    credit: 'Ilyushin Il-76 — FlightGear FGAddon, GPL-2.0',
  },
  {
    id: 'a306',
    path: 'A300-600',
    parts: [
      { model: 'Models/Fuselage.ac' },
      { model: 'Models/Wings.ac' },
      { model: 'Models/Tail.ac' },
      { model: 'Models/GE-CF6.ac' },
      { model: 'Models/Gears.ac' },
    ],
    types: ['A306', 'A30B', 'A310'],
    lengthM: 54.1,
    credit: 'A300-600 — FlightGear FGAddon, GPL-2.0',
    liveries: { dirs: ['Models/Liveries/603', 'Models/Liveries/600F'] },
  },
];

// ---------------------------------------------------------------------------

/**
 * Downscale and re-encode a texture.
 *
 * WebP rather than PNG: these are photographic paint schemes, not line art, and
 * lossless PNG spends most of its bytes on noise the eye cannot see at this
 * size. Quality 82 is where the difference stops being findable by flicking
 * between the two at full zoom, and it is roughly a tenth of the bytes.
 *
 * `withoutEnlargement` matters — a 512-pixel placards sheet must not be blown
 * up to 2048 on the way through.
 */
export async function shrink(data, base) {
  try {
    // SGI images (older models) are read by neither the encoder nor a browser.
    const input = isSgi(data)
      ? await (({ width, height, rgba }) => sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer())(decodeSgi(data))
      : data;
    const encoded = await sharp(input)
      .resize({
        width: MAX_TEXTURE_PX,
        height: MAX_TEXTURE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 82 })
      .toBuffer();
    return { data: encoded, name: `${base.replace(/\.[^.]+$/, '')}.webp` };
  } catch {
    /*
     * Pass it through untouched.
     *
     * A handful of FGAddon textures are in formats this encoder does not read
     * — old interlaced PNGs and the occasional mislabelled file. Losing the
     * whole aircraft over a texture that the *browser* can very likely still
     * decode is the wrong trade, and if it cannot, the pipeline already draws
     * that part in flat colour rather than failing.
     */
    return { data, name: base };
  }
}

export async function fetchCached(url, file) {
  const target = join(CACHE, file);
  if (existsSync(target)) return readFile(target);

  await mkdir(dirname(target), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(target, buffer);
  return buffer;
}

/**
 * Every livery upstream offers for an aircraft.
 *
 * Reads the XML descriptors in `Models/Liveries/` (and any extra folders the
 * entry names). A texture path in a descriptor is relative to `Models/`, which
 * is where the simulator resolves it from. Folders that hold bare images and
 * no descriptors are read as images named after their operator.
 */
async function discoverLiveries(entry) {
  const dirs = entry.liveries?.dirs ?? ['Models/Liveries'];
  const all = [];
  for (const dir of dirs) {
    let listing;
    try {
      listing = listingEntries(
        (await fetchCached(`${FGADDON}/${entry.path}/${dir}/`, `${entry.id}/ls-${dir.replace(/\//g, '_')}.html`)).toString(),
      );
    } catch {
      continue;
    }
    const xmls = listing.filter((f) => f.endsWith('.xml'));
    for (const file of xmls) {
      try {
        const xml = (await fetchCached(`${FGADDON}/${entry.path}/${dir}/${file}`, `${entry.id}/livery-${file}`)).toString();
        const texture = liveryTexture(xml);
        if (!texture) continue;
        const relative = texture.startsWith('Models/') || texture.startsWith('Aircraft/')
          ? texture.replace(/^Aircraft\/[^/]+\//, '')
          : `Models/${texture}`;
        all.push({ stem: file.replace(/\.xml$/, ''), texture: relative });
      } catch {
        // An unreadable descriptor is one fewer livery, not a failed aircraft.
      }
    }
    if (xmls.length === 0) {
      for (const file of listing.filter((f) => /\.png$/i.test(f))) {
        all.push({ stem: file.replace(/\.png$/i, ''), texture: `${dir}/${file}` });
      }
    }
  }
  const { chosen, skipped } = pickPerOperator(all);
  return { all, chosen, skipped, dirs };
}

/** Authors named in the aircraft's FlightGear `-set.xml`, if any. */
async function readSetAuthors(path) {
  try {
    const listing = (await fetchCached(`${FGADDON}/${path}/`, `${path}/listing.html`)).toString();
    const setFile = /<li><a href="([^"]+-set\.xml)">/.exec(listing)?.[1];
    if (!setFile) return null;

    const xml = (await fetchCached(`${FGADDON}/${path}/${setFile}`, `${path}/${setFile}`)).toString();
    const author = /<author>([\s\S]*?)<\/author>/i.exec(xml)?.[1];
    return author ? author.replace(/\s+/g, ' ').trim() : null;
  } catch {
    return null;
  }
}

/** True when every vertex shares one coordinate: a zero-thickness sheet. */
function isFlatSheet(tris) {
  for (let axis = 0; axis < 3; axis++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const tri of tris) {
      for (const p of tri.v) {
        lo = Math.min(lo, p[axis]);
        hi = Math.max(hi, p[axis]);
      }
    }
    if (hi - lo < 1e-6) return true;
  }
  return false;
}

/** FlightGear axes to ours. See the note at the top. */
function toAppAxes(v) {
  return [-v[2], -v[0], v[1]];
}

/*
 * `roles` on an entry names its rotors where the author's object names do not
 * start the way `ROTOR` expects — the Apache's are `Mesh7 mainrotor Group`.
 * Those rotors are also cut into one object per blade, so the spinner they
 * make is keyed by role rather than by object (see `side` below): sixteen
 * blades each turning about its own centroid is not a rotor.
 */
function roleOf(name, isRotorcraft, roles) {
  if (isRotorcraft && roles) {
    if (roles.tailRotor?.test(name)) return 'tailRotor';
    if (roles.mainRotor?.test(name)) return 'mainRotor';
  }
  if (PROPDISC.test(name)) return 'disc';
  if (PROP.test(name)) return 'prop';
  if (isRotorcraft) {
    if (TAILROTOR.test(name)) return 'tailRotor';
    if (ROTOR.test(name)) return 'mainRotor';
  }
  if (GEAR.test(name)) return 'gear';
  return 'hull';
}

/**
 * Turn one AC3D object into triangles in app axes.
 *
 * AC3D surfaces are n-gons; they are fanned. Normals are not stored in the
 * format at all, so they are computed here — averaged across faces that share
 * a position when the surface asks for smooth shading, and left per-face
 * otherwise. Skipping that and letting every face keep its own normal turns a
 * fuselage into a faceted tube.
 */
function triangulate(object, transform) {
  const world = object.verts.map((v) => toAppAxes(applyTransform(transform, v)));
  const tris = [];

  for (const surface of object.surfaces) {
    // Low nibble 0 is a filled polygon; 1 and 2 are construction lines.
    if ((surface.flags & 0x0f) !== 0) continue;
    if (surface.refs.length < 3) continue;
    const smooth = (surface.flags & 0x10) !== 0;

    for (let k = 1; k < surface.refs.length - 1; k++) {
      const a = surface.refs[0];
      const b = surface.refs[k];
      const c = surface.refs[k + 1];
      if (!a || !b || !c) continue;
      tris.push({
        smooth,
        v: [world[a.v], world[b.v], world[c.v]],
        uv: [
          [a.u, a.t],
          [b.u, b.t],
          [c.u, c.t],
        ],
      });
    }
  }
  return tris;
}

function faceNormal(p, q, r) {
  const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
  const vx = r[0] - q[0], vy = r[1] - q[1], vz = r[2] - q[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** Average face normals across shared positions, for the smooth-shaded faces. */
export function computeNormals(tris) {
  const accum = new Map();
  const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)}`;

  for (const tri of tris) {
    if (!tri.smooth) continue;
    const n = faceNormal(tri.v[0], tri.v[1], tri.v[2]);
    for (const p of tri.v) {
      const k = key(p);
      const a = accum.get(k) ?? [0, 0, 0];
      a[0] += n[0];
      a[1] += n[1];
      a[2] += n[2];
      accum.set(k, a);
    }
  }

  for (const tri of tris) {
    const flat = faceNormal(tri.v[0], tri.v[1], tri.v[2]);
    tri.n = tri.v.map((p) => {
      const n = tri.smooth ? accum.get(key(p)) ?? flat : flat;
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      return [n[0] / len, n[1] / len, n[2] / len];
    });
  }
}

/** Weld identical (position, normal, uv) triples into an indexed mesh. */
export function index(tris) {
  const map = new Map();
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (const tri of tris) {
    for (let c = 0; c < 3; c++) {
      const p = tri.v[c];
      const n = tri.n[c];
      const t = tri.uv[c];
      const k = `${p[0].toFixed(4)},${p[1].toFixed(4)},${p[2].toFixed(4)},${n[0].toFixed(2)},${n[1].toFixed(2)},${n[2].toFixed(2)},${t[0].toFixed(4)},${t[1].toFixed(4)}`;
      let id = map.get(k);
      if (id === undefined) {
        id = positions.length / 3;
        map.set(k, id);
        positions.push(p[0], p[1], p[2]);
        normals.push(n[0], n[1], n[2]);
        uvs.push(t[0], t[1]);
      }
      indices.push(id);
    }
  }
  return { positions, normals, uvs, indices };
}

/**
 * The aircraft's geometry as one AC3D tree, however many files it is kept in.
 *
 * Most FGAddon aircraft are one `.ac` file. Some — the A320 family, the
 * 737NG — keep the engines, or the wings, in files of their own that the
 * simulator places from XML offsets. `entry.parts` lists those files with the
 * offsets copied from that XML, and they are joined here under one root.
 *
 * Three things have to be carried across when two files become one tree:
 *
 *  - **Materials** are numbered per file, so each file's surfaces are shifted
 *    past the materials of the files before it.
 *  - **Offsets** are in FlightGear's body frame (x aft, y right, z up) while
 *    the geometry is in AC3D's (y up, z toward the viewer): x, y, z in the
 *    XML is x, z, -y in the file.
 *  - **Texture names** are relative to the file that uses them, so a part in
 *    a sub-folder has its folder put in front, relative to `Models/`, which
 *    is where the texture search starts.
 */
async function loadAssembly(entry) {
  const parts = entry.parts ?? [{ model: entry.model }];
  const materials = [];
  const roots = [];

  for (const part of parts) {
    const cacheName = entry.parts ? `${entry.id}/part-${part.model.replace(/[\\/]/g, '_')}` : `${entry.id}/model.ac`;
    const text = (await fetchCached(`${FGADDON}/${entry.path}/${part.model}`, cacheName)).toString('utf8');
    const parsed = parseAc3d(text);

    const folder = dirname(part.model).replace(/^Models\/?/, '');
    const shift = materials.length;
    for (const { object } of flatten(parsed.root)) {
      for (const surface of object.surfaces) surface.material += shift;
      if (folder && object.texture && !object.texture.includes('/')) {
        object.texture = `${folder}/${object.texture}`;
      }
    }
    materials.push(...parsed.materials);

    const o = part.offset ?? {};
    const r = parsed.root;
    r.loc = [r.loc[0] + (o.x ?? 0), r.loc[1] + (o.z ?? 0), r.loc[2] - (o.y ?? 0)];
    roots.push(r);
  }

  const root =
    roots.length === 1
      ? roots[0]
      : {
          type: 'group',
          name: 'assembly',
          texture: null,
          texrep: [1, 1],
          verts: [],
          surfaces: [],
          kids: roots,
          rot: null,
          loc: [0, 0, 0],
        };
  return { materials, root };
}

export async function convert(entry, { quiet = false } = {}) {
  const say = (...a) => {
    if (!quiet) console.log(...a);
  };

  const { materials, root } = await loadAssembly(entry);

  // --- collect, grouped by role + texture + material ------------------------
  const groups = new Map();
  const textures = [];
  let discarded = 0;

  for (const { object, transform } of flatten(root)) {
    if (object.verts.length === 0) continue;
    if (
      DISCARD.test(object.name) ||
      entry.discard?.test(object.name) ||
      (object.texture && EFFECT_TEXTURE.test(object.texture))
    ) {
      discarded += object.verts.length;
      continue;
    }

    const tris = triangulate(object, transform);
    if (tris.length === 0) continue;

    /*
     * Drop the flat helper sheets — per object, before anything is merged.
     *
     * FlightGear models carry a cast-shadow plane and sometimes a fog card:
     * quads with exactly zero extent in one axis, lying under or through the
     * airframe. In a simulator that projects them onto the ground they are
     * invisible; here they render as a flat plate across the wing, which is
     * what the 777 was doing and what the 737-300 was still doing.
     *
     * The test used to run after grouping and only on untextured groups, and
     * missed both ways round. Objects are merged by role, texture and
     * material, so a helper sharing a sheet with real geometry arrived welded
     * to it and no longer measured flat; and a helper that *is* textured — the
     * 737's is painted with the white livery sheet — was never examined. Here
     * it is one object at a time, whatever it is painted with.
     *
     * The test itself is unchanged and stays strict: exactly zero extent, not
     * merely thin. A real surface on an aeroplane is never a perfectly planar
     * sheet; a wing is thin, not zero.
     */
    const material = object.surfaces[0]?.material ?? 0;
    const texture = object.texture;
    const role = roleOf(object.name, Boolean(entry.rotorcraft), entry.roles);

    // A propeller's blur disc is a flat sheet on purpose — that is what a disc
    // is — so it is the one thing this test must not be applied to.
    if (role !== 'disc' && isFlatSheet(tris)) {
      say(`  ${entry.id}: dropped flat helper "${object.name}"`);
      discarded += object.verts.length;
      continue;
    }
    if (texture && !textures.includes(texture)) textures.push(texture);

    // Spinners are kept whole and separate: each one turns about its own hub.
    const side = role === 'hull' || role === 'gear' ? '' : entry.roles && (role === 'mainRotor' || role === 'tailRotor') ? `:${role}` : `:${object.name}`;
    const key = `${role}${side}|${texture ?? ''}|${material}`;

    const group = groups.get(key) ?? { role, texture, material, name: object.name, tris: [] };
    group.tris.push(...tris);
    groups.set(key, group);
  }

  // --- validate the scale before anything is written ------------------------
  const box = [
    [Infinity, -Infinity],
    [Infinity, -Infinity],
    [Infinity, -Infinity],
  ];
  for (const group of groups.values()) {
    for (const tri of group.tris) {
      for (const p of tri.v) {
        for (let a = 0; a < 3; a++) {
          box[a][0] = Math.min(box[a][0], p[a]);
          box[a][1] = Math.max(box[a][1], p[a]);
        }
      }
    }
  }
  const measured = box[1][1] - box[1][0];
  const error = Math.abs(measured - entry.lengthM) / entry.lengthM;
  if (error > 0.06) {
    throw new Error(
      `${entry.id}: model is ${measured.toFixed(2)} m along the fuselage axis but the type is ` +
        `${entry.lengthM} m (${(error * 100).toFixed(1)}% out) — axes or units are wrong`,
    );
  }

  /**
   * The span of a set of groups, as a ratio to the measured length.
   *
   * The length check above passes a fuselage with no wings, because a fuselage
   * is exactly as long as the aeroplane. Several FGAddon aircraft keep the
   * wings, stabilisers and engines in separate `.ac` files that the simulator
   * assembles from XML offsets — the 737-800 is one — and converting only the
   * main file yields a tube, correctly scaled, with nothing sticking out.
   *
   * No fixed-wing aircraft has a span under 60% of its length; most airliners
   * are near parity and gliders are several times over. A tube measures about
   * 10%, so the two populations are nowhere near each other and the threshold
   * needs no per-type data.
   */
  const spanRatioOf = (keep) => {
    let min = Infinity;
    let max = -Infinity;
    for (const group of groups.values()) {
      if (!keep(group)) continue;
      for (const tri of group.tris) {
        for (const p of tri.v) {
          min = Math.min(min, p[0]);
          max = Math.max(max, p[0]);
        }
      }
    }
    return Number.isFinite(min) ? (max - min) / measured : 0;
  };

  if (!entry.rotorcraft) {
    const ratio = spanRatioOf(() => true);
    // A delta (MiG-21, Gripen) really is narrower than that; such entries say so.
    const minSpan = entry.minSpan ?? 0.6;
    if (ratio < minSpan) {
      throw new Error(
        `${entry.id}: span is only ${(ratio * 100).toFixed(0)}% of length ` +
          `(${(ratio * measured).toFixed(1)} m across ${measured.toFixed(1)} m) — the wings ` +
          `are probably in a separate file this converter does not assemble`,
      );
    }

    const cruise = spanRatioOf((group) => group.role !== 'gear');
    if (cruise < minSpan) {
      throw new Error(
        `${entry.id}: with the gear retracted the span drops to ${(cruise * 100).toFixed(0)}% ` +
          `of length — a wing has been classified as undercarriage`,
      );
    }
  }

  /*
   * A helicopter has to have a rotor.
   *
   * The exact analogue of the wing check, and it catches the same upstream
   * habit: the R44 and the UH-1 keep their rotors in a separate `.ac` file
   * that the simulator assembles from XML offsets, so converting the main
   * file yields a fuselage with a bare mast. Nothing else notices — the model
   * loads, lights and renders — and the aeroplane simply hovers on nothing.
   *
   * Both were dropped rather than shipped; their types fall back to the EC135,
   * whose rotor does turn. A real model with a frozen rotor is worse than a
   * generated one that spins.
   */
  if (entry.rotorcraft) {
    const hasRotor = [...groups.values()].some((group) => group.role === 'mainRotor');
    if (!hasRotor) {
      throw new Error(
        `${entry.id}: no main rotor — it is probably in a separate file this converter does ` +
          `not assemble, and the model would hover on a bare mast`,
      );
    }
  }

  /*
   * The undercarriage has to be underneath.
   *
   * Everything roled `gear` is hidden above circuit height, so a surface
   * misclassified as undercarriage does not merely look odd — it disappears in
   * the cruise, which is where the aeroplane spends its whole life. The
   * MD-80's texture sheet is called `txt_hstab_gear`, and a rule that read the
   * texture name retracted the entire tailplane with the wheels.
   *
   * The span check above does not catch that: a stabiliser is a quarter of the
   * span, so losing it still leaves a wing wide enough to pass. What is always
   * true is *where* gear is — wheels hang below the fuselage, lifting surfaces
   * sit on or above the centreline — so a gear group whose centre is in the
   * upper half of the airframe is not gear.
   *
   * ## What this cannot see
   *
   * Objects are merged by role, texture and material before they get here, so
   * a stabiliser that shares a texture sheet with the real undercarriage
   * arrives as one group with the wheels, and its centroid averages out to
   * somewhere near the middle. Tested against the MD-80 with the texture rule
   * restored: this check passes it. Geometry cannot separate two surfaces that
   * have already been welded together.
   *
   * So this is a guard against an *isolated* misclassification — a name-regex
   * false positive on a part with its own texture — and not a substitute for
   * classifying by name in the first place. It is worth the six lines; it is
   * not worth trusting on its own.
   */
  {
    const midZ = (box[2][0] + box[2][1]) / 2;
    for (const group of groups.values()) {
      if (group.role !== 'gear') continue;
      let sum = 0;
      let count = 0;
      for (const tri of group.tris) {
        for (const p of tri.v) {
          sum += p[2];
          count++;
        }
      }
      if (count > 0 && sum / count > midZ) {
        throw new Error(
          `${entry.id}: "${group.name}" is classified as undercarriage but its centre is in ` +
            `the upper half of the airframe — it is a lifting surface, and hiding it above ` +
            `circuit height would fly the aeroplane without it`,
        );
      }
    }
  }

  /*
   * Centre on the airframe and scale to length 1.
   *
   * Centred on the *bounding box*, because that is what the procedural models
   * are centred on and what `shape.length` scales; the FlightGear datum is
   * usually the nose or an arbitrary station and using it would hang every
   * aircraft off its own nose.
   */
  const centre = [
    (box[0][0] + box[0][1]) / 2,
    (box[1][0] + box[1][1]) / 2,
    (box[2][0] + box[2][1]) / 2,
  ];
  const scale = 1 / measured;

  const parts = [];
  const chunks = [];
  let offset = 0;

  const push = (array, Ctor) => {
    const typed = Ctor.from(array);
    const buffer = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const at = offset;
    chunks.push(buffer);
    offset += buffer.length;
    return { offset: at, count: array.length };
  };

  for (const group of groups.values()) {
    for (const tri of group.tris) {
      tri.v = tri.v.map((p) => [
        (p[0] - centre[0]) * scale,
        (p[1] - centre[1]) * scale,
        (p[2] - centre[2]) * scale,
      ]);
    }
    computeNormals(group.tris);
    const mesh = index(group.tris);

    // A spinner's geometry is moved to its own origin so it can be rotated in
    // place; everything else stays in airframe space.
    let origin = [0, 0, 0];
    const spins = group.role === 'prop' || group.role === 'mainRotor' || group.role === 'tailRotor';
    if (spins || group.role === 'disc') {
      const n = mesh.positions.length / 3;
      for (let i = 0; i < n; i++) {
        origin[0] += mesh.positions[i * 3];
        origin[1] += mesh.positions[i * 3 + 1];
        origin[2] += mesh.positions[i * 3 + 2];
      }
      origin = origin.map((c) => c / n);
      for (let i = 0; i < n; i++) {
        mesh.positions[i * 3] -= origin[0];
        mesh.positions[i * 3 + 1] -= origin[1];
        mesh.positions[i * 3 + 2] -= origin[2];
      }
    }

    const mat = materials[group.material] ?? { rgb: [1, 1, 1], emis: [0, 0, 0], trans: 0 };
    parts.push({
      role: group.role,
      name: group.name,
      texture: group.texture ? textures.indexOf(group.texture) : -1,
      color: mat.rgb.map((c) => +c.toFixed(4)),
      emissive: mat.emis.map((c) => +c.toFixed(4)),
      opacity: +(1 - mat.trans).toFixed(3),
      origin: origin.map((c) => +c.toFixed(6)),
      // Props turn about the nose axis; main rotors about the vertical.
      axis: group.role === 'mainRotor' ? [0, 0, 1] : group.role === 'tailRotor' ? [1, 0, 0] : [0, 1, 0],
      position: push(mesh.positions, Float32Array),
      normal: push(mesh.normals, Float32Array),
      uv: push(mesh.uvs, Float32Array),
      index: push(mesh.indices, Uint32Array),
    });
  }

  /*
   * --- textures -------------------------------------------------------------
   *
   * A texture name in an .ac file is relative to wherever the author happened
   * to have the file, so the same name lives under `Models/` on one aircraft
   * and in a `Liveries/` folder on the next. Each candidate is tried in turn,
   * and a texture that is nowhere to be found leaves its parts untextured
   * rather than failing the aircraft — a plain-coloured 380 is worth having,
   * and the alternative is no 380.
   */
  await mkdir(OUT, { recursive: true });
  const textureFiles = [];
  const missing = [];

  for (const texture of textures) {
    const base = texture.replace(/^.*[\\/]/, '');
    const candidates = [
      `${entry.path}/Models/${texture}`,
      `${entry.path}/${texture}`,
      `${entry.path}/Models/${base}`,
      `${entry.path}/Models/Liveries/${base}`,
      `${entry.path}/Liveries/${base}`,
      `${entry.path}/Models/Effects/${base}`,
      `${entry.path}/Textures/${base}`,
      `${entry.path}/Models/Textures/${base}`,
    ];

    let data = null;
    for (const candidate of candidates) {
      try {
        data = await fetchCached(`${FGADDON}/${candidate}`, `${entry.id}/${base}`);
        break;
      } catch {
        // Try the next place it might be.
      }
    }

    if (!data) {
      missing.push(texture);
      textureFiles.push(null);
      continue;
    }

    const hash = createHash('sha1').update(data).digest('hex').slice(0, 8);
    const encoded = await shrink(data, base.replace(/[^\w.-]/g, '_'));
    const name = `${entry.id}-${hash}-${encoded.name}`;
    await writeFile(join(OUT, name), encoded.data);
    textureFiles.push({ name, bytes: encoded.data.length });
  }

  // Renumber around anything that could not be found.
  const kept = [];
  const remap = textureFiles.map((t) => (t ? kept.push(t) - 1 : -1));
  for (const part of parts) part.texture = part.texture >= 0 ? remap[part.texture] ?? -1 : -1;
  if (missing.length) say(`  ${entry.id}: no texture found for ${missing.join(', ')}`);

  /*
   * --- operator liveries ----------------------------------------------------
   *
   * Emitted as loose files beside the model rather than packed into it: they
   * are alternatives, only ever one is wanted, and a visitor who never flies a
   * Qatar 777 should never download Qatar's paint. The renderer swaps the one
   * texture slot the livery occupies and keeps every geometry it already has.
   */
  const liveries = {};
  let liveryTexture = -1;

  if (entry.liveries !== false) {
    const found = await discoverLiveries(entry);
    const byBase = (t) => t.replace(/^.*[\\/]/, '').toLowerCase();

    // The slot a livery replaces is the model texture that one of the
    // schemes also supplies — that is the sheet the author painted the
    // default livery on. Named explicitly where the file names disagree.
    const liveryBases = new Set(found.all.map((c) => byBase(c.texture)));
    const wantedBase = entry.liveries?.replaces?.toLowerCase();
    const slot = textures.findIndex((t) =>
      wantedBase ? byBase(t) === wantedBase : liveryBases.has(byBase(t)),
    );
    liveryTexture = slot >= 0 ? remap[slot] ?? -1 : -1;

    if (found.all.length === 0) {
      // Nothing upstream; nothing to say.
    } else if (liveryTexture < 0) {
      say(`  ${entry.id}: ${found.all.length} liveries upstream, but no model texture they replace — skipped`);
    } else {
      const fetchLivery = async (texture) => {
        const base = texture.replace(/^.*[\\/]/, '');
        // Beside the descriptor, or in the resolution folder some authors
        // file the full-size paint under.
        const places = found.dirs.flatMap((d) => [d, `${d}/4k`, `${d}/2k`]);
        for (const candidate of [`${entry.path}/${texture}`, ...places.map((d) => `${entry.path}/${d}/${base}`)]) {
          try {
            return await fetchCached(`${FGADDON}/${candidate}`, `${entry.id}/livery-${base}`);
          } catch {
            // Try the next place it might be.
          }
        }
        return null;
      };
      const emit = async (operator, data) => {
        const encoded = await shrink(data, `${operator}.png`);
        const name = `${entry.id}-livery-${encoded.name}`;
        await writeFile(join(OUT, name), encoded.data);
        liveries[operator] = name;
      };

      for (const [operator, texture] of Object.entries(found.chosen)) {
        const data = await fetchLivery(texture);
        if (data) await emit(operator, data);
        else say(`  ${entry.id}: livery ${operator} (${texture}) unavailable`);
      }
      const airlines = Object.keys(liveries).filter((k) => k !== 'NEUTRAL');

      /*
       * The neutral scheme, which every aircraft with liveries must have.
       *
       * Without it an operator with no scheme of its own would be drawn in
       * the paint the upstream author happened to model — on the 767 that is
       * one specific charter airline, shown on every unmatched 767 in the
       * sky. In order of preference: a plain white scheme upstream; the
       * manufacturer's own colours, which name no operator; and failing
       * both, the model's paint washed out to near-white, so its sheet keeps
       * its panel lines and windows but no airline can be read off it.
       */
      const dropAll = async () => {
        for (const [key, name] of Object.entries(liveries)) {
          await rm(join(OUT, name), { force: true });
          delete liveries[key];
        }
        liveryTexture = -1;
      };

      if (airlines.length === 0) {
        /*
         * No airline schemes: nothing to swap, so nothing to neutralise.
         * A light aircraft, a helicopter or a military type keeps the paint
         * it was modelled in, which names no airline to begin with.
         */
        await dropAll();
      } else if (!liveries['NEUTRAL']) {
        const house = found.all.find((c) => isHouseScheme(c.stem));
        const houseData = house ? await fetchLivery(house.texture) : null;
        if (houseData) {
          await emit('NEUTRAL', houseData);
        } else {
          const own = textures[slot].replace(/^.*[\\/]/, '');
          try {
            const raw = await fetchCached(`${FGADDON}/${entry.path}/Models/${textures[slot]}`, `${entry.id}/${own}`);
            await emit('NEUTRAL', await sharp(raw).greyscale().linear(0.3, 178).png().toBuffer());
            say(`  ${entry.id}: neutral scheme washed out from ${own}`);
          } catch {
            // Airline schemes with no honest fallback would put somebody's
            // paint on every unmatched operator. Keep the model as modelled.
            say(`  ${entry.id}: no neutral scheme and ${own} cannot be washed out — liveries dropped`);
            await dropAll();
          }
        }
      }

      say(
        `  ${entry.id}: ${Object.keys(liveries).filter((k) => k !== 'NEUTRAL').length} airline liveries` +
          (found.skipped.length ? ` (not airlines: ${found.skipped.join(', ')})` : ''),
      );
    }
  }

  /*
   * --- attribution ----------------------------------------------------------
   *
   * Not a nicety. These models are GPL-2.0, and the licence requires that the
   * copyright notices travel with them — so every notice file the upstream
   * aircraft carries is fetched and shipped beside the converted model. An
   * aircraft that has none is reported rather than silently accepted, because
   * a GPL work with no attributable author is a thing to look at by hand
   * before redistributing it.
   */
  const notices = [];
  for (const file of ['LICENSE', 'COPYING', 'AUTHORS', 'README', 'README.md', 'Thanks']) {
    try {
      const data = await fetchCached(
        `${FGADDON}/${entry.path}/${file}`,
        `${entry.id}/notice-${file}`,
      );
      const name = `credits/${entry.id}/${file}`;
      await mkdir(dirname(join(OUT, name)), { recursive: true });
      await writeFile(join(OUT, name), data);
      notices.push(name);
    } catch {
      // Not every aircraft carries every file.
    }
  }
  /*
   * Several aircraft carry no notice file at all and name their authors only
   * in the FlightGear `-set.xml`. That is still an attributable copyright
   * notice and still has to travel with the model, so it is pulled out and
   * written as one. An aircraft with neither is reported loudly: a GPL work
   * with no attributable author is something to look at by hand rather than
   * quietly redistribute.
   */
  if (notices.length === 0) {
    const authors = await readSetAuthors(entry.path);
    if (authors) {
      const name = `credits/${entry.id}/AUTHORS`;
      await mkdir(dirname(join(OUT, name)), { recursive: true });
      await writeFile(
        join(OUT, name),
        `${entry.path} — FlightGear FGAddon\n\nAuthors: ${authors}\n\n` +
          `Licensed GPL-2.0 as part of FGAddon. Attribution taken from the\n` +
          `aircraft's FlightGear -set.xml, which is the only notice upstream carries.\n`,
      );
      notices.push(name);
    } else {
      say(`  ${entry.id}: WARNING — no licence or author information upstream`);
    }
  }

  const header = {
    id: entry.id,
    source: `FlightGear FGAddon Aircraft/${entry.path}`,
    license: 'GPL-2.0',
    notices,
    lengthM: +measured.toFixed(3),
    /** The FlightGear datum's offset from the model's centre, app axes, metres: where the cockpit is placed from. */
    centreM: centre.map((c) => +c.toFixed(4)),
    textures: kept.map((t) => t.name),
    /** Texture slot an operator livery replaces, or -1 if the model has none. */
    liveryTexture,
    /** True for a helicopter: it has a rotor and no fixed lifting surface. */
    rotorcraft: Boolean(entry.rotorcraft),
    parts,
  };

  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const head = Buffer.alloc(8);
  head.write('PVM1', 0, 'ascii');
  head.writeUInt32LE(json.length + pad, 4);

  const blob = packPvm(Buffer.concat([head, json, Buffer.alloc(pad), ...chunks]));
  await writeFile(join(OUT, `${entry.id}.pvm`), blob);

  const triangles = parts.reduce((s, p) => s + p.index.count / 3, 0);
  say(
    `${entry.id}: ${parts.length} parts, ${triangles.toLocaleString()} triangles, ` +
      `${(blob.length / 1024).toFixed(0)} kB + ${(kept.reduce((s, t) => s + t.bytes, 0) / 1024).toFixed(0)} kB textures ` +
      `(dropped ${discarded.toLocaleString()} interior verts)`,
  );

  return { header, bytes: blob.length, textureFiles: kept, triangles, notices, liveries };
}

/** The attribution page shipped beside the models. */
function creditsMarkdown(rows) {
  const lines = [
    '# 3D aircraft models',
    '',
    'The textured airframes in this directory are converted from the',
    '[FlightGear](https://www.flightgear.org/) add-on hangar (FGAddon) by',
    '`tools/fgmodel/convert.mjs`. They are **not** original to this project.',
    '',
    'Each is licensed **GPL-2.0** by its original authors. The converted form is a',
    'derivative work and carries the same licence; the upstream licence and author',
    'files are reproduced under `credits/<id>/`, and the full GPL text is in',
    '`LICENSE-GPL-2.0.txt`.',
    '',
    'Aircraft types with no model here are drawn by the procedural generator in',
    '`src/render/aircraft`, which is original work under the project licence.',
    '',
    '| Model | Types | Upstream | Licence | Notices |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const row of rows) {
    const url = `https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/${row.path}/`;
    lines.push(
      `| \`${row.id}\` | ${row.types.join(', ')} | [Aircraft/${row.path}](${url}) | GPL-2.0 | ${
        row.notices.length ? row.notices.map((n) => `\`${n}\``).join(', ') : '**none upstream**'
      } |`,
    );
  }

  lines.push('', 'To regenerate: `node tools/fgmodel/convert.mjs`.', '');
  return lines.join('\n');
}

async function main() {
  const wanted = process.argv.slice(2);
  const list = wanted.length ? AIRCRAFT.filter((a) => wanted.includes(a.id)) : AIRCRAFT;

  /*
   * The catalogue.
   *
   * `types` maps an ICAO type designator to a model id; `liveries` maps a model
   * id to the operator paint schemes that exist for it. Two maps rather than
   * one nested structure because the client reads them at different moments —
   * the type is needed to decide whether to download anything at all, and the
   * livery only once the operator is known.
   */
  /*
   * What to draw when the exact type has no model.
   *
   * Six hundred designators exist and two dozen have a converted airframe, so
   * the common case is a miss — and until now a miss meant the procedural
   * generator, which is a decent silhouette and unmistakably not a photograph
   * of an aeroplane. A real model of the wrong variant is closer to the truth
   * than an accurate drawing of a generic one: an unknown narrowbody jet looks
   * far more like a 737 than like anything a mesh generator produces.
   *
   * Keyed by airframe kind rather than by type, because that is the most the
   * client knows about a designator it has never heard of. Gliders have no
   * entry on purpose — the generated one is a long thin wing and a pod, which
   * is genuinely what they all look like, and no glider in the hangar is a
   * better stand-in for the rest than that.
   */
  const FALLBACKS = {
    jet: 'b738',
    turboprop: 'at72',
    piston: 'c172',
    rotorcraft: 'ec35',
  };

  /*
   * Clear the output first.
   *
   * Removing an aircraft from the list above does not remove the files it
   * wrote last time, and a stale `.pvm` is still served — so a model dropped
   * for being broken goes on being downloaded by anyone whose type code still
   * matches a stale catalogue. Rewriting the directory each run means the
   * shipped set is exactly the set that passed validation on this run.
   */
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const index = { types: {}, liveries: {}, fallback: {} };
  const rows = [];
  const skipped = [];
  for (const entry of list) {
    /*
     * One aircraft failing must not take the catalogue with it.
     *
     * The bounding-box check exists to catch a model whose wings live in a
     * separate file, or whose axes are wrong — both of which produce an
     * aeroplane scaled to nonsense. With a handful of aircraft, throwing was
     * the right response. With two dozen, it means one bad entry in the middle
     * of the list silently costs every entry after it, and the run that
     * reports the problem is also the run that shipped nothing.
     */
    let converted;
    try {
      converted = await convert(entry);
    } catch (error) {
      console.log(`  ${entry.id}: SKIPPED — ${error instanceof Error ? error.message : String(error)}`);
      skipped.push(entry.id);
      continue;
    }
    const { notices, liveries } = converted;
    index.types[entry.id] = index.types[entry.id] ?? entry.id;
    for (const type of entry.types) index.types[type] = entry.id;
    if (Object.keys(liveries).length > 0) index.liveries[entry.id] = liveries;
    rows.push({ ...entry, notices });
  }

  // Only offer a fallback that actually converted this run.
  for (const [kind, id] of Object.entries(FALLBACKS)) {
    if (rows.some((row) => row.id === id)) index.fallback[kind] = id;
    else console.log(`  fallback for ${kind} (${id}) did not convert — omitted`);
  }

  await writeFile(join(OUT, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  await writeFile(join(OUT, 'CREDITS.md'), creditsMarkdown(rows));

  // The licence text itself, fetched once from an aircraft that ships it.
  const gpl = await fetchCached(`${FGADDON}/${list[0].path}/LICENSE`, 'gpl-2.0.txt').catch(
    () => null,
  );
  if (gpl) await writeFile(join(OUT, 'LICENSE-GPL-2.0.txt'), gpl);

  console.log(`wrote index.json, CREDITS.md and ${rows.length} model(s) to public/models`);
  if (skipped.length) console.log(`skipped: ${skipped.join(', ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
