<!--
  Application shell.

  Both surfaces exist at all times and are cross-faded between. Tearing down
  the MapLibre instance on entering the cockpit and rebuilding it on the way
  back would cost a visible rebuild of every tile — and the whole premise here
  is that nothing ever visibly rebuilds.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Orchestrator } from '@/app/orchestrator';
  import { app } from '@/state/appStore.svelte';
  import { CAMERA_MODES } from '@/render/pov';
  import AircraftPanel from '@/ui/AircraftPanel.svelte';
  import Diagnostics from '@/ui/Diagnostics.svelte';
  import Hud from '@/ui/Hud.svelte';
  import LayerPicker from '@/ui/LayerPicker.svelte';
  import Legend from '@/ui/Legend.svelte';
  import Notices from '@/ui/Notices.svelte';
  import StatusBar from '@/ui/StatusBar.svelte';

  let mapContainer: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let orchestrator = $state<Orchestrator | null>(null);
  let booting = $state(true);
  let bootError = $state<string | null>(null);

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  /**
   * Open the key once, for someone who has never seen this before.
   *
   * `localStorage` is exactly the right store for this and exactly the wrong
   * thing to trust: it throws outright in a locked-down browser and comes back
   * empty in a private window. Both are fine — the worst case is that a
   * returning user is shown the key again, which is a far smaller problem than
   * a first-time user never discovering that the keyboard does anything.
   */
  function openLegendOnFirstVisit(): void {
    try {
      if (localStorage.getItem('planesview.seen') === '1') return;
      localStorage.setItem('planesview.seen', '1');
    } catch {
      return;
    }
    app.showLegend = true;
  }

  onMount(() => {
    const instance = new Orchestrator();
    instance
      .start(mapContainer, canvas)
      .then(() => {
        orchestrator = instance;
        booting = false;
        openLegendOnFirstVisit();
      })
      .catch((err: unknown) => {
        bootError = err instanceof Error ? err.message : String(err);
        booting = false;
      });

    return () => instance.dispose();
  });

  function onKeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    const o = orchestrator;
    if (!o) return;

    switch (event.key) {
      case 'Escape':
        // The key closes whatever is on top before it changes the view, so it
        // never both dismisses a panel and ejects the user in one press.
        if (app.showLegend) app.showLegend = false;
        else if (app.view === 'pov') o.exitPov();
        else if (app.selectedHex) void o.select(null);
        break;
      case 'Enter':
        if (app.view === 'map' && app.selectedHex) o.enterPov();
        break;
      case 'd':
      case 'D':
        app.showDiagnostics = !app.showDiagnostics;
        break;
      case 'c':
      case 'C':
        o.recentreView();
        break;
      case 'h':
      case 'H':
      case '?':
        app.showLegend = !app.showLegend;
        break;
      default: {
        // 1-5 select a camera view while flying.
        const index = Number.parseInt(event.key, 10) - 1;
        const mode = CAMERA_MODES[index];
        if (app.view === 'pov' && mode) o.setCameraMode(mode.id);
      }
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (app.view !== 'pov') return;
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging || app.view !== 'pov') return;
    orchestrator?.handleDrag(event.clientX - lastX, event.clientY - lastY);
    lastX = event.clientX;
    lastY = event.clientY;
  }

  function onPointerUp(event: PointerEvent): void {
    dragging = false;
    const el = event.currentTarget as HTMLElement;
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
  }

  function onWheel(event: WheelEvent): void {
    if (app.view !== 'pov') return;
    event.preventDefault();
    orchestrator?.handleZoom(event.deltaY);
  }

  // MapLibre only recalculates its size on demand, so it has to be told when
  // it comes back from behind the cockpit view.
  $effect(() => {
    if (app.view === 'map') {
      requestAnimationFrame(() => orchestrator?.resizeMap());
    }
  });
</script>

<svelte:window onkeydown={onKeydown} />

<main class:pov={app.view === 'pov'}>
  <div class="surface map" bind:this={mapContainer} aria-hidden={app.view === 'pov'}></div>

  <canvas
    class="surface globe"
    bind:this={canvas}
    aria-hidden={app.view !== 'pov'}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onwheel={onWheel}
  ></canvas>

  <div class="brackets" aria-hidden="true">
    <span></span><span></span><span></span><span></span>
  </div>

  {#if booting}
    <div class="boot">
      <div class="spinner" aria-hidden="true"></div>
      <p>Finding aircraft near you…</p>
    </div>
  {:else if bootError}
    <div class="boot error">
      <h1>PlanesView could not start</h1>
      <p>{bootError}</p>
      <p class="hint">A WebGL2-capable browser is required.</p>
    </div>
  {:else if orchestrator}
    {#if app.view === 'map'}
      <header class="toolbar">
        <h1>Planes<span>View</span></h1>
        <LayerPicker {orchestrator} />
        <button class="chip" onclick={() => (app.showLegend = !app.showLegend)}>
          Key <span class="kbd">H</span>
        </button>
      </header>
      <AircraftPanel {orchestrator} />
    {:else}
      <Hud {orchestrator} />
    {/if}

    <Diagnostics />
    <Legend />
    <Notices />
    <StatusBar />
  {/if}
</main>

<style>
  main { position: relative; width: 100%; height: 100%; overflow: hidden; }

  .surface {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  .map { z-index: 1; }

  .globe {
    z-index: 2;
    display: block;
    opacity: 0;
    pointer-events: none;
    /* Slightly slower in than out: arriving in the cockpit should feel like
       settling into it, leaving should feel immediate. */
    transition: opacity 0.55s ease-out;
    touch-action: none;
  }
  main.pov .globe { opacity: 1; pointer-events: auto; }
  main.pov .map { pointer-events: none; }
  /*
   * MapLibre's own stylesheet sets `pointer-events: auto` on its controls, so
   * they punch back through the container's `none` and keep taking clicks from
   * behind the cockpit view — including the attribution link, which navigates
   * away from the app entirely.
   */
  main.pov .map :global(.maplibregl-ctrl) { pointer-events: none; }

  .toolbar {
    position: absolute;
    top: 16px;
    left: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    z-index: 20;
  }
  h1 {
    margin: 0;
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--accent);
    padding: 8px 14px 8px 16px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-left: 2px solid var(--accent);
    border-radius: var(--radius);
    backdrop-filter: blur(12px);
    box-shadow: var(--glow);
  }
  h1 span { color: var(--text); font-weight: 400; }

  .toolbar .kbd {
    font-family: var(--mono);
    font-size: 9px;
    padding: 1px 4px;
    border: 1px solid var(--border);
    color: var(--accent);
  }

  .boot {
    position: absolute;
    inset: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    background: var(--bg);
    color: var(--text-dim);
    text-align: center;
    padding: 24px;
  }
  .boot.error { color: var(--text); }
  .boot h1 { background: none; border: none; font-size: 18px; }
  .boot .hint { font-size: 12px; color: var(--text-faint); }

  .spinner {
    width: 26px;
    height: 26px;
    border: 2px solid transparent;
    border-top-color: var(--accent);
    border-right-color: var(--accent-dim);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    filter: drop-shadow(0 0 6px rgba(127, 223, 255, 0.5));
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /*
   * Viewport brackets.
   *
   * Four corner rules, drawn over everything and clickable through. They frame
   * the cockpit view the way a targeting display would, and — less decoratively
   * — they give the eye a fixed reference at the edge of a view where
   * everything else is moving, which makes the attitude of the aircraft much
   * easier to read.
   */
  .brackets {
    position: absolute;
    inset: 14px;
    z-index: 14;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.5s ease-out;
  }
  main.pov .brackets { opacity: 0.55; }
  .brackets span {
    position: absolute;
    width: 26px;
    height: 26px;
    border: 1px solid var(--accent);
  }
  .brackets span:nth-child(1) { top: 0; left: 0; border-right: 0; border-bottom: 0; }
  .brackets span:nth-child(2) { top: 0; right: 0; border-left: 0; border-bottom: 0; }
  .brackets span:nth-child(3) { bottom: 0; left: 0; border-right: 0; border-top: 0; }
  .brackets span:nth-child(4) { bottom: 0; right: 0; border-left: 0; border-top: 0; }
</style>
