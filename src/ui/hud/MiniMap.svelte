<!--
  Where the aircraft is, while watching it.

  A small north-up map in the corner of the 3D view, the same imagery as the
  2D map: the aircraft at the centre pointing where its nose points, the leg
  flown so far behind it, and the traffic around. It reaches a couple of
  kilometres either side on the ground and grows with altitude (see
  `autoZoom`); the visitor can step it closer or wider, enlarge it with a tap,
  and fold it away — remembered, like the docks.

  Another aircraft on it can be tapped to step across into it, as in the 3D
  view.
-->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import { DEFAULT_IMAGERY, imageryById } from '@/tiles/sources';
  import type { Orchestrator } from '@/app/orchestrator';
  import type { SampledAircraft } from '@/state/track';
  import { t } from '@/i18n/index.svelte';
  import { num } from '../format';
  import Icon from '../Icon.svelte';
  import { dockFolded, rememberDockFolded } from '../dockMemory';
  import { METRES_PER_NM, autoZoom, coverTiles, mercator, metresPerPixel } from './minimap';

  let {
    sample,
    orchestrator,
    folded = $bindable(dockFolded('minimap', false)),
    large = $bindable(false),
  }: { sample: SampledAircraft; orchestrator: Orchestrator; folded?: boolean; large?: boolean } = $props();

  $effect(() => rememberDockFolded('minimap', folded));
  let steps = $state(0);
  let width = $state(0);
  let height = $state(0);

  /** At most this many other aircraft drawn: past it the map is a swarm, not a picture. */
  const MAX_OTHERS = 60;
  /** The reach is chosen for a window this wide; an enlarged map shows more around, not the same bigger. */
  const REFERENCE_PX = 240;

  const imagery = $derived(imageryById(app.imageryId) ?? DEFAULT_IMAGERY);
  // One level deeper on a high-density screen, or the imagery is visibly soft.
  const detail = typeof devicePixelRatio === 'number' && devicePixelRatio >= 1.5 ? 1 : 0;

  // In twentieths of a level: a climb changes the scale smoothly without
  // relaying out the tiles at every refresh.
  const zoom = $derived(Math.round(autoZoom(sample.altFt, sample.lat, REFERENCE_PX, steps) * 20) / 20);
  const centre = $derived(mercator(sample.lat, sample.lon));
  const pxPerWorld = $derived(256 * 2 ** zoom);
  const tiles = $derived(width > 0 ? coverTiles(centre, zoom, width, height, detail, imagery.maxZoom) : []);
  // Two levels coarser, under the rest: when the zoom crosses a level and a
  // new set of tiles is on its way, the picture blurs for a moment instead of
  // going blank.
  const coarse = $derived(width > 0 ? coverTiles(centre, zoom, width, height, -2, imagery.maxZoom) : []);

  /** A point of the world in the window's pixels, the shorter way round the antimeridian. */
  function place(mx: number, my: number): [number, number] {
    let dx = mx - centre[0];
    dx -= Math.round(dx);
    return [width / 2 + dx * pxPerWorld, height / 2 + (my - centre[1]) * pxPerWorld];
  }

  // The leg so far changes slowly, and the fetched history arrives late: read
  // every couple of seconds, projected once.
  let path = $state<[number, number][]>([]);
  $effect(() => {
    const read = (): void => {
      path = orchestrator.flownPath().map((p) => mercator(p.lat, p.lon));
    };
    read();
    const timer = setInterval(read, 2000);
    return () => clearInterval(timer);
  });

  const line = $derived.by(() => {
    if (!width) return '';
    const reach = Math.max(width, height) * 3;
    const points: string[] = [];
    let lastX = NaN;
    let lastY = NaN;
    for (const [mx, my] of path) {
      const [x, y] = place(mx, my);
      if (Math.abs(x - width / 2) > reach || Math.abs(y - height / 2) > reach) continue;
      if (Math.hypot(x - lastX, y - lastY) < 1.5) continue;
      points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      lastX = x;
      lastY = y;
    }
    points.push(`${width / 2},${height / 2}`);
    return points.length > 1 ? points.join(' ') : '';
  });

  // Re-read with every refresh of the aircraft in view, which is when the
  // fleet was sampled too.
  const others = $derived.by(() => {
    if (!width || !sample) return [];
    const list: { hex: string; x: number; y: number; track: number; name: string }[] = [];
    for (const other of orchestrator.samples) {
      if (other.hex === sample.hex) continue;
      const [x, y] = place(...mercator(other.lat, other.lon));
      if (x < -8 || y < -8 || x > width + 8 || y > height + 8) continue;
      list.push({ hex: other.hex, x, y, track: other.trackDeg, name: other.latest.callsign ?? other.hex.toUpperCase() });
      if (list.length >= MAX_OTHERS) break;
    }
    return list;
  });

  const spanNm = $derived((metresPerPixel(zoom, sample.lat) * width) / METRES_PER_NM);
</script>

{#if folded}
  <button class="minimap-open" onclick={() => (folded = false)} title={t('minimap.show')} aria-label={t('minimap.show')}>
    <Icon name="map" size={18} />
  </button>
{:else}
  <section class="minimap" class:large aria-label={t('minimap.label')}>
    <div class="frame" bind:clientWidth={width} bind:clientHeight={height}>
      <button
        class="surface"
        onclick={() => (large = !large)}
        title={t(large ? 'minimap.shrink' : 'minimap.enlarge')}
        aria-label={t(large ? 'minimap.shrink' : 'minimap.enlarge')}
      >
        {#each coarse as tile (tile.key)}
          <img class="coarse" src={imagery.url(tile.z, tile.x, tile.y)} alt="" draggable="false"
            style="transform: translate({tile.left}px, {tile.top}px); width: {tile.size}px; height: {tile.size}px" />
        {/each}
        {#each tiles as tile (tile.key)}
          <img src={imagery.url(tile.z, tile.x, tile.y)} alt="" draggable="false"
            onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')}
            style="transform: translate({tile.left}px, {tile.top}px); width: {tile.size}px; height: {tile.size}px" />
        {/each}
      </button>

      <svg class="overlay" width={width} height={height} aria-hidden="true">
        {#if line}<polyline class="flown" points={line} />{/if}
      </svg>

      {#each others as other (other.hex)}
        <button
          class="other"
          style="transform: translate({other.x}px, {other.y}px) rotate({other.track}deg)"
          onclick={() => orchestrator.switchTo(other.hex)}
          title={t('minimap.stepInto', { callsign: other.name })}
          aria-label={t('minimap.stepInto', { callsign: other.name })}
        >
          <svg viewBox="-6 -6 12 12" aria-hidden="true"><path d="M0 -5 4 4 0 2 -4 4Z" /></svg>
        </button>
      {/each}

      <svg class="self" viewBox="0 0 24 24" style="transform: translate(-50%, -50%) rotate({sample.headingDeg}deg)" aria-hidden="true">
        <path d="M21 15.5v-2l-8-5V3.8a1.5 1.5 0 0 0-3 0V8.5l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-6Z" />
      </svg>

      <span class="north" aria-hidden="true">N</span>
      <span class="span">↔ {num(spanNm, spanNm < 10 ? 1 : 0)} NM</span>

      <div class="controls">
        <button onclick={() => (steps = Math.min(4, steps + 1))} title={t('minimap.zoomIn')} aria-label={t('minimap.zoomIn')}>
          <Icon name="plus" size={14} />
        </button>
        <button onclick={() => (steps = Math.max(-4, steps - 1))} title={t('minimap.zoomOut')} aria-label={t('minimap.zoomOut')}>
          <Icon name="minus" size={14} />
        </button>
        <button onclick={() => (folded = true)} title={t('minimap.hide')} aria-label={t('minimap.hide')}>
          <Icon name="close" size={13} />
        </button>
      </div>
    </div>
  </section>
{/if}

<style>
  .minimap,
  .minimap-open {
    position: absolute;
    left: 28px;
    bottom: 22px;
    z-index: 1;
    text-shadow: none;
    animation: map-in 0.45s var(--ease) both;
  }
  @keyframes map-in {
    from { opacity: 0; transform: translateY(10px); }
  }

  .minimap {
    padding: 4px;
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 0 100%);
  }
  .frame {
    position: relative;
    width: 236px;
    height: 164px;
    overflow: hidden;
    background: #0b1a26;
    transition: width 0.35s var(--ease), height 0.35s var(--ease);
  }
  /*
   * Bigger, but never into the view controls at the bottom centre nor up
   * into the speed tape at mid-height.
   */
  .large .frame {
    width: clamp(236px, calc(50vw - 360px), 420px);
    height: clamp(164px, calc(50vh - 110px), 300px);
  }

  .surface {
    position: absolute;
    inset: 0;
    display: block;
    padding: 0;
    border: 0;
    background: none;
    cursor: zoom-in;
  }
  .large .surface { cursor: zoom-out; }
  .surface img {
    position: absolute;
    left: 0;
    top: 0;
    max-width: none;
    user-select: none;
    pointer-events: none;
    /* Toned down like the 2D map's ground, so the aircraft is what stands out. */
    filter: saturate(0.75) brightness(0.85);
  }

  .overlay { position: absolute; inset: 0; pointer-events: none; }
  .flown {
    fill: none;
    stroke: var(--hud-accent);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
    opacity: 0.85;
    filter: drop-shadow(0 0 1.5px rgba(0, 0, 0, 0.9));
  }

  .self {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 22px;
    height: 22px;
    pointer-events: none;
    fill: var(--hud-accent);
    stroke: rgba(0, 0, 0, 0.85);
    stroke-width: 1.2;
    filter: drop-shadow(0 0 4px rgb(var(--accent-rgb) / 0.7));
  }

  .other {
    position: absolute;
    left: -9px;
    top: -9px;
    width: 18px;
    height: 18px;
    padding: 3px;
    border: 0;
    background: none;
    cursor: pointer;
  }
  .other svg { display: block; width: 100%; height: 100%; }
  .other path {
    fill: #ffd27a;
    stroke: rgba(0, 0, 0, 0.8);
    stroke-width: 1;
    transition: fill 0.15s;
  }
  .other:hover path, .other:focus-visible path { fill: #fff; }

  .north, .span {
    position: absolute;
    font: 600 9.5px/1 var(--mono);
    letter-spacing: 0.08em;
    color: #e8f6ff;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95), 0 0 4px rgba(0, 0, 0, 0.8);
    pointer-events: none;
  }
  .north { top: 6px; left: 7px; }
  .span { bottom: 6px; left: 7px; }

  .controls {
    position: absolute;
    right: 4px;
    bottom: 4px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .controls button,
  .minimap-open {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    padding: 0;
    color: var(--hud-text);
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    transition: color 0.2s, border-color 0.2s;
  }
  .controls button:hover,
  .minimap-open:hover { color: var(--hud-accent); border-color: var(--hud-accent); }
  .minimap-open { width: 40px; height: 40px; }

  /*
   * A phone: smaller, at the left over the two rows of view controls, clear
   * of the speed tape above it.
   */
  @media (max-width: 720px) {
    .minimap,
    .minimap-open {
      left: calc(8px + env(safe-area-inset-left));
      bottom: calc(118px + env(safe-area-inset-bottom));
    }
    .frame { width: 128px; height: 112px; }
    .large .frame { width: min(260px, calc(100vw - 26px)); height: min(220px, 34vh); }
    .controls button { width: 30px; height: 30px; }
    .span { display: none; }
  }
  /* A phone on its side: no corner to spare. */
  @media (max-height: 480px) {
    .minimap, .minimap-open { display: none; }
  }
</style>
