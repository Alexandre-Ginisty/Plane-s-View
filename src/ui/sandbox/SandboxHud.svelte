<!--
  The sandbox's own layer of the HUD: score, weapon, lock, kills.

  Over the ordinary cockpit HUD rather than instead of it — speed, altitude
  and the horizon are as useful when flying yourself as when riding along.
  The kill announcement plays once per kill, keyed on its id, and the
  controls fade out after the first seconds, once they have been read.
-->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import Icon from '../Icon.svelte';

  const st = $derived(app.sandbox);
  const banner = $derived(st.banner);

  let showControls = $state(true);
  $effect(() => {
    const t = setTimeout(() => (showControls = false), 9000);
    return () => clearTimeout(t);
  });

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
    <span class="state">{st.ready >= 1 ? (st.lock ? 'LOCKED' : 'READY') : 'RELOAD'}</span>
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

  <div class="controls" class:gone={!showControls}>
    <span><span class="kbd">↑↓</span> climb / dive</span>
    <span><span class="kbd">←→</span> turn</span>
    <span><span class="kbd">Space</span> fire</span>
    <span><span class="kbd">Shift</span> boost · <span class="kbd">Ctrl</span> slow</span>
    <span><span class="kbd">Tab</span> / click a target to lock</span>
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
  .controls.gone { opacity: 0; transform: translateX(-50%) translateY(8px); }
  .controls .kbd { margin-right: 4px; }
</style>
