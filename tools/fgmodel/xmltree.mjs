/**
 * A FlightGear model-XML tree, resolved into the `.ac` files it places.
 *
 * A FlightGear aircraft is rarely one file. Its cockpit, in particular, is a
 * tree of `PropertyList` XML files: each names an `.ac` (its own geometry) and
 * any number of `<model>` children — another XML or `.ac` — each with
 * `<offsets>` placing it in its parent. This walks that tree and returns every
 * `.ac` with the transform that puts it in the aircraft's body frame.
 *
 * ## Frames
 *
 * Offsets are in the body frame: x aft, y right, z up, metres and degrees. An
 * `.ac` file is y up, z toward the viewer, so body (x, y, z) is AC (x, z, −y).
 * Transforms are returned in AC axes, ready to be set as an AC3D node's
 * `rot`/`loc` (row-major 3×3 and a translation).
 *
 * Rotations follow SimGear's `SGReaderWriterXML`: pitch about y, then roll
 * about x, then heading about z, then the translation — an OSG
 * `makeRotate(pitch, Y, roll, X, heading, Z)` times a translate.
 *
 * ## What is not followed
 *
 * Animations are not evaluated: every object is drawn in its rest pose.
 * `<condition>`s are not evaluated either; a caller that knows which variant
 * of a cockpit it wants skips the others by path (`skip`).
 */

import { dirname, posix } from 'node:path';

const DEG = Math.PI / 180;

/** 3×3 row-major multiply. */
function mul(a, b) {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
}

function apply(m, v) {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

const rx = (a) => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const ry = (a) => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const rz = (a) => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

/** Body axes to AC axes, and back. */
const C = [1, 0, 0, 0, 0, 1, 0, -1, 0];
const Ci = [1, 0, 0, 0, 0, -1, 0, 1, 0];

/** An `<offsets>` block as a transform in AC axes. */
function offsetsToAc(o) {
  if (!o) return { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], l: [0, 0, 0] };
  // Column-vector form of pitch first, then roll, then heading.
  const body = mul(rz(o.h * DEG), mul(rx(o.r * DEG), ry(o.p * DEG)));
  return { r: mul(C, mul(body, Ci)), l: apply(C, [o.x, o.y, o.z]) };
}

/** parent ∘ child. */
function compose(p, c) {
  const l = apply(p.r, c.l);
  return { r: mul(p.r, c.r), l: [l[0] + p.l[0], l[1] + p.l[1], l[2] + p.l[2]] };
}

const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*</${name}>`).exec(xml);
  return m ? m[1] : null;
};

/**
 * The value an `alias="../../params/a/b"` points at: a property of the file
 * itself, found by walking its elements by name from the root.
 */
function aliased(xml, alias) {
  let scope = xml;
  for (const name of alias.replace(/^(\.\.\/)+/, '').split('/')) {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(scope);
    if (!m) return null;
    scope = m[1];
  }
  return scope.trim();
}

function readOffsets(block, file = block) {
  const m = /<offsets(?:\s[^>]*)?>([\s\S]*?)<\/offsets>/.exec(block);
  if (!m) return null;
  const n = (k) => {
    const alias = new RegExp(`<${k}\\s[^>]*alias="([^"]+)"`).exec(m[1])?.[1];
    return Number(alias ? aliased(file, alias) : tag(m[1], k) ?? 0) || 0;
  };
  return { x: n('x-m'), y: n('y-m'), z: n('z-m'), h: n('heading-deg'), p: n('pitch-deg'), r: n('roll-deg') };
}

/** The direct children of `<PropertyList>` named `path` or `offsets`, as text. */
function topLevel(xml) {
  const body = xml.replace(/<\?[\s\S]*?\?>/g, '');
  const re = /<(\/?)([\w:-]+)[^>]*?(\/?)>/g;
  let depth = 0;
  let start = -1;
  let name = '';
  let out = '';
  for (let m; (m = re.exec(body)); ) {
    if (m[3]) continue; // <empty/>
    if (!m[1]) {
      depth++;
      if (depth === 2) {
        start = m.index;
        name = m[2];
      }
    } else {
      if (depth === 2 && start >= 0 && (name === 'path' || name === 'offsets')) out += body.slice(start, m.index + m[0].length);
      depth--;
    }
  }
  return out;
}

/** The top-level `<model>` blocks, with comments removed and nesting respected. */
function modelBlocks(xml) {
  const blocks = [];
  const re = /<(\/?)model(?:\s[^>]*)?>/g;
  let depth = 0;
  let start = -1;
  for (let m; (m = re.exec(xml)); ) {
    if (!m[1]) {
      if (depth === 0) start = m.index;
      depth++;
    } else if (--depth === 0 && start >= 0) {
      blocks.push(xml.slice(start, m.index + m[0].length));
      start = -1;
    }
  }
  return blocks;
}

/**
 * @param {string} rootPath  path of the root XML under `Aircraft/`, e.g. `f16/Models/Cockpit/Main/cockpit.xml`
 * @param {(path: string) => Promise<string>} read  fetches a file under `Aircraft/`
 * @param {{ skip?: RegExp, within?: RegExp }} options  `within`: flags as `inside` what is placed by an XML whose path matches, e.g. the flight deck of a whole aircraft
 * @returns {Promise<{ ac: string, transform: { r: number[], l: number[] }, via: string, inside: boolean }[] & { rootFrame: { r: number[], l: number[] } }>}
 *   `rootFrame` is the root file's own offsets: the aircraft frame from the root `.ac`'s.
 */
export async function resolveModelTree(rootPath, read, { skip, within } = {}) {
  const out = [];
  out.rootFrame = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], l: [0, 0, 0] };

  /*
   * Where a path in a file points. Beside the file first; then, as the
   * simulator also looks, from the aircraft's own folder — many authors
   * write `Models/Instruments/...` from there.
   */
  async function locate(here, p) {
    const candidates = [resolve(here, p)];
    if (!/^\/?Aircraft\//.test(p)) candidates.push(posix.normalize(posix.join(here.split('/')[0], p.replace(/\\/g, '/'))));
    for (const c of candidates) {
      try {
        await read(c);
        return c;
      } catch {
        // Try the next place.
      }
    }
    return candidates[0];
  }

  async function walk(path, parent, via, inside = !within) {
    if (skip?.test(path)) return;
    if (path.endsWith('.ac')) {
      // A model placed straight from its `.ac` can be named by `within` too.
      out.push({ ac: path, transform: parent, via, inside: inside || Boolean(within?.test(path)) });
      return;
    }
    inside ||= within.test(path);
    let xml;
    try {
      xml = (await read(path)).replace(/<!--[\s\S]*?-->/g, '');
    } catch {
      return;
    }
    const here = dirname(path);
    const blocks = modelBlocks(xml);
    // The file's own geometry and offsets: its top-level elements only — a
    // `<text>` or an animation carries `<offsets>` and `<path>` of its own.
    let own = topLevel(xml);
    // `<PropertyList include="...">`: the included file's children, under
    // this file's own path and offsets where it gives them.
    const include = /<PropertyList[^>]*\sinclude="([^"]+)"/.exec(xml)?.[1];
    if (include) {
      try {
        const base = (await read(await locate(here, include))).replace(/<!--[\s\S]*?-->/g, '');
        blocks.unshift(...modelBlocks(base));
        const inherited = topLevel(base);
        for (const name of ['path', 'offsets']) {
          const m = new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>`).exec(inherited);
          if (m && !new RegExp(`<${name}[\\s>]`).test(own)) own += m[0];
        }
      } catch {
        // A missing include is a file with fewer children.
      }
    }
    const frame = compose(parent, offsetsToAc(readOffsets(own)));
    if (!via) out.rootFrame = frame;
    const acPath = tag(own, 'path');
    // A file whose own geometry is another model file wraps it.
    if (acPath?.endsWith('.xml')) await walk(await locate(here, acPath), frame, path, inside);
    else if (acPath) out.push({ ac: await locate(here, acPath), transform: frame, via: path, inside });

    for (const b of blocks) {
      const p = tag(b, 'path');
      if (!p) continue;
      await walk(await locate(here, p), compose(frame, offsetsToAc(readOffsets(b, xml))), path, inside);
    }
  }

  await walk(rootPath, { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], l: [0, 0, 0] }, '');
  return out;
}

/** A path in an XML: `Aircraft/...` is absolute, anything else is beside the file. */
function resolve(here, p) {
  p = p.replace(/\\/g, '/').replace(/^\/+/, '');
  if (p.startsWith('Aircraft/')) return p.slice('Aircraft/'.length);
  return posix.normalize(posix.join(here, p));
}
