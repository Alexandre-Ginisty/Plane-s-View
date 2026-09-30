<!--
  Key and controls.

  The app had no legend at all, which made two things unknowable by looking:
  what the aircraft colours mean, and that the keyboard does anything. Both are
  the kind of thing a user either learns in five seconds or never learns, so
  they live behind one key and one always-visible button rather than in a
  README nobody opens.

  Deliberately plain English. Everything else on screen is a cockpit readout in
  mono capitals; this is the one surface whose job is to be understood on the
  first read, so it is the one surface that does not perform.
-->
<script lang="ts">
  import { SANDBOX_ENABLED } from '@/sandbox/enabled';
  import { app } from '@/state/appStore.svelte';
  import { CAMERA_MODES } from '@/render/pov';
  import { TRAFFIC_LEGEND } from './palette';

  /*
   * Built from `CAMERA_MODES`, not typed out.
   *
   * The number keys index that array directly (see `App.svelte`), and the
   * hand-written version had drifted out of step with it: it promised
   * "cockpit, wing, chase, tower, free" against the real order — two keys
   * transposed and two simply wrong. A help panel that misstates the controls
   * is worse than no help panel, and the only way it stays right is by not
   * being written down twice.
   */
  const cameraKeys = CAMERA_MODES.map((mode) => mode.label.toLowerCase()).join(', ');

  const KEYS: readonly { key: string; does: string }[] = [
    { key: 'Click', does: 'Select an aircraft on the map' },
    { key: 'Enter', does: 'Step inside the selected aircraft' },
    { key: 'Esc', does: 'Leave the cockpit, or clear the selection' },
    { key: 'Drag', does: 'Look around: the camera goes the way you drag' },
    { key: 'Wheel', does: 'Zoom — nearer or further outside, a longer lens in the cockpit' },
    { key: 'Click', does: 'A framed aircraft in 3D: fly across to it' },
    { key: `1 – ${CAMERA_MODES.length}`, does: `Switch camera: ${cameraKeys}` },
    { key: 'V', does: 'Inside or outside: the flight deck and a window seat, or the views of the aircraft' },
    { key: 'C', does: 'Re-centre the view' },
    { key: 'P', does: 'Pin mode: click the map to mark places you want to see from the air' },
    { key: 'Right-click', does: 'Drop a pin on the map at any time' },
    { key: 'L', does: 'Catch a landing: step into an aircraft on final approach' },
    { key: 'T', does: 'Catch a takeoff: step into an aircraft on the runway or climbing out' },
    { key: 'A', does: 'Auto camera: pick the view for takeoffs and landings' },
    ...(SANDBOX_ENABLED
      ? [
          { key: 'B', does: 'Sandbox: spawn your own armed aircraft anywhere and shoot down real traffic' },
          { key: '↑ ↓ ← →', does: 'Sandbox: climb, dive, turn' },
          { key: 'Space', does: 'Sandbox: fire at the locked target (Tab or click to choose one)' },
          { key: 'Shift', does: 'Sandbox: boost (Ctrl slows down, or hovers a helicopter)' },
        ]
      : []),
    { key: 'F', does: 'Fullscreen, with nothing but the view' },
    { key: 'D', does: 'Show the performance and connection counters' },
    { key: 'H', does: 'Show or hide this panel' },
  ];
</script>

{#if app.showLegend}
  <div class="panel legend" role="dialog" aria-label="Key and controls">
    <header>
      <h2>Key &amp; controls</h2>
      <button class="close" onclick={() => (app.showLegend = false)} aria-label="Close">×</button>
    </header>

    <section>
      <p class="label">Aircraft colour</p>
      <ul class="swatches">
        {#each TRAFFIC_LEGEND as entry (entry.meaning)}
          <li>
            <span class="swatch" style="background: {entry.color}"></span>
            <span>{entry.meaning}</span>
          </li>
        {/each}
      </ul>
      <p class="note">
        Helicopters are drawn with a rotor instead of wings — shape tells you
        what it is, colour tells you what it is doing.
      </p>
    </section>

    <section>
      <p class="label">Controls</p>
      <dl class="keys">
        {#each KEYS as entry, i (i)}
          <div><dt>{entry.key}</dt><dd>{entry.does}</dd></div>
        {/each}
      </dl>
      <label class="toggle">
        <input type="checkbox" checked={app.invertY} onchange={(e) => app.setInvertY(e.currentTarget.checked)} />
        <span>Invert vertical drag (drag down to look up)</span>
      </label>
    </section>

    <section>
      <p class="label">If the ground looks soft</p>
      <p class="note">
        The terrain detail follows your connection. On a weak link the app
        deliberately loads a coarser picture, because a complete blurry ground
        looks better — and stays smoother — than a sharp one full of holes. The
        status bar says which it has chosen.
      </p>
    </section>
  </div>
{/if}

<style>
  .legend {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(440px, calc(100vw - 32px));
    max-height: calc(100vh - 96px);
    overflow-y: auto;
    padding: 18px 20px 20px;
    z-index: 60;
    font-family: var(--sans);
  }

  header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  h2 {
    margin: 0;
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .close { font-size: 20px; line-height: 1; color: var(--text-faint); }
  .close:hover { color: var(--text); }

  section { margin-top: 18px; }
  section .label { margin: 0 0 8px; }

  .swatches { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .swatches li { display: flex; align-items: center; gap: 10px; font-size: 12.5px; }
  .swatch {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    /* A blade shape rather than a square: it matches the marks on screen. */
    clip-path: polygon(50% 0, 100% 100%, 50% 78%, 0 100%);
  }

  .keys { margin: 0; display: grid; gap: 5px; }
  .keys > div { display: grid; grid-template-columns: 76px 1fr; gap: 10px; align-items: baseline; }
  .keys dt {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--accent);
    letter-spacing: 0.06em;
  }
  .keys dd { margin: 0; font-size: 12.5px; color: var(--text-dim); }

  .toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    font-size: 12.5px;
    color: var(--text-dim);
    cursor: pointer;
  }
  .toggle input { accent-color: var(--accent); width: 15px; height: 15px; }
  .note { margin: 10px 0 0; font-size: 12px; line-height: 1.5; color: var(--text-dim); }
</style>
