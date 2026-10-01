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
  import { PHASE_LABELS, isLandingPhase, isTakeoffPhase } from '@/state/phase';
  import type { Orchestrator } from '@/app/orchestrator';
  import Attitude from './hud/Attitude.svelte';
  import Compass from './hud/Compass.svelte';
  import FlightCard from './hud/FlightCard.svelte';
  import Tapes from './hud/Tapes.svelte';
  import Icon, { type IconName } from './Icon.svelte';

  let { orchestrator }: { orchestrator: Orchestrator } = $props();

  const sample = $derived(app.selected);
  const dossier = $derived(app.dossier);

  const callsign = $derived(
    sample?.latest.callsign ?? dossier?.meta?.registration ?? sample?.hex.toUpperCase() ?? '',
  );

  /*
   * The artificial horizon and the heading strip are *first-person*
   * instruments: they describe what the pilot sees out of the windscreen. In
   * chase, wing or orbit the camera is not the pilot, so the horizon line
   * refers to an attitude the view does not have and the compass to a
   * heading it is not pointing along — and both are drawn straight across the
   * aircraft you came to look at. The tapes stay in every view, because speed
   * and altitude are facts about the aircraft rather than about the eye.
   */
  const firstPerson = $derived(app.cameraMode === 'cockpit');

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
  const countdown = $derived.by(() => {
    const s = app.touchdownInS;
    if (s === null || !(phase === 'final' || phase === 'approach')) return null;
    const whole = Math.max(0, Math.round(s));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
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
  const GROUPS: { id: CameraGroup; label: string; hint: string }[] = [
    { id: 'interior', label: 'Inside', hint: 'From inside the aircraft: the flight deck or a window seat' },
    { id: 'exterior', label: 'Outside', hint: 'Looking at the aircraft from outside' },
  ];
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

  const degraded = $derived(
    app.network && app.network.grade !== 'fast' && app.network.grade !== 'good'
      ? profileFor(app.network.grade)
      : null,
  );
</script>

{#if sample}
  <div class="hud" aria-live="off">
    <!-- With the 3D cockpit up, its own instruments show attitude and heading,
         redrawn every frame; these DOM ones refresh at the UI rate and would
         trail the view. -->
    {#if firstPerson && !app.cockpit3d}
      <Attitude pitchDeg={sample.pitchDeg} rollDeg={sample.rollDeg} />
      <Compass headingDeg={app.viewHeadingDeg} />
    {/if}
    <Tapes {sample} />

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
        {PHASE_LABELS[phase]}{#if countdown}<span class="eta"> · touchdown in {countdown}</span>{/if}
      </p>
    {/if}

    {#if event}
      {#key event.id}
        <p class="caption" aria-live="polite">{event.kind === 'liftoff' ? 'Liftoff' : 'Touchdown'}</p>
      {/key}
    {/if}

    <!-- Two different silences, deliberately worded differently. The first is
         about this aircraft, the second about the whole connection; conflating
         them sends the user looking for the wrong problem. -->
    {#if sample.stale}
      <p class="banner warn" role="status">
        Signal lost — this position is estimated, not received
      </p>
    {:else if degraded}
      <p class="banner info" role="status">{degraded.advice}</p>
    {/if}

    <FlightCard {sample} {orchestrator} />

    {#if toast}
      {#key toast.id}
        <div class="mode-toast" aria-live="polite">
          <Icon name={MODE_ICONS[toast.mode.id] ?? 'cockpit'} size={30} />
          <span>{toast.mode.label}</span>
        </div>
      {/key}
    {/if}

    <div class="bottom" class:faded={app.lookingAround}>
      <div class="views">
        <div class="groups" role="group" aria-label="Inside or outside">
          {#each GROUPS as group (group.id)}
            <button
              class="group"
              class:active={current.group === group.id}
              onclick={() => orchestrator.setCameraGroup(group.id)}
              title={`${group.hint} (V)`}
              aria-pressed={current.group === group.id}
            >
              {group.label}
            </button>
          {/each}
        </div>
        <nav class="modes" aria-label="Camera view" style="--index: {modeIndex}; --count: {groupModes.length}">
          <span class="slider" aria-hidden="true"></span>
          {#each groupModes as mode (mode.id)}
            <button
              class="mode"
              class:active={app.cameraMode === mode.id}
              onclick={() => orchestrator.setCameraMode(mode.id)}
              title={`${mode.hint} (${CAMERA_MODES.indexOf(mode) + 1})`}
              aria-pressed={app.cameraMode === mode.id}
            >
              <Icon name={MODE_ICONS[mode.id] ?? 'cockpit'} size={18} />
              <span>{mode.label}</span>
            </button>
          {/each}
        </nav>
      </div>

      <!--
        The engine note sits with the view controls because it is the same
        kind of switch: it changes what the aircraft is like to be in rather
        than what the app is doing. Off by default — see `app.sound`.
      -->
      <div class="utility">
        <button
          class="round"
          class:active={app.sound}
          onclick={() => void orchestrator.setSound(!app.sound)}
          title={app.sound ? 'Mute the engines' : 'Hear the engines'}
          aria-label={app.sound ? 'Mute the engines' : 'Hear the engines'}
          aria-pressed={app.sound}
        ><Icon name={app.sound ? 'sound' : 'mute'} size={17} /></button>
        <button
          class="round"
          class:active={app.autoCamera}
          onclick={() => app.setAutoCamera(!app.autoCamera)}
          title="Auto camera: pick the view for takeoffs and landings (A)"
          aria-label="Auto camera"
          aria-pressed={app.autoCamera}
        ><Icon name="auto" size={17} /></button>
        <button
          class="round"
          onclick={() => (app.cinema = true)}
          title="Fullscreen, nothing but the view (F)"
          aria-label="Fullscreen"
        ><Icon name="fullscreen" size={17} /></button>
      </div>
    </div>

    <button class="exit" onclick={() => orchestrator.exitPov()}>
      <Icon name="back" size={15} />
      <span>Back to map</span>
      <span class="kbd">Esc</span>
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
    /* Under the heading strip, above the warning banner. */
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

  .utility { display: flex; gap: 6px; }
  .round {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    color: var(--hud-dim);
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
    border-radius: 50%;
    backdrop-filter: blur(12px);
    transition: color 0.2s, border-color 0.2s, box-shadow 0.2s, transform 0.2s var(--ease);
  }
  .round:hover { color: var(--hud-accent); border-color: var(--hud-accent); transform: translateY(-2px); }
  .round.active { color: var(--hud-accent); border-color: var(--hud-accent); box-shadow: 0 0 14px rgb(var(--accent-rgb) / 0.35); }

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
    .bottom { gap: 6px; bottom: calc(12px + env(safe-area-inset-bottom)); max-width: calc(100vw - 16px); }
    .round { width: 40px; height: 40px; }
  }
  @media (max-width: 380px) {
    .utility .round:nth-child(2) { display: none; }
  }
  /* A phone on its side: no room for anything stacked. */
  @media (max-height: 480px) {
    .ident { display: none; }
    .bottom { bottom: calc(8px + env(safe-area-inset-bottom)); }
  }
</style>
