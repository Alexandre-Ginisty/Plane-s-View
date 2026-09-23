<!-- Imagery layer selector. Each option states what it is good for, because
     "Sentinel-2" means nothing without knowing it is the cloud-free one. -->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import { IMAGERY_SOURCES } from '@/tiles/sources';
  import type { Orchestrator } from '@/app/orchestrator';

  let { orchestrator }: { orchestrator: Orchestrator } = $props();
</script>

<div class="layers">
  <button
    class="chip"
    onclick={() => (app.showLayers = !app.showLayers)}
    aria-expanded={app.showLayers}
  >Imagery</button>

  {#if app.showLayers}
    <div class="panel menu" role="menu">
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
</style>
