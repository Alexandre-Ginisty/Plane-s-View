<!--
  Which imagery the globe is skinned with.

  Each option states what it is good for, since "Sentinel-2" means nothing
  without knowing it is the cloud-free one.

  There is no detail setting beside it any more. It used to offer a standard
  and a high level, and the standard one — the default — is what people were
  looking at when they said parts of the map were not really 3D. Detail is not
  a taste, and the only honest input to it is what the connection can carry,
  which is measured rather than asked about.
-->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import { IMAGERY_SOURCES } from '@/tiles/sources';
  import type { Orchestrator } from '@/app/orchestrator';
  import Icon from './Icon.svelte';

  let { orchestrator }: { orchestrator: Orchestrator } = $props();
</script>

<div class="layers">
  <button
    class="tool"
    class:on={app.showLayers}
    onclick={() => (app.showLayers = !app.showLayers)}
    aria-expanded={app.showLayers}
    title="Imagery and map overlays"
  ><Icon name="layers" /><span class="text">Layers</span></button>

  {#if app.showLayers}
    <div class="panel menu" role="menu">
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

      <p class="heading">Map overlay</p>
      <button
        role="menuitemcheckbox"
        aria-checked={app.showLabels}
        class:active={app.showLabels}
        onclick={() => orchestrator.setLabels(!app.showLabels)}
      >
        <span class="name">Countries &amp; cities</span>
        <span class="zoom">{app.showLabels ? 'on' : 'off'}</span>
        <span class="desc">Borders and place names over the imagery, loaded with the view.</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .layers { position: relative; }
  .menu {
    position: absolute;
    top: calc(100% + 10px);
    left: -3px;
    width: 280px;
    padding: 5px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    z-index: 30;
    animation: menu-in 0.22s var(--ease);
    transform-origin: top left;
  }
  @keyframes menu-in {
    from { opacity: 0; transform: translateY(-6px) scale(0.98); }
    to { opacity: 1; transform: none; }
  }
  .menu button {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 1px 8px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    text-align: left;
  }
  .menu button:hover { background: var(--hover-bg); }
  .menu button.active { background: var(--active-bg); box-shadow: inset 2px 0 0 var(--accent); }
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
