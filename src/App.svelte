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
  import { t } from '@/i18n/index.svelte';
  import Rich from '@/ui/Rich.svelte';
  import { dockFolded, rememberDockFolded } from '@/ui/dockMemory';
  import LanguagePicker from '@/ui/LanguagePicker.svelte';
  import Logo from '@/ui/Logo.svelte';
  import AircraftPanel from '@/ui/AircraftPanel.svelte';
  import Landing from '@/ui/intro/Landing.svelte';
  import ToolbarDock, { type DockItem } from '@/ui/ToolbarDock.svelte';
  import Diagnostics from '@/ui/Diagnostics.svelte';
  import Hud from '@/ui/Hud.svelte';
  import Legend from '@/ui/Legend.svelte';
  import Notices from '@/ui/Notices.svelte';
  import StatusBar from '@/ui/StatusBar.svelte';
  import Icon from '@/ui/Icon.svelte';
  import SearchBox from '@/ui/SearchBox.svelte';
  import { parseDeepLink, writeDeepLink } from '@/app/deepLink';
  import { currentLink, shareView } from '@/app/share';

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
  /** A link to an aircraft or a place: see `@/app/deepLink`. It skips the front page too. */
  const openingLink = parseDeepLink(location.hash);
  let showLanding = $state(!new URLSearchParams(location.search).has('go') && !openingLink && !hasEntered());

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
   * gesture or button — leaves cinema too, so the two can never disagree.
   *
   * The way out is a button, like a video player's: it shows whenever the
   * mouse moves or the screen is touched, and fades with the cursor.
   */
  let idle = $state(false);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (app.cinema) {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => undefined);
      }
      wakeCursor();
    } else {
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

  /** The cursor and the way out hide after a moment of stillness in cinema, like a video. */
  function wakeCursor(): void {
    idle = false;
    clearTimeout(idleTimer);
    if (app.cinema) idleTimer = setTimeout(() => (idle = true), 2500);
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
      .start(mapContainer, canvas, pinOverlay, openingLink)
      .then(() => {
        orchestrator = instance;
        booting = false;
      })
      .catch((err: unknown) => {
        bootError = err instanceof Error ? err.message : String(err);
        booting = false;
      });

    /*
     * Leaving the site. A closed tab frees everything by itself, but one the
     * browser keeps frozen for the Back button (the back/forward cache) would
     * keep the whole globe — the GPU's terrain, the decoded tiles, the polling
     * — alive in the background. So on the way out it is all let go, and a
     * return through Back starts the page afresh instead of thawing a
     * half-dismantled one.
     */
    const onLeave = (event: PageTransitionEvent): void => {
      if (event.persisted) instance.dispose();
    };
    const onReturn = (event: PageTransitionEvent): void => {
      if (event.persisted) location.reload();
    };
    addEventListener('pagehide', onLeave);
    addEventListener('pageshow', onReturn);

    return () => {
      removeEventListener('pagehide', onLeave);
      removeEventListener('pageshow', onReturn);
      instance.dispose();
    };
  });

  /*
   * No keyboard shortcuts: everything is a button in a dock, because nobody
   * browsing a website reaches for the keyboard and a phone has none. Escape
   * alone is kept, as every web page keeps it — it closes whatever is on top,
   * one thing per press, and never both dismisses a panel and ejects the user.
   */
  function onKeydown(event: KeyboardEvent): void {
    if (showLanding || event.key !== 'Escape') return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    const o = orchestrator;
    if (!o) return;
    if (app.cinema) app.cinema = false;
    else if (langOpen) langOpen = false;
    else if (app.pinMode) app.pinMode = false;
    else if (app.showLegend) app.showLegend = false;
    else if (app.view === 'pov') o.exitPov();
    else if (app.selectedHex) void o.select(null);
  }

  /*
   * The map's dock: going flying first, then the map's own tools. Folded or
   * open is remembered per visitor (see `@/ui/dockMemory`).
   */
  let langOpen = $state(false);
  let mapDockFolded = $state(dockFolded('map', false));
  $effect(() => rememberDockFolded('map', mapDockFolded));
  const mapDock = $derived<DockItem[]>([
    {
      id: 'landing',
      label: t('app.catchLanding'),
      icon: 'landing',
      disabled: app.shuffling,
      onclick: () => void orchestrator?.catchAircraft('landing'),
    },
    {
      id: 'takeoff',
      label: t('app.catchTakeoff'),
      icon: 'takeoff',
      disabled: app.shuffling,
      onclick: () => void orchestrator?.catchAircraft('takeoff'),
    },
    {
      id: 'pin',
      label: t('app.pin'),
      icon: 'pin',
      active: app.pinMode,
      badge: app.pins.length || undefined,
      onclick: () => (app.pinMode = !app.pinMode),
    },
    { id: 'share', label: t('share.button'), icon: 'share', onclick: () => void shareView() },
    {
      id: 'legend',
      label: t('legend.title'),
      icon: 'help',
      active: app.showLegend,
      onclick: () => (app.showLegend = !app.showLegend),
    },
    {
      id: 'theme',
      label: t(app.theme === 'dark' ? 'theme.toLight' : 'theme.toDark'),
      icon: app.theme === 'dark' ? 'sun' : 'moon',
      onclick: () => app.setTheme(app.theme === 'dark' ? 'light' : 'dark', false),
    },
    { id: 'language', label: t('lang.title'), icon: 'globe', active: langOpen, onclick: () => (langOpen = !langOpen) },
  ]);

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

  /*
   * The address bar follows the view, so copying it at any moment gives a
   * link to exactly what is on screen. Not while the front page is up (a
   * reload there should come back to it), and not while a shared link is
   * still being looked up, or the map's first move would overwrite it.
   */
  $effect(() => {
    if (showLanding || booting || app.linkPending) return;
    writeDeepLink(currentLink());
  });
  // Our own writes replace the entry and fire nothing; this is a link
  // pasted into the address bar, or Back to one.
  onMount(() => {
    const onHash = (): void => {
      const link = parseDeepLink(location.hash);
      if (!link || !orchestrator) return;
      if (showLanding) {
        rememberEntered(true);
        showLanding = false;
      }
      orchestrator.openLink(link);
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  });

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

        <div class="search-slot" style="--i: 1"><SearchBox {orchestrator} /></div>

      </header>
      <div class="dock-area" class:behind={app.selectedHex !== null}>
        <ToolbarDock
          items={mapDock}
          label={t('app.mapToolbar')}
          openLabel={t('dock.open')}
          closeLabel={t('dock.close')}
          bind:collapsed={mapDockFolded}
        />
        <div class="lang-slot"><LanguagePicker bare bind:open={langOpen} /></div>
      </div>
      {#if app.pinMode && !app.cinema}
        <p class="pin-hint" role="status">
          <Icon name="pin" size={14} />
          <Rich key="app.pinHint" />
          {#if app.pins.length > 0}
            <button class="chip" onclick={() => app.clearPins()}>{t('app.removeAll')}</button>
          {/if}
          <button class="chip done" onclick={() => (app.pinMode = false)}>{t('app.pinDone')}</button>
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
    {:else}
      <button class="cinema-exit" class:asleep={idle} onclick={() => (app.cinema = false)}>
        <Icon name="close" size={15} /><span>{t('app.cinemaExit')}</span>
      </button>
    {/if}
  {/if}
</main>

<style>
  main { position: relative; width: 100%; height: 100%; overflow: hidden; }
  main.idle, main.idle :global(canvas) { cursor: none; }
  main.cinema { touch-action: manipulation; }

  main.cinema .toolbar,
  main.cinema .brackets { display: none; }

  .cinema-exit {
    position: absolute;
    top: calc(16px + env(safe-area-inset-top));
    right: calc(16px + env(safe-area-inset-right));
    z-index: 30;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 9px 14px 9px 11px;
    font: 600 11px/1 var(--mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--hud-text);
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
    border-radius: 999px;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    transition: opacity 0.4s var(--ease);
  }
  .cinema-exit:hover { border-color: var(--hud-accent); color: var(--hud-accent); }
  .cinema-exit.asleep { opacity: 0; pointer-events: none; }


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

  .search-slot { display: contents; }

  /*
   * The dock floats at the bottom centre of the map, clear of the aircraft
   * panel on the right and the feed status on the left; the language list
   * opens above it.
   */
  .dock-area {
    position: absolute;
    left: 50%;
    bottom: calc(18px + env(safe-area-inset-bottom));
    z-index: 21;
    transform: translateX(-50%);
    animation: dock-in 0.5s var(--ease) 0.2s both;
  }
  @keyframes dock-in {
    from { opacity: 0; transform: translate(-50%, 14px); }
  }
  .lang-slot { position: absolute; right: 0; bottom: 100%; }
  .lang-slot :global(.menu) { top: auto; bottom: 10px; }

  .pin-hint .done { color: var(--accent); }

  /* A phone: the aircraft sheet takes the bottom; the dock waits under it. */
  @media (max-width: 640px) {
    .dock-area.behind { display: none; }
  }
  /* Too narrow to share the bottom row with the feed status: the dock sits above it. */
  @media (max-width: 900px) {
    .dock-area { bottom: calc(58px + env(safe-area-inset-bottom)); }
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
