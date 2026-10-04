<!--
  Flight details, cockpit surface.

  The same dossier the map shows, at HUD scale — see `DossierBody`. It used to
  be a hand-maintained subset, which meant stepping into an aircraft quietly
  dropped its photo, its route airline, the wind aloft, the outside air
  temperature and the emergency squawk, and added four figures the map never
  had. Two lists of the same thing diverge; one does not.

  Collapsible, because in the cockpit the view matters more than the numbers —
  and the toggle now works. It is a direct child of this component, so Hud's
  `.hud button { pointer-events: auto }` never reached it: the rule was scoped
  to Hud's own markup, the button inherited the HUD's `pointer-events: none`,
  and "Hide details" was dead for the whole session.
-->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import { t } from '@/i18n/index.svelte';
  import type { Orchestrator } from '@/app/orchestrator';
  import type { SampledAircraft } from '@/state/traffic';
  import DossierBody from '../panel/DossierBody.svelte';

  let {
    sample,
    orchestrator,
  }: { sample: SampledAircraft; orchestrator: Orchestrator } = $props();
</script>

<aside class="flight-card" class:collapsed={!app.showFlightCard} class:aside={app.lookingAround}>
  <button
    class="chip"
    onclick={() => (app.showFlightCard = !app.showFlightCard)}
    aria-expanded={app.showFlightCard}
  >{t(app.showFlightCard ? 'card.hideDetails' : 'card.details')}</button>

  {#if app.showFlightCard}
    <div class="panel card-body">
      <div class="scroller">
        <DossierBody {sample} dense />
      </div>

      <div class="actions">
        <button
          class="chip primary shuffle"
          disabled={app.shuffling}
          onclick={() => void orchestrator.shuffleAircraft()}
        >
          {t(app.shuffling ? 'card.finding' : 'card.somewhereElse')}
        </button>
        <button class="chip back" onclick={() => orchestrator.exitPov()}>{t('hud.backToMap')}</button>
      </div>
    </div>
  {/if}
</aside>

<style>
  .flight-card {
    position: absolute;
    top: 62px;
    right: 24px;
    width: 286px;
    max-width: calc(100vw - 48px);
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    font-family: var(--sans);
    max-height: calc(100% - 120px);
  }
  .flight-card.collapsed { width: auto; }
  /*
   * Stepped aside while the view is being dragged, and back on release. The
   * toggle is still the way to keep it hidden; this only gets it out of the
   * way of a look around, which is what it used to block.
   */
  .flight-card { transition: opacity 0.28s var(--ease), transform 0.28s var(--ease); }
  .flight-card.aside { opacity: 0; transform: translateX(24px); pointer-events: none; }
  .flight-card.aside :global(*) { pointer-events: none !important; }

  /*
   * The two actions are pinned; only the figures scroll.
   *
   * The card used to scroll as one block with the button last, so in the
   * cockpit — where the card is already short to leave the view room — the
   * way out was reliably below the fold.
   */
  .card-body {
    width: 100%;
    min-height: 0;
    padding: 14px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    pointer-events: auto;
  }

  .scroller {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }

  .actions {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 12px;
  }

  .actions button { width: 100%; justify-content: center; }
  .shuffle:disabled { opacity: 0.6; cursor: progress; }
  .back { font-size: 11px; padding: 6px; }

  /*
   * Narrow screens keep the toggle and lose the panel's default.
   *
   * It used to be `display: none` outright, on the reasoning that the same
   * figures were one tap away on the map. They are — but only if you leave
   * the cockpit to get them, and the toggle that would have made this a
   * choice was broken anyway. Now the card is reachable everywhere and simply
   * narrower where there is less room.
   */
  @media (max-width: 900px) {
    .flight-card { top: 54px; right: 12px; width: 250px; max-height: calc(100% - 160px); }
  }
  /*
   * A phone: the toggle top right, and the card a sheet along the bottom over
   * the dock — open, it is what the user is reading, and closing it gives the
   * whole view back.
   */
  @media (max-width: 720px) {
    .flight-card {
      position: static;
      width: auto;
      max-width: none;
    }
    .flight-card > .chip {
      position: absolute;
      top: calc(10px + env(safe-area-inset-top));
      right: calc(10px + env(safe-area-inset-right));
      padding: 10px 12px;
    }
    .card-body {
      position: absolute;
      left: 8px;
      right: 8px;
      bottom: calc(8px + env(safe-area-inset-bottom));
      width: auto;
      max-height: 58%;
      z-index: 2;
      animation: sheet-up 0.3s var(--ease) both;
    }
  }
  @keyframes sheet-up {
    from { transform: translateY(24px); opacity: 0; }
  }
</style>
