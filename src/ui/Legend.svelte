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
  import { app } from '@/state/appStore.svelte';
  import { t, type MessageKey } from '@/i18n/index.svelte';
  import { CAMERA_MODES } from '@/render/pov';
  import { TRAFFIC_LEGEND } from './palette';
  import { cameraLabel } from './labels';

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
  const cameraNames = $derived(CAMERA_MODES.map((mode) => cameraLabel(mode.id).toLowerCase()).join(', '));

  /** A key (or gesture) and what it does: both are message keys, except the key name of a plain letter. */
  type Entry = { key: string; does: string };
  const entry = (key: MessageKey | string, does: MessageKey, params?: Record<string, string>): Entry => ({
    key: key.startsWith('key.') ? t(key as MessageKey) : key,
    does: t(does, params),
  });

  const keys = $derived<Entry[]>([
    entry('key.click', 'ctl.select'),
    entry('key.enter', 'ctl.stepInside'),
    entry('key.esc', 'ctl.leave'),
    entry('key.drag', 'ctl.look'),
    entry('key.wheel', 'ctl.zoom'),
    entry('key.click', 'ctl.framed'),
    entry(`1 – ${CAMERA_MODES.length}`, 'ctl.camera', { cameras: cameraNames }),
    entry('V', 'ctl.inOut'),
    entry('C', 'ctl.recentre'),
    entry('P', 'ctl.pinMode'),
    entry('key.rightClick', 'ctl.rightClickPin'),
    entry('L', 'ctl.catchLanding'),
    entry('T', 'ctl.catchTakeoff'),
    entry('A', 'ctl.autoCamera'),
    entry('F', 'ctl.fullscreen'),
    entry('D', 'ctl.diagnostics'),
    entry('H', 'ctl.panel'),
  ]);

  /* The same controls for a finger: every key above has a button somewhere. */
  const taps = $derived<Entry[]>([
    entry('key.tap', 'ctl.tapSelect'),
    entry('key.drag', 'ctl.touchLook'),
    entry('key.pinch', 'ctl.zoom'),
    entry('key.tap', 'ctl.framed'),
    entry('key.longPress', 'ctl.longPressPin'),
    entry('←', 'ctl.back'),
  ]);
  const touch = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
  const controls = $derived(touch ? taps : keys);

  const LEGEND_KEYS: Record<string, MessageKey> = {
    climbing: 'legend.climbing',
    level: 'legend.level',
    descending: 'legend.descending',
    emergency: 'legend.emergency',
    stale: 'legend.stale',
  };
</script>

{#if app.showLegend}
  <div class="panel legend" role="dialog" aria-label={t('legend.title')}>
    <header>
      <h2>{t('legend.title')}</h2>
      <button class="close" onclick={() => (app.showLegend = false)} aria-label={t('common.close')}>×</button>
    </header>

    <section>
      <p class="label">{t('legend.aircraftColour')}</p>
      <ul class="swatches">
        {#each TRAFFIC_LEGEND as item (item.id)}
          <li>
            <span class="swatch" style="background: {item.color}"></span>
            <span>{t(LEGEND_KEYS[item.id]!)}</span>
          </li>
        {/each}
      </ul>
      <p class="note">{t('legend.helicopters')}</p>
    </section>

    <section>
      <p class="label">{t('legend.controls')}</p>
      <dl class="keys">
        {#each controls as row, i (i)}
          <div><dt>{row.key}</dt><dd>{row.does}</dd></div>
        {/each}
      </dl>
      <label class="toggle">
        <input type="checkbox" checked={app.invertY} onchange={(e) => app.setInvertY(e.currentTarget.checked)} />
        <span>{t('legend.invertY')}</span>
      </label>
    </section>

    <section>
      <p class="label">{t('legend.soft')}</p>
      <p class="note">{t('legend.softBody')}</p>
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
