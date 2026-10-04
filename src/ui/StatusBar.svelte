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
  import { REGIONAL_LAYERS } from '@/tiles/regional';
  import { imageryById, TERRARIUM } from '@/tiles/sources';
  import { age } from './format';

  const imagery = $derived(imageryById(app.imageryId));
  /** National layers drawn right now: the credit their licence asks for is shown while they are. */
  const national = $derived(REGIONAL_LAYERS.filter((l) => app.regionalImagery.includes(l.id)));

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
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
  const STATUS_TEXT: Record<string, string> = {
    ok: 'Answering',
    degraded: 'Slow or rate-limited',
    down: 'Not answering',
    disabled: 'Off',
    untried: 'Standing by',
  };

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
          net.failureRatio > 0 ? `${Math.round(net.failureRatio * 100)}% failing` : null,
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
      <div class="panel sheet" role="dialog" aria-label="Data status">
        <header>
          <h2>Status</h2>
          <button class="close" onclick={() => (open = false)} aria-label="Close">×</button>
        </header>

        <section>
          <p class="label">Live traffic</p>
          <p class="big">
            <span class="tabular">{app.aircraftCount.toLocaleString('en')}</span> aircraft
            {#if feedAge !== null}
              <span class="dim">· updated <span class:stale={feedStale}>{age(feedAge)} ago</span></span>
            {/if}
          </p>
        </section>

        <section>
          <p class="label">Feeds</p>
          <ul class="feeds">
            {#each app.providers as provider (provider.id)}
              <li class:active={app.feedSource === provider.id}>
                <span class="dot" style="background: {STATUS_COLOR[provider.status]}"></span>
                <a href={provider.homepage} target="_blank" rel="noopener noreferrer">{provider.label}</a>
                <span class="state">
                  {app.feedSource === provider.id ? 'In use' : STATUS_TEXT[provider.status] ?? provider.status}
                </span>
              </li>
              {#if provider.disabledReason}<li class="why">{provider.disabledReason}</li>{/if}
            {/each}
          </ul>
        </section>

        <section>
          <p class="label">Connection</p>
          <p class="row">
            <span class="dot" style="background: {linkBad ? 'var(--error)' : linkSlow ? 'var(--warn)' : 'var(--ok)'}"></span>
            <span>{measured?.label ?? 'Measuring…'}</span>
            {#if linkDetail}<span class="dim">· {linkDetail}</span>{/if}
          </p>
          {#if app.networkProfile}<p class="note">{app.networkProfile.advice}</p>{/if}
        </section>

        <section>
          <p class="label">Sources</p>
          <p class="note credits">
            {#if imagery}<a href={imagery.attributionUrl} target="_blank" rel="noopener noreferrer">{imagery.attribution}</a><br />{/if}
            Close-up aerial imagery, where open data exists: {#each REGIONAL_LAYERS as layer, i}<a href={layer.attributionUrl} target="_blank" rel="noopener noreferrer" title={layer.attribution}>{layer.label}</a> ({layer.licence}){i < REGIONAL_LAYERS.length - 1 ? ' · ' : ''}{/each}<br />
            <a href={TERRARIUM.attributionUrl} target="_blank" rel="noopener noreferrer">{TERRARIUM.attribution}</a><br />
            Roads, runways and footprints © OpenStreetMap contributors (ODbL), OpenMapTiles, OpenFreeMap<br />
            Night lights NASA Black Marble (public domain) · 3D aircraft <a href="./models/CREDITS.md" target="_blank" rel="noopener noreferrer">FlightGear community (GPL-2.0)</a><br />
            Places © Natural Earth, GeoNames (CC BY 4.0) · Traffic <a href="https://adsb.fi" target="_blank" rel="noopener noreferrer">adsb.fi</a>, <a href="https://adsb.lol" target="_blank" rel="noopener noreferrer">adsb.lol</a> (ODbL)<br />
            Weather: data from <a href="https://www.met.no/en" target="_blank" rel="noopener noreferrer">MET Norway</a> (CC BY 4.0) · Routes Virtual Radar Server community (CC0) · Photos Wikimedia Commons, credited on each<br />
            <a href="./mentions-legales.html" target="_blank" rel="noopener noreferrer">Mentions légales</a>
          </p>
        </section>
      </div>
    {/if}

    <button
      class="pill"
      onclick={() => (open = !open)}
      aria-expanded={open}
      title="Feeds, connection and data sources"
    >
      <span class="dot pulse" style="background: {health}"></span>
      <span class="tabular">{app.aircraftCount.toLocaleString('en')}</span>
      <span class="unit">aircraft</span>
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
      rel="noopener noreferrer">{TERRARIUM.attribution}</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a> · <a href="./mentions-legales.html" target="_blank" rel="noopener noreferrer">Mentions légales</a>
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
  .unit { color: var(--text-faint); }
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
