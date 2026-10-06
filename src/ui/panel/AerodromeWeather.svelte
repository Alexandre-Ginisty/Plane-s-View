<!--
  The weather at each end of the flight, as its METARs give it.

  One line per aerodrome in the notation a pilot reads — flight category,
  wind, visibility or CAVOK, ceiling, temperature over dew point, QNH — and
  the raw report under it on request, for whoever wants to decode the rest.
  Absent rather than empty when there is nothing to say: weather is a
  garnish on the dossier, never a hole in it.
-->
<script lang="ts">
  import type { Airport } from '@/data/types';
  import { fetchMetars, type Metar } from '@/data/weather/metar';
  import { t } from '@/i18n/index.svelte';

  let { origin, destination, dense = false }: { origin: Airport | null; destination: Airport | null; dense?: boolean } = $props();

  let reports = $state<Metar[]>([]);
  let open = $state<string | null>(null);

  $effect(() => {
    const ends = [origin?.icao, destination?.icao];
    let live = true;
    reports = [];
    void fetchMetars(ends).then((found) => {
      if (!live) return;
      reports = ends.map((c) => (c ? found.get(c.toUpperCase()) : undefined)).filter((m): m is Metar => !!m);
    });
    return () => {
      live = false;
    };
  });

  const pad3 = (n: number) => String(Math.round(n) % 360 || 360).padStart(3, '0');

  function windOf(m: Metar): string {
    if (m.windKt === null) return '';
    if (m.windKt === 0) return t('metar.calm');
    const dir = m.windVariable ? 'VRB' : m.windDirDeg !== null ? `${pad3(m.windDirDeg)}°` : '';
    return `${dir}/${Math.round(m.windKt)}${m.gustKt ? `G${Math.round(m.gustKt)}` : ''} kt`;
  }

  /** Statute miles as reported, in kilometres; "6+" is ten kilometres or more. */
  function visibilityOf(m: Metar): string {
    if (m.cover === 'CAVOK') return 'CAVOK';
    if (!m.visibility) return '';
    if (m.visibility.endsWith('+')) return '≥10 km';
    const sm = Number.parseFloat(m.visibility);
    if (!Number.isFinite(sm)) return m.visibility;
    const km = sm * 1.609;
    return km < 5 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
  }

  function line(m: Metar): string {
    return [
      windOf(m),
      visibilityOf(m),
      m.ceilingFt !== null ? t('metar.ceiling', { ft: m.ceilingFt }) : null,
      m.tempC !== null ? `${Math.round(m.tempC)}°${m.dewC !== null ? `/${Math.round(m.dewC)}°` : ''}` : null,
      m.qnhHpa !== null ? `Q${Math.round(m.qnhHpa)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  const ago = (m: Metar) => (m.observedAt ? Math.max(0, Math.round((Date.now() - m.observedAt) / 60_000)) : null);
</script>

{#if reports.length > 0}
  <section class="wx" class:dense aria-label={t('metar.title')}>
    <p class="label">{t('metar.title')}</p>
    {#each reports as m (m.icao)}
      <button class="row" onclick={() => (open = open === m.icao ? null : m.icao)} aria-expanded={open === m.icao} title={t('metar.showRaw')}>
        <span class="icao">{m.icao}</span>
        {#if m.category}<span class="cat {m.category.toLowerCase()}">{m.category}</span>{/if}
        <span class="summary tabular">{line(m)}</span>
        {#if ago(m) !== null}<span class="age">{t('metar.ago', { min: ago(m) ?? 0 })}</span>{/if}
      </button>
      {#if open === m.icao}<p class="raw">{m.raw}</p>{/if}
    {/each}
    <p class="source">{t('metar.source')}</p>
  </section>
{/if}

<style>
  .wx { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
  .row {
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 4px 0;
    text-align: left;
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    cursor: pointer;
  }
  .row:hover .summary { color: var(--text); }
  .icao { font-family: var(--mono); font-size: 12px; font-weight: 650; letter-spacing: 0.06em; }
  .cat {
    padding: 0 5px;
    font-family: var(--mono);
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.06em;
    border-radius: 3px;
    color: #fff;
  }
  /* The colours every briefing uses. */
  .cat.vfr { background: #2e9e4f; }
  .cat.mvfr { background: #2f6fd6; }
  .cat.ifr { background: #d23b3b; }
  .cat.lifr { background: #b03ad0; }
  .summary { font-size: 11.5px; color: var(--text-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .age { font-size: 10px; color: var(--text-faint); white-space: nowrap; }
  .raw {
    margin: 2px 0 6px;
    padding: 6px 8px;
    font-family: var(--mono);
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--text);
    background: var(--hover-bg);
    word-break: break-word;
  }
  .source { margin: 6px 0 0; font-size: 9.5px; color: var(--text-faint); }
  .dense .summary { font-size: 10.5px; }
  .dense .icao { font-size: 11px; }
</style>
