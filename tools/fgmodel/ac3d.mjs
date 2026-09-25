/**
 * AC3D (.ac) parser.
 *
 * FlightGear's aircraft are distributed as AC3D files, which is why this
 * exists: it is the only format the hangar ships, nothing in the Node
 * ecosystem reads it without pulling in a native Assimp build, and the format
 * itself is a few hundred lines of plain text grammar. Writing it is less risk
 * than depending on a wasm blob to read it.
 *
 * Build-time only. Nothing here ships to the browser — the converter turns the
 * result into the compact binary in `pvm.mjs`.
 *
 * ## The format, in brief
 *
 *   AC3Db
 *   MATERIAL "name" rgb r g b  amb ...  emis ...  spec ...  shi n  trans t
 *   OBJECT world | group | poly
 *     name "..."
 *     texture "file.png"
 *     texrep u v
 *     rot r11 .. r33          (row-major 3x3, applies to this object and kids)
 *     loc x y z
 *     numvert N   -> N lines of "x y z"
 *     numsurf M   -> M surfaces, each:
 *       SURF 0xNN             (low nibble = type, bit 4 = smooth, bit 5 = 2-sided)
 *       mat i
 *       refs K  -> K lines of "vertexIndex u v"
 *     kids N      -> N nested OBJECTs
 *
 * `data N` is the one line that does not follow the pattern: it is a count of
 * *bytes*, and the payload is the following line.
 */

/** @typedef {{ name: string, rgb: [number,number,number], emis: [number,number,number], trans: number }} Material */

/**
 * @typedef {object} Surface
 * @property {number} flags
 * @property {number} material
 * @property {Array<{ v: number, u: number, t: number }>} refs
 */

/**
 * @typedef {object} AcObject
 * @property {string} type
 * @property {string} name
 * @property {string | null} texture
 * @property {[number, number]} texrep
 * @property {number[][]} verts
 * @property {Surface[]} surfaces
 * @property {AcObject[]} kids
 * @property {number[] | null} rot
 * @property {[number, number, number]} loc
 */


/** Split a line into tokens, keeping quoted strings whole. */
function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

export function parseAc3d(text) {
  const lines = text.split(/\r?\n/);
  let i = 0;

  if (!lines[0]?.startsWith('AC3D')) throw new Error('not an AC3D file');
  i = 1;

  /** @type {Material[]} */
  const materials = [];

  const readObject = () => {
    /** @type {AcObject} */
    const object = {
      type: 'poly',
      name: '',
      texture: null,
      texrep: [1, 1],
      verts: [],
      surfaces: [],
      kids: [],
      rot: null,
      loc: [0, 0, 0],
    };

    // The OBJECT line itself has already been consumed by the caller except
    // for its type, which it passes back in.
    for (; i < lines.length; ) {
      const raw = lines[i];
      if (raw === undefined) break;
      const t = tokenize(raw);
      const head = t[0];

      if (head === undefined || head === '') {
        i++;
        continue;
      }

      switch (head) {
        case 'name':
          object.name = t[1] ?? '';
          i++;
          break;
        case 'texture':
          object.texture = t[1] ?? null;
          i++;
          break;
        case 'texrep':
          object.texrep = [Number(t[1]), Number(t[2])];
          i++;
          break;
        case 'rot':
          object.rot = t.slice(1, 10).map(Number);
          i++;
          break;
        case 'loc':
          object.loc = [Number(t[1]), Number(t[2]), Number(t[3])];
          i++;
          break;
        case 'data': {
          // A byte count, then the payload on its own line. The only field
          // that does not describe itself on one line.
          i += 2;
          break;
        }
        case 'numvert': {
          const n = Number(t[1]);
          i++;
          for (let v = 0; v < n; v++) {
            const parts = tokenize(lines[i + v] ?? '');
            object.verts.push([Number(parts[0]), Number(parts[1]), Number(parts[2])]);
          }
          i += n;
          break;
        }
        case 'numsurf': {
          const n = Number(t[1]);
          i++;
          for (let s = 0; s < n; s++) object.surfaces.push(readSurface());
          break;
        }
        case 'kids': {
          const n = Number(t[1]);
          i++;
          for (let k = 0; k < n; k++) {
            // Each child starts with its own OBJECT line.
            const childHead = tokenize(lines[i] ?? '');
            if (childHead[0] !== 'OBJECT') break;
            const type = childHead[1] ?? 'poly';
            i++;
            const child = readObject();
            child.type = type;
            object.kids.push(child);
          }
          // `kids` closes the object: everything after it belongs to the parent.
          return object;
        }
        default:
          // OBJECT at this level means the previous object had no `kids` line.
          if (head === 'OBJECT') return object;
          i++;
          break;
      }
    }
    return object;
  };

  const readSurface = () => {
    /** @type {Surface} */
    const surface = { flags: 0, material: 0, refs: [] };

    for (; i < lines.length; ) {
      const t = tokenize(lines[i] ?? '');
      const head = t[0];
      if (head === 'SURF') {
        surface.flags = Number(t[1]);
        i++;
      } else if (head === 'mat') {
        surface.material = Number(t[1]);
        i++;
      } else if (head === 'refs') {
        const n = Number(t[1]);
        i++;
        for (let r = 0; r < n; r++) {
          const parts = tokenize(lines[i + r] ?? '');
          surface.refs.push({
            v: Number(parts[0]),
            u: Number(parts[1]),
            t: Number(parts[2]),
          });
        }
        i += n;
        return surface;
      } else {
        i++;
        if (head === undefined) return surface;
      }
    }
    return surface;
  };

  /** @type {AcObject | null} */
  let root = null;

  for (; i < lines.length; ) {
    const t = tokenize(lines[i] ?? '');
    const head = t[0];

    if (head === 'MATERIAL') {
      const at = (key, count) => {
        const k = t.indexOf(key);
        return k < 0 ? null : t.slice(k + 1, k + 1 + count).map(Number);
      };
      materials.push({
        name: t[1] ?? '',
        rgb: at('rgb', 3) ?? [1, 1, 1],
        emis: at('emis', 3) ?? [0, 0, 0],
        trans: at('trans', 1)?.[0] ?? 0,
      });
      i++;
    } else if (head === 'OBJECT') {
      const type = t[1] ?? 'poly';
      i++;
      root = readObject();
      root.type = type;
      break;
    } else {
      i++;
    }
  }

  if (!root) throw new Error('no root OBJECT');
  return { materials, root };
}

/** Walk the tree, yielding every object with its accumulated world transform. */
export function* flatten(object, parent = null) {
  const transform = compose(parent, object);
  yield { object, transform };
  for (const kid of object.kids) yield* flatten(kid, transform);
}

/** Compose a parent transform with a child's own rot/loc. */
function compose(parent, object) {
  const r = object.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const l = object.loc;
  if (!parent) return { r, l };

  // parent.r * r, then parent.r * l + parent.l
  const pr = parent.r;
  const out = new Array(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        pr[row * 3] * r[col] + pr[row * 3 + 1] * r[3 + col] + pr[row * 3 + 2] * r[6 + col];
    }
  }
  const lo = [0, 0, 0];
  for (let row = 0; row < 3; row++) {
    lo[row] = pr[row * 3] * l[0] + pr[row * 3 + 1] * l[1] + pr[row * 3 + 2] * l[2] + parent.l[row];
  }
  return { r: out, l: lo };
}

/** Apply a composed transform to a vertex. */
export function applyTransform(transform, v) {
  const { r, l } = transform;
  return [
    r[0] * v[0] + r[1] * v[1] + r[2] * v[2] + l[0],
    r[3] * v[0] + r[4] * v[1] + r[5] * v[2] + l[1],
    r[6] * v[0] + r[7] * v[1] + r[8] * v[2] + l[2],
  ];
}

