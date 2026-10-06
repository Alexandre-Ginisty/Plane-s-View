<!--
  Key and controls.

  The app had no legend at all, which made two things unknowable by looking:
  what the aircraft colours mean, and what the mouse or a finger does on the
  view. Both are the kind of thing a user either learns in five seconds or
  never learns, so they live behind one button in the dock rather than in a
  README nobody opens.

  Deliberately plain English. Everything else on screen is a cockpit readout in
  mono capitals; this is the one surface whose job is to be understood on the
  first read, so it is the one surface that does not perform.
-->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import { t, type MessageKey } from '@/i18n/index.svelte';
  import { TRAFFIC_LEGEND } from './palette';

  /** A gesture and what it does: both are message keys. */
  type Entry = { key: string; does: string };
  const entry = (key: MessageKey, does: MessageKey): Entry => ({ key: t(key), does: t(does) });

  /*
   * The mouse, and nothing else: every other control is a button in a dock,
   * named where it is, so there is no list of keys to learn.
   */
  const keys = $derived<Entry[]>([
    entry('key.click', 'ctl.select'),
    entry('key.drag', 'ctl.look'),
    entry('key.wheel', 'ctl.zoom'),
    entry('key.click', 'ctl.framed'),
    entry('key.rightClick', 'ctl.rightClickPin'),
  ]);

  /* The same for a finger. */
  const taps = $derived<Entry[]>([
    entry('key.tap', 'ctl.tapSelect'),
    entry('key.drag', 'ctl.touchLook'),
    entry('key.pinch', 'ctl.zoom'),
    entry('key.tap', 'ctl.framed'),
    entry('key.longPress', 'ctl.longPressPin'),
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
