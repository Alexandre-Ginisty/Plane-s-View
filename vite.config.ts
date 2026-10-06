import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';
import relayTargets from './relay-targets.json' with { type: 'json' };

/**
 * The site-wide headers from `public/_headers` (the `/*` block), so the
 * preview server answers with the very policy Vercel will apply (`vercel.json`
 * repeats them: keep the two in step).
 */
function siteHeaders(drop: readonly string[] = []): Record<string, string> {
  const lines = readFileSync(new URL('./public/_headers', import.meta.url), 'utf8').split('\n');
  const headers: Record<string, string> = {};
  let inBlock = false;
  for (const line of lines) {
    if (/^\S/.test(line)) inBlock = line.trim() === '/*';
    else if (inBlock && line.trim()) {
      const at = line.indexOf(':');
      const name = line.slice(0, at).trim();
      if (!drop.includes(name)) headers[name] = line.slice(at + 1).trim();
    }
  }
  return headers;
}

/**
 * Dev-server relay.
 *
 * The free ADS-B feeds send no CORS headers, so a page cannot call them
 * directly. In development Vite forwards `/feeds/<target>/*` to the upstream
 * origin; in production the identical paths are served by
 * `api/feeds.ts`. See `src/data/endpoints.ts`.
 */
const feedProxy = Object.fromEntries(
  Object.entries(relayTargets).map(([target, origin]) => [
    // With the slash: proxies match by prefix, and `/feeds/adsb-lol` would
    // otherwise also take every `/feeds/adsb-lol-traces/...` request.
    `/feeds/${target}/`,
    {
      target: origin,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(new RegExp(`^/feeds/${target}(?=/)`), ''),
      headers: {
        // MET Norway requires an agent that identifies the project, and
        // browsers forbid scripts from setting User-Agent. The relay is the
        // only place it can be set.
        'User-Agent': 'PlanesView/1.0 (+https://github.com/Alexandre-Ginisty/Plane-s-View)',
      },
    },
  ]),
);


/**
 * The model files, gzipped once at build time.
 *
 * Left alone, a host compresses a `.pvm` the first time each edge location is
 * asked for it — Brotli at a high level, on a few megabytes — and that first
 * visitor waits several seconds for a cockpit that is already a few hundred
 * milliseconds of transfer. A file that is already a `.gz` is served as it is,
 * the browser unpacks it itself (see `fetchModel`), and the raw copies, which
 * were more than half of what a deployment uploaded, are not shipped at all.
 * Development serves the raw files.
 */
function packModels(): Plugin {
  let outDir = 'dist';
  return {
    name: 'planesview-pack-models',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const dir = new URL(`./${outDir}/models/`, import.meta.url);
      let names: string[] = [];
      try {
        names = readdirSync(dir).filter((n) => n.endsWith('.pvm'));
      } catch {
        return;
      }
      for (const name of names) {
        const file = new URL(name, dir);
        writeFileSync(new URL(`${name}.gz`, dir), gzipSync(readFileSync(file), { level: 9 }));
        rmSync(file);
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  // Relative base so the build works unchanged on GitHub Pages project sites,
  // Cloudflare Pages and Vercel without env-specific configuration.
  base: './',
  plugins: [svelte(), packModels()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    /**
     * MapLibre ships its own Web Worker. Vite's dependency optimiser rewrites
     * the bundle but does not emit `maplibre-gl-worker.mjs` alongside it, so
     * the worker 404s, MapLibre tears itself down, and the dev server
     * re-optimises — which triggers a full page reload, every few seconds,
     * forever. The symptom is a black map and an app that never finishes
     * starting; the server log names the missing file.
     *
     * Excluding it from pre-bundling leaves MapLibre's own worker wiring
     * intact. Production builds are unaffected (Rollup handles the worker
     * correctly), so this is purely a dev-server fix.
     */
    exclude: ['maplibre-gl'],
  },
  build: {
    target: 'es2022',
    /**
     * No source maps in the published build.
     *
     * A source map is the entire original TypeScript — every file, every
     * comment, every name — served next to the bundle and loaded by DevTools
     * automatically. Shipping one does not merely make the code readable; it
     * republishes the repository in a form that is easier to read than the
     * repository, and it does it to every visitor.
     *
     * It is kept in development, where it is the difference between a stack
     * trace and a wall of minified identifiers, and dropped in production,
     * where nobody debugging the deployed site has the source to map to
     * anyway.
     *
     * This is a real reduction in what a visitor is handed. It is not a
     * protection: a browser must receive the code in order to run it, so the
     * bundle can always be read, paused and modified in DevTools. What stops
     * someone reusing the code is the licence, not the build.
     */
    sourcemap: mode !== 'production',
    rollupOptions: {
      output: {
        // Function form: the object form was dropped in the Vite 8 bundler.
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/maplibre-gl')) return 'maplibre';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    // `api/` too: the relay is the only code in this project exposed
    // directly to the internet, and it was the only code with no tests.
    include: ['src/**/*.test.ts', 'api/**/*.test.ts'],
  },
  server: {
    port: 5173,
    proxy: feedProxy,
  },
  preview: {
    port: 4173,
    proxy: feedProxy,
    headers: process.env['PREVIEW_BARE'] ? {} : siteHeaders(process.env['PREVIEW_DROP']?.split(',') ?? []),
  },
}));
