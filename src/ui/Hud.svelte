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
  import { CAMERA_MODES } from '@/render/pov';
  import type { Orchestrator } from '@/app/orchestrator';
  import Attitude from './hud/Attitude.svelte';
  import Compass from './hud/Compass.svelte';
  import FlightCard from './hud/FlightCard.svelte';
  import Tapes from './hud/Tapes.svelte';

  let { orchestrator }: { orchestrator: Orchestrator } = $props();

  const sample = $derived(app.selected);
  const dossier = $derived(app.dossier);

  const callsign = $derived(
    sample?.latest.callsign ?? dossier?.meta?.registration ?? sample?.hex.toUpperCase() ?? '',
  );

  /*
   * The artificial horizon and the heading strip are *first-person*
   * instruments: they describe what the pilot sees out of the windscreen. In
   * chase, wing, orbit or tower the camera is not the pilot, so the horizon
   * line refers to an attitude the view does not have and the compass to a
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
  const degraded = $derived(
    app.network && app.network.grade !== 'fast' && app.network.grade !== 'good'
      ? profileFor(app.network.grade)
      : null,
  );
</script>

{#if sample}
  <div class="hud" aria-live="off">
    {#if firstPerson}
      <Attitude pitchDeg={sample.pitchDeg} rollDeg={sample.rollDeg} />
      <Compass headingDeg={sample.headingDeg} />
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

    <nav class="modes" aria-label="Camera view">
      {#each CAMERA_MODES as mode (mode.id)}
        <button
          class="chip"
          class:active={app.cameraMode === mode.id}
          onclick={() => orchestrator.setCameraMode(mode.id)}
          title={mode.hint}
        >{mode.label}</button>
      {/each}

      <!--
        The engine note, next to the camera modes because it is the same kind
        of control: it changes what the aircraft is like to be in rather than
        what the app is doing. Off by default — see `app.sound`.
      -->
      <button
        class="chip sound"
        class:active={app.sound}
        onclick={() => void orchestrator.setSound(!app.sound)}
        title={app.sound ? 'Mute the engines' : 'Hear the engines'}
        aria-pressed={app.sound}
      >{app.sound ? 'Sound on' : 'Sound off'}</button>
    </nav>

    <button class="chip exit" onclick={() => orchestrator.exitPov()}>
      <span class="kbd">Esc</span> Back to map
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
    text-shadow:
      0 1px 2px rgba(0, 0, 0, 0.95),
      0 0 6px rgba(0, 0, 0, 0.7);
  }

  /* Brighter than the app-wide label colour, which was tuned for dark panels
     and disappears entirely against sky. */
  .hud :global(.label) {
    color: #a8d8ee;
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
    background: rgba(3, 8, 14, 0.45);
    border: 1px solid var(--border);
    border-left: 2px solid var(--accent);
    backdrop-filter: blur(4px);
  }
  .callsign { font-size: 19px; font-weight: 700; letter-spacing: 0.12em; }
  .sub { font-size: 11.5px; color: var(--text-dim); letter-spacing: 0.06em; }

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
    color: #ffd7ab;
    background: rgba(255, 176, 46, 0.14);
    border: 1px solid rgba(255, 176, 46, 0.45);
  }
  .banner.info {
    color: #bfe9ff;
    background: rgba(127, 223, 255, 0.1);
    border: 1px solid var(--border);
  }

  .modes {
    position: absolute;
    bottom: 22px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 3px;
  }

  /* Set apart from the camera modes: it is a different kind of switch, and
     grouping it with them invites the eye to read it as a sixth view. */
  .sound { margin-left: 14px; }

  .exit { position: absolute; top: 18px; left: 24px; }
  .kbd {
    font-family: var(--mono);
    font-size: 9px;
    padding: 1px 4px;
    border: 1px solid var(--border);
    color: var(--accent);
  }
</style>
