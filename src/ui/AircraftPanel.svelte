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
  import { t } from '@/i18n/index.svelte';
  import type { Orchestrator } from '@/app/orchestrator';
  import DossierBody from './panel/DossierBody.svelte';

  let { orchestrator }: { orchestrator: Orchestrator } = $props();

  const sample = $derived(app.selected);

  function close(): void {
    void orchestrator.select(null);
  }
</script>

{#if sample}
  <aside class="panel dossier" aria-label={t('panel.aria')}>
    <button class="close" onclick={close} aria-label={t('panel.close')}>×</button>

    <div class="scroller">
      <DossierBody {sample} />
    </div>

    <button class="chip primary enter" onclick={() => orchestrator.enterPov()}>
      {t('panel.stepInside')}
      <span class="kbd">↵</span>
    </button>
  </aside>
{/if}

<style>
  /*
   * The action never scrolls out of reach.
   *
   * The panel used to scroll as one block with "Step inside" as its last
   * child, so on a laptop window the one button the whole surface exists for
   * was below the fold and you had to scroll a dossier you had not asked to
   * read in order to find it. The facts scroll; the action is pinned.
   */
  .dossier {
    position: absolute;
    top: 16px;
    right: 16px;
    width: 340px;
    max-height: calc(100% - 32px);
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    padding: 16px;
    z-index: 20;
  }

  .scroller {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    /* Room for the pinned button's shadow, and so the last row does not look
       clipped mid-character where the scroll area ends. */
    padding-bottom: 4px;
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
  .close:hover { color: var(--text); background: var(--hover-bg); }

  /* The one primary action on this surface, so it gets the one amber button. */
  .enter {
    flex: 0 0 auto;
    width: 100%;
    margin-top: 14px;
    padding: 11px;
    justify-content: center;
    font-size: 12px;
  }
  .enter:hover { filter: brightness(1.15); }

  .enter .kbd { font-size: 11px; padding: 1px 6px; color: inherit; border-color: currentColor; }

  /*
   * A phone: a sheet along the bottom, so the aircraft stays visible on the
   * map above it instead of disappearing under a panel the height of the
   * screen. Wide enough for the figures, short enough to see where it is.
   */
  @media (max-width: 640px) {
    .dossier {
      top: auto;
      left: 8px;
      right: 8px;
      bottom: calc(8px + env(safe-area-inset-bottom));
      width: auto;
      max-height: 56%;
      padding: 14px 14px 12px;
      animation: sheet-up 0.32s var(--ease) both;
    }
    .enter { margin-top: 10px; padding: 13px; }
  }
  @keyframes sheet-up {
    from { transform: translateY(24px); opacity: 0; }
  }
</style>
