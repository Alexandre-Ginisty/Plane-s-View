<!--
  Cockpit HUD.

  Pure DOM and SVG, overlaid on the WebGL canvas rather than drawn inside it.
  Text rendered into a 3D scene has to live in a texture atlas, which costs a
  re-upload whenever a digit changes and still ends up blurry under any
  perspective. The browser's own text rasteriser is sharper, free, and
  accessible to a screen reader.

  Numbers update at the store's 10 Hz, not the render loop's 60. A HUD digit
  changing sixty times a second is unreadable anyway, and it would force a
  Svelte pass every frame.

  This file is the layout and the chrome; the instruments are in `hud/`.
-->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import { profileFor } from '@/net/quality';
  import { CAMERA_MODES, type CameraGroup } from '@/render/pov';
  import { isLandingPhase, isTakeoffPhase } from '@/state/phase';
  import { t } from '@/i18n/index.svelte';
  import { cameraHint, cameraLabel, gradeAdvice, groupHint, groupLabel, phaseLabel } from './labels';
  import type { Orchestrator } from '@/app/orchestrator';
  import FlightCard from './hud/FlightCard.svelte';
  import Tapes from './hud/Tapes.svelte';
  import MiniMap from './hud/MiniMap.svelte';
  import Icon, { type IconName } from './Icon.svelte';
  import { shareView } from '@/app/share';
  import { hasGyro } from '@/app/gyro';
  import ToolbarDock, { type DockItem } from './ToolbarDock.svelte';
  import { dockFolded, rememberDockFolded } from './dockMemory';

  const gyroAvailable = hasGyro();

  let { orchestrator }: { orchestrator: Orchestrator } = $props();

  const sample = $derived(app.selected);
  const dossier = $derived(app.dossier);

  const callsign = $derived(
    sample?.latest.callsign ?? dossier?.meta?.registration ?? sample?.hex.toUpperCase() ?? '',
  );

  /*
   * Only when the *link* is what is constraining the picture.
   *
   * Keyed on the measured grade, not the effective profile. Once the detail
   * ceiling existed, a user on a strong connection who had left the app on
   * standard detail got a profile graded `slow` and this banner announced
   * "Detail reduced so the ground finishes loading instead of stalling" across
   * the middle of their cockpit — blaming a connection that was fine for a
   * setting they had chosen. An explanation that names the wrong cause is
   * worse than no explanation.
   */
  /*
   * The phase, and a countdown when there is one to give.
   *
   * Takeoff and landing get the accent: they are what someone stepping into
   * an aircraft most hopes to catch, and saying "Final approach · touchdown in
   * 0:48" turns a minute of descent into something to watch for.
   */
  const phase = $derived(app.phase);
  const moment = $derived(isTakeoffPhase(phase) || isLandingPhase(phase));
  /*
   * Far out, minutes: nobody needs to know it is 3:47 rather than 3:52, and a
   * number that precise invites watching it wobble. Inside two minutes the
   * clock counts down by the second — see `TouchdownClock`, which makes sure
   * it only ever goes down.
   */
  const countdown = $derived.by(() => {
    const s = app.touchdownInS;
    if (s === null || !(phase === 'final' || phase === 'approach')) return null;
    if (s > 120) return t('hud.touchdownAbout', { min: Math.round(s / 60) });
    const whole = Math.max(0, Math.ceil(s));
    return t('hud.touchdownIn', { time: `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}` });
  });

  /*
   * Liftoff and touchdown, as a caption that plays once.
   *
   * Keyed on the event id so the next one replays the animation; ignored when
   * old, so reopening the HUD (leaving cinema mode, say) does not replay a
   * touchdown from a minute ago.
   */
  const event = $derived(
    app.phaseEvent && Date.now() - app.phaseEvent.at < 3500 ? app.phaseEvent : null,
  );

  const MODE_ICONS: Record<string, IconName> = { cockpit: 'cockpit', cabin: 'window', chase: 'chase', wing: 'wing', orbit: 'orbit' };

  /*
   * Two groups of views: from inside the aircraft (the flight deck, a window
   * seat) and from outside it. The group is the first choice; the view within
   * it the second, and each group remembers the last one picked, so going
   * outside and back in returns to the same seat.
   */
  const GROUPS: { id: CameraGroup }[] = [{ id: 'interior' }, { id: 'exterior' }];
  const current = $derived(CAMERA_MODES.find((m) => m.id === app.cameraMode) ?? CAMERA_MODES[0]!);
  const groupModes = $derived(CAMERA_MODES.filter((m) => m.group === current.group));
  const modeIndex = $derived(Math.max(0, groupModes.findIndex((m) => m.id === app.cameraMode)));

  /*
   * A change of view is announced in the middle of the screen for a moment —
   * the icon and the name — while the camera glides to its new place. Keyed
   * on a counter so switching twice quickly replays it.
   */
  let toast = $state<{ id: number; mode: (typeof CAMERA_MODES)[number] } | null>(null);
  let toastId = 0;
  let lastMode: string | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const mode = app.cameraMode;
    if (lastMode !== null && lastMode !== mode) {
      const info = CAMERA_MODES.find((m) => m.id === mode);
      if (info) {
        toast = { id: ++toastId, mode: info };
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => (toast = null), 1400);
      }
    }
    lastMode = mode;
  });

  /* The running clip's length, ticking once a second while it records. */
  let now = $state(performance.now());
  $effect(() => {
    if (app.recordingSince === null) return;
    const timer = setInterval(() => (now = performance.now()), 500);
    return () => clearInterval(timer);
  });
  const clipTime = $derived.by(() => {
    if (app.recordingSince === null) return null;
    const s = Math.max(0, Math.floor((now - app.recordingSince) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

  /*
   * The view's tools, in one dock that folds into its menu button: on a phone
   * it starts folded, so the view is the view.
   */
  let toolsFolded = $state(dockFolded('hud'));
  $effect(() => rememberDockFolded('hud', toolsFolded));
  const tools = $derived<DockItem[]>([
    {
      id: 'sound',
      label: t(app.sound ? 'hud.muteEngines' : 'hud.hearEngines'),
      icon: app.sound ? 'sound' : 'mute',
      active: app.sound,
      onclick: () => void orchestrator.setSound(!app.sound),
    },
    {
      id: 'auto',
      label: t('hud.autoCamera'),
      icon: 'auto',
      active: app.autoCamera,
      onclick: () => {
        app.setAutoCamera(!app.autoCamera);
        app.notify(t(app.autoCamera ? 'app.autoCameraOn' : 'app.autoCameraOff'), 'info', 2500);
      },
    },
    ...(gyroAvailable
      ? [{ id: 'gyro', label: t('hud.gyro'), icon: 'gyro', active: app.gyro, onclick: () => void orchestrator.setGyro(!app.gyro) } satisfies DockItem]
      : []),
    { id: 'recentre', label: t('ctl.recentre'), icon: 'recentre', onclick: () => orchestrator.recentreView() },
    { id: 'photo', label: t('capture.photo'), icon: 'camera', onclick: () => void orchestrator.takePhoto() },
    {
      id: 'record',
      label: t(clipTime !== null ? 'capture.stop' : 'capture.record'),
      icon: clipTime !== null ? 'stop' : 'record',
      alert: clipTime !== null,
      onclick: () => void orchestrator.toggleRecording(),
    },
    { id: 'share', label: t('share.button'), icon: 'share', onclick: () => void shareView() },
    { id: 'fullscreen', label: t('hud.fullscreen'), icon: 'fullscreen', onclick: () => (app.cinema = true) },
  ]);

  /* The minimap's state, so the wind and heading block can sit above it. */
  let mapFolded = $state(dockFolded('minimap', false));
  let mapLarge = $state(false);

  const degraded = $derived(
    app.network && app.network.grade !== 'fast' && app.network.grade !== 'good'
      ? profileFor(app.network.grade)
      : null,
  );
</script>

{#if sample}
  <div class="hud" class:with-map={!mapFolded} class:map-large={!mapFolded && mapLarge} aria-live="off">
    <Tapes {sample} />
    <MiniMap {sample} {orchestrator} bind:folded={mapFolded} bind:large={mapLarge} />

    <div class="ident">
      <span class="callsign">{callsign}</span>
      {#if dossier?.meta?.icaoTypeCode}<span class="sub">{dossier.meta.icaoTypeCode}</span>{/if}
      {#if dossier?.route?.origin || dossier?.route?.destination}
        <span class="sub">
          {dossier.route.origin?.iata ?? dossier.route.origin?.icao ?? '···'}
          →
          {dossier.route.destination?.iata ?? dossier.route.destination?.icao ?? '···'}
        </span>
      {/if}
    </div>

    {#if phase}
      <p class="phase" class:moment role="status">
        {phaseLabel(phase)}{#if countdown}<span class="eta"> · {countdown}</span>{/if}
      </p>
    {/if}

    {#if event}
      {#key event.id}
        <p class="caption" aria-live="polite">{t(event.kind === 'liftoff' ? 'hud.liftoff' : 'hud.touchdown')}</p>
      {/key}
    {/if}

    <!-- Two different silences, deliberately worded differently. The first is
         about this aircraft, the second about the whole connection; conflating
         them sends the user looking for the wrong problem. -->
    {#if sample.stale}
      <p class="banner warn" role="status">
        {t('hud.signalLost')}
      </p>
    {:else if degraded}
      <p class="banner info" role="status">{gradeAdvice(degraded.grade)}</p>
    {/if}

    <FlightCard {sample} {orchestrator} />

    {#if toast}
      {#key toast.id}
        <div class="mode-toast" aria-live="polite">
          <Icon name={MODE_ICONS[toast.mode.id] ?? 'cockpit'} size={30} />
          <span>{cameraLabel(toast.mode.id)}</span>
        </div>
      {/key}
    {/if}

    <div class="bottom" class:faded={app.lookingAround}>
      <div class="views">
        <div class="groups" role="group" aria-label={t('hud.viewGroups')}>
          {#each GROUPS as group (group.id)}
            <button
              class="group"
              class:active={current.group === group.id}
              onclick={() => orchestrator.setCameraGroup(group.id)}
              title={groupHint(group.id)}
              aria-pressed={current.group === group.id}
            >
              {groupLabel(group.id)}
            </button>
          {/each}
        </div>
        <nav class="modes" aria-label={t('hud.cameraView')} style="--index: {modeIndex}; --count: {groupModes.length}">
          <span class="slider" aria-hidden="true"></span>
          {#each groupModes as mode (mode.id)}
            <button
              class="mode"
              class:active={app.cameraMode === mode.id}
              onclick={() => orchestrator.setCameraMode(mode.id)}
              title={cameraHint(mode.id)}
              aria-pressed={app.cameraMode === mode.id}
            >
              <Icon name={MODE_ICONS[mode.id] ?? 'cockpit'} size={18} />
              <span>{cameraLabel(mode.id)}</span>
            </button>
          {/each}
        </nav>
      </div>

      <!--
        The tools sit with the view controls but apart from them: they change
        what the aircraft is like to be in, or keep a moment of it, rather than
        where the camera is.
      -->
      <ToolbarDock
        items={tools}
        label={t('hud.tools')}
        openLabel={t('dock.open')}
        closeLabel={t('dock.close')}
        hud
        bind:collapsed={toolsFolded}
      />
    </div>

    {#if clipTime !== null}
      <p class="rec" role="status"><span class="dot" aria-hidden="true"></span>{t('capture.recording', { time: clipTime })}</p>
    {/if}

    <button class="exit" onclick={() => orchestrator.exitPov()}>
      <Icon name="back" size={15} />
      <span>{t('hud.backToMap')}</span>
    </button>
  </div>
{/if}

<style>
  .hud {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 15;
    font-family: var(--mono);
    /*
     * The HUD sits over whatever the camera is pointed at — noon Mediterranean
     * haze one second, night ocean the next — so it cannot rely on the
     * background for contrast. A tight dark shadow on every glyph keeps thin
     * strokes readable against a white cloud top without needing a scrim that
     * would hide the view.
     */
    color: var(--hud-text);
    text-shadow: var(--hud-halo);
  }

  /* Brighter than the app-wide label colour, which was tuned for dark panels
     and disappears entirely against sky. */
  .hud :global(.label) {
    color: var(--hud-label);
    font-weight: 700;
  }
  /*
   * `:global`, and it has to be.
   *
   * Svelte scopes a selector to the markup of the component it is written in,
   * so a bare `.hud button` matched the mode chips and the exit button here
   * and nothing inside a child component. The flight card's own toggle is a
   * direct child of `<FlightCard>`, so it never got this rule, inherited the
   * `pointer-events: none` above, and was simply dead: the card opened on
   * entering the cockpit and "Hide details" did nothing for the rest of the
   * session.
   */
  .hud :global(button) { pointer-events: auto; }

  .ident {
    position: absolute;
    top: 62px;
    left: 28px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 12px;
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
    border-left: 2px solid var(--hud-accent);
    backdrop-filter: blur(6px);
  }
  /*
   * The wind and heading block stands on the minimap's corner when it is
   * open; enlarged, or on a short screen where it would reach the speed tape,
   * it gives way — its figures are all in the details card too.
   */
  .hud.with-map :global(.environment) { bottom: 204px; }
  .hud.map-large :global(.environment) { display: none; }
  @media (max-height: 760px) {
    .hud.with-map :global(.environment) { display: none; }
  }

  .callsign { font-size: 19px; font-weight: 700; letter-spacing: 0.12em; }
  .sub { font-size: 11.5px; color: var(--hud-dim); letter-spacing: 0.06em; }

  .banner {
    position: absolute;
    top: 96px;
    left: 50%;
    transform: translateX(-50%);
    margin: 0;
    padding: 5px 14px;
    font-size: 11px;
    letter-spacing: 0.06em;
    max-width: min(520px, calc(100vw - 48px));
    text-align: center;
  }
  .banner.warn {
    color: var(--warn-text);
    background: color-mix(in srgb, var(--hud-bg) 70%, rgb(var(--warm-rgb)) 30%);
    border: 1px solid rgb(var(--warm-rgb) / 0.5);
  }
  .banner.info {
    color: var(--hud-text);
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
  }

  .phase {
    position: absolute;
    /* Top centre, above the warning banner. */
    top: 60px;
    left: 50%;
    transform: translateX(-50%);
    margin: 0;
    padding: 4px 12px;
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--hud-dim);
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
    white-space: nowrap;
    transition: color 0.4s, border-color 0.4s;
  }
  .phase.moment {
    color: var(--hud-accent);
    border-color: var(--hud-accent);
    box-shadow: var(--glow);
  }
  .eta { text-transform: none; letter-spacing: 0.06em; color: var(--hud-text); }

  .caption {
    position: absolute;
    top: 30%;
    left: 50%;
    transform: translateX(-50%);
    margin: 0;
    font-size: clamp(28px, 5vw, 52px);
    font-weight: 300;
    letter-spacing: 0.4em;
    text-transform: uppercase;
    color: var(--hud-text);
    opacity: 0;
    animation: caption 3.2s ease-out forwards;
  }
  @keyframes caption {
    0% { opacity: 0; letter-spacing: 0.6em; }
    15% { opacity: 0.95; letter-spacing: 0.4em; }
    70% { opacity: 0.95; }
    100% { opacity: 0; letter-spacing: 0.34em; }
  }
  @media (prefers-reduced-motion: reduce) {
    .caption { animation-duration: 2.5s; letter-spacing: 0.4em; }
  }

  /*
   * The view controls: a segmented dock of camera modes, with a lit slider
   * that glides to the chosen one, and the utilities beside it as round
   * buttons — a different kind of switch, kept visibly apart so nobody reads
   * the sound as a fifth view. The whole strip dims while the view is being
   * dragged, like the details card.
   */
  .bottom {
    position: absolute;
    bottom: 22px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 14px;
    text-shadow: none;
    transition: opacity 0.3s var(--ease), transform 0.3s var(--ease);
    animation: rise-in 0.5s var(--ease) both;
  }
  .bottom.faded { opacity: 0.25; transform: translateX(-50%) translateY(6px); }
  @keyframes rise-in {
    from { opacity: 0; transform: translateX(-50%) translateY(12px); }
  }

  .views { display: flex; align-items: stretch; gap: 6px; }
  .groups {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px;
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    clip-path: polygon(0 0, 100% 0, 100% 100%, 10px 100%, 0 calc(100% - 10px));
  }
  .group {
    flex: 1;
    padding: 0 12px;
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--hud-dim);
    border-left: 2px solid transparent;
    transition: color 0.2s, border-color 0.2s, background 0.2s;
  }
  .group:hover { color: var(--hud-text); }
  .group.active { color: var(--hud-accent); border-left-color: var(--hud-accent); background: rgb(var(--accent-rgb) / 0.1); }
  .modes {
    --w: 92px;
    position: relative;
    display: grid;
    grid-template-columns: repeat(var(--count), var(--w));
    padding: 4px;
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
  }
  .slider {
    position: absolute;
    top: 4px;
    bottom: 4px;
    left: 4px;
    width: var(--w);
    background: var(--hud-accent);
    box-shadow: 0 0 18px rgb(var(--accent-rgb) / 0.45);
    transform: translateX(calc(var(--index) * var(--w)));
    transition: transform 0.42s cubic-bezier(0.34, 1.4, 0.64, 1);
  }
  .mode {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: 7px 4px 6px;
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--hud-dim);
    transition: color 0.25s var(--ease);
  }
  .mode :global(.icon) { transition: transform 0.35s var(--ease); }
  .mode:hover { color: var(--hud-text); }
  .mode:hover :global(.icon) { transform: translateY(-2px); }
  .mode.active { color: var(--on-accent); }
  .mode.active :global(.icon) { transform: scale(1.12); }


  .rec {
    position: absolute;
    top: 18px;
    right: 24px;
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--hud-text);
    background: var(--hud-bg);
    border: 1px solid rgb(255 90 79 / 0.6);
  }
  .rec .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #ff5a4f;
    animation: blink 1s steps(2, start) infinite;
  }
  @keyframes blink { to { visibility: hidden; } }

  .mode-toast {
    position: absolute;
    left: 50%;
    top: 40%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--hud-text);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.4em;
    text-transform: uppercase;
    pointer-events: none;
    animation: toast 1.4s var(--ease) forwards;
  }
  .mode-toast :global(.icon) { filter: drop-shadow(0 0 10px rgb(var(--accent-rgb) / 0.6)); color: var(--hud-accent); }
  @keyframes toast {
    0% { opacity: 0; transform: translate(-50%, -40%) scale(0.85); filter: blur(4px); }
    18% { opacity: 1; transform: translate(-50%, -50%) scale(1); filter: blur(0); }
    70% { opacity: 1; }
    100% { opacity: 0; transform: translate(-50%, -56%) scale(1.03); }
  }

  .exit {
    position: absolute;
    top: 18px;
    left: 24px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px 7px 10px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--hud-text);
    text-shadow: none;
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
    backdrop-filter: blur(12px);
    transition: border-color 0.2s, color 0.2s;
  }
  .exit :global(.icon) { transition: transform 0.25s var(--ease); }
  .exit:hover { color: var(--hud-accent); border-color: var(--hud-accent); }
  .exit:hover :global(.icon) { transform: translateX(-3px); }

  /*
   * A phone. One row along the top — the way out, the phase, the details
   * toggle (in FlightCard) — the identity under it, and the dock along the
   * bottom clear of the home indicator. Every target at least 40 px.
   */
  @media (max-width: 720px) {
    .exit {
      top: calc(10px + env(safe-area-inset-top));
      left: calc(10px + env(safe-area-inset-left));
      padding: 10px 11px;
    }
    .exit span { display: none; }
    .ident { top: calc(62px + env(safe-area-inset-top)); left: calc(10px + env(safe-area-inset-left)); padding: 5px 9px; }
    .callsign { font-size: 15px; }
    .sub { font-size: 10px; }
    .phase {
      top: calc(18px + env(safe-area-inset-top));
      max-width: calc(100vw - 200px);
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 9.5px;
      padding: 4px 8px;
    }
    .eta { display: none; }
    .banner { top: calc(112px + env(safe-area-inset-top)); font-size: 10px; }
    .modes { --w: 52px; }
    .group { padding: 0 8px; font-size: 9px; }
    .mode { padding: 9px 4px; }
    .mode span { display: none; }
    /* Two rows: the switches above, the views under the thumb. */
    .bottom {
      flex-wrap: wrap-reverse;
      justify-content: center;
      gap: 8px 6px;
      bottom: calc(12px + env(safe-area-inset-bottom));
      width: calc(100vw - 16px);
    }
  }
  @media (max-width: 520px) {
    .rec { top: calc(60px + env(safe-area-inset-top)); right: calc(10px + env(safe-area-inset-right)); }
  }
  /* A phone on its side: no room for anything stacked. */
  @media (max-height: 480px) {
    .ident { display: none; }
    .bottom { bottom: calc(8px + env(safe-area-inset-bottom)); }
  }
</style>
