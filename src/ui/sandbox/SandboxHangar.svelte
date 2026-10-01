<!--
  The sandbox hangar: pick what to fly from the place just chosen.

  Every aircraft the app has a model for, grouped, with the armed ones first.
  The map stays live underneath — another click on it moves the start — and
  the choice is remembered for next time.
-->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import type { Orchestrator } from '@/app/orchestrator';
  import { GROUP_LABELS, SANDBOX_AIRCRAFT, type SandboxGroup } from '@/sandbox/catalog';
  import Icon from '../Icon.svelte';

  let { orchestrator }: { orchestrator: Orchestrator } = $props();

  const GROUPS = Object.keys(GROUP_LABELS) as SandboxGroup[];
  let group = $state<SandboxGroup>(SANDBOX_AIRCRAFT.find((a) => a.id === app.sandbox.aircraftId)?.group ?? 'combat');
  const list = $derived(SANDBOX_AIRCRAFT.filter((a) => a.group === group));
  const chosen = $derived(SANDBOX_AIRCRAFT.find((a) => a.id === app.sandbox.aircraftId) ?? SANDBOX_AIRCRAFT[0]!);

  const spawn = $derived(app.sandbox.spawn);
  const coords = $derived(
    spawn ? `${Math.abs(spawn.lat).toFixed(2)}°${spawn.lat >= 0 ? 'N' : 'S'} ${Math.abs(spawn.lon).toFixed(2)}°${spawn.lon >= 0 ? 'E' : 'W'}` : '',
  );

  function launch(): void {
    void orchestrator.launchSandbox(app.sandbox.aircraftId);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      launch();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<aside class="panel hangar" aria-label="Sandbox hangar">
  <header>
    <p class="eyebrow"><Icon name="crosshair" size={13} /> Sandbox</p>
    <h2>{spawn?.name ?? 'Somewhere'}</h2>
    <p class="where tabular">{coords} · <span>click the map to move</span></p>
    <button class="close" onclick={() => orchestrator.cancelSandbox()} aria-label="Cancel"><Icon name="close" size={16} /></button>
  </header>

  <div class="tabs" role="tablist">
    {#each GROUPS as g (g)}
      <button role="tab" class:active={group === g} aria-selected={group === g} onclick={() => (group = g)}>
        {GROUP_LABELS[g]}
      </button>
    {/each}
  </div>

  <ul class="grid">
    {#each list as a, i (a.id)}
      <li style="--i: {i}">
        <button class="card" class:chosen={chosen.id === a.id} onclick={() => (app.sandbox.aircraftId = a.id)} ondblclick={launch}>
          <span class="name">{a.name}</span>
          <span class="meta">
            <span class="type">{a.type.startsWith('SB') ? 'Armed' : a.type}</span>
            <span class="weapon" class:rockets={a.weapon === 'rockets'}>
              <Icon name="missile" size={11} />{a.weapon === 'rockets' ? 'Rockets' : 'Missiles'}
            </span>
          </span>
          {#if a.blurb}<span class="blurb">{a.blurb}</span>{/if}
          <span class="speed tabular">{a.flight.cruiseKt} kt{a.flight.heli ? ' · hover' : ''}</span>
        </button>
      </li>
    {/each}
  </ul>

  <footer>
    <div class="controls">
      <span><span class="kbd">↑</span><span class="kbd">↓</span> climb / dive</span>
      <span><span class="kbd">←</span><span class="kbd">→</span> turn</span>
      <span><span class="kbd">Space</span> fire</span>
      <span><span class="kbd">Shift</span> boost</span>
      <span><span class="kbd">Tab</span> next target</span>
    </div>
    <button class="chip primary deploy" onclick={launch}>
      <Icon name="plane" size={15} /> Deploy the {chosen.name} <span class="kbd">↵</span>
    </button>
  </footer>
</aside>

<style>
  .hangar {
    position: absolute;
    top: 76px;
    right: 16px;
    bottom: 44px;
    width: min(420px, calc(100vw - 32px));
    z-index: 25;
    display: flex;
    flex-direction: column;
    padding: 18px 18px 16px;
    animation: slide-in 0.45s var(--ease);
  }
  @keyframes slide-in {
    from { opacity: 0; transform: translateX(30px); }
  }
  header { position: relative; }
  .eyebrow {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font: 700 10px/1 var(--mono);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--accent-warm);
  }
  h2 { margin: 8px 0 2px; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
  .where { margin: 0; font-size: 11px; color: var(--text-faint); }
  .where span { font-family: var(--sans); }
  .close { position: absolute; top: -4px; right: -4px; padding: 6px; color: var(--text-faint); }
  .close:hover { color: var(--text); }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    margin: 16px 0 12px;
    padding: 3px;
    border: 1px solid var(--border);
  }
  .tabs button {
    flex: 1 1 auto;
    padding: 6px 8px;
    font: 600 10px/1 var(--mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
    transition: background 0.2s, color 0.2s;
  }
  .tabs button:hover { background: var(--hover-bg); color: var(--accent); }
  .tabs button.active { background: var(--accent); color: var(--on-accent); }

  .grid {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 0 2px 0 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    align-content: start;
  }
  .grid li { animation: card-in 0.35s var(--ease) both; animation-delay: calc(var(--i) * 25ms); }
  @keyframes card-in {
    from { opacity: 0; transform: translateY(8px); }
  }
  .card {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 5px;
    padding: 10px 11px;
    text-align: left;
    border: 1px solid var(--border);
    background: var(--hover-bg);
    transition: border-color 0.2s, background 0.2s, transform 0.2s var(--ease);
  }
  .card:hover { border-color: var(--border-strong); transform: translateY(-2px); }
  .card.chosen {
    border-color: var(--accent-warm);
    background: rgb(var(--warm-rgb) / 0.1);
    box-shadow: inset 2px 0 0 var(--accent-warm);
  }
  .name { font-size: 13px; font-weight: 650; color: var(--text); }
  .meta { display: flex; gap: 6px; align-items: center; }
  .type { font: 600 9.5px/1 var(--mono); letter-spacing: 0.08em; color: var(--accent); }
  .weapon {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 5px;
    font: 600 9px/1 var(--mono);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent-warm);
    border: 1px solid rgb(var(--warm-rgb) / 0.4);
  }
  .blurb { font-size: 11px; line-height: 1.35; color: var(--text-dim); }
  .speed { margin-top: auto; font-size: 10px; color: var(--text-faint); }

  footer { margin-top: 14px; display: flex; flex-direction: column; gap: 12px; }
  .controls { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 11px; color: var(--text-dim); }
  .controls .kbd { margin-right: 3px; }
  .deploy { justify-content: center; padding: 12px; font-size: 12px; }
</style>
