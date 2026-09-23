<!--
  Aircraft dossier, map surface.

  Shown the moment an aircraft is picked, before any lookup returns: the
  position feed already carries registration, type, altitude and speed, so the
  panel is useful immediately and the network results fill in behind it. A
  panel that opens empty and spins for a second feels far slower than one that
  opens with two thirds of the answer.

  The facts themselves are in `DossierBody`, shared with the cockpit card so
  the two surfaces cannot drift apart again. What is here is this surface's
  chrome: a way out, and the one action that belongs on a map.
-->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import type { Orchestrator } from '@/app/orchestrator';
  import DossierBody from './panel/DossierBody.svelte';

  let { orchestrator }: { orchestrator: Orchestrator } = $props();

  const sample = $derived(app.selected);

  function close(): void {
    void orchestrator.select(null);
  }
</script>

{#if sample}
  <aside class="panel dossier" aria-label="Aircraft details">
    <button class="close" onclick={close} aria-label="Close details">×</button>

    <DossierBody {sample} />

    <button class="chip primary enter" onclick={() => orchestrator.enterPov()}>
      Step inside this aircraft
      <span class="kbd">↵</span>
    </button>
  </aside>
{/if}

<style>
  .dossier {
    position: absolute;
    top: 16px;
    right: 16px;
    width: 340px;
    max-height: calc(100% - 32px);
    overflow-y: auto;
    padding: 16px;
    z-index: 20;
  }

  /* Floated rather than in a flex header: the identity block belongs to the
     shared body now, and a close button has no business inside it. */
  .close {
    position: absolute;
    top: 10px;
    right: 12px;
    font-size: 22px;
    line-height: 1;
    color: var(--text-faint);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
  }
  .close:hover { color: var(--text); background: rgba(255, 255, 255, 0.07); }

  /* The one primary action on this surface, so it gets the one amber button. */
  .enter {
    width: 100%;
    margin-top: 16px;
    padding: 11px;
    justify-content: center;
    font-size: 12px;
  }
  .enter:hover { filter: brightness(1.15); }

  .kbd {
    font-family: var(--mono);
    font-size: 11px;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.18);
  }
</style>
