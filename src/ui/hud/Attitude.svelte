<!--
  Attitude indicator and roll pointer.

  A real artificial horizon rotates the *world* against a fixed aircraft
  symbol, and that is what is happening here: the boresight is nailed to the
  centre of the screen and the horizon line rotates and translates behind it.
  Doing it the other way round — tilting a little aeroplane over a fixed
  horizon — is the single most common way to get this wrong, and it reads as
  backwards to anyone who has seen the real instrument.

  Pitch is scaled at about 7 px per degree, which is roughly what a head-up
  display uses. Exact 1:1 mapping to the outside world would be correct and
  unreadable: ±5° would occupy almost the whole screen.
-->
<script lang="ts">
  let { pitchDeg = 0, rollDeg = 0 }: { pitchDeg?: number; rollDeg?: number } = $props();

  const pitchOffset = $derived(pitchDeg * 7);
</script>

<div class="attitude" aria-hidden="true">
  <div class="horizon-wrap" style="transform: rotate({-rollDeg}deg)">
    <div class="horizon" style="transform: translateY({pitchOffset}px)">
      {#each [-20, -10, 10, 20] as ladder (ladder)}
        <div class="ladder" style="top: {50 - (ladder * 7) / 2}%">
          <span class="rung"></span>
          <span class="rung-label">{Math.abs(ladder)}</span>
        </div>
      {/each}
      <div class="horizon-line"></div>
    </div>
  </div>

  <div class="boresight">
    <span class="wing left"></span>
    <span class="dot"></span>
    <span class="wing right"></span>
  </div>

  <div class="roll-pointer" style="transform: rotate({-rollDeg}deg)"></div>
</div>

<style>
  .attitude {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 340px;
    height: 240px;
    transform: translate(-50%, -50%);
    overflow: hidden;
    filter: drop-shadow(0 0 4px rgba(0, 0, 0, 0.85));
  }
  .horizon-wrap, .horizon { position: absolute; inset: -60%; }
  .horizon-line {
    position: absolute;
    top: 50%;
    left: 12%;
    right: 12%;
    height: 2px;
    background: var(--accent);
    box-shadow: 0 0 10px rgba(127, 223, 255, 0.6);
  }
  .ladder {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .rung { display: block; width: 54px; height: 1.5px; background: rgba(127, 223, 255, 0.72); }
  .rung-label { font-size: 9.5px; color: rgba(127, 223, 255, 0.95); font-weight: 600; }

  .boresight {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    align-items: center;
    gap: 5px;
  }
  /* Amber, and the only amber in the middle of the screen: this is the one
     mark that says "you are here". */
  .wing { width: 34px; height: 2px; background: var(--accent-warm); }
  .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent-warm); }

  .roll-pointer {
    position: absolute;
    left: 50%;
    top: 18px;
    width: 0;
    height: 0;
    margin-left: -6px;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-bottom: 9px solid var(--accent);
    transform-origin: 50% 102px;
  }

  @media (max-width: 720px) {
    .attitude { width: 240px; height: 180px; }
  }
</style>
