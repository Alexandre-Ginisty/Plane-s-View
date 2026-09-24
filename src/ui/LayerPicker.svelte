<!--
  Imagery layer and detail ceiling.

  Two settings, one menu, because they answer the same question — "what am I
  looking at, and how much of it am I willing to download". Each imagery option
  states what it is good for, since "Sentinel-2" means nothing without knowing
  it is the cloud-free one.

  The detail control is a *ceiling*, not a level: see `@/net/quality/preference`.
  The wording has to stay honest about that. "High detail" lets the terrain
  stream as sharp as the connection allows; it cannot make a weak link carry
  more, and a label promising sharpness would be a promise the physics breaks.
-->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import { IMAGERY_SOURCES } from '@/tiles/sources';
  import { QUALITY_LABELS, type QualityPreference } from '@/net/quality';
  import type { Orchestrator } from '@/app/orchestrator';

  let { orchestrator }: { orchestrator: Orchestrator } = $props();

  const options: QualityPreference[] = ['low', 'high'];
</script>

<div class="layers">
  <button
    class="chip"
    onclick={() => (app.showLayers = !app.showLayers)}
    aria-expanded={app.showLayers}
  >Imagery</button>

  {#if app.showLayers}
    <div class="panel menu" role="menu">
      <p class="heading">Detail</p>
      {#each options as option (option)}
        <button
          role="menuitemradio"
          aria-checked={app.quality === option}
          class:active={app.quality === option}
          onclick={() => orchestrator.setQuality(option)}
        >
          <span class="name">{QUALITY_LABELS[option].label}</span>
          <span class="desc">{QUALITY_LABELS[option].hint}</span>
        </button>
      {/each}

      <p class="heading">Imagery</p>
      {#each IMAGERY_SOURCES as source (source.id)}
        <button
          role="menuitemradio"
          aria-checked={app.imageryId === source.id}
          class:active={app.imageryId === source.id}
          onclick={() => { orchestrator.setImagery(source.id); app.showLayers = false; }}
        >
          <span class="name">{source.label}</span>
          <span class="desc">{source.description}</span>
          <span class="zoom">to z{source.maxZoom}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .layers { position: relative; }
  .menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    width: 280px;
    padding: 5px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    z-index: 30;
  }
  .menu button {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 1px 8px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    text-align: left;
  }
  .menu button:hover { background: rgba(127, 223, 255, 0.08); }
  .menu button.active { background: rgba(127, 223, 255, 0.14); box-shadow: inset 2px 0 0 var(--accent); }
  .name { font-size: 12.5px; font-weight: 600; letter-spacing: 0.04em; }
  .zoom { font-size: 10px; color: var(--accent-dim); font-family: var(--mono); }
  .desc { grid-column: 1 / -1; font-size: 11px; color: var(--text-dim); }

  .heading {
    margin: 6px 0 2px;
    padding: 0 10px;
    font-family: var(--mono);
    font-size: 9.5px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .heading:first-child { margin-top: 2px; }
</style>
