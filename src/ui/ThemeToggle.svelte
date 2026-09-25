<!--
  Dark / daylight switch.

  A single button rather than a three-way control with "system". The stored
  value already means "override", so the way back to following the system is to
  clear it — and a tri-state toggle that most people will never reach the third
  state of is a worse trade than one clear switch. Alt-clicking clears it, which
  is documented in the title and costs nothing to anyone who never finds it.
-->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';

  let { compact = false }: { compact?: boolean } = $props();

  const next = $derived(app.theme === 'dark' ? 'light' : 'dark');
</script>

<button
  class="theme-toggle"
  class:compact
  onclick={(event) => app.setTheme(next, event.altKey)}
  aria-label={`Switch to ${next} theme`}
  title={`Switch to ${next} theme — alt-click to follow the system`}
>
  {#if app.theme === 'dark'}
    <!-- Sun: what the button will give you, not what you have. A control
         labelled with the current state reads as a status light. -->
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4.4" />
      {#each [0, 45, 90, 135, 180, 225, 270, 315] as angle (angle)}
        <line x1="12" y1="2.6" x2="12" y2="5.2" transform="rotate({angle} 12 12)" />
      {/each}
    </svg>
  {:else}
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 14.2A8.4 8.4 0 0 1 9.8 4 8.6 8.6 0 1 0 20 14.2Z" />
    </svg>
  {/if}
  {#if !compact}<span>{app.theme === 'dark' ? 'Light' : 'Dark'}</span>{/if}
</button>

<style>
  .theme-toggle {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 6px 11px;
    font: 600 11px/1 var(--mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    transition: border-color 180ms ease, color 180ms ease;
  }
  .theme-toggle:hover { border-color: var(--border-strong); }
  .theme-toggle.compact { padding: 6px; }

  svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
  }
  /* The moon is a solid shape; the sun is strokes. */
  svg path { fill: currentColor; stroke: none; }
</style>
