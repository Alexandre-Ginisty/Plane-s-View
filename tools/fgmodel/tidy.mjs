/**
 * Tidy the converted models in place — run after `convert.mjs` or `cockpit.mjs`:
 *
 *   node tools/fgmodel/tidy.mjs
 *
 *  1. **Stray SGI textures** (`.rgb`) re-encoded to WebP. Neither the image
 *     encoder nor any browser reads SGI, so one passed through untouched was
 *     a part drawn untextured.
 *  2. **Identical textures** kept once. Each model names its textures after
 *     itself, so a sheet two aircraft share (an A-10 panel in the Apache's
 *     cockpit, a cockpit's own sheet in its exterior) was shipped — and
 *     downloaded, and uploaded to the GPU — once per model. References in the
 *     models and in `index.json` are pointed at one copy.
 *  3. **Models packed** to the compact encoding (`pvmpack.mjs`).
 *  4. **Undercarriage** re-read: airframe parts the converter's `GEAR`
 *     pattern now names as gear are marked so (they retract in flight), and
 *     the types whose gear never retracts are flagged `fixedGear`.
 *
 * Idempotent: a second run finds nothing to do.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GEAR, shrink } from './convert.mjs';
import { editHeader, packPvm, renameTextures, texturesOf } from './pvmpack.mjs';

/** Airframes whose undercarriage is fixed: drawn down at every height. */
const FIXED_GEAR = new Set(['c172', 'c208', 'da40']);
const INTERIOR = /-(cockpit|cabin|cargo)\.pvm$/;

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.PVM_OUT ?? join(HERE, '..', '..', 'public', 'models');

const files = () => readdirSync(OUT).filter((f) => statSync(join(OUT, f)).isFile());
const models = () => files().filter((f) => f.endsWith('.pvm'));
const size = (f) => statSync(join(OUT, f)).size;
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

const indexPath = join(OUT, 'index.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8'));

/** Point every reference to a texture through `rename` (old name → new, or undefined). */
function renameEverywhere(rename) {
  for (const m of models()) {
    const blob = readFileSync(join(OUT, m));
    if (texturesOf(blob).some((t) => rename(t))) writeFileSync(join(OUT, m), renameTextures(blob, rename));
  }
  for (const liveries of Object.values(index.liveries ?? {})) {
    for (const [op, name] of Object.entries(liveries)) liveries[op] = rename(name) ?? name;
  }
}

const before = files().reduce((s, f) => s + size(f), 0);

// 1. SGI → WebP.
const sgi = new Map();
for (const f of files().filter((f) => /\.rgba?$/i.test(f))) {
  const encoded = await shrink(readFileSync(join(OUT, f)), f);
  if (!encoded.name.endsWith('.webp')) {
    console.log(`  ${f}: could not be re-encoded, kept`);
    continue;
  }
  writeFileSync(join(OUT, encoded.name), encoded.data);
  sgi.set(f, encoded.name);
}
if (sgi.size) {
  renameEverywhere((t) => sgi.get(t));
  for (const f of sgi.keys()) unlinkSync(join(OUT, f));
  console.log(`re-encoded ${sgi.size} SGI texture(s)`);
}

// 2. One copy of each identical texture: the shortest name, so a shared sheet
// keeps the exterior's name rather than a cockpit's.
const byHash = new Map();
for (const f of files().filter((f) => /\.(webp|png|jpe?g)$/i.test(f))) {
  const h = createHash('sha1').update(readFileSync(join(OUT, f))).digest('hex');
  (byHash.get(h) ?? byHash.set(h, []).get(h)).push(f);
}
const canonical = new Map();
for (const group of byHash.values()) {
  if (group.length < 2) continue;
  group.sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const f of group.slice(1)) canonical.set(f, group[0]);
}
if (canonical.size) {
  renameEverywhere((t) => canonical.get(t));
  for (const f of canonical.keys()) unlinkSync(join(OUT, f));
  console.log(`merged ${canonical.size} duplicate texture(s)`);
}
writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

// 3. Pack.
for (const m of models()) {
  const blob = readFileSync(join(OUT, m));
  const packed = packPvm(blob);
  if (packed !== blob) writeFileSync(join(OUT, m), packed);
}

// 4. Undercarriage.
let regeared = 0;
for (const m of models().filter((f) => !INTERIOR.test(f))) {
  const id = m.replace(/\.pvm$/, '');
  const blob = readFileSync(join(OUT, m));
  const edited = editHeader(blob, (header) => {
    let changed = false;
    for (const part of header.parts) {
      if (part.role === 'hull' && GEAR.test(part.name)) {
        part.role = 'gear';
        regeared++;
        changed = true;
      }
    }
    const fixed = FIXED_GEAR.has(id);
    if (Boolean(header.fixedGear) !== fixed) {
      header.fixedGear = fixed;
      changed = true;
    }
    return changed;
  });
  if (edited !== blob) writeFileSync(join(OUT, m), edited);
}
if (regeared) console.log(`marked ${regeared} part(s) as undercarriage`);

// Nothing may point at a file that is not there.
const present = new Set(files());
for (const m of models()) {
  for (const t of texturesOf(readFileSync(join(OUT, m)))) if (!present.has(t)) throw new Error(`${m} references missing ${t}`);
}
for (const liveries of Object.values(index.liveries ?? {})) {
  for (const t of Object.values(liveries)) if (!present.has(t)) throw new Error(`index.json references missing ${t}`);
}

const after = files().reduce((s, f) => s + size(f), 0);
console.log(`public/models: ${mb(before)} → ${mb(after)}`);
