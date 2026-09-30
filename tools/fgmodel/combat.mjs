/**
 * The sandbox's combat hangar: real FlightGear airframes for the aircraft the
 * sandbox arms.
 *
 * Build-time only, like `convert.mjs`, and additive: it converts just these
 * entries and merges them into the existing `public/models/index.json` and
 * `CREDITS.md`, rather than wiping the directory the way a full run does.
 *
 *   node tools/fgmodel/combat.mjs [id ...]
 *
 * Every entry is GPL-2.0 upstream, exactly like the civil hangar; see
 * `public/models/CREDITS.md`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { convert } from './convert.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', '..', 'public', 'models');

/*
 * Lengths are the real aircraft's, nose (or pitot) to tail, because that is
 * what the converter's bounding-box check measures against. Types are the ICAO
 * designators, so a live F-16 in the feed is drawn with the same model.
 */
export const COMBAT = [
  {
    id: 'f16',
    path: 'f16',
    // The nozzle is a file of its own, placed by `F-16.xml`; the afterburner
    // flame and the drag chute are effects, drawn here by the sandbox itself.
    parts: [{ model: 'Models/f16.ac' }, { model: 'Models/nozzle-GE.ac', offset: { x: -3.08, y: -1.485, z: 1.255 } }],
    discard: /flame|chute/i,
    types: ['F16', 'F16X'],
    lengthM: 15.06,
    credit: 'F-16 — FlightGear FGAddon, GPL-2.0',
    liveries: false,
  },
  {
    id: 'a10',
    path: 'A-10',
    model: 'Models/A10-004-015l3.ac',
    types: ['A10'],
    lengthM: 16.26,
    credit: 'A-10 — FlightGear FGAddon, GPL-2.0',
    liveries: false,
  },
  {
    id: 'f4u',
    path: 'F4U',
    parts: [{ model: 'Models/f4u.ac' }, { model: 'Models/lwing.ac' }, { model: 'Models/rwing.ac' }],
    types: ['F4U', 'CORS'],
    lengthM: 10.2,
    credit: 'F4U Corsair — FlightGear FGAddon, GPL-2.0',
    liveries: false,
  },
  {
    id: 'ah64',
    path: 'apache',
    parts: [
      { model: 'Models/apachemodel/apache.ac' },
      { model: 'Models/mainrotor/mainrotor.ac' },
      { model: 'Models/tailrotor/tailrotor.ac' },
    ],
    rotorcraft: true,
    roles: { mainRotor: /mainrotor/i, tailRotor: /tailrot/i },
    types: ['H64'],
    lengthM: 17.7,
    credit: 'AH-64 Apache — FlightGear FGAddon, GPL-2.0',
    liveries: false,
  },
  { id: 'f15', path: 'F-15', model: 'Models/f15c.ac', types: ['F15'], lengthM: 19.43, credit: 'F-15 — FlightGear FGAddon, GPL-2.0', liveries: false },
  { id: 'f14', path: 'f-14b', model: 'Models/f-14b.ac', types: ['F14'], lengthM: 19.1, credit: 'F-14B — FlightGear FGAddon, GPL-2.0', liveries: false },
  { id: 'f18', path: 'f18', model: 'Models/f18.ac', types: ['F18', 'F18H', 'F18S'], lengthM: 17.07, credit: 'F/A-18 — FlightGear FGAddon, GPL-2.0', liveries: false },
  { id: 'm2k', path: 'Mirage-2000', model: 'Models/m2000-5.ac', types: ['MIR2'], lengthM: 14.36, credit: 'Mirage 2000-5 — FlightGear FGAddon, GPL-2.0', liveries: false },
  { id: 'jas39', path: 'JAS39-Gripen', model: 'Models/gripen.ac', types: ['GRIF'], lengthM: 14.1, minSpan: 0.5, credit: 'JAS 39 Gripen — FlightGear FGAddon, GPL-2.0', liveries: false },
  { id: 'mig29', path: 'Mig-29', model: 'Models/Mig-29.ac', types: ['MG29'], lengthM: 17.32, credit: 'MiG-29 — FlightGear FGAddon, GPL-2.0', liveries: false },
  { id: 'su25', path: 'Su-25', model: 'Models/Su-25.ac', types: ['SU25'], lengthM: 15.33, credit: 'Su-25 — FlightGear FGAddon, GPL-2.0', liveries: false },
  { id: 'mig21', path: 'MiG-21bis', model: 'Models/MiG-21bis.ac', types: ['MG21'], lengthM: 15.76, minSpan: 0.4, credit: 'MiG-21bis — FlightGear FGAddon, GPL-2.0', liveries: false },
  { id: 'p51', path: 'p51d', model: 'Models/P-51D-25NA.ac', types: ['P51'], lengthM: 9.83, credit: 'P-51D Mustang — FlightGear FGAddon, GPL-2.0', liveries: false },
];

async function main() {
  const wanted = process.argv.slice(2);
  const list = wanted.length ? COMBAT.filter((a) => wanted.includes(a.id)) : COMBAT;

  const indexPath = join(OUT, 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const rows = [];
  const skipped = [];
  for (const entry of list) {
    try {
      const { notices, liveries } = await convert(entry);
      index.types[entry.id] = entry.id;
      for (const type of entry.types) index.types[type] = entry.id;
      if (Object.keys(liveries).length > 0) index.liveries[entry.id] = liveries;
      rows.push({ ...entry, notices });
    } catch (error) {
      console.log(`  ${entry.id}: SKIPPED — ${error instanceof Error ? error.message : String(error)}`);
      skipped.push(entry.id);
    }
  }
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  // Append (or refresh) a row per converted aircraft in the attribution table.
  const creditsPath = join(OUT, 'CREDITS.md');
  let credits = await readFile(creditsPath, 'utf8');
  for (const row of rows) {
    const url = `https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/${row.path}/`;
    const line = `| \`${row.id}\` | ${row.types.join(', ')} | [Aircraft/${row.path}](${url}) | GPL-2.0 | ${
      row.notices.length ? row.notices.map((n) => `\`${n}\``).join(', ') : '**none upstream**'
    } |`;
    const existing = new RegExp(`^\\| \`${row.id}\` \\|.*$`, 'm');
    if (existing.test(credits)) credits = credits.replace(existing, line);
    else credits = credits.replace(/\n\nTo regenerate:/, `\n${line}\n\nTo regenerate:`);
  }
  await writeFile(creditsPath, credits);
  console.log(`merged ${rows.length} model(s) into public/models`);
  if (skipped.length) console.log(`skipped: ${skipped.join(', ')}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
