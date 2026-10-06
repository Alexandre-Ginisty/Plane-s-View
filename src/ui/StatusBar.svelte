<!--
  Feed status and attribution.

  Two jobs. The first is telling the truth about where the data is coming from:
  which provider answered, how stale it is, and which are down — a tracker that
  silently shows minute-old positions as current is worse than one that admits
  it. The second is attribution, which EOX, NASA, Mapzen, OpenStreetMap and the
  ADS-B feed require.

  It used to be a strip of small print across the whole bottom of the screen,
  on the map and under the cockpit alike. Now it is one pill — a health dot,
  the aircraft count and the age of the data — that opens into a panel with
  the detail. Nothing is hidden that matters: a feed going stale turns the dot
  amber and the age red, without opening anything. On the map the imagery
  credit is MapLibre's own (bottom right); in the 3D view, where that control
  is hidden, a one-line credit stays under the view.
-->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import { profileFor } from '@/net/quality';
  import { t, tAround, type MessageKey } from '@/i18n/index.svelte';
  import { SITE } from '@/config/site';
  import { gradeAdvice, gradeLabel } from './labels';
  import { REGIONAL_LAYERS } from '@/tiles/regional';
  import { imageryById, TERRARIUM } from '@/tiles/sources';
  import { age } from './format';

  const imagery = $derived(imageryById(app.imageryId));
  /** National layers drawn right now: the credit their licence asks for is shown while they are. */
  const national = $derived(REGIONAL_LAYERS.filter((l) => app.regionalImagery.includes(l.id)));

  let now = $state(Date.now());
  $effect(() => {
    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });

  let open = $state(false);

  const feedAge = $derived(app.lastUpdateAt ? (now - app.lastUpdateAt) / 1000 : null);
  const feedStale = $derived(feedAge !== null && feedAge > 15);

  const STATUS_COLOR: Record<string, string> = {
    ok: 'var(--ok)',
    degraded: 'var(--warn)',
    down: 'var(--error)',
    disabled: 'var(--text-faint)',
    untried: 'var(--text-faint)',
  };
  const STATUS_TEXT: Record<string, MessageKey> = {
    ok: 'status.ok',
    degraded: 'status.degraded',
    down: 'status.down',
    disabled: 'status.disabled',
    untried: 'status.untried',
  };
  const madeBy = $derived(tAround('landing.madeBy', 'name'));

  const net = $derived(app.network);
  /*
   * The link indicator reports the raw measurement: it is the most alarming
   * thing here, so it says only what it means — the connection, and nothing
   * about how the app chose to spend it.
   */
  const measured = $derived(net ? profileFor(net.grade) : null);
  const linkBad = $derived(measured?.grade === 'offline' || measured?.grade === 'poor');
  const linkSlow = $derived(measured?.grade === 'slow');

  /** One colour for everything: the worst of the feed age and the link. */
  const health = $derived(
    feedAge === null
      ? 'var(--text-faint)'
      : linkBad || feedAge > 45
        ? 'var(--error)'
        : linkSlow || feedStale
          ? 'var(--warn)'
          : 'var(--ok)',
  );

  const linkDetail = $derived(
    net
      ? [
          net.pingMs !== null ? `${Math.round(net.pingMs)} ms` : null,
          net.throughputBps > 0 ? `${Math.round(net.throughputBps / 1000)} kB/s` : null,
          net.failureRatio > 0 ? t('status.failing', { percent: Math.round(net.failureRatio * 100) }) : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : '',
  );

  function onKeydown(event: KeyboardEvent): void {
    if (open && event.key === 'Escape') {
      open = false;
      event.stopPropagation();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if app.view === 'map'}
  <div class="status" class:open class:behind={app.selectedHex !== null}>
    {#if open}
      <div class="panel sheet" role="dialog" aria-label={t('status.dialog')}>
        <header>
          <h2>{t('status.title')}</h2>
          <button class="close" onclick={() => (open = false)} aria-label={t('common.close')}>×</button>
        </header>

        <section>
          <p class="label">{t('status.liveTraffic')}</p>
          <p class="big">
            <span class="tabular">{t('status.aircraftCount', { n: app.aircraftCount })}</span>
            {#if feedAge !== null}
              <span class="dim">· <span class:stale={feedStale}>{t('status.updated', { age: age(feedAge) })}</span></span>
            {/if}
          </p>
        </section>

        <section>
          <p class="label">{t('status.feeds')}</p>
          <ul class="feeds">
            {#each app.providers as provider (provider.id)}
              <li class:active={app.feedSource === provider.id}>
                <span class="dot" style="background: {STATUS_COLOR[provider.status]}"></span>
                <a href={provider.homepage} target="_blank" rel="noopener noreferrer">{provider.label}</a>
                <span class="state">
                  {app.feedSource === provider.id ? t('status.inUse') : STATUS_TEXT[provider.status] ? t(STATUS_TEXT[provider.status]!) : provider.status}
                </span>
              </li>
              {#if provider.disabledReason}<li class="why">{provider.disabledReason}</li>{/if}
            {/each}
          </ul>
        </section>

        <section>
          <p class="label">{t('status.connection')}</p>
          <p class="row">
            <span class="dot" style="background: {linkBad ? 'var(--error)' : linkSlow ? 'var(--warn)' : 'var(--ok)'}"></span>
            <span>{measured ? gradeLabel(measured.grade) : t('status.measuring')}</span>
            {#if linkDetail}<span class="dim">· {linkDetail}</span>{/if}
          </p>
          {#if app.networkProfile}<p class="note">{gradeAdvice(app.networkProfile.grade)}</p>{/if}
          <button class="counters" class:on={app.showDiagnostics} aria-pressed={app.showDiagnostics} onclick={() => (app.showDiagnostics = !app.showDiagnostics)}>
            {t('ctl.diagnostics')}
          </button>
        </section>

        <section>
          <p class="label">{t('status.sources')}</p>
          <p class="note credits">
            {#if imagery}<a href={imagery.attributionUrl} target="_blank" rel="noopener noreferrer">{imagery.attribution}</a><br />{/if}
            {t('status.closeUp')} {#each REGIONAL_LAYERS as layer, i}<a href={layer.attributionUrl} target="_blank" rel="noopener noreferrer" title={layer.attribution}>{layer.label}</a> ({layer.licence}){i < REGIONAL_LAYERS.length - 1 ? ' · ' : ''}{/each}<br />
            <a href={TERRARIUM.attributionUrl} target="_blank" rel="noopener noreferrer">{TERRARIUM.attribution}</a><br />
            {t('status.osm')}<br />
            {t('status.night')} · {t('status.models')} <a href="./models/CREDITS.md" target="_blank" rel="noopener noreferrer">FlightGear community (GPL-2.0)</a>
            · {t('status.airports')} <a href="./models/airports/CREDITS.md" target="_blank" rel="noopener noreferrer">FlightGear scenery (GPL-2.0)</a><br />
            {t('status.places')} · {t('status.traffic')} <a href="https://adsb.fi" target="_blank" rel="noopener noreferrer">adsb.fi</a>, <a href="https://adsb.lol" target="_blank" rel="noopener noreferrer">adsb.lol</a> (ODbL)<br />
            {t('status.weather')} <a href="https://www.met.no/en" target="_blank" rel="noopener noreferrer">MET Norway</a> (CC BY 4.0) · {t('status.routes')} · {t('status.photos')}<br />
            {madeBy[0]}{#if SITE.author.portfolio}<a href={SITE.author.portfolio} target="_blank" rel="noopener noreferrer">{SITE.author.name}</a>{:else}{SITE.author.name}{/if}{madeBy[1]}
            · <a href="./mentions-legales.html" target="_blank" rel="noopener noreferrer">{t('landing.legal')}</a>
          </p>
        </section>
      </div>
    {/if}

    <button
      class="pill"
      onclick={() => (open = !open)}
      aria-expanded={open}
      title={t('status.pillTitle')}
    >
      <span class="dot pulse" style="background: {health}"></span>
      <span class="tabular">{t('status.aircraftCount', { n: app.aircraftCount })}</span>
      {#if feedAge !== null}
        <span class="sep">·</span>
        <span class="tabular" class:stale={feedStale}>{age(feedAge)}</span>
      {/if}
    </button>
  </div>
{:else}
  <!-- MapLibre's credit is hidden under the 3D view; this one stands in for it. -->
  <p class="credit">
    {#if imagery}<a href={imagery.attributionUrl} target="_blank" rel="noopener noreferrer">{imagery.attribution}</a> · {/if}{#each national as layer}<a href={layer.attributionUrl} target="_blank" rel="noopener noreferrer">{layer.attribution}</a> · {/each}<a
      href={TERRARIUM.attributionUrl}
      target="_blank"
      rel="noopener noreferrer">{TERRARIUM.attribution}</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a> · <a href="./mentions-legales.html" target="_blank" rel="noopener noreferrer">{t('landing.legal')}</a>
  </p>
{/if}

<style>
  .status {
    position: absolute;
    left: calc(12px + env(safe-area-inset-left));
    bottom: calc(12px + env(safe-area-inset-bottom));
    z-index: 22;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  /* A phone: the aircraft sheet takes the bottom; the pill waits under it. */
  @media (max-width: 640px) {
    .status.behind { display: none; }
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 34px;
    padding: 0 12px 0 11px;
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    transition: border-color 0.2s, color 0.2s;
  }
  .pill:hover, .open .pill { color: var(--text); border-color: var(--accent); }
  .sep { opacity: 0.4; }
  .stale { color: var(--error); }

  .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .pulse { box-shadow: 0 0 0 0 currentColor; animation: pulse 2.4s ease-out infinite; }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgb(255 255 255 / 0.35); }
    70%, 100% { box-shadow: 0 0 0 6px rgb(255 255 255 / 0); }
  }
  @media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }

  .sheet {
    width: min(340px, calc(100vw - 24px));
    max-height: min(70vh, 560px);
    overflow-y: auto;
    padding: 14px 16px 16px;
    font-family: var(--sans);
    animation: sheet-up 0.25s var(--ease) both;
  }
  @keyframes sheet-up { from { opacity: 0; transform: translateY(8px); } }

  header { display: flex; align-items: baseline; justify-content: space-between; }
  h2 {
    margin: 0;
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }
  .close { font-size: 20px; line-height: 1; color: var(--text-faint); padding: 2px 6px; }
  .close:hover { color: var(--text); }

  section { margin-top: 14px; }
  .label { margin: 0 0 6px; }
  .big { margin: 0; font-size: 15px; font-weight: 600; }
  .dim { color: var(--text-faint); font-weight: 400; font-size: 12px; }
  .row { display: flex; align-items: center; gap: 7px; margin: 0; font-size: 13px; }
  .note { margin: 6px 0 0; font-size: 12px; line-height: 1.5; color: var(--text-dim); }
  .credits { font-size: 11px; color: var(--text-faint); }
  .credits a, .feeds a { color: inherit; text-decoration: none; }
  .credits a:hover, .feeds a:hover { text-decoration: underline; color: var(--text); }

  .counters {
    margin-top: 8px;
    padding: 0;
    font-size: 11.5px;
    color: var(--text-faint);
    text-decoration: underline;
    text-underline-offset: 2px;
    background: none;
    border: 0;
    cursor: pointer;
  }
  .counters:hover, .counters.on { color: var(--accent); }

  .feeds { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; font-size: 13px; }
  .feeds li { display: flex; align-items: center; gap: 8px; }
  .feeds li.active a { font-weight: 600; color: var(--text); }
  .feeds .state { margin-left: auto; font-size: 11px; color: var(--text-faint); }
  .feeds li.active .state { color: var(--ok); }
  .feeds .why { display: block; margin: -4px 0 0 15px; font-size: 11px; color: var(--text-faint); }

  .credit {
    position: absolute;
    right: calc(10px + env(safe-area-inset-right));
    bottom: calc(3px + env(safe-area-inset-bottom));
    z-index: 12;
    margin: 0;
    max-width: 46vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 9.5px;
    color: var(--text-faint);
    text-shadow: var(--hud-halo);
  }
  .credit a { color: inherit; text-decoration: none; }
  .credit a:hover { text-decoration: underline; }
  @media (max-width: 720px) {
    .credit { left: 0; right: 0; max-width: none; text-align: center; font-size: 8.5px; bottom: env(safe-area-inset-bottom); }
  }
</style>
