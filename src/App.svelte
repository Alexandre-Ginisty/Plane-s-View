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
  import { resolveTheme, watchSystemTheme } from '@/ui/theme';
  import { CAMERA_MODES } from '@/render/pov';
  import { CATCH_LABELS } from '@/app/catch';
  import AircraftPanel from '@/ui/AircraftPanel.svelte';
  import Landing from '@/ui/intro/Landing.svelte';
  import ThemeToggle from '@/ui/ThemeToggle.svelte';
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

  /**
   * The front page, shown over an app that is already starting.
   *
   * Not a route and not a gate on boot: the orchestrator runs behind it, so the
   * seconds someone spends reading are the seconds the first terrain and the
   * first traffic snapshot take. Entering then lands on a warm app instead of
   * on the spinner this used to open with.
   *
   * Skipped when the URL says so, which is what makes the app linkable —
   * `?go` drops straight in, and anything sharing a specific view will want
   * that.
   */
  let showLanding = $state(!new URLSearchParams(location.search).has('go'));

  /*
   * Cinema: nothing on screen but the view.
   *
   * The browser's fullscreen is asked for alongside, and where it is refused
   * or missing (an iPhone has none for a page) the overlays still go, which
   * is most of what was wanted. Leaving the browser's fullscreen — its own
   * Esc, or a swipe — leaves cinema too, so the two can never disagree.
   */
  let cinemaHint = $state(false);
  let idle = $state(false);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (app.cinema) {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => undefined);
      }
      cinemaHint = true;
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => (cinemaHint = false), 2500);
      wakeCursor();
    } else {
      cinemaHint = false;
      idle = false;
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
    }
  });

  onMount(() => {
    const onFullscreen = (): void => {
      if (!document.fullscreenElement && app.cinema) app.cinema = false;
    };
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => document.removeEventListener('fullscreenchange', onFullscreen);
  });

  /** The cursor hides after a moment of stillness in cinema, like a video. */
  function wakeCursor(): void {
    idle = false;
    clearTimeout(idleTimer);
    if (app.cinema) idleTimer = setTimeout(() => (idle = true), 2000);
  }

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

  /*
   * Seed the store from what `main.ts` already put on the document, then keep
   * following the system while the visitor has not overridden it. Reading it
   * back rather than resolving again is what guarantees the two agree.
   */
  app.theme = resolveTheme();

  onMount(() => watchSystemTheme((theme) => app.setTheme(theme, true)));

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
    // The landing page owns the keyboard while it is up; it has its own
    // handler, and letting these through would switch camera modes in an app
    // the visitor cannot see.
    if (showLanding) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    const o = orchestrator;
    if (!o) return;

    switch (event.key) {
      case 'Escape':
        // The key closes whatever is on top before it changes the view, so it
        // never both dismisses a panel and ejects the user in one press.
        if (app.cinema) app.cinema = false;
        else if (app.showLegend) app.showLegend = false;
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
      case 'f':
      case 'F':
        app.cinema = !app.cinema;
        break;
      case 'a':
      case 'A':
        app.setAutoCamera(!app.autoCamera);
        app.notify(app.autoCamera ? 'Auto camera on for takeoffs and landings.' : 'Auto camera off.', 'info', 2500);
        break;
      case 'l':
      case 'L':
        void o.catchAircraft('landing');
        break;
      case 't':
      case 'T':
        void o.catchAircraft('takeoff');
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

<main
  class:pov={app.view === 'pov'}
  class:cinema={app.cinema}
  class:idle={app.cinema && idle}
  onpointermove={wakeCursor}
>
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

  {#if showLanding && !bootError}
    <Landing ready={!booting} onEnter={() => (showLanding = false)} />
  {/if}

  {#if booting}
    <div class="boot" class:hidden={showLanding}>
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
        <ThemeToggle compact />
        <button class="chip" onclick={() => (app.showLegend = !app.showLegend)}>
          Key <span class="kbd">H</span>
        </button>
        <span class="catch">
          <button
            class="chip"
            disabled={app.shuffling}
            onclick={() => void orchestrator?.catchAircraft('landing')}
            title="Step into an aircraft on final approach (L)"
          >{CATCH_LABELS.landing.verb}</button>
          <button
            class="chip"
            disabled={app.shuffling}
            onclick={() => void orchestrator?.catchAircraft('takeoff')}
            title="Step into an aircraft taking off (T)"
          >{CATCH_LABELS.takeoff.verb}</button>
        </span>
      </header>
      {#if !app.cinema}<AircraftPanel {orchestrator} />{/if}
    {:else if !app.cinema}
      <Hud {orchestrator} />
    {/if}

    {#if !app.cinema}
      <Diagnostics />
      <Legend />
      <Notices />
      <StatusBar />
    {:else if cinemaHint}
      <p class="cinema-hint" role="status">Press <span class="kbd">F</span> or <span class="kbd">Esc</span> to leave fullscreen</p>
    {/if}
  {/if}
</main>

<style>
  main { position: relative; width: 100%; height: 100%; overflow: hidden; }
  main.idle, main.idle :global(canvas) { cursor: none; }

  main.cinema .toolbar,
  main.cinema .brackets { display: none; }

  .cinema-hint {
    position: absolute;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 30;
    margin: 0;
    padding: 6px 14px;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    color: var(--text);
    background: rgba(3, 8, 14, 0.55);
    border: 1px solid var(--border);
    pointer-events: none;
    animation: hint 2.5s ease-out forwards;
  }
  .cinema-hint .kbd {
    font-size: 9px;
    padding: 1px 4px;
    border: 1px solid var(--border);
    color: var(--accent);
  }
  @keyframes hint {
    0%, 70% { opacity: 1; }
    100% { opacity: 0; }
  }

  .catch { display: flex; gap: 4px; margin-left: 6px; }
  .catch .chip:disabled { opacity: 0.6; cursor: progress; }
  @media (max-width: 720px) {
    .catch { display: none; }
  }

  .boot.hidden { opacity: 0; pointer-events: none; }

  .surface {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  /*
   * Hidden once the cockpit is fully opaque, shown again instantly on the way
   * out.
   *
   * Belt and braces. The globe canvas covers this completely in POV, so this
   * changes nothing visible — but "covers it completely" is an invariant that
   * a single undrawn frame breaks, and when it broke, what showed through was
   * the 2D map. Nothing can show through something that is not painted.
   *
   * The delay is on `visibility` alone and costs nothing: entering waits out
   * the cross-fade before hiding, leaving reveals the map in the same frame
   * the class is removed, so the fade out still has something underneath it.
   */
  .map {
    z-index: 1;
    transition: visibility 0s linear 0s;
  }
  main.pov .map {
    visibility: hidden;
    transition: visibility 0s linear 0.55s;
  }

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
