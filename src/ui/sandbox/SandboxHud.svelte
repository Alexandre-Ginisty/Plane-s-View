<!--
  The sandbox's own layer of the HUD: score, weapon, lock, kills.

  Over the ordinary cockpit HUD rather than instead of it — speed, altitude
  and the horizon are as useful when flying yourself as when riding along.
  The kill announcement plays once per kill, keyed on its id. The controls
  are a card shown on demand — H, or the chip at the bottom — rather than a
  panel that is either in the way or gone when it is wanted.

  The weapon strip says what the radar is doing: off, locking (the seeker
  toning up on a target in front of it), or locked — only then will a missile
  guide; otherwise it flies where it is pointed.

  With a flight model behind the aircraft, a systems panel on the right: the
  air data a pilot flies by (IAS, Mach, angle of attack, load factor), the
  engine and the configuration (flaps, gear, speed brake, trim) — and the
  stall warning, which is the one thing on it that must be impossible to miss.
-->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import Icon from '../Icon.svelte';

  const st = $derived(app.sandbox);
  const banner = $derived(st.banner);
  const fl = $derived(st.flight);

  const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('en')}`;

  const lockState = $derived(!st.lock ? 'off' : st.lockLevel >= 1 ? 'locked' : 'locking');

  let bannerVisible = $state(false);
  let bannerTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (!banner) return;
    void banner.id;
    bannerVisible = true;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => (bannerVisible = false), 2600);
  });
</script>

<div class="sandbox-hud" aria-live="polite">
  <div class="score">
    <span class="label">Score</span>
    {#key st.score}<span class="points tabular">{st.score.toLocaleString('en')}</span>{/key}
    <span class="row">
      <span><Icon name="crosshair" size={12} /> {st.kills}</span>
      {#if st.streak > 1}<span class="streak">×{st.streak}</span>{/if}
      <span class="best"><Icon name="trophy" size={12} /> {st.best.toLocaleString('en')}</span>
    </span>
  </div>

  <div class="weapon" class:ready={st.ready >= 1}>
    <Icon name="missile" size={16} />
    <span class="bar"><span style="transform: scaleX({st.ready})"></span></span>
    <span class="state">{st.ready >= 1 ? 'READY' : 'RELOAD'}</span>
    <span class="radar {lockState}">
      {#if lockState === 'off'}RADAR <span class="kbd">R</span>{:else if lockState === 'locking'}LOCKING{:else}LOCKED{/if}
    </span>
  </div>

  {#if st.killCam}
    <p class="killcam"><span class="rec"></span>Kill cam</p>
  {/if}

  {#if st.crashed}
    <p class="crashed">Crashed</p>
  {/if}

  {#if banner && bannerVisible}
    {#key banner.id}
      <div class="banner">
        <span class="title">{banner.title}</span>
        <span class="plus tabular">+{banner.points}</span>
        <span class="detail">{banner.detail}</span>
      </div>
    {/key}
  {/if}

  {#if st.feed.length > 0}
    <ul class="feed">
      {#each st.feed as item (item.id)}
        <li><span>{item.text}</span><span class="tabular">+{item.points}</span></li>
      {/each}
    </ul>
  {/if}

  {#if fl}
    <div class="systems tabular" class:alarm={fl.stallWarning || fl.stalled || fl.overspeed}>
      <div class="air">
        <span class="big">{Math.round(fl.iasKt)}<small>KIAS</small></span>
        {#if fl.jet}<span>M {fl.mach.toFixed(2)}</span>{/if}
      </div>
      <div class="row2">
        <span><small>AOA</small>{fl.aoaDeg.toFixed(1)}°</span>
        <span><small>G</small>{fl.g.toFixed(1)}</span>
        <span><small>VS</small>{signed(fl.verticalFpm)}</span>
      </div>
      <div class="gauge">
        <small>THR</small>
        <span class="meter"><span style="transform: scaleX({fl.throttle})"></span></span>
        <span class="val">{Math.round(fl.throttle * 100)}%</span>
      </div>
      {#if fl.hasAfterburner}
        <div class="gauge ab" class:lit={fl.afterburner > 0.02}>
          <small>A/B</small>
          <span class="meter"><span style="transform: scaleX({fl.afterburner})"></span></span>
          <span class="val">{fl.afterburner > 0.02 ? 'ON' : '—'}</span>
        </div>
      {/if}
      <div class="row2">
        <span><small>{fl.jet ? 'N2' : 'RPM'}</small>{fl.jet ? `${Math.round(fl.rpm)}%` : Math.round(fl.rpm / 10) * 10}</span>
        <span><small>TRIM</small>{signed(fl.trim * 100)}</span>
      </div>
      <div class="config">
        <span class:on={fl.flapsDeg > 0.5}>FLAPS {Math.round(fl.flapsDeg)}°{#if Math.abs(fl.flapsTargetDeg - fl.flapsDeg) > 0.5}→{Math.round(fl.flapsTargetDeg)}°{/if}</span>
        <span class:on={fl.gear === 'down'} class:moving={fl.gear === 'transit'}>GEAR {fl.gear === 'down' ? 'DN' : fl.gear === 'up' ? 'UP' : '···'}</span>
        {#if fl.speedBrake}<span class="on">SPD BRK</span>{/if}
        {#if fl.brake}<span class="on">BRAKES</span>{/if}
      </div>
      {#if fl.stalled}
        <p class="warning">STALL</p>
      {:else if fl.stallWarning}
        <p class="warning soft">STALL WARNING</p>
      {:else if fl.overspeed}
        <p class="warning">OVERSPEED</p>
      {/if}
    </div>
  {/if}

  <button
    class="keys-chip"
    class:on={st.showKeys}
    onclick={() => (app.sandbox.showKeys = !app.sandbox.showKeys)}
    aria-expanded={st.showKeys}
  ><span class="kbd">H</span> {st.showKeys ? 'Hide keys' : 'Keys'}</button>

  <div class="controls" class:gone={!st.showKeys}>
    {#if fl}
      <span><span class="kbd">↑↓</span> pitch (↓ pulls)</span>
      <span><span class="kbd">←→</span> roll</span>
      <span><span class="kbd">A</span><span class="kbd">D</span> rudder</span>
      <span><span class="kbd">W</span><span class="kbd">S</span> / <span class="kbd">Shift</span><span class="kbd">Ctrl</span> throttle</span>
      <span><span class="kbd">F</span><span class="kbd">V</span> flaps · <span class="kbd">G</span> gear · <span class="kbd">X</span> speed brake · <span class="kbd">B</span> brakes</span>
      <span><span class="kbd">[</span><span class="kbd">]</span> trim</span>
      <span><span class="kbd">R</span> radar lock on / off · <span class="kbd">Tab</span> next target · click a target</span>
      <span><span class="kbd">Space</span> fire (guided once LOCKED)</span>
      <span><span class="kbd">1</span>–<span class="kbd">4</span> camera · drag to look around · <span class="kbd">C</span> recentre</span>
    {:else}
      <span><span class="kbd">↑↓</span> climb / dive</span>
      <span><span class="kbd">←→</span> turn</span>
      <span><span class="kbd">Space</span> fire</span>
      <span><span class="kbd">Shift</span> boost · <span class="kbd">Ctrl</span> slow</span>
      <span><span class="kbd">R</span> radar lock on / off · <span class="kbd">Tab</span> next target · click a target</span>
      <span><span class="kbd">1</span>–<span class="kbd">4</span> camera · drag to look around</span>
    {/if}
  </div>
</div>

<style>
  .sandbox-hud {
    position: absolute;
    inset: 0;
    z-index: 16;
    pointer-events: none;
    font-family: var(--mono);
    color: var(--hud-text);
    text-shadow: var(--hud-halo);
  }

  .score {
    position: absolute;
    top: 18px;
    right: 24px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    padding: 8px 12px;
    background: var(--hud-bg);
    border: 1px solid rgb(var(--warm-rgb) / 0.45);
    border-right: 2px solid var(--hud-warm);
    backdrop-filter: blur(8px);
  }
  .label { font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--hud-label); font-weight: 700; }
  .points { font-size: 26px; font-weight: 700; color: var(--hud-warm); animation: bump 0.4s var(--ease); }
  @keyframes bump {
    from { transform: scale(1.25); }
  }
  .row { display: flex; gap: 10px; align-items: center; font-size: 11px; color: var(--hud-dim); }
  .row span { display: inline-flex; gap: 4px; align-items: center; }
  .streak { color: var(--hud-warm); font-weight: 700; }

  .weapon {
    position: absolute;
    bottom: 96px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    font-size: 10px;
    letter-spacing: 0.14em;
    color: var(--hud-dim);
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
  }
  .weapon.ready { color: var(--hud-warm); border-color: rgb(var(--warm-rgb) / 0.5); }
  .bar { width: 90px; height: 3px; background: var(--hud-border); overflow: hidden; }
  .bar span { display: block; height: 100%; background: currentColor; transform-origin: left; transition: transform 0.1s linear; }
  .state { min-width: 52px; font-weight: 700; }
  .radar { padding-left: 8px; border-left: 1px solid var(--hud-border); color: var(--hud-dim); font-weight: 700; }
  .radar.locking { color: var(--hud-warm); animation: blink 0.25s steps(2) infinite; }
  .radar.locked { color: var(--error); }

  .keys-chip {
    position: absolute;
    bottom: 96px;
    left: calc(50% + 190px);
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    font: inherit;
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--hud-dim);
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
    cursor: pointer;
  }
  .keys-chip:hover, .keys-chip.on { color: var(--hud-text); border-color: var(--hud-accent); }

  .killcam {
    position: absolute;
    top: 64px;
    left: 50%;
    transform: translateX(-50%);
    margin: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    color: #fff;
    background: rgb(var(--error-rgb) / 0.75);
    text-shadow: none;
  }
  .rec { width: 8px; height: 8px; border-radius: 50%; background: #fff; animation: blink 1s steps(2) infinite; }
  @keyframes blink {
    50% { opacity: 0; }
  }
  .crashed {
    position: absolute;
    top: 38%;
    left: 50%;
    transform: translateX(-50%);
    margin: 0;
    font-size: clamp(28px, 5vw, 48px);
    font-weight: 300;
    letter-spacing: 0.5em;
    text-transform: uppercase;
    color: var(--error);
    animation: fade-in 0.4s ease-out;
  }

  .banner {
    position: absolute;
    top: 24%;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    animation: banner 2.6s var(--ease) forwards;
  }
  .title { font-size: clamp(22px, 4vw, 38px); font-weight: 800; letter-spacing: 0.3em; text-transform: uppercase; color: var(--hud-warm); }
  .plus { font-size: 20px; font-weight: 700; color: var(--hud-text); }
  .detail { font-size: 11px; letter-spacing: 0.14em; color: var(--hud-dim); }
  @keyframes banner {
    0% { opacity: 0; transform: translateX(-50%) scale(1.6); filter: blur(6px); }
    12% { opacity: 1; transform: translateX(-50%) scale(1); filter: blur(0); }
    80% { opacity: 1; }
    100% { opacity: 0; transform: translateX(-50%) translateY(-12px); }
  }
  @keyframes fade-in {
    from { opacity: 0; }
  }

  .feed {
    position: absolute;
    top: 104px;
    right: 24px;
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 3px;
    font-size: 11px;
  }
  .feed li {
    display: flex;
    gap: 10px;
    padding: 3px 8px;
    background: var(--hud-bg);
    border-right: 2px solid var(--hud-warm);
    animation: feed-in 0.3s var(--ease);
  }
  .feed li span:last-child { color: var(--hud-warm); font-weight: 700; }
  @keyframes feed-in {
    from { opacity: 0; transform: translateX(16px); }
  }

  .controls {
    position: absolute;
    bottom: 132px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 6px 16px;
    max-width: min(640px, calc(100vw - 32px));
    padding: 8px 14px;
    font-size: 11px;
    color: var(--hud-dim);
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
    transition: opacity 0.8s ease, transform 0.8s ease;
  }
  .controls.gone { opacity: 0; transform: translateX(-50%) translateY(8px); visibility: hidden; }
  .controls { transition: opacity 0.25s ease, transform 0.25s ease, visibility 0.25s; }

  .systems {
    position: absolute;
    top: 50%;
    right: 24px;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 176px;
    padding: 10px 12px;
    font-size: 11px;
    background: var(--hud-bg);
    border: 1px solid var(--hud-border);
    border-right: 2px solid var(--hud-accent);
    backdrop-filter: blur(8px);
    transition: border-color 0.2s;
  }
  .systems.alarm { border-color: rgb(var(--error-rgb) / 0.8); }
  .systems small { margin-right: 5px; font-size: 9px; letter-spacing: 0.14em; color: var(--hud-label); font-weight: 700; }
  .air { display: flex; align-items: baseline; justify-content: space-between; }
  .big { font-size: 24px; font-weight: 700; }
  .big small { margin-left: 4px; }
  .row2 { display: flex; justify-content: space-between; gap: 8px; color: var(--hud-dim); }
  .row2 span { color: var(--hud-text); }
  .gauge { display: grid; grid-template-columns: 30px 1fr 34px; align-items: center; gap: 6px; }
  .meter { height: 4px; background: var(--hud-border); overflow: hidden; }
  .meter span { display: block; height: 100%; background: var(--hud-accent); transform-origin: left; }
  .gauge.ab .meter span { background: var(--hud-warm); }
  .gauge.ab.lit .val { color: var(--hud-warm); font-weight: 700; }
  .val { text-align: right; }
  .config { display: flex; flex-wrap: wrap; gap: 4px 8px; font-size: 10px; letter-spacing: 0.08em; color: var(--hud-dim); }
  .config .on { color: var(--hud-accent); }
  .config .moving { color: var(--hud-warm); animation: blink 0.8s steps(2) infinite; }
  .warning {
    margin: 2px 0 0;
    padding: 3px 0;
    text-align: center;
    font-weight: 800;
    letter-spacing: 0.3em;
    color: #fff;
    background: rgb(var(--error-rgb) / 0.85);
    text-shadow: none;
    animation: blink 0.5s steps(2) infinite;
  }
  .warning.soft { background: rgb(var(--warm-rgb) / 0.75); animation-duration: 0.9s; }

  @media (max-width: 720px) {
    .keys-chip { left: auto; right: 12px; bottom: 132px; }
    .systems { top: auto; bottom: 170px; transform: none; width: 150px; right: 12px; }
  }
  .controls .kbd { margin-right: 4px; }
</style>
