<!--
  The aircraft dossier, once.

  Both surfaces show the same aircraft, so both should show the same facts
  about it. They did not: the map panel had the photo, the wind aloft, the
  outside air temperature, the track, the emergency squawk and the provenance
  line; the cockpit card had the true airspeed, the barometric altitude, the
  bank angle and the autopilot modes. Picking an aircraft on the map and then
  stepping into it silently swapped one half of its dossier for the other.

  So the body lives here and the two surfaces contribute only their own
  chrome — a close button and "step inside" on the map, a collapse toggle and
  "pick another" in the cockpit. `dense` is the cockpit's variant: the same
  content at the smaller type a HUD wants, not a smaller set of it.
-->
<script lang="ts">
  import type { SampledAircraft } from '@/state/traffic';
  import { app } from '@/state/appStore.svelte';
  import {
    age,
    altitude,
    distanceNm,
    heading,
    mach,
    num,
    speed,
    squawkMeaning,
    temperature,
    verticalRate,
    wind,
  } from '../format';
  import AircraftPhoto from './AircraftPhoto.svelte';
  import RouteStrip from './RouteStrip.svelte';

  let { sample, dense = false }: { sample: SampledAircraft; dense?: boolean } = $props();

  const dossier = $derived(app.dossier);
  const meta = $derived(dossier?.meta ?? null);
  const route = $derived(dossier?.route ?? null);
  const photo = $derived(dossier?.photo ?? null);
  const latest = $derived(sample.latest);

  const title = $derived(latest.callsign ?? meta?.registration ?? sample.hex.toUpperCase());
  const subtitle = $derived(
    [meta?.manufacturer, meta?.typeName ?? meta?.typeCode].filter(Boolean).join(' ') ||
      (meta?.icaoTypeCode ?? ''),
  );
  const emergencyNote = $derived(latest.emergency ?? squawkMeaning(latest.squawk ?? null));

  /** Present, not merely defined — the feeds send explicit nulls. */
  const has = (v: number | null | undefined): v is number => v !== null && v !== undefined;
</script>

<div class="dossier-body" class:dense>
  <div class="titles">
    <h2>{title}</h2>
    {#if subtitle}<p class="subtitle">{subtitle}</p>{/if}
    {#if meta?.registration}<p class="reg">{meta.registration}</p>{/if}
  </div>

  {#if emergencyNote}
    <p class="emergency" role="alert">⚠ {emergencyNote}</p>
  {/if}

  {#if photo}
    <AircraftPhoto {photo} alt="{title} — {subtitle || 'aircraft'}" />
  {/if}

  {#if route && (route.origin || route.destination)}
    <RouteStrip {route} />
  {/if}

  <dl class="stats">
    <div><dt>Altitude</dt><dd class="tabular">{altitude(sample.altFt, latest.onGround)}</dd></div>
    {#if has(latest.altBaroFt)}
      <div><dt>Baro alt</dt><dd class="tabular">{altitude(latest.altBaroFt, latest.onGround)}</dd></div>
    {/if}
    <div><dt>Ground speed</dt><dd class="tabular">{speed(sample.groundSpeedKt)}</dd></div>
    {#if has(latest.tasKt)}
      <div><dt>True air</dt><dd class="tabular">{speed(latest.tasKt)}</dd></div>
    {/if}
    {#if has(latest.iasKt)}
      <div><dt>Indicated</dt><dd class="tabular">{speed(latest.iasKt)}</dd></div>
    {/if}
    {#if has(latest.mach)}
      <div><dt>Mach</dt><dd class="tabular">{mach(latest.mach)}</dd></div>
    {/if}
    <div><dt>Track</dt><dd class="tabular">{heading(sample.trackDeg)}</dd></div>
    <div><dt>Vertical</dt><dd class="tabular">{verticalRate(sample.verticalRateFpm)}</dd></div>
    <div><dt>Bank</dt><dd class="tabular">{num(sample.rollDeg, 1)}°</dd></div>
    {#if has(latest.windSpeedKt)}
      <div><dt>Wind aloft</dt><dd class="tabular">{wind(latest.windDirectionDeg, latest.windSpeedKt)}</dd></div>
    {/if}
    {#if has(latest.oatC)}
      <div><dt>Outside air</dt><dd class="tabular">{temperature(latest.oatC)}</dd></div>
    {/if}
    {#if has(latest.navQnhHpa)}
      <div><dt>QNH</dt><dd class="tabular">{num(latest.navQnhHpa)} hPa</dd></div>
    {/if}

    <div><dt>Registration</dt><dd class="tabular">{meta?.registration ?? '—'}</dd></div>
    <div><dt>Type</dt><dd class="tabular">{meta?.icaoTypeCode ?? latest.category ?? '—'}</dd></div>
    <div><dt>Squawk</dt><dd class="tabular">{latest.squawk ?? '—'}</dd></div>
    <div><dt>ICAO hex</dt><dd class="tabular">{sample.hex.toUpperCase()}</dd></div>

    {#if latest.navModes?.length}
      <div class="wide"><dt>Autopilot</dt><dd>{latest.navModes.join(', ')}</dd></div>
    {/if}
    {#if meta?.owner}
      <div class="wide"><dt>Operator</dt><dd>{meta.owner}</dd></div>
    {/if}
  </dl>

  <p class="provenance">
    {#if sample.stale}
      <span class="stale">No contact for {age(sample.ageSec)}</span>
    {:else}
      Position {age(sample.ageSec)} old
    {/if}
    {#if latest.isMlat}· multilateration{/if}
    {#if latest.isTisb}· TIS-B{/if}
    {#if has(latest.receiverDistanceNm)}
      · {distanceNm(latest.receiverDistanceNm)} from receiver
    {/if}
    {#if has(latest.rssi)}· {num(latest.rssi, 1)} dBFS{/if}
  </p>

  {#if app.dossierLoading}
    <p class="loading">Looking up registry and photo…</p>
  {/if}
  {#if dossier?.warnings.length}
    <ul class="warnings">
      {#each dossier.warnings as warning (warning)}<li>{warning}</li>{/each}
    </ul>
  {/if}
</div>

<style>
  h2 {
    margin: 0;
    font-size: 20px;
    font-weight: 650;
    letter-spacing: 0.01em;
  }
  .subtitle { margin: 2px 0 0; font-size: 12px; color: var(--text-dim); }
  .reg {
    margin: 2px 0 0;
    font-family: var(--mono);
    font-size: 11.5px;
    letter-spacing: 0.06em;
    color: var(--accent);
  }

  .emergency {
    margin: 10px 0 0;
    padding: 7px 10px;
    border-radius: var(--radius-sm);
    background: rgba(255, 92, 122, 0.14);
    border: 1px solid rgba(255, 92, 122, 0.4);
    color: #ffbecb;
    font-size: 12px;
    font-weight: 600;
  }

  .stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 12px;
    margin: 16px 0 0;
  }
  .stats > div { min-width: 0; }
  .stats > .wide { grid-column: 1 / -1; }
  dt {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
    font-weight: 600;
  }
  dd {
    margin: 1px 0 0;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .provenance {
    margin: 14px 0 0;
    font-size: 10px;
    color: var(--text-faint);
    line-height: 1.5;
  }
  .stale { color: var(--warn); }

  .loading { margin: 8px 0 0; font-size: 11px; color: var(--text-faint); }

  .warnings {
    margin: 8px 0 0;
    padding-left: 16px;
    font-size: 10px;
    color: var(--text-faint);
  }

  /*
   * The cockpit variant. Same facts, tighter setting: a HUD panel competes
   * with the view behind it, so the labels go monospaced and small and the
   * figures stay the one thing with weight.
   */
  .dense h2 { font-size: 15px; }
  .dense .subtitle { font-size: 11px; }
  .dense .stats { gap: 7px 10px; margin-top: 12px; }
  .dense dt { font-size: 9.5px; letter-spacing: 0.1em; color: var(--accent-dim); }
  .dense dd { font-family: var(--mono); font-size: 12.5px; }
</style>
