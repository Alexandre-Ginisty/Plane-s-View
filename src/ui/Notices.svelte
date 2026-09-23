<!-- Transient messages. Failures here are normal (a provider goes down, a
     lookup misses) so they are reported quietly and never block the view. -->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
</script>

<div class="notices" role="log" aria-live="polite">
  {#each app.notices as notice (notice.id)}
    <div class="notice {notice.level}">
      <span>{notice.text}</span>
      <button onclick={() => app.dismiss(notice.id)} aria-label="Dismiss">×</button>
    </div>
  {/each}
</div>

<style>
  .notices {
    position: absolute;
    bottom: 40px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 6px;
    z-index: 40;
    pointer-events: none;
    max-width: min(560px, calc(100vw - 32px));
  }
  .notice {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 14px;
    font-size: 12px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    /* A coloured rule down the leading edge, so severity is readable before
       the text is — the same cue the status dots use. */
    border-left: 2px solid var(--accent);
    backdrop-filter: blur(12px);
    box-shadow: var(--shadow);
    pointer-events: auto;
    animation: rise 0.22s ease-out;
  }
  .notice.warn { border-left-color: var(--warn); color: #ffd7ab; }
  .notice.error { border-left-color: var(--error); color: #ffc0cd; }
  .notice button { color: inherit; opacity: 0.5; font-size: 16px; line-height: 1; }
  .notice button:hover { opacity: 1; }

  @keyframes rise {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }
</style>
