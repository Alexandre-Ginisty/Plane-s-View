<!--
  Heading strip.

  ±60° either side of the current heading, ticked every 5° and labelled every
  30° in tens of degrees — the convention every compass card uses, so "27"
  means 270°. Rendered as absolutely positioned ticks rather than a scrolling
  background image so the labels stay crisp text at any pixel ratio.
-->
<script lang="ts">
  let { headingDeg = 0 }: { headingDeg?: number } = $props();

  const ticks = $derived.by(() => {
    const out: { offset: number; label: string | null; major: boolean }[] = [];
    for (let d = -60; d <= 60; d += 5) {
      const bearing = (((headingDeg + d) % 360) + 360) % 360;
      // Tolerant comparison: `headingDeg` is continuous, so a major tick would
      // otherwise only land exactly on a multiple of 30 by luck.
      const major = bearing % 30 < 2.5 || bearing % 30 > 27.5;
      out.push({
        offset: d,
        label: major ? Math.round(bearing / 10).toString().padStart(2, '0') : null,
        major,
      });
    }
    return out;
  });
</script>

<div class="compass" aria-hidden="true">
  {#each ticks as tick (tick.offset)}
    <div class="tick" class:major={tick.major} style="left: calc(50% + {tick.offset * 3.4}px)">
      <span class="mark"></span>
      {#if tick.label}<span class="tick-label">{tick.label}</span>{/if}
    </div>
  {/each}
  <div class="cursor"></div>
</div>

<style>
  .compass {
    position: absolute;
    top: 18px;
    left: 50%;
    transform: translateX(-50%);
    width: 420px;
    height: 34px;
    overflow: hidden;
  }
  .tick { position: absolute; top: 0; transform: translateX(-50%); text-align: center; }
  .mark {
    display: block;
    width: 1.5px;
    height: 7px;
    margin: 0 auto;
    background: rgba(233, 244, 255, 0.7);
    box-shadow: 0 0 3px rgba(0, 0, 0, 0.9);
  }
  .tick.major .mark { height: 13px; background: var(--accent); }
  .tick-label { font-size: 11.5px; color: var(--text); font-weight: 600; letter-spacing: 0.06em; }
  .cursor {
    position: absolute;
    left: 50%;
    top: 0;
    width: 0;
    height: 0;
    margin-left: -5px;
    border-left: 5px solid transparent;
    border-right: 5px solid transparent;
    border-top: 8px solid var(--accent-warm);
  }

  @media (max-width: 720px) {
    .compass { width: 280px; }
  }
</style>
