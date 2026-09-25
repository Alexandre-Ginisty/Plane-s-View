import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath, URL } from 'node:url';
import relayTargets from './relay-targets.json' with { type: 'json' };

/**
 * Dev-server relay.
 *
 * The free ADS-B feeds send no CORS headers, so a page cannot call them
 * directly. In development Vite forwards `/feeds/<target>/*` to the upstream
 * origin; in production the identical paths are served by
 * `functions/feeds/[[path]].ts`. See `src/data/endpoints.ts`.
 */
const feedProxy = Object.fromEntries(
  Object.entries(relayTargets).map(([target, origin]) => [
    `/feeds/${target}`,
    {
      target: origin,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(new RegExp(`^/feeds/${target}`), ''),
      headers: {
        // Planespotters rejects generic agents, and browsers forbid scripts
        // from setting User-Agent. The relay is the only place it can be set.
        'User-Agent': 'PlanesView/0.1 (+https://github.com/planesview/planesview)',
      },
    },
  ]),
);

export default defineConfig(({ mode }) => ({
  // Relative base so the build works unchanged on GitHub Pages project sites,
  // Cloudflare Pages and Vercel without env-specific configuration.
  base: './',
  plugins: [svelte()],
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
    // `functions/` too: the relay is the only code in this project exposed
    // directly to the internet, and it was the only code with no tests.
    include: ['src/**/*.test.ts', 'functions/**/*.test.ts'],
  },
  server: {
    port: 5173,
    proxy: feedProxy,
  },
  preview: {
    port: 4173,
    proxy: feedProxy,
  },
}));
