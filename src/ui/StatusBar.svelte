<!--
  Feed status and attribution.

  Two jobs. The first is telling the truth about where the data is coming from:
  which provider answered, how stale it is, and which are down — a tracker that
  silently shows minute-old positions as current is worse than one that admits
  it. The second is attribution, which Esri, EOX, NASA, OSM, Planespotters and
  the ADS-B feeds all require, and which is therefore always on screen.
-->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import { gradeRank, profileFor } from '@/net/quality';
  import { imageryById } from '@/tiles/sources';
  import { TERRARIUM } from '@/tiles/sources';
  import { age } from './format';

  const imagery = $derived(imageryById(app.imageryId));

  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(t);
  });

  const feedAge = $derived(app.lastUpdateAt ? (now - app.lastUpdateAt) / 1000 : null);
  const feedStale = $derived(feedAge !== null && feedAge > 15);

  const statusColor: Record<string, string> = {
    ok: 'var(--ok)',
    degraded: 'var(--warn)',
    down: 'var(--error)',
    disabled: 'var(--text-faint)',
    untried: 'var(--text-faint)',
  };

  const profile = $derived(app.networkProfile);
  const net = $derived(app.network);

  /*
   * The link indicator reports the *measurement*, never the effective profile.
   *
   * They stopped being the same thing when the detail ceiling arrived: a user
   * on fibre who has left the app on standard detail gets a profile graded
   * `slow`, and reading that out as "Link: slow" tells them their connection
   * is bad when it is their own setting. It is also the single most alarming
   * thing this bar can say, so getting it wrong turns a preference into a
   * support question.
   *
   * `app.network` is the raw readout and its grade is unfiltered, which is
   * exactly what belongs here. The ceiling gets its own chip below.
   */
  const measured = $derived(net ? profileFor(net.grade) : null);

  const linkColor = $derived(
    measured?.grade === 'offline' || measured?.grade === 'poor'
      ? 'var(--error)'
      : measured?.grade === 'slow'
        ? 'var(--warn)'
        : 'var(--ok)',
  );

  /** True when detail is being held back by the setting rather than the link. */
  const heldByPreference = $derived(
    app.quality === 'low' && !!net && gradeRank(net.grade) > gradeRank('slow'),
  );

  /**
   * The tooltip carries the numbers; the bar carries the meaning.
   *
   * Putting "142 ms / 380 kB/s" on the bar itself would be honest and useless:
   * almost nobody can convert that into "this is why the ground is soft". The
   * profile's own advice line says that in one sentence, and the measurements
   * stay one hover (or one D keypress) away.
   */
  const linkTitle = $derived(
    !net || !profile
      ? 'Measuring the connection…'
      : [
          profile.advice,
          net.pingMs !== null ? `ping ${Math.round(net.pingMs)} ms` : null,
          net.throughputBps > 0 ? `${Math.round(net.throughputBps / 1000)} kB/s` : null,
          net.failureRatio > 0 ? `${Math.round(net.failureRatio * 100)}% failing` : null,
        ]
          .filter(Boolean)
          .join(' · '),
  );
</script>

<footer class="status">
  <div class="feeds">
    {#each app.providers as provider (provider.id)}
      <span
        class="feed"
        class:active={app.feedSource === provider.id}
        title={provider.disabledReason ?? provider.lastError ?? `${provider.label}: ${provider.status}`}
      >
        <span class="dot" style="background: {statusColor[provider.status]}"></span>
        <a href={provider.homepage} target="_blank" rel="noopener noreferrer">{provider.label}</a>
      </span>
    {/each}
  </div>

  <div class="link" title={linkTitle}>
    <span class="dot" style="background: {linkColor}"></span>
    <span>{measured?.label ?? 'Link: measuring'}</span>
  </div>

  {#if heldByPreference}
    <!--
      Only shown when the setting is what is limiting detail, never when the
      link is. Otherwise it reads as an apology for a weak connection, and the
      user goes looking for a problem that is one click away from being a
      choice.
    -->
    <button
      class="detail"
      onclick={() => (app.showLayers = true)}
      title="Your connection could carry more. Switch to high detail in the Imagery menu."
    >Standard detail</button>
  {/if}

  <div class="live">
    <span class="tabular">{app.aircraftCount}</span> aircraft
    {#if feedAge !== null}
      <span class="sep">·</span>
      <span class:stale={feedStale} class="tabular">{age(feedAge)} old</span>
    {/if}
  </div>

  <div class="attrib">
    {#if imagery}
      <a href={imagery.attributionUrl} target="_blank" rel="noopener noreferrer">{imagery.attribution}</a>
      <span class="sep">·</span>
    {/if}
    <a href={TERRARIUM.attributionUrl} target="_blank" rel="noopener noreferrer">{TERRARIUM.attribution}</a>
  </div>
</footer>

<style>
  .status {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 6px 14px;
    font-size: 10px;
    color: var(--text-faint);
    background: linear-gradient(180deg, transparent, rgba(3, 5, 10, 0.92) 55%);
    z-index: 12;
    pointer-events: none;
  }
  .status a { pointer-events: auto; color: inherit; text-decoration: none; }
  .status a:hover { color: var(--text-dim); text-decoration: underline; }

  .feeds { display: flex; gap: 12px; flex-shrink: 0; }
  .feed { display: flex; align-items: center; gap: 5px; }
  .feed.active a { color: var(--text-dim); font-weight: 600; }
  .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

  .detail {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    color: var(--accent-dim);
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    border: 1px solid rgba(127, 223, 255, 0.25);
  }
  .detail:hover { color: var(--accent); background: rgba(127, 223, 255, 0.1); }

  .link { display: flex; align-items: center; gap: 5px; flex-shrink: 0; cursor: help; }

  .live { flex-shrink: 0; }
  .stale { color: var(--warn); }
  .sep { opacity: 0.4; margin: 0 3px; }

  .attrib {
    margin-left: auto;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  @media (max-width: 900px) {
    .attrib { display: none; }
  }

  /* The link state is the last thing to go: on a narrow screen it is the one
     status that explains what the user is looking at. */
  @media (max-width: 620px) {
    .feeds { display: none; }
  }
</style>
