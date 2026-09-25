<!--
  Heading strip.

  ## Why the ticks are anchored to bearings

  The first version placed a tick every 5 px across a fixed ±60° ruler and
  relabelled them as the heading changed. That is not a compass card: the marks
  never move, so turning the aircraft makes the numbers flicker in place while
  the strip itself sits perfectly still. It reads as broken because it is —
  there is no motion to tell you which way you are turning, or how fast.

  A real card is anchored to the world. Each tick belongs to a *bearing* — a
  fixed multiple of 5° — and its position on screen is how far that bearing is
  from where you are looking. Turn right and the whole card slides left under a
  fixed cursor, at a rate proportional to the rate of turn, which is the entire
  information content of the instrument.

  Anchoring in world space also makes the major ticks exact. Against a floating
  heading a multiple of 30 could only be recognised with a tolerance, so major
  ticks drifted on and off by a couple of degrees as the aircraft turned.
-->
<script lang="ts">
  import { wrapHeading } from '@/core/math/geo';

  let { headingDeg = 0 }: { headingDeg?: number } = $props();

  /** Half-width of the visible arc, degrees. */
  const SPAN_DEG = 60;
  /** Degrees between ticks, and between labelled ticks. */
  const TICK_DEG = 5;
  const LABEL_DEG = 30;
  const PX_PER_DEG = 3.4;

  /** The four cardinals read faster than their numbers on a moving card. */
  const CARDINALS: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };

  const heading = $derived(wrapHeading(headingDeg));

  const ticks = $derived.by(() => {
    const out: { bearing: number; offset: number; label: string | null }[] = [];
    // Anchored to the world: walk the multiples of TICK_DEG that fall inside
    // the arc rather than stepping outwards from the heading.
    const first = Math.ceil((heading - SPAN_DEG) / TICK_DEG) * TICK_DEG;

    for (let b = first; b <= heading + SPAN_DEG; b += TICK_DEG) {
      const bearing = wrapHeading(b);
      const major = bearing % LABEL_DEG === 0;
      out.push({
        bearing,
        offset: b - heading,
        label: major
          ? (CARDINALS[bearing] ?? Math.round(bearing / 10).toString().padStart(2, '0'))
          : null,
      });
    }
    return out;
  });
</script>

<div class="compass" aria-hidden="true">
  <!-- Keyed by bearing, so Svelte moves each tick rather than rewriting its
       label in place — which is what the old version did, and looked like. -->
  {#each ticks as tick (tick.bearing)}
    <div
      class="tick"
      class:major={tick.label !== null}
      class:cardinal={tick.label !== null && tick.label.length === 1}
      style="left: calc(50% + {tick.offset * PX_PER_DEG}px)"
    >
      <span class="mark"></span>
      {#if tick.label}<span class="tick-label">{tick.label}</span>{/if}
    </div>
  {/each}
  <div class="cursor"></div>
  <div class="readout">{Math.round(heading).toString().padStart(3, '0')}°</div>
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
  .tick.cardinal .mark { background: var(--accent-warm); }
  .tick-label { font-size: 11.5px; color: var(--text); font-weight: 600; letter-spacing: 0.06em; }
  .tick.cardinal .tick-label { color: var(--accent-warm); }
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
  .readout {
    position: absolute;
    left: 50%;
    bottom: 0;
    transform: translateX(-50%);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--accent-warm);
    text-shadow: 0 0 4px rgba(0, 0, 0, 0.9);
  }

  @media (max-width: 720px) {
    .compass { width: 280px; }
  }
</style>
