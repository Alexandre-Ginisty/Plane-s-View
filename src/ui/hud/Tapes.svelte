<!--
  Speed and altitude readouts, plus heading/wind/temperature.

  Grouped into one component because they are the same thing — numbers the
  feed gives us, framed identically — and splitting them further would mean
  four files sharing one stylesheet.

  Each figure states its provenance where it differs. Wind carries a marker
  when it comes from a forecast model rather than from the aircraft's own
  sensors, because a modelled wind at FL380 can be tens of knots out and
  showing it as if it were measured would be a quiet lie.
-->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import type { SampledAircraft } from '@/state/traffic';
  import { altitude, heading, mach, num, temperature, verticalRate, wind } from '../format';

  let { sample }: { sample: SampledAircraft } = $props();

  const latest = $derived(sample.latest);

  /** Prefer what the aircraft measured; fall back to the forecast model. */
  const windFromAircraft = $derived(latest.windSpeedKt != null);
  const windText = $derived(
    latest.windSpeedKt != null
      ? wind(latest.windDirectionDeg, latest.windSpeedKt)
      : app.weather?.windSpeedMs != null
        ? wind(app.weather.windDirectionDeg, app.weather.windSpeedMs * 1.94384)
        : '—',
  );

  const oatText = $derived(
    latest.oatC != null ? temperature(latest.oatC) : temperature(app.weather?.temperatureC ?? null),
  );
</script>

<div class="tape left">
  <span class="label">Ground speed</span>
  <span class="value tabular">{num(sample.groundSpeedKt)}</span>
  <span class="unit">knots</span>
  {#if latest.iasKt != null}<span class="sub tabular">IAS {num(latest.iasKt)}</span>{/if}
  {#if latest.mach != null}<span class="sub tabular">{mach(latest.mach)}</span>{/if}
</div>

<div class="tape right">
  <span class="label">Altitude</span>
  <span class="value tabular">{altitude(sample.altFt, latest.onGround)}</span>
  <span class="sub tabular">{verticalRate(sample.verticalRateFpm)}</span>
  {#if latest.navAltitudeMcpFt != null}
    <span class="sub dim tabular">Selected {num(latest.navAltitudeMcpFt)}</span>
  {/if}
</div>

<div class="environment">
  <div><span class="label">Heading</span><span class="tabular">{heading(sample.headingDeg)}</span></div>
  <div><span class="label">Track</span><span class="tabular">{heading(sample.trackDeg)}</span></div>
  <div>
    <span class="label">Wind</span>
    <span class="tabular">{windText}</span>
    {#if !windFromAircraft}<span class="modelled" title="From a weather model, not measured by the aircraft">est</span>{/if}
  </div>
  <div><span class="label">Outside air</span><span class="tabular">{oatText}</span></div>
</div>

<style>
  .tape {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    padding: 10px 14px;
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
    backdrop-filter: blur(6px);
  }
  /* The cut corner points away from the screen edge on each side, so the pair
     reads as one instrument rather than two unrelated boxes. */
  .tape.left {
    left: 28px;
    align-items: flex-start;
    clip-path: polygon(0 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%);
  }
  .tape.right {
    right: 28px;
    align-items: flex-end;
    clip-path: polygon(0 0, 100% 0, 100% 100%, 10px 100%, 0 calc(100% - 10px));
  }
  .tape .value { font-size: 27px; font-weight: 600; line-height: 1.15; color: var(--hud-text); }
  .tape .unit { font-size: 9.5px; color: var(--hud-dim); letter-spacing: 0.12em; text-transform: uppercase; }
  .tape .sub { font-size: 11.5px; color: var(--hud-accent); margin-top: 3px; }
  .tape .sub.dim { color: var(--hud-dim); }

  .environment {
    position: absolute;
    bottom: 76px;
    left: 28px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 12.5px;
    padding: 9px 12px;
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
    backdrop-filter: blur(6px);
  }
  .environment div { display: flex; gap: 8px; align-items: baseline; }
  .environment :global(.label) { width: 84px; flex-shrink: 0; }
  .modelled {
    font-size: 8.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--hud-warm);
    border: 1px solid rgb(var(--warm-rgb) / 0.45);
    padding: 0 3px;
  }

  /*
   * A phone: slimmer tapes hugging the edges, and the environment block — the
   * least urgent figures here, all of them in the details card too — left
   * out, because on a 390 px screen it sat on the panel and under the dock.
   */
  @media (max-width: 720px) {
    .tape { padding: 6px 9px; }
    .tape.left { left: calc(8px + env(safe-area-inset-left)); }
    .tape.right { right: calc(8px + env(safe-area-inset-right)); }
    .tape .value { font-size: 19px; }
    .tape .sub { font-size: 10px; }
    .environment { display: none; }
  }
  @media (max-height: 480px) {
    .environment { display: none; }
    .tape { top: 46%; }
  }
</style>
