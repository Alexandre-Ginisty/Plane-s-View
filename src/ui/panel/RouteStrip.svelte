<!--
  Origin → destination.

  Falls back through IATA, ICAO and then a placeholder rather than hiding: a
  route with one known end is still worth showing, and an empty gap reads as a
  layout bug rather than as missing data.
-->
<script lang="ts">
  import type { FlightRoute } from '@/data/types';
  import { airportLabel } from '../format';

  let { route }: { route: FlightRoute } = $props();
</script>

<div class="route">
  <div class="port">
    <span class="code">{airportLabel(route.origin)}</span>
    <span class="city">{route.origin?.municipality ?? ''}</span>
  </div>
  <div class="leg" aria-hidden="true">
    <span class="line"></span>
    <span class="plane">✈</span>
  </div>
  <div class="port right">
    <span class="code">{airportLabel(route.destination)}</span>
    <span class="city">{route.destination?.municipality ?? ''}</span>
  </div>
</div>
{#if route.airline?.name}
  <p class="airline">{route.airline.name}</p>
{/if}

<style>
  .route {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 10px;
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }
  .port { display: flex; flex-direction: column; min-width: 0; }
  .port.right { text-align: right; }
  .code {
    font-family: var(--mono);
    font-size: 19px;
    font-weight: 650;
    letter-spacing: 0.08em;
  }
  .city {
    font-size: 11px;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .leg { position: relative; width: 56px; height: 14px; }
  .line {
    position: absolute;
    top: 50%;
    left: 0;
    right: 0;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--accent), transparent);
  }
  .plane {
    position: absolute;
    top: -2px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 12px;
    color: var(--accent);
  }
  .airline { margin: 6px 0 0; font-size: 11.5px; color: var(--text-dim); text-align: center; }
</style>
