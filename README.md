# PlanesView

Live air traffic on a photoreal globe, and a first-person view from inside any
aircraft in the sky.

Free data only — no API key, no account, no card.

```bash
npm install
npm run dev      # http://localhost:5173
```

---

## The one thing the brief got wrong

The project brief specifies **"Aucun backend"** — everything in the browser.
That is achievable for most of this app, but **not for the aircraft positions**,
and no amount of client-side code changes it. Measured against the live
services:

| Service | `Access-Control-Allow-Origin` | Callable from a page? |
|---|---|---|
| adsb.lol | *absent* | ❌ |
| adsb.fi | *absent* | ❌ |
| OpenSky | `https://opensky-network.org` only | ❌ |
| airplanes.live | 403 — written approval required | ❌ |
| Planespotters | `*`, but demands a custom `User-Agent`, which browsers forbid scripts from setting | ❌ |
| adsbdb | `*` | ✅ |
| Open-Meteo | `*` | ✅ |
| Esri / EOX / AWS Terrarium | `*` | ✅ |

So imagery, terrain, airframe metadata and weather are genuinely backend-free.
Traffic and photos need a relay, which keeps every constraint that actually
mattered — free, no key, no account, no card:

- **Development** — Vite's dev server proxies `/feeds/*`. No extra process.
- **Production** — `functions/feeds/[[path]].ts`, a Cloudflare Pages Function
  on the free tier. Deploy it beside the static build.

The relay is an **allowlist**, not an open proxy: the target is matched against
a fixed map of origins in `relay-targets.json`, so an arbitrary URL can never
be reached through it. Set `VITE_DIRECT_FEEDS=1` to bypass it entirely (useful
in an extension or Electron shell).

Two smaller corrections to the brief, both verified against live payloads:

- In the readsb schema, **`r` is the registration and `t` the type code** — not
  receiver distance and timestamp. Mapping them correctly means most aircraft
  show their identity with no extra lookup.
- **adsb.fi's URL is `/api/v2/lat/{lat}/lon/{lon}/dist/{d}/`**, not `/point/`.

---

## How it works

```
data/     provider fallback chain, normalisation, metadata, weather
state/    Kalman filters turning ~1 Hz fixes into 60 fps motion
tiles/    quadtree sources, priority loader, IndexedDB LRU cache
workers/  Terrarium decode + terrain geometry, off the main thread
render/   engine, quadtree globe, terrain shader, camera, aircraft models
map2d/    MapLibre selection map
ui/       Svelte HUD and panels (DOM overlay, never drawn in 3D)
```

### Motion

ADS-B arrives about once a second, quantised and sometimes late. Drawing it
directly gives a 1 Hz stutter; interpolating between the last two fixes is
smooth but always a second behind. Instead each aircraft runs a
constant-velocity Kalman filter, so the renderer can extrapolate to the exact
frame time. Because `gs` and `track` *are* a velocity measurement, the filter
is well conditioned and converges in a couple of updates.

It factorises into two independent per-axis filters rather than one 4-state
filter — for a CV model the covariance is block-diagonal, so this is exactly
the same filter with 4 terms to propagate instead of 16.

### Never looking like it is loading

1. A tile is **never blank**: until its own imagery arrives it samples the
   nearest loaded ancestor's texture through a UV transform.
2. Detail **sharpens rather than snaps** — the shader cross-fades from
   inherited to own imagery.
3. A parent is replaced **only once all four children are built**, and stays
   drawn underneath while they fade in.
4. Visible tiles are never evicted; eviction is **farthest-first**, so terrain
   only ever dissolves far away.
5. The tile cache is **warmed ahead along the flight path**.

### Attitude is real, not faked

ADS-B v2 transponders broadcast `roll`, `track_rate`, `ias`, `tas`, `mach` and
wind and temperature measured by the aircraft itself. The cockpit horizon tilts
with the actual bank angle, and the HUD shows the aircraft's own wind rather
than a surface forecast.

---

## Controls

| Key | Action |
|---|---|
| click | select an aircraft |
| `↵` | step inside the selected aircraft |
| `Esc` | back to the map |
| `1`–`5` | Cockpit / Chase / Wing / Orbit / Tower |
| drag | look around |
| `C` | recentre the view |
| `D` | diagnostics (fps, render ms, tiles, queue) |

---

## Testing

```bash
npm test          # 62 tests: geodesy, Mercator, Kalman, solar position,
                  # feed-clock units, tile templates, Terrarium decoding
npm run check     # svelte-check + TypeScript strict
npm run build     # production build
```

The tests concentrate on the maths that is expensive to debug visually — WGS84
round-trips to sub-millimetre, the ellipsoid normal's 0.19° deviation from the
radial, filter convergence, and the two unit traps that cost the most time:
Esri's `{z}/{y}/{x}` axis order, and feed clocks that are milliseconds on
adsb.lol but seconds on adsb.fi.

---

## Aircraft models

Two sources, and the app moves between them without the user noticing.

**Procedural.** `src/render/aircraft` generates an airframe from the ICAO type
code: wing sweep and span, engine count and mounting, propeller blade count,
winglet style, undercarriage layout. It covers every designator the type table
knows and is what makes a Dash 8 look like a Dash 8 rather than like a generic
twin. Original work, under this project's licence.

**Converted.** For the types that have one, `tools/fgmodel/convert.mjs` pulls a
real textured airframe from the [FlightGear](https://www.flightgear.org/)
add-on hangar and converts it to a compact binary the app loads on demand. The
procedural model is shown immediately and the real one replaces it when it
arrives, so nothing ever waits on a download.

Run `node tools/fgmodel/convert.mjs` to regenerate `public/models`.

### Licence of the converted models

**They are GPL-2.0 and this project is MIT — those are different licences, on
purpose, and it matters.**

The FlightGear aircraft are licensed GPL-2.0 by their original authors. A
converted model is a derivative work of one, so it stays GPL-2.0; the upstream
licence and author files are reproduced under `public/models/credits/` and the
model catalogue is `public/models/CREDITS.md`. Nothing in `src/` derives from
them — the app loads them at runtime as data, the way it loads a map tile — so
the application code remains MIT.

That reading is the ordinary one for a program that ships separately-licensed
assets, but it *is* a reading. If you would rather not rely on it, delete
`public/models`: the app works exactly as before with the procedural models,
which is what it does today for every type the library does not cover.

## Attribution

Required and always on screen: Esri World Imagery; Sentinel-2 cloudless by EOX;
Mapzen Terrain Tiles on AWS Open Data; adsb.lol, adsb.fi and OpenSky Network;
adsbdb; Planespotters (photographer credit and link); Open-Meteo.

3D aircraft models from FlightGear FGAddon, GPL-2.0 — see
`public/models/CREDITS.md` for the per-aircraft authors and licences.
