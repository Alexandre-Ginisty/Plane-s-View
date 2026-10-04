<!--
  Application shell.

  Both surfaces exist at all times and are cross-faded between. Tearing down
  the MapLibre instance on entering the cockpit and rebuilding it on the way
  back would cost a visible rebuild of every tile — and the whole premise here
  is that nothing ever visibly rebuilds.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { ScreenAwake, titleFor, watchTab } from '@/app/tabs';
  import { Orchestrator } from '@/app/orchestrator';
  import { app } from '@/state/appStore.svelte';
  import { resolveTheme, watchSystemTheme } from '@/ui/theme';
  import { CAMERA_MODES } from '@/render/pov';
  import { t } from '@/i18n/index.svelte';
  import Rich from '@/ui/Rich.svelte';
  import LanguagePicker from '@/ui/LanguagePicker.svelte';
  import Logo from '@/ui/Logo.svelte';
  import AircraftPanel from '@/ui/AircraftPanel.svelte';
  import Landing from '@/ui/intro/Landing.svelte';
  import ThemeToggle from '@/ui/ThemeToggle.svelte';
  import Diagnostics from '@/ui/Diagnostics.svelte';
  import Hud from '@/ui/Hud.svelte';
  import Legend from '@/ui/Legend.svelte';
  import Notices from '@/ui/Notices.svelte';
  import StatusBar from '@/ui/StatusBar.svelte';
  import Icon from '@/ui/Icon.svelte';

  let mapContainer: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let pinOverlay: HTMLCanvasElement;
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
  const ENTERED_KEY = 'pv.entered';
  let showLanding = $state(!new URLSearchParams(location.search).has('go') && !hasEntered());

  /*
   * A reload — a tab the browser discarded under memory pressure, a crashed GPU
   * process, a refresh — must not throw someone out of the app and back onto the
   * front page. The visit remembers that the app was entered, for this tab only
   * (session storage, so a new visit still opens on the front page).
   */
  function hasEntered(): boolean {
    try {
      return sessionStorage.getItem(ENTERED_KEY) === '1';
    } catch {
      return false;
    }
  }
  function rememberEntered(entered: boolean): void {
    try {
      if (entered) sessionStorage.setItem(ENTERED_KEY, '1');
      else sessionStorage.removeItem(ENTERED_KEY);
    } catch {
      /* storage blocked: the front page simply shows again after a reload */
    }
  }

  /** Back to the front page: out of the cockpit first, so the app waits on the map behind it. */
  function goHome(): void {
    if (app.view === 'pov') orchestrator?.exitPov();
    app.pinMode = false;
    rememberEntered(false);
    showLanding = true;
  }

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
  /*
   * A click is a press that barely moved. Anything more is a drag to look
   * around, and must not also switch aircraft when the button comes up over
   * one.
   */
  let downX = 0;
  let downY = 0;
  let downAt = 0;
  let overTraffic = $state(false);

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
    // A touch screen has no keyboard to discover.
    if (matchMedia('(hover: none) and (pointer: coarse)').matches) return;
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

  // The tab: its title, and staying quiet in the background. See `@/app/tabs`.
  onMount(() => watchTab((hidden) => orchestrator?.setBackground(hidden)));
  $effect(() => {
    document.title = titleFor();
  });
  onMount(() => {
    const awake = new ScreenAwake();
    const stop = $effect.root(() => {
      $effect(() => awake.set(app.view === 'pov'));
    });
    return () => {
      stop();
      awake.dispose();
    };
  });

  onMount(() => {
    const instance = new Orchestrator();
    instance
      .start(mapContainer, canvas, pinOverlay)
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
        else if (app.pinMode) app.pinMode = false;
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
      case 'p':
      case 'P':
        if (app.view === 'map') app.pinMode = !app.pinMode;
        break;
      case 'f':
      case 'F':
        app.cinema = !app.cinema;
        break;
      case 'a':
      case 'A':
        app.setAutoCamera(!app.autoCamera);
        app.notify(t(app.autoCamera ? 'app.autoCameraOn' : 'app.autoCameraOff'), 'info', 2500);
        break;
      case 'l':
      case 'L':
        void o.catchAircraft('landing');
        break;
      case 't':
      case 'T':
        void o.catchAircraft('takeoff');
        break;
      case 'v':
      case 'V':
        // Inside or outside.
        if (app.view === 'pov') o.toggleCameraGroup();
        break;
      default: {
        // 1-5 select a camera view while flying.
        const index = Number.parseInt(event.key, 10) - 1;
        const mode = CAMERA_MODES[index];
        if (app.view === 'pov' && mode) o.setCameraMode(mode.id);
      }
    }
  }

  /*
   * Fingers on the view. One finger looks around and a tap steps across, like
   * the mouse; two pinch the field of view, the way every phone zooms. While
   * two are down neither is a drag, or the view would lurch as the second
   * finger lands.
   */
  const touches = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;
  const spread = (): number => {
    const [a, b] = [...touches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  function onPointerDown(event: PointerEvent): void {
    if (app.view !== 'pov') return;
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size >= 2) {
        dragging = false;
        app.lookingAround = false;
        pinchDistance = spread();
        return;
      }
    }
    dragging = true;
    lastX = downX = event.clientX;
    lastY = downY = event.clientY;
    downAt = performance.now();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (app.view !== 'pov') return;
    const touch = touches.get(event.pointerId);
    if (touch) {
      touch.x = event.clientX;
      touch.y = event.clientY;
      if (touches.size >= 2) {
        const d = spread();
        // Spreading the fingers zooms in, as the wheel's negative delta does.
        if (pinchDistance > 0 && d > 0) orchestrator?.handleZoom((pinchDistance - d) * 4);
        pinchDistance = d;
        return;
      }
    }
    if (!dragging) {
      // Mouse only: a finger has no hover, and a tap is handled on release.
      if (event.pointerType === 'mouse') overTraffic = orchestrator?.hoverAt(event.clientX, event.clientY) ?? false;
      return;
    }
    // Past the click threshold this is a look around: the details card steps
    // aside until the button comes up. See `app.lookingAround`.
    if (!app.lookingAround && Math.hypot(event.clientX - downX, event.clientY - downY) >= 6) {
      app.lookingAround = true;
    }
    orchestrator?.handleDrag(event.clientX - lastX, event.clientY - lastY);
    lastX = event.clientX;
    lastY = event.clientY;
  }

  function onPointerUp(event: PointerEvent): void {
    const pinching = touches.size >= 2;
    touches.delete(event.pointerId);
    if (pinching) {
      // The finger left behind starts no drag and no tap.
      dragging = false;
      pinchDistance = 0;
      return;
    }
    const wasDragging = dragging;
    dragging = false;
    app.lookingAround = false;
    const still = Math.hypot(event.clientX - downX, event.clientY - downY) < 6;
    if (wasDragging && still && performance.now() - downAt < 500 && event.type === 'pointerup') {
      orchestrator?.clickAt(event.clientX, event.clientY);
    }
    const el = event.currentTarget as HTMLElement;
    if (el.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
  }

  function onWheel(event: WheelEvent): void {
    if (app.view !== 'pov') return;
    event.preventDefault();
    orchestrator?.handleZoom(event.deltaY);
  }

  // The store owns the pins; the map's markers follow it. `$state.snapshot`
  // hands the map plain objects rather than reactive proxies.
  $effect(() => {
    const pins = $state.snapshot(app.pins);
    orchestrator?.syncPins(pins);
  });
  $effect(() => {
    orchestrator?.setPinMode(app.pinMode && app.view === 'map');
  });

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
    class:clickable={overTraffic}
    bind:this={canvas}
    aria-hidden={app.view !== 'pov'}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onwheel={onWheel}
  ></canvas>

  <!-- Names and distances of the user's pins, drawn over the 3D view. -->
  <canvas class="surface pin-overlay" bind:this={pinOverlay} aria-hidden="true"></canvas>

  <div class="brackets" aria-hidden="true">
    <span></span><span></span><span></span><span></span>
  </div>

  {#if showLanding && !bootError}
    <Landing ready={!booting} onEnter={() => {
        rememberEntered(true);
        showLanding = false;
      }} />
  {/if}

  {#if booting}
    <div class="boot" class:hidden={showLanding}>
      <div class="spinner" aria-hidden="true"></div>
      <p>{t('app.finding')}</p>
    </div>
  {:else if bootError}
    <div class="boot error">
      <h1>{t('app.startFailed')}</h1>
      <p>{bootError}</p>
      <p class="hint">{t('app.needsWebgl2')}</p>
    </div>
  {:else if orchestrator}
    {#if app.view === 'map'}
      <header class="toolbar">
        <h1 class="brand" style="--i: 0">
          <button class="brand-home" onclick={goHome} title={t('app.homeTitle')} aria-label={t('app.homeTitle')}>
            <Logo size={22} /><span class="word">Planes<span>View</span></span>
          </button>
        </h1>

        <div class="dock" style="--i: 1" role="toolbar" aria-label={t('app.mapToolbar')}>
          <button class="tool" onclick={goHome} title={t('app.homeTitle')}>
            <Icon name="home" /><span class="text">{t('app.home')}</span>
          </button>
          <button
            class="tool"
            class:on={app.pinMode}
            aria-pressed={app.pinMode}
            onclick={() => (app.pinMode = !app.pinMode)}
            title={t('app.pinTitle')}
          >
            <Icon name="pin" /><span class="text">{t('app.pin')}</span>
            {#if app.pins.length > 0}<span class="count">{app.pins.length}</span>{/if}
          </button>
          <button class="tool" class:on={app.showLegend} onclick={() => (app.showLegend = !app.showLegend)} title={t('app.keyTitle')}>
            <Icon name="key" /><span class="text">{t('app.key')}</span>
          </button>
          <LanguagePicker tool />
          <ThemeToggle compact tool />
        </div>

        <div class="dock actions" style="--i: 2" role="toolbar" aria-label={t('app.goFlying')}>
          <button
            class="tool"
            disabled={app.shuffling}
            onclick={() => void orchestrator?.catchAircraft('landing')}
            title={t('app.catchLandingTitle')}
          ><Icon name="landing" /><span class="text">{t('app.catchLanding')}</span><span class="kbd">L</span></button>
          <button
            class="tool"
            disabled={app.shuffling}
            onclick={() => void orchestrator?.catchAircraft('takeoff')}
            title={t('app.catchTakeoffTitle')}
          ><Icon name="takeoff" /><span class="text">{t('app.catchTakeoff')}</span><span class="kbd">T</span></button>
        </div>
      </header>
      {#if app.pinMode && !app.cinema}
        <p class="pin-hint" role="status">
          <Icon name="pin" size={14} />
          <Rich key="app.pinHint" />
          {#if app.pins.length > 0}
            <button class="chip" onclick={() => app.clearPins()}>{t('app.removeAll')}</button>
          {/if}
        </p>
      {/if}
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
      <p class="cinema-hint" role="status"><Rich key="app.cinemaHint" /></p>
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
    color: var(--hud-text);
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
    pointer-events: none;
    animation: hint 2.5s ease-out forwards;
  }
  @keyframes hint {
    0%, 70% { opacity: 1; }
    100% { opacity: 0; }
  }


  .pin-hint {
    position: absolute;
    top: 64px;
    left: 16px;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    padding: 6px 10px 6px 14px;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--text);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-left: 2px solid #ffb347;
    backdrop-filter: blur(12px);
    animation: drop-in 0.35s var(--ease);
  }

  /* Only over the cockpit view, and fading with it. */
  .pin-overlay {
    z-index: 3;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.55s ease-out;
  }
  main.pov .pin-overlay { opacity: 1; }

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
  .globe.clickable { cursor: pointer; }
  main.pov .map { pointer-events: none; }
  /*
   * MapLibre's own stylesheet sets `pointer-events: auto` on its controls, so
   * they punch back through the container's `none` and keep taking clicks from
   * behind the cockpit view — including the attribution link, which navigates
   * away from the app entirely.
   */
  main.pov .map :global(.maplibregl-ctrl) { pointer-events: none; }

  /*
   * The map toolbar: the wordmark, then two docks — map tools, and the ways
   * to go flying. Each dock is one frosted console panel with its buttons
   * inside, rather than a row of loose chips, and the three pieces drop in
   * one after another when the map appears.
   */
  .toolbar {
    position: absolute;
    top: 16px;
    left: 16px;
    right: 16px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    z-index: 20;
    pointer-events: none;
  }
  .toolbar > * {
    pointer-events: auto;
    animation: drop-in 0.5s var(--ease) both;
    animation-delay: calc(var(--i, 0) * 70ms);
  }
  @keyframes drop-in {
    from { opacity: 0; transform: translateY(-10px); }
    to { opacity: 1; transform: none; }
  }

  .brand {
    margin: 0;
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--accent);
    padding: 10px 16px 10px 16px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-left: 2px solid var(--accent);
    backdrop-filter: blur(14px);
    box-shadow: var(--shadow), var(--glow);
  }
  .brand span { color: var(--text); font-weight: 400; }
  .brand { padding: 0; }
  .brand-home {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    padding: 8px 16px 8px 12px;
    border: 0;
    background: none;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    color: inherit;
    cursor: pointer;
  }
  .brand-home:hover .word { filter: brightness(1.2); }
  .brand-home:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  .dock {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 3px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    backdrop-filter: blur(14px) saturate(1.2);
    -webkit-backdrop-filter: blur(14px) saturate(1.2);
    box-shadow: var(--shadow);
    clip-path: polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 9px 100%, 0 calc(100% - 9px));
  }

  /* A button inside a dock. Also used by `ThemeToggle`. */
  .dock :global(.tool) {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 34px;
    padding: 0 12px;
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
    background: transparent;
    border: 0;
    transition: color 0.18s var(--ease), background 0.18s var(--ease);
  }
  /* The lit rule under a hovered or active tool grows from its centre. */
  .dock :global(.tool)::after {
    content: '';
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 3px;
    height: 2px;
    background: var(--accent);
    box-shadow: var(--glow-strong);
    transform: scaleX(0);
    transition: transform 0.25s var(--ease);
  }
  .dock :global(.tool:hover) { color: var(--accent); background: var(--hover-bg); }
  .dock :global(.tool:hover)::after { transform: scaleX(0.5); }
  .dock :global(.tool.on) { color: var(--accent); background: var(--active-bg); }
  .dock :global(.tool.on)::after { transform: scaleX(1); }
  .dock :global(.tool:hover .icon) { transform: translateY(-1px) scale(1.08); }
  .dock :global(.tool .icon) { transition: transform 0.25s var(--ease); }
  .dock :global(.tool:disabled) { opacity: 0.5; cursor: progress; }
  .dock .kbd { margin-left: 2px; opacity: 0.7; }

  .count {
    min-width: 17px;
    padding: 1px 5px;
    font-size: 9px;
    text-align: center;
    color: var(--on-accent);
    background: var(--accent);
    border-radius: 9px;
  }

  .actions { margin-left: auto; }

  @media (max-width: 1180px) {
    .actions .tool .text { display: none; }
  }
  @media (max-width: 760px) {
    .dock .text, .dock .kbd { display: none; }
    .actions { margin-left: 0; }
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
    filter: drop-shadow(0 0 6px rgb(var(--accent-rgb) / 0.5));
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
