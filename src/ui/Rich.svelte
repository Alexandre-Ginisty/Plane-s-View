<!--
  A translated sentence with key caps in it: `Press <k>F</k> to leave`.
  The key caps are drawn as keys; everything else is text, never markup.
-->
<script lang="ts">
  import { t, type MessageKey } from '@/i18n/index.svelte';
  import { splitKeys } from '@/i18n/rich';

  let { key, params }: { key: MessageKey; params?: Record<string, string | number> } = $props();
  const parts = $derived(splitKeys(t(key, params)));
</script>

{#each parts as part, i (i)}{#if part.kbd}<span class="kbd">{part.text}</span>{:else}{part.text}{/if}{/each}
