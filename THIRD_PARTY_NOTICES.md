# Third-party notices and licence audit

Rule for this project: **everything used must be free, and its terms must allow
a commercial product to use it.** This file records the audit against that
rule (last checked 2026-10-06), says what each source obliges the project to
do, and lists what was rejected and why. Re-check a source's terms before
adding it, and again before launch: terms change.

The application code is MIT (`LICENSE`). Everything below is somebody else's.

## 1. Services called while the app runs

| Service | Used for | Licence / terms | Commercial use | Obligation |
|---|---|---|---|---|
| [adsb.lol](https://adsb.lol) `api.adsb.lol` | live aircraft positions | ODbL 1.0 | ✅ | credit adsb.lol (shown in *Sources*) |
| [adsb.lol](https://adsb.lol) `adsb.lol/data/traces` | the selected aircraft's track since takeoff | ODbL 1.0 (the same dataset as the positions) | ✅ | credit adsb.lol (shown) |
| [NOAA Aviation Weather Center](https://aviationweather.gov/data/api/) METAR API | weather at the departure and arrival aerodromes | US government work, public domain | ✅ | none; credited under every report anyway. Relay caches 5 min (a METAR is issued every 30) |
| [adsb.fi](https://adsb.fi) `opendata.adsb.fi` — **second feed, first in the chain while the site is a demonstration** | live aircraft positions (adsb.lol answers 429 to most requests from one address) | personal, non-commercial use | ❌ **not for a commercial product** | credit adsb.fi. **Drop before the site earns money:** remove it from `PROVIDERS` in `src/data/adsb/providers.ts`, and `adsb-fi` from `relay-targets.json` and the relay function; then ask adsb.lol for a higher limit or self-host a feed |
| [MET Norway](https://api.met.no/doc/TermsOfService) Locationforecast | surface weather | CC BY 4.0 / NLOD | ✅ explicitly | credit "Data from MET Norway" (shown); identifying `User-Agent` (set by the relay); respect `Expires` (relay caches 10 min); ≤ 4 decimals (client sends a 0.25° cell centre) |
| [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) `services.arcgisonline.com` — **default while the site is a demonstration** | satellite imagery, sharp worldwide | licensed to ArcGIS subscribers | ❌ **not for a commercial product** | credit Esri, Maxar, Earthstar Geographics (shown). **Replace before charging anyone or carrying advertising:** switch `DEFAULT_IMAGERY` in `src/tiles/sources.ts` to the Sentinel-2 layer below, which the national orthophotos then sharpen |
| [EOX](https://maps.eox.at) `tiles.maps.eox.at`, layer `s2cloudless_3857` (Sentinel-2 cloudless **2016**) | satellite imagery | data: CC BY 4.0; "contains modified Copernicus Sentinel data" | ✅ for the 2016 data | credit EOX + Copernicus (shown). The service is "as is", no SLA — see §5 |
| [NASA GIBS](https://gibs.earthdata.nasa.gov) | Blue Marble fallback, night-lights region | NASA imagery, public domain | ✅ | credit appreciated (shown) |
| National aerial imagery, used instead of EOX from zoom 13 inside each country (`src/tiles/regional.ts`): [IGN](https://geoservices.ign.fr/) France `data.geopf.fr` | close-up imagery, 20 cm | Licence Ouverte Etalab 2.0 | ✅ | credit IGN (shown when in view) |
| ↳ [Beeldmateriaal Nederland](https://www.pdok.nl/introductie/-/article/pdok-luchtfoto-rgb-open-) via PDOK | 8 cm | CC BY 4.0 | ✅ | credit (shown when in view) |
| ↳ [basemap.at](https://basemap.at) Austria | 15–30 cm | CC BY 4.0 | ✅ | "Datenquelle: basemap.at" (shown) |
| ↳ [PNOA / IGN España](https://pnoa.ign.es/) | 25–50 cm | CC BY 4.0 | ✅ | "PNOA cedido por © Instituto Geográfico Nacional de España" (shown) |
| ↳ [swisstopo SWISSIMAGE](https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10) Switzerland | 10 cm | Open Government Data | ✅ | "© swisstopo" (shown) |
| ↳ [Géoportail.lu](https://data.public.lu/) Luxembourg | 10 cm | CC0 1.0 | ✅ | none; credited anyway |
| ↳ [Maa- ja Ruumiamet](https://geoportaal.maaruum.ee/avaandmete-litsents) Estonia | 20 cm | Estonian Land Board open data licence (CC BY 4.0 equivalent) | ✅ | credit (shown) |
| ↳ [USGS The National Map](https://www.usgs.gov/programs/national-geospatial-program/national-map) — **contiguous United States only** | 1 m NAIP | public domain | ✅ (Alaska and Hawaii are commercially licensed, so excluded) | credit appreciated (shown) |
| ↳ [Geobasis NRW](https://www.govdata.de/dl-de/zero-2-0) North Rhine-Westphalia | 10 cm | dl-de/zero-2.0 | ✅ unrestricted | none; credited anyway |
| ↳ [Bayerische Vermessungsverwaltung](https://geodaten.bayern.de/) Bavaria | 40 cm | CC BY 4.0 | ✅ | "Bayerische Vermessungsverwaltung – www.geodaten.bayern.de" (shown) |
| [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) `s3.amazonaws.com/elevation-tiles-prod` | elevation | AWS Open Data; sources SRTM, GMTED, ETOPO1, NED… | ✅ | credit; full list at [tilezen/joerd attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) (linked from *Sources*) |
| [OpenFreeMap](https://openfreemap.org) `tiles.openfreemap.org` | night-lights map and ground detail (roads, rail, runways, building footprints) | OpenStreetMap data (ODbL) in OpenMapTiles schema (CC BY 4.0); service free incl. commercial | ✅ | "© OpenStreetMap contributors, OpenMapTiles, OpenFreeMap" (shown) |
| [Wikimedia Commons](https://commons.wikimedia.org) API | aircraft photos | per file; the app keeps only CC BY, CC BY-SA, CC0, public domain | ✅ for those | author + licence + link shown on every photo (`AircraftPhoto.svelte`) |

All of it is reached keyless. Only adsb.lol, MET Norway and the Aviation
Weather Center go through the project's relay (`api/feeds.ts`); the rest is
called from the visitor's browser.

## 2. Data shipped inside the app

| Data | Where | Licence | Commercial use | Obligation |
|---|---|---|---|---|
| Natural Earth (borders, major places; country outlines in `src/tiles/coverage.json`) | `public/map`, `src/tiles` | public domain | ✅ | none; credited anyway |
| GeoNames `cities1000` (towns) | `public/map` | CC BY 4.0 | ✅ | credit GeoNames (shown on the map and in *Sources*) |
| OurAirports | `public/map/search-*.json` | public domain | ✅ | none |
| Virtual Radar Server standing data (routes, airlines, airports) | `public/routes` | CC0 1.0 | ✅ | none; credited in `public/routes/CREDITS.md` |
| NASA Black Marble (VIIRS, 2016) | `public/night` | NASA, public domain | ✅ | none |
| Icons, favicon, 404 page | `public/` | original to this project | ✅ | — |

## 3. 3D aircraft models — GPL-2.0

`public/models` holds airframes converted from the FlightGear FGAddon hangar.
FGAddon accepts only GPL-compatible aircraft, so all are GPL-2.0 (or later). A
GPL licence **allows commercial use and sale**; it imposes obligations, which
this project meets as follows:

- the licence text ships with the models (`public/models/LICENSE-GPL-2.0.txt`);
- every upstream copyright/authors file ships beside them (`public/models/credits/`)
  and the catalogue is `public/models/CREDITS.md`, linked from the in-app *Sources*;
- the corresponding source is the upstream FGAddon tree linked in `CREDITS.md`
  plus `tools/fgmodel` (the converter) in this repository;
- the models are loaded at runtime as data; nothing in `src/` derives from them,
  which is what keeps the application code MIT. That is the usual reading for a
  program that ships separately licensed assets, but it is a reading — if it ever
  worries a lawyer, `public/models` can be deleted and the app falls back to its
  procedural airframes.

Removed from the project because their licensing is not clean:

| Model | Reason |
|---|---|
| `b712` (Boeing 717) | upstream README: adapted from Gary Neely's MD-81, "under a Creative Commons licence, and **not compatible with the GNU GPL**… ask for permission". B712/MD95 are now drawn with the MD-80 model |
| `f14`, `mig21`, `mig29`, `su25` | removed from the working tree before this audit |

Models with no licence file upstream (`b742`, `f15`) rest on the FGAddon-wide
GPL-compatibility rule only. That rule is explicit, but if you want a written
statement, ask the authors listed in `CREDITS.md`.

The passenger cabin seen from every airliner's window seat (`airliner-cabin`)
is the ATR 42-500 cabin by Narendran M, from the FGMEMBERS mirror
(`github.com/FGMEMBERS/ATR-42-500`, GPL-2.0), converted by
`tools/fgmodel/cockpit.mjs`. Its seat-pocket magazines (scans of real TIME and
Digit covers), an airline safety-card scan and the airline logos on the
headrests are **left out**, and the seat-back screens' picture (photographs and
film posters) is painted over as a switched-off screen: those images were not
the model authors' to license.

### 3D airport buildings — GPL-2.0

`public/models/airports` holds terminals, piers, towers and hangars from the
FlightGear scenery database (`scenery.flightgear.org`), converted by
`tools/airports/build.mjs`. Every model there is GPL-2.0 by its author; the
authors are listed per airport in `public/models/airports/CREDITS.md` (linked
from *Sources*), the licence text is `public/models/LICENSE-GPL-2.0.txt`, and
the corresponding source is the database itself plus the converter. Fences,
signs, vehicles and parked aircraft are left out. A few façade sheets carry
painted airline or brand names, as the real buildings do.

**Trademarks are a separate question from copyright.** The 777 and 787 models
carry airline liveries (logos and colours). Showing an airline's own aircraft in
its livery to identify it is descriptive, but it is not covered by the GPL;
decide whether you are comfortable, or set the 777 to its neutral white scheme.

## 4. Libraries

Shipped in the bundle (runtime dependencies, all permissive):

| Package | Licence |
|---|---|
| three 0.186 | MIT |
| maplibre-gl 6.10 | BSD-3-Clause |
| ↳ @mapbox/* (point-geometry, tiny-sdf, unitbezier, vector-tile, jsonlint-lines-primitives), pbf, potpack, kdbush, geojson-vt, vt-pbf, earcut, gl-matrix, quickselect, tinyqueue, murmurhash-js, bidi-js, protocol-buffers-schema, resolve-protobuf-schema, minimist, require-from-string, json-stringify-pretty-compact, @maplibre/mlt | MIT / ISC / BSD-2/3-Clause / (MIT OR Apache-2.0) |
| svelte 5 (compiled into the bundle) | MIT |

Build and test tools only — not shipped to visitors: vite, vitest, svelte-check,
typescript (Apache-2.0), sharp (Apache-2.0; its bundled libvips is LGPL and is
used only by the offline model converter), meshoptimizer (MIT), @sveltejs/vite-plugin-svelte,
@types/*. All MIT or Apache-2.0.

BSD-3-Clause asks that the copyright notice travel with binary redistribution;
the bundle keeps the libraries' own licence banners and this file lists them.
No fonts are loaded: the interface uses the visitor's system fonts.

## 5. Going live — what is free but not unconditional

Nothing here is a licence problem; these are the places where "free" has a
limit, so they should not come as a surprise.

1. **The relay is the scaling limit.** Vercel Functions on the free (Hobby)
   plan have a monthly quota of invocations and of bandwidth. One visitor
   polls traffic every ~3 s, so a few busy visitors use it up. Options, in
   order of effort: raise `minIntervalMs` in `src/data/adsb/providers.ts`;
   self-host the relay on a free VM; or move to a paid plan. The Hobby plan is
   also reserved by Vercel for personal, non-commercial use: once the site
   earns money it has to move to Pro (or another host).
2. **adsb.lol is one volunteer-run service, with no SLA**, and it is the only
   traffic feed left: OpenSky, adsb.fi and airplanes.live are non-commercial.
   If it throttles or changes terms the map empties. Mitigation worth doing
   before launch: ask adsb.lol (<https://adsb.lol>) for explicit confirmation
   of commercial use and for guidance on request volume, and credit them.
3. **EOX's tile server is a free demo service**, "as is", rate-limited, with no
   SLA. The 2016 data is CC BY 4.0; the *service* is the soft spot. For a
   guarantee write to office@eox.at, or self-host the tiles. NASA Blue Marble
   is the automatic fallback (blurry, but never a blank globe).
4. **Imagery is Esri's while the site is a demonstration; commercially it would be 10 m (zoom 14) outside the covered countries.** Esri's 0.3 m
   imagery is not licensed for a commercial product. Inside France, the Netherlands, Austria,
   Spain, Switzerland, Luxembourg, Estonia, the contiguous United States, North
   Rhine-Westphalia and Bavaria the app switches to the national agency's
   open imagery from zoom 13 (5–50 cm). Elsewhere — the UK, Italy, the rest of
   Germany, Canada, Asia, Africa, South America, Oceania — the ground is soft
   close up. These national services are free "as is" like EOX's; each agency
   can change its terms or throttle, and the app then falls back to the global
   imagery tile by tile. To add a country: one entry in `src/tiles/regional.ts`,
   its outline via `tools/tiles/build-coverage.mjs`, its host in the CSP —
   and check the three conditions listed at the top of `regional.ts`.
5. **Wikimedia Commons** photos exist for a fraction of aircraft; it is a
   low-volume public API. Each photo's licence is shown with it.
6. **Keep the credits visible.** CC BY and ODbL are conditions of use, not
   courtesy; the in-app *Sources* panel and the map attribution are how they are
   met.
7. **Privacy.** The app has no cookies and no account. Page views are counted
   with Vercel Web Analytics (`@vercel/analytics`, MIT), which sets no cookie,
   keeps no personal data and talks only to this site's own origin. It asks
   for the visitor's location only if they allow it; position is never sent
   anywhere except as the area queried from adsb.lol and MET Norway through
   the relay.

## 6. Considered and rejected

| Source | Why it is out |
|---|---|
| OpenSky Network | terms: for-profit use "requires a written license"; REST API in a live product needs a prior agreement |
| adsb.fi open data | "personal, non-commercial use only" |
| airplanes.live | non-commercial; API needs prior approval |
| ADS-B Exchange | paid for API access |
| Open-Meteo free API | "only … non-commercial purposes"; commercial use needs a paid plan |
| Esri World Imagery | licensed to ArcGIS subscribers; no commercial use without a licence |
| Sentinel-2 cloudless 2017–2025 (EOX) | CC BY-NC-SA 4.0; commercial licence is paid |
| adsbdb | route data "may not be copied, published, or incorporated into other databases without the explicit permission" of its author; no published licence or rate limit for the service |
| Planespotters / airport-data.com photos | copyright of the photographers; use requires their permission |
| Mapbox, Google, Bing, MapTiler imagery | paid or key-gated |
| GSI Japan, ČÚZK Czechia aerial imagery | free to use, but the servers send no CORS headers, so a page cannot fetch them |
| Poland (Geoportal), Portugal (DGT) aerial imagery | terms unclear for a commercial product (Poland forbids automated "harvesting"; Portugal's service only says "public") |
| Denmark (Dataforsyningen), Finland (NLS), Sweden (Lantmäteriet), New Zealand (LINZ) | free, but need an API key or account |
| Hawaii and Alaska (USGS orthoimagery) | commercially licensed |
| Belgium (Flanders, Wallonia), other German states | not yet added: each is its own service and licence; adding them is straightforward |
