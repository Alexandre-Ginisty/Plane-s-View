<!-- Renderer and network counters. Hidden by default (press D). The tile
     numbers are the ones that matter when the globe misbehaves: a rising
     "loading" count with a flat "rendered" count means the network is the
     bottleneck, the reverse means the quadtree is thrashing. -->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import { bytes, num } from './format';

  const s = $derived(app.stats);
  const net = $derived(app.network);
  const profile = $derived(app.networkProfile);

  /** kB/s reads better than bytes here: tiles are tens of kB each. */
  const throughput = $derived(
    net && net.throughputBps > 0 ? `${Math.round(net.throughputBps / 1000)} kB/s` : '—',
  );
</script>

{#if app.showDiagnostics}
  <div class="panel diag tabular" role="status">
    <div class="row"><span>fps</span><b class:bad={s.fps < 45}>{s.fps}</b></div>
    <div class="row"><span>render</span><b class:busy={s.renderMs > 12}>{s.renderMs} ms</b></div>
    <div class="row"><span>pixel ratio</span><b>{s.pixelRatio}</b></div>
    <div class="row sep"><span>tiles drawn</span><b>{s.tilesRendered}</b></div>
    <div class="row"><span>tiles resident</span><b>{s.tilesResident}</b></div>
    <div class="row"><span>tiles loading</span><b class:busy={s.tilesLoading > 20}>{s.tilesLoading}</b></div>
    <div class="row"><span>triangles</span><b>{num(s.triangles)}</b></div>
    <div class="row"><span>deepest zoom</span><b>z{s.deepestZoom}</b></div>
    {#if s.eyeAltFt !== null}
      <div class="row"><span>eye altitude</span><b>{s.eyeAltFt.toLocaleString()} ft</b></div>
    {/if}
    <div class="row sep"><span>req queued</span><b>{s.requestsQueued}</b></div>
    <div class="row"><span>req in flight</span><b>{s.requestsInFlight}</b></div>
    <div class="row"><span>disk cache</span><b>{bytes(s.diskCacheMb)}</b></div>
    <div class="row sep"><span>tracked</span><b>{s.aircraftTracked}</b></div>
    <div class="row"><span>drawn 3D</span><b>{s.aircraftDrawn}</b></div>

    <!-- Connection. The block that explains the tile counters above it: a
         high queue with a low grade is a link problem, not a renderer one. -->
    {#if net}
      <div class="row sep"><span>link</span><b class:busy={net.grade === 'slow'} class:bad={net.grade === 'poor' || net.grade === 'offline'}>{net.grade}</b></div>
      <div class="row"><span>ping</span><b>{net.pingMs !== null ? `${Math.round(net.pingMs)} ms` : '—'}</b></div>
      <div class="row"><span>latency</span><b>{net.latencyMs !== null ? `${Math.round(net.latencyMs)} ms` : '—'}</b></div>
      <div class="row"><span>throughput</span><b>{throughput}</b></div>
      <div class="row"><span>errors</span><b class:busy={net.failureRatio > 0.15}>{Math.round(net.failureRatio * 100)}%</b></div>
      <div class="row"><span>timeouts</span><b class:busy={net.timeouts > 0}>{net.timeouts}</b></div>
      {#if net.effectiveType}
        <div class="row"><span>reported</span><b>{net.effectiveType}</b></div>
      {/if}
    {/if}
    {#if profile}
      <div class="row"><span>max zoom</span><b>z{profile.maxZoom}</b></div>
      <div class="row"><span>target error</span><b>{profile.screenSpaceError} px/texel</b></div>
      <div class="row"><span>parallel</span><b>{profile.concurrency}</b></div>
    {/if}
  </div>
{/if}

<style>
  .diag {
    position: absolute;
    top: 16px;
    left: 16px;
    padding: 10px 12px;
    font-size: 11px;
    min-width: 176px;
    z-index: 25;
  }
  .row { display: flex; justify-content: space-between; gap: 16px; line-height: 1.55; }
  .row span { color: var(--text-faint); }
  .row b { font-weight: 600; }
  .row.sep { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
  .bad { color: var(--error); }
  .busy { color: var(--warn); }
</style>
