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
| `1`–`4` | Cockpit / Chase / Wing / Orbit |
| drag | look around |
| `C` | recentre the view |
| `D` | diagnostics (fps, render ms, tiles, queue) |
| `H` | key and controls |

Append `?go` to the URL to skip the landing page and open straight into the
map — useful for a bookmark, and for anything sharing a specific view.

---

## Testing

```bash
npm test          # 369 tests
npm run check     # svelte-check + TypeScript strict
npm run build     # production build
npx knip          # unused files, exports and dependencies
```

The tests concentrate on two things that are expensive to debug any other way.

**Maths that is wrong plausibly rather than obviously** — WGS84 round-trips to
sub-millimetre, the ellipsoid normal's 0.19° deviation from the radial, filter
convergence, compass bearings against an east/north swap, and the two unit
traps that cost the most time: Esri's `{z}/{y}/{x}` axis order, and feed clocks
that are milliseconds on adsb.lol but seconds on adsb.fi.

**Behaviour that only misbehaves on someone else's connection** — the network
classifier's hysteresis, the rule that a grade change must persist before the
user is told about it, and the frame-by-frame continuity of a drawn aircraft
across a position update. Each of those was a real complaint first, and each
test fails against the code that caused it.

The relay is covered too (`functions/feeds/relay.test.ts`): it is the only code
in this project a stranger can reach, so its allowlist is proved rather than
asserted — path traversal, host smuggling, link-local addresses, and error
messages that describe the infrastructure.

---

## Aircraft models

Two sources, and the app moves between them without the user noticing.

**Procedural.** `src/render/aircraft` generates an airframe from the ICAO type
code: wing sweep and span, engine count and mounting, propeller blade count,
winglet style, undercarriage layout. It covers every designator the type table
knows and is what makes a Dash 8 look like a Dash 8 rather than like a generic
twin. Original work, under this project's licence.

**Converted.** `tools/fgmodel/convert.mjs` pulls real textured airframes from
the [FlightGear](https://www.flightgear.org/) add-on hangar and converts them
to a compact binary the app loads on demand — **27 airframes covering 127 type
designators**. The procedural model is shown immediately and the real one
replaces it when it arrives, so nothing ever waits on a download.

Two things make the substitution honest rather than merely plausible:

- **Operator liveries.** The 777's paint schemes are filed upstream under ICAO
  airline designators, which is exactly what the first three letters of an
  ADS-B callsign are — so an Air France 777 is drawn in Air France colours.
  When the operator has no livery the *neutral* white scheme is used, never
  another airline's: a white aircraft is honest about not knowing, and a Qatar
  777 painted as Emirates is not.
- **Fallback by kind, never by type.** A designator with no model gets the
  nearest converted airframe of the same kind — an unknown narrowbody gets a
  737, an unknown helicopter gets an EC135 — and never one of a different
  kind. A real model of the wrong variant reads as far more true than an
  accurate drawing of a generic one.

### Other aircraft in the 3D view

Almost none are drawn, and that is the feature. Traffic used to be rendered to
120 km with anything under eleven screen pixels inflated so it stayed visible —
the right rule for a chart and the wrong one for a window. The inflated marks
were a crude twenty-triangle silhouette held at a size the aircraft does not
have, scattered across a photographic sky.

Aircraft are now drawn at **true scale**, never inflated, and only within 12 km
— the range at which a 60 m airliner still subtends more than about a pixel.
Past that they are absent, which is also what you see out of a real aeroplane.
The few that remain are real converted airframes, one standing in for every
fixed-wing type and one for every rotorcraft, instanced per part so the fleet
costs a draw call per part rather than per aircraft.

### Validation

The converter validates what it produces, because a bad model is wrong in a way
nothing else notices — it loads, it lights, it renders, and the aeroplane is
simply missing a piece. An aircraft is reported and skipped, never shipped, if:

- it measures the wrong length (axes or units are wrong);
- its span is under 60% of its length — the signature of wings kept in a
  separate `.ac` file that FlightGear assembles from XML offsets and this
  converter does not. The 737-800 is one, and converted alone it is a tube;
- it is a helicopter with no main rotor, for the same reason. The R44 and the
  UH-1 are;
- a part classified as undercarriage sits in the upper half of the airframe,
  which means a lifting surface has been mislabelled and would be retracted
  above circuit height.

It also drops what should never have been drawn: cabin interiors (an airliner's
bulkheads and floor are modelled because the simulator flies from inside, and
one of the 737's panels poked through the fuselage as a flat white plate), and
zero-thickness helper sheets — shadow planes and fog cards that a simulator
projects onto the ground and this renders as a plate across the wing. Both are
judged per object before parts are merged, because a helper welded to real
geometry no longer measures flat.

The same properties are asserted against the *committed* models in
`src/render/aircraft/models.test.ts`, because the converter only validates when
someone runs it, and the repository is what visitors are served.

Textures are downscaled to 2048 px and re-encoded as WebP, which took the model
set from 88 MB to 33 MB with no visible difference at the size these are drawn.

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

## Security

Worth being exact about what is and is not achievable. **The code cannot be
hidden**: a browser has to receive a script in order to run it, so anyone can
read the bundle and modify it at runtime in DevTools. Obfuscation raises the
cost and prevents nothing. What protects the source is the licence, not the
build.

What *is* done, and does change something:

- **No source maps in production.** A source map is the entire original
  TypeScript — every file, every comment — served next to the bundle and loaded
  by DevTools automatically. Shipping one republishes the repository in a form
  easier to read than the repository.
- **A strict Content-Security-Policy** (`public/_headers`) listing every origin
  the app is allowed to talk to, with `object-src 'none'`, `frame-ancestors
  'none'` and `form-action 'none'`. An injected script is refused by the
  browser rather than merely discouraged. This is only possible because the app
  has no third-party scripts at all.
- **A same-origin relay.** It used to answer `Access-Control-Allow-Origin: *`,
  which let any site on the internet point its own client at this deployment
  and spend its request budget — and, through it, the bandwidth that the ADS-B
  feeds donate on the understanding that this project is the one using them.
- **A relay that answers only GET**, pins its response content type so a
  compromised upstream cannot decide what kind of document this origin serves,
  and reports failures without naming the infrastructure behind them.

There are no secrets in the bundle because there are none anywhere: no key, no
account, no card is the premise, not a precaution.

---

## Attribution

Required and always on screen: Esri World Imagery; Sentinel-2 cloudless by EOX;
Mapzen Terrain Tiles on AWS Open Data; adsb.lol, adsb.fi and OpenSky Network;
adsbdb; Planespotters (photographer credit and link); Open-Meteo.

3D aircraft models from FlightGear FGAddon, GPL-2.0 — see
`public/models/CREDITS.md` for the per-aircraft authors and licences.
