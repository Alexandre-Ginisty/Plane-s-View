# PlanesView — architecture

A map of the code, written so that a change can be located before it is made.

The project is a browser-only app: no backend, no API key, no account. The one
server-side file is a relay allowlist (`functions/feeds/`), and it exists only
because four ADS-B providers refuse cross-origin requests.

## The three surfaces

| Surface | Lives in | Renderer |
|---|---|---|
| 2D selection map | `src/map2d/` | MapLibre GL |
| 3D globe and cockpit | `src/render/` | Three.js |
| Chrome, HUD, panels | `src/ui/`, `src/App.svelte` | Svelte 5 + DOM |

The HUD is deliberately DOM, never 3D. Text in a 3D scene lives in a texture
atlas, costs a re-upload per changed digit, ends up blurry under perspective,
and is invisible to a screen reader.

## The frame loop

`src/app/orchestrator.ts` owns the only `requestAnimationFrame` in the app.
One loop means one place where ordering is decided, and ordering matters:

1. sample every track at one instant (`state/traffic.ts`)
2. move the camera (`render/pov/`) — this may rebase the floating origin
3. update the quadtree against the *new* camera (`render/globe/`)
4. rebuild the instanced traffic buffers (`render/traffic3d.ts`)
5. publish a 10 Hz snapshot to the store (`app/telemetry.ts`)

Step 2 before step 3 is not stylistic. Reversed, every tile is selected for
where the camera *was*, and the error is largest exactly when the camera is
moving fastest.

## Directory map

```
src/
  app/          composition root — the loop and its policies
    orchestrator.ts   the loop, the view transitions, the public API for the UI
    connection.ts     watches the link, retunes the renderer, tells the user
    povSession.ts     the "follow / hold / give up" rule for a lost signal
    selection.ts      dossier + weather lookups, token-guarded against races
    surfaces.ts       builds the 3D stack and sets the quality ceiling
    sunlight.ts       sun, sky and haze, which must move together
    telemetry.ts      the UI snapshot
    geolocate.ts      where to point before the user has said

  core/
    math/geo/     units, WGS84 ellipsoid, great circles, Web Mercator tiles
    frame.ts      floating origin — see "Precision" below
    lru.ts        bounded map used by the caches

  data/           everything that comes over the network but is not a tile
    adsb/         provider chain, polling, normalisation, coercion
    meta/         airframe registry and photos
    weather/      Open-Meteo
    http.ts       resilient fetch, circuit breaker
    endpoints.ts  which services need the relay and why

  net/quality/    what the connection can deliver, and what to do about it
    profile.ts    the grades and what each one permits
    monitor.ts    the measurement
    environment.ts  browser hints, injected so it is testable

  render/
    engine.ts     renderer, camera, sky, adaptive pixel ratio
    globe/        the quadtree — see below
    aircraft/     procedural airframe geometry by ICAO type
    traffic/      low-poly markers for distant traffic
    pov/          body frame and the five camera modes
    ownAircraft.ts, traffic3d.ts, terrainMaterial.ts

  state/
    track.ts      one aircraft: Kalman filter, extrapolation, attitude
    traffic.ts    the fleet: ingest, sample, prune
    kalman.ts     the filter itself
    appStore.svelte.ts   the reactive boundary, written once per 100 ms

  tiles/
    sources.ts       imagery and elevation providers, verified keyless
    loader.ts        fetch scheduling, concurrency, source fallback
    requestQueue.ts  priority, reference counting, shared continuations
    cache.ts         IndexedDB with LRU and a quota

  ui/             Svelte components; `palette.ts` is shared with the renderers
  workers/        terrain decoding and meshing, off the main thread
```

## The quadtree, in detail

`render/globe/` is the largest subsystem, split by failure mode:

- **`constants.ts`** — every tuning number, with the measurement that set it.
  Together, because most of them interact: the frontier cap only makes sense
  against the loader's concurrency, the prefetch priority only against what
  `priorityOf` returns for a live tile.
- **`tileNode.ts`** — per-tile state. No behaviour.
- **`metrics.ts`** — pure geometry: visibility, screen-space error, priority,
  which heightmap covers a tile. The most heavily tested code in the renderer,
  because each function is small arithmetic that is easy to get *plausibly*
  wrong.
- **`streaming.ts`** — the load state machine.
- **`tileFetch.ts`** — the two loads, and the ownership rules they must obey.
- **`sceneSync.ts`** — the Three.js side: meshes, materials, fades.
- **`eviction.ts`** — what may be thrown away.
- **`terrainQuery.ts`** — height sampling and path prefetching.
- **`index.ts`** — selection, and the composition of the above.

### The rules that remove the loading feeling

1. A tile is never blank — it samples its nearest loaded ancestor's texture
   through a UV transform until its own arrives.
2. Detail sharpens rather than snapping: a cross-fade, not a swap.
3. A parent is replaced only once **all four** children are built. A partially
   refined quad is the classic flickering checkerboard.
4. The parent stays drawn underneath while the children fade in.
5. Visible tiles are never evicted, whatever the memory pressure.
6. The aircraft's own path is prefetched, so tiles are resident before they
   matter — unless the queue is already backed up, in which case speculation
   would be taking bandwidth from the ground actually on screen.
7. Detail follows the connection (below).

## Detail follows the connection

`net/quality/` measures what the link delivers and every consumer derives its
numbers from that one profile: the loader its concurrency and timeouts, the
globe its zoom ceiling and error target, the traffic client its query radius.

The counter-intuitive part, and the reason the module exists: **asking for more
makes you get less.** 128 parallel requests over a weak link give each one a
sliver of the pipe, so they all miss their timeout together and the ground
never finishes at *any* zoom. Twelve requests complete in sequence and the
picture fills in ring by ring.

Two measurement traps are documented in `monitor.ts` because both were live
bugs: per-request latency is not independent of the concurrency the profile
itself sets (grading on it closes a control loop and oscillates), and aggregate
throughput falls when the app simply stops asking for tiles.

## Precision: the floating origin

Positions are ECEF metres, so a vertex near the surface is ~6.4 million metres
from the origin — about a metre of float32 precision, which reads as terrain
that jitters as the camera moves. `core/frame.ts` keeps a movable origin near
the camera and every mesh is positioned relative to it; tile geometry is built
in the tile's own local frame in the worker. Nothing in the render path ever
holds a raw ECEF coordinate in a float32 buffer.

## Data flow

```
providers ──► client ──► normalize ──► TrafficStore ──► SampledAircraft
  (relay)      (poll,     (coerce)      (Kalman,          │
               fallback)                 extrapolate)     ├─► map2d
                                                          ├─► traffic3d
                                                          └─► pov camera

tile sources ──► TileLoader ──► worker ──► TileNode ──► scene
                 (priority,     (decode,
                  fallback)      mesh)
                     │
                     └──► NetworkMonitor ──► StreamingProfile ──► loader, globe
```

## Conventions

- TypeScript `strict`, plus `noUnusedLocals` and `noUnusedParameters` — the
  cheapest anomaly detector the project has.
- Aircraft geometry is nose-along-**+Y**, starboard **+X**, up **+Z**, matching
  the body frame `render/pov/frame.ts` produces, so a model needs no correction.
- Tile Y runs **south**; texture V runs **north**. The flip lives in exactly one
  place, `TileNode.uvInto`.
- Colour carries **state**, geometry carries **kind**. A helicopter is not given
  its own colour; it is given its own silhouette, and it still turns amber when
  it descends.
- Comments explain *why*, and especially why the obvious alternative is wrong.
  Several of them record a bug that was actually shipped.
