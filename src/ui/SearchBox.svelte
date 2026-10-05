<!--
  Search, in two ways: for a place, and for an aircraft model.

  A place puts the map over it. A model flies the visitor into a random
  aircraft of exactly that model, wherever one is in the air right now. Both
  are answered from tables in the page (see `@/data/places/search` and
  `@/data/meta/typeNames`), so what is typed goes nowhere.
-->
<script lang="ts">
  import { app } from '@/state/appStore.svelte';
  import { t } from '@/i18n/index.svelte';
  import type { Orchestrator } from '@/app/orchestrator';
  import { onPlaceIndex, preparePlaceSearch, searchPlaces, type PlaceResult } from '@/data/places/search';
  import { onMount } from 'svelte';
  import { searchTypes, type TypeChoice } from '@/data/meta/typeNames';
  import Icon from '@/ui/Icon.svelte';

  let { orchestrator }: { orchestrator: Orchestrator } = $props();

  let mode = $state<'city' | 'model'>('city');
  let query = $state('');
  let focused = $state(false);
  let active = $state(0);
  let input: HTMLInputElement;
  /** Bumped when more of the place index arrives, so a query typed before it did is answered. */
  let indexVersion = $state(0);
  onMount(() => onPlaceIndex(() => indexVersion++));

  interface Row {
    key: string;
    title: string;
    detail: string;
    choose(): void;
  }

  const rows = $derived.by((): Row[] => {
    if (query.trim().length < (mode === 'city' ? 2 : 1)) return [];
    if (mode === 'city') {
      void indexVersion;
      return searchPlaces(query).map((p: PlaceResult) => ({
        key: `${p.kind}|${p.name}|${p.lat}|${p.lon}`,
        title: p.name,
        detail: p.detail,
        choose: () => orchestrator.goToPlace(p),
      }));
    }
    return searchTypes(query).map((c: TypeChoice) => ({
      key: c.code,
      title: c.name,
      detail: c.code,
      choose: () => void orchestrator.flyToType(c.code),
    }));
  });

  const open = $derived(focused && query.trim().length > 0);

  function choose(row: Row | undefined): void {
    if (!row) return;
    row.choose();
    query = '';
    active = 0;
    input.blur();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = rows.length ? (active + 1) % rows.length : 0;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = rows.length ? (active - 1 + rows.length) % rows.length : 0;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(rows[active]);
    } else if (event.key === 'Escape') {
      query = '';
      input.blur();
    }
  }

  function setMode(next: 'city' | 'model'): void {
    mode = next;
    active = 0;
    input.focus();
  }

  // The index is a couple of hundred kilobytes: fetched when the box is first used.
  function onFocus(): void {
    focused = true;
    void preparePlaceSearch().catch(() => undefined);
  }
</script>

<div class="search" role="search" aria-label={t('search.label')}>
  <div class="field" class:open>
    <span class="lens"><Icon name="search" size={15} /></span>
    <input
      bind:this={input}
      id="search-input"
      type="search"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      enterkeyhint="go"
      placeholder={t(mode === 'city' ? 'search.cityHint' : 'search.modelHint')}
      bind:value={query}
      oninput={() => (active = 0)}
      onfocus={onFocus}
      onblur={() => setTimeout(() => (focused = false), 120)}
      onkeydown={onKeydown}
      disabled={mode === 'model' && app.shuffling}
    />
    <div class="modes" role="tablist">
      <button role="tab" aria-selected={mode === 'city'} class:on={mode === 'city'} onmousedown={(e) => e.preventDefault()} onclick={() => setMode('city')}>
        <Icon name="pin" size={13} /><span>{t('search.city')}</span>
      </button>
      <button role="tab" aria-selected={mode === 'model'} class:on={mode === 'model'} onmousedown={(e) => e.preventDefault()} onclick={() => setMode('model')}>
        <Icon name="plane" size={13} /><span>{t('search.model')}</span>
      </button>
    </div>
  </div>

  {#if open}
    <ul class="results" role="listbox">
      {#each rows as row, i (row.key)}
        <li role="option" aria-selected={i === active}>
          <button class:active={i === active} onmousedown={(e) => e.preventDefault()} onclick={() => choose(row)} onmouseenter={() => (active = i)}>
            <span class="title">{row.title}</span>
            <span class="detail">{row.detail}</span>
          </button>
        </li>
      {:else}
        <li class="none">{t('search.none')}</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .search {
    position: relative;
    flex: 1 1 260px;
    min-width: 220px;
    max-width: 440px;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 40px;
    padding: 0 4px 0 12px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    backdrop-filter: blur(14px) saturate(1.2);
    -webkit-backdrop-filter: blur(14px) saturate(1.2);
    box-shadow: var(--shadow);
    clip-path: polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 9px 100%, 0 calc(100% - 9px));
    transition: border-color 0.18s var(--ease);
  }
  .field:focus-within { border-color: var(--border-strong); }
  .lens { display: inline-flex; color: var(--text-dim); }
  .field:focus-within .lens { color: var(--accent); }
  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.04em;
    color: var(--text);
    background: transparent;
    border: 0;
    outline: 0;
  }
  input::placeholder { color: var(--text-dim); opacity: 0.8; }
  input::-webkit-search-cancel-button { display: none; }
  input:disabled { opacity: 0.5; cursor: progress; }

  .modes { display: flex; gap: 1px; }
  .modes button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 32px;
    padding: 0 9px;
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
    background: transparent;
    border: 0;
    cursor: pointer;
    transition: color 0.18s var(--ease), background 0.18s var(--ease);
  }
  .modes button:hover { color: var(--accent); background: var(--hover-bg); }
  .modes button.on { color: var(--accent); background: var(--active-bg); }

  .results {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 40;
    margin: 0;
    padding: 3px;
    list-style: none;
    background: var(--bg-panel);
    border: 1px solid var(--border-strong);
    backdrop-filter: blur(16px) saturate(1.2);
    -webkit-backdrop-filter: blur(16px) saturate(1.2);
    box-shadow: var(--shadow);
    max-height: min(60vh, 380px);
    overflow-y: auto;
  }
  .results button {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 8px 10px;
    text-align: start;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text);
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  .results button.active { color: var(--accent); background: var(--hover-bg); }
  .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail { flex: none; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; letter-spacing: 0.05em; color: var(--text-dim); }
  .none { padding: 10px; font-family: var(--mono); font-size: 11px; color: var(--text-dim); }

  @media (max-width: 760px) {
    .search { flex: 1 1 100%; max-width: none; order: 3; }
    .modes span { display: none; }
  }
</style>
