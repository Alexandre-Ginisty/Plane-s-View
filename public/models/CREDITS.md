# 3D aircraft models

The textured airframes in this directory are converted from the
[FlightGear](https://www.flightgear.org/) add-on hangar (FGAddon) by
`tools/fgmodel/convert.mjs`. They are **not** original to this project.

Each is licensed **GPL-2.0** by its original authors. The converted form is a
derivative work and carries the same licence; the upstream licence and author
files are reproduced under `credits/<id>/`, and the full GPL text is in
`LICENSE-GPL-2.0.txt`.

Aircraft types with no model here are drawn by the procedural generator in
`src/render/aircraft`, which is original work under the project licence.

| Model | Types | Upstream | Licence | Notices |
| --- | --- | --- | --- | --- |
| `dh8d` | DH8D, DH8C, DH8B, DH8A | [Aircraft/DHC-8](https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/DHC-8/) | GPL-2.0 | `credits/dh8d/COPYING`, `credits/dh8d/README.md` |
| `b788` | B788, B789, B78X | [Aircraft/787-8](https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/787-8/) | GPL-2.0 | `credits/b788/COPYING`, `credits/b788/README` |
| `a388` | A388 | [Aircraft/A380](https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/A380/) | GPL-2.0 | `credits/a388/AUTHORS` |
| `b77w` | B77W, B77L, B773, B772, B77F | [Aircraft/777](https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/777/) | GPL-2.0 | `credits/b77w/LICENSE`, `credits/b77w/AUTHORS` |

To regenerate: `node tools/fgmodel/convert.mjs`.
