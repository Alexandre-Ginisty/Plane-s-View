<!--
  The weather at each end of the flight.

  Said first the way anyone would say it — the town, the sky in a word, the
  temperature, the wind and how far one can see — because most people looking
  at a flight do not read METARs, and "VRB/03 kt · CAVOK · 18°/9° · Q1019"
  told them nothing. A tap opens the pilot's version under it: the flight
  category, the same figures in the notation a briefing uses, and the raw
  report, for the enthusiast who does read them.

  Absent rather than empty when there is nothing to say: weather is a garnish
  on the dossier, never a hole in it.
-->
<script lang="ts">
  import type { Airport } from '@/data/types';
  import { fetchMetars, skyOf, type Metar, type Sky } from '@/data/weather/metar';
  import { t, type MessageKey } from '@/i18n/index.svelte';

  let { origin, destination, dense = false }: { origin: Airport | null; destination: Airport | null; dense?: boolean } = $props();

  let reports = $state<{ metar: Metar; airport: Airport }[]>([]);
  let open = $state<string | null>(null);

  $effect(() => {
    const ends = [origin, destination].filter((a): a is Airport => !!a?.icao);
    let live = true;
    reports = [];
    void fetchMetars(ends.map((a) => a.icao)).then((found) => {
      if (!live) return;
      reports = ends.flatMap((airport) => {
        const metar = found.get(airport.icao!.toUpperCase());
        return metar ? [{ metar, airport }] : [];
      });
    });
    return () => {
      live = false;
    };
  });

  const SKY: Record<Sky, { key: MessageKey; glyph: string }> = {
    clear: { key: 'wx.clear', glyph: '☀' },
    mostlyClear: { key: 'wx.mostlyClear', glyph: '🌤' },
    partlyCloudy: { key: 'wx.partlyCloudy', glyph: '⛅' },
    cloudy: { key: 'wx.cloudy', glyph: '🌥' },
    overcast: { key: 'wx.overcast', glyph: '☁' },
    haze: { key: 'wx.haze', glyph: '🌫' },
    fog: { key: 'wx.fog', glyph: '🌫' },
    rain: { key: 'wx.rain', glyph: '🌧' },
    snow: { key: 'wx.snow', glyph: '🌨' },
    storm: { key: 'wx.storm', glyph: '⛈' },
  };

  const KMH = 1.852;
  /** The phrases are written to follow a comma; at the start of a line they take a capital. */
  const cap = (text: string): string => text.charAt(0).toLocaleUpperCase() + text.slice(1);
  const placeOf = (a: Airport, m: Metar): string => a.municipality ?? a.name ?? m.icao;

  function windPlain(m: Metar): string | null {
    if (m.windKt === null) return null;
    if (m.windKt < 2) return cap(t('metar.calm'));
    const wind = cap(t('wx.wind', { kmh: Math.round(m.windKt * KMH) }));
    return m.gustKt ? `${wind}, ${t('wx.gusts', { kmh: Math.round(m.gustKt * KMH) })}` : wind;
  }

  /** Statute miles as reported, in kilometres; "6+" (or CAVOK) is ten kilometres or more. */
  function visibilityKm(m: Metar): number | null {
    if (m.cover === 'CAVOK' || m.visibility?.endsWith('+')) return Infinity;
    const sm = m.visibility ? Number.parseFloat(m.visibility) : Number.NaN;
    return Number.isFinite(sm) ? sm * 1.609 : null;
  }
  function visibilityPlain(m: Metar): string | null {
    const km = visibilityKm(m);
    if (km === null) return null;
    if (km >= 10) return cap(t('wx.visibilityGood'));
    return cap(t('wx.visibility', { km: km < 5 ? Math.round(km * 10) / 10 : Math.round(km) }));
  }

  /** The pilot's line: wind in degrees and knots, visibility or CAVOK, ceiling, temperature/dew point, QNH. */
  const pad3 = (n: number) => String(Math.round(n) % 360 || 360).padStart(3, '0');
  function pilotLine(m: Metar): string {
    const km = visibilityKm(m);
    const wind =
      m.windKt === null
        ? null
        : m.windKt === 0
          ? '00000KT'
          : `${m.windVariable ? 'VRB' : m.windDirDeg !== null ? `${pad3(m.windDirDeg)}°` : ''}/${Math.round(m.windKt)}${m.gustKt ? `G${Math.round(m.gustKt)}` : ''} kt`;
    return [
      wind,
      m.cover === 'CAVOK' ? 'CAVOK' : km === null ? null : km >= 10 ? '≥10 km' : `${km < 5 ? km.toFixed(1) : Math.round(km)} km`,
      m.ceilingFt !== null ? t('metar.ceiling', { ft: m.ceilingFt }) : null,
      m.tempC !== null ? `${Math.round(m.tempC)}°${m.dewC !== null ? `/${Math.round(m.dewC)}°` : ''}` : null,
      m.qnhHpa !== null ? `Q${Math.round(m.qnhHpa)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /** The way the wind blows, as an arrow: a METAR gives where it comes from. */
  const blowsTo = (m: Metar): number | null => (m.windVariable || m.windDirDeg === null || (m.windKt ?? 0) < 2 ? null : (m.windDirDeg + 180) % 360);

  const ago = (m: Metar) => (m.observedAt ? Math.max(0, Math.round((Date.now() - m.observedAt) / 60_000)) : null);
</script>

{#if reports.length > 0}
  <section class="wx" class:dense aria-label={t('metar.title')}>
    <p class="label">{t('metar.title')}</p>
    {#each reports as { metar: m, airport } (m.icao)}
      {@const sky = skyOf(m)}
      {@const to = blowsTo(m)}
      <button class="row" onclick={() => (open = open === m.icao ? null : m.icao)} aria-expanded={open === m.icao} title={t('metar.showRaw')}>
        <span class="glyph" aria-hidden="true">{sky ? SKY[sky].glyph : '·'}</span>
        <span class="main">
          <span class="line1">
            <span class="place">{placeOf(airport, m)}</span>
            {#if sky}<span class="sky">{t(SKY[sky].key)}</span>{/if}
            {#if m.tempC !== null}<span class="temp tabular">{Math.round(m.tempC)} °C</span>{/if}
          </span>
          <span class="line2">
            {#if windPlain(m)}<span>{#if to !== null}<span class="arrow" style="transform: rotate({to}deg)" aria-hidden="true">↑</span>{/if}{windPlain(m)}</span>{/if}
            {#if visibilityPlain(m)}<span>{visibilityPlain(m)}</span>{/if}
          </span>
        </span>
        <span class="chev" class:up={open === m.icao} aria-hidden="true">›</span>
      </button>
      {#if open === m.icao}
        <div class="pilot">
          <p class="pilot-head">
            <span>{t('wx.pilot')}</span>
            <span class="icao">{m.icao}</span>
            {#if m.category}<span class="cat {m.category.toLowerCase()}">{m.category}</span>{/if}
            {#if ago(m) !== null}<span class="age">{t('metar.ago', { min: ago(m) ?? 0 })}</span>{/if}
          </p>
          <p class="summary tabular">{pilotLine(m)}</p>
          <p class="raw">{m.raw}</p>
        </div>
      {/if}
    {/each}
    <p class="source">{t('metar.source')}</p>
  </section>
{/if}

<style>
  .wx { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
  .row {
    display: grid;
    grid-template-columns: 22px 1fr auto;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 0;
    text-align: left;
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    cursor: pointer;
  }
  .glyph { font-size: 17px; line-height: 1; text-align: center; }
  .main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .line1 { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
  .place { font-size: 12.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sky { font-size: 12px; color: var(--text-dim); white-space: nowrap; }
  .temp { margin-left: auto; font-size: 12.5px; font-weight: 600; }
  .line2 { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 11px; color: var(--text-faint); }
  .arrow { display: inline-block; margin-right: 4px; font-weight: 700; color: var(--accent); }
  .chev { font-size: 15px; color: var(--text-faint); transition: transform 0.2s var(--ease); }
  .chev.up { transform: rotate(90deg); }
  .row:hover .place, .row:hover .chev { color: var(--accent); }

  .pilot { margin: 2px 0 8px 30px; }
  .pilot-head { display: flex; align-items: baseline; gap: 8px; margin: 0 0 3px; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-faint); }
  .icao { font-family: var(--mono); font-weight: 650; color: var(--text-dim); }
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
  .age { margin-left: auto; text-transform: none; letter-spacing: 0; }
  .summary { margin: 0 0 4px; font-size: 11px; color: var(--text-dim); }
  .raw {
    margin: 0;
    padding: 6px 8px;
    font-family: var(--mono);
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--text);
    background: var(--hover-bg);
    word-break: break-word;
  }
  .source { margin: 6px 0 0; font-size: 9.5px; color: var(--text-faint); }
  .dense .place { font-size: 11.5px; }
  .dense .line2 { font-size: 10.5px; }
</style>
