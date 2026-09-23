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
  import type { Orchestrator } from '@/app/orchestrator';
  import type { SampledAircraft } from '@/state/traffic';
  import DossierBody from '../panel/DossierBody.svelte';

  let {
    sample,
    orchestrator,
  }: { sample: SampledAircraft; orchestrator: Orchestrator } = $props();
</script>

<aside class="flight-card" class:collapsed={!app.showFlightCard}>
  <button
    class="chip"
    onclick={() => (app.showFlightCard = !app.showFlightCard)}
    aria-expanded={app.showFlightCard}
  >{app.showFlightCard ? 'Hide details' : 'Details'}</button>

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
          {app.shuffling ? 'Finding one…' : 'Take me somewhere else'}
        </button>
        <button class="chip back" onclick={() => orchestrator.exitPov()}>Back to map</button>
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
</style>
