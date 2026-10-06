<!--
  The language button.

  A pill showing the current language by its own name, opening a list of every
  language, each in its own script (a visitor who cannot read the page cannot be
  expected to look for their language under its English name). Choosing one
  switches the whole site at once, and the choice is remembered.

  Used on the front page and in the map toolbar, so the language can be changed
  from either; `tool` styles it as a plain button inside a dock, and `bare`
  leaves the button out altogether, for a dock that has its own: the list then
  opens and closes through `open`.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { i18n, setLocale, t } from '@/i18n/index.svelte';
  import { LOCALES, localeInfo } from '@/i18n/locales';
  import Icon from '@/ui/Icon.svelte';

  let { tool = false, bare = false, open = $bindable(false) }: { tool?: boolean; bare?: boolean; open?: boolean } = $props();

  let query = $state('');
  let root: HTMLDivElement;
  let search: HTMLInputElement | undefined = $state();

  const current = $derived(localeInfo(i18n.locale));

  /** Matches either name, in either script, ignoring case and accents. */
  function plain(text: string): string {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }
  const shown = $derived.by(() => {
    const q = plain(query.trim());
    if (!q) return LOCALES;
    return LOCALES.filter((l) => plain(l.native).includes(q) || plain(l.name).includes(q) || l.code.toLowerCase().startsWith(q));
  });

  async function toggle(): Promise<void> {
    open = !open;
    query = '';
    if (open) {
      await tick();
      search?.focus();
    }
  }

  async function choose(code: string): Promise<void> {
    open = false;
    await setLocale(code);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (open && event.key === 'Escape') {
      // The front page leaves on Escape; here it only closes the list.
      event.stopPropagation();
      event.preventDefault();
      open = false;
    }
  }

  function onOutside(event: PointerEvent): void {
    const target = event.target as Element | null;
    // The dock's own language button toggles the list itself.
    if (open && !root.contains(target) && !target?.closest?.('[data-dock-item="language"]')) open = false;
  }

  // Opened from outside: the search box takes the keyboard, as it does from the trigger.
  $effect(() => {
    if (bare && open) {
      query = '';
      if (!matchMedia('(pointer: coarse)').matches) void tick().then(() => search?.focus({ preventScroll: true }));
    }
  });
</script>

<svelte:window onpointerdown={onOutside} onkeydown={onKeydown} />

<div class="lang-picker" class:tool class:bare bind:this={root}>
  {#if !bare}<button
    class="trigger"
    onclick={toggle}
    aria-haspopup="true"
    aria-expanded={open}
    aria-label="{t('lang.title')} — {current.native}"
    title={t('lang.title')}
  >
    <Icon name="globe" size={15} />
    <span class="name" lang={current.code}>{current.native}</span>
  </button>{/if}

  {#if open}
    <div class="menu" role="dialog" aria-label={t('lang.label')}>
      <input
        bind:this={search}
        bind:value={query}
        type="search"
        placeholder={t('lang.search')}
        aria-label={t('lang.search')}
        autocomplete="off"
        spellcheck="false"
      />
      {#if shown.length === 0}
        <p class="none">{t('lang.none')}</p>
      {:else}
        <ul>
          {#each shown as locale (locale.code)}
            <li>
              <button
                class="item"
                class:active={locale.code === current.code}
                lang={locale.code}
                dir={locale.dir}
                aria-current={locale.code === current.code ? 'true' : undefined}
                onclick={() => choose(locale.code)}
              >
                <span class="native">{locale.native}</span>
                {#if locale.native !== locale.name}<span class="english">{locale.name}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .lang-picker { position: relative; display: inline-block; }

  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 7px 11px;
    font: 600 11px/1 var(--mono);
    letter-spacing: 0.08em;
    color: var(--accent);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    transition: border-color 180ms ease, color 180ms ease;
  }
  .trigger:hover { border-color: var(--border-strong); }
  .trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .name { max-width: 11ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Inside a dock: a plain tool like its neighbours. */
  .tool .trigger {
    height: 34px;
    padding: 0 11px;
    background: transparent;
    border: 0;
    color: var(--text-dim);
  }
  .tool .trigger:hover { color: var(--accent); background: var(--hover-bg); }

  .menu {
    position: absolute;
    inset-inline-end: 0;
    top: calc(100% + 8px);
    z-index: 300;
    width: min(340px, calc(100vw - 32px));
    max-height: min(70vh, 460px);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    background: var(--bg-panel-solid, var(--bg-panel));
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
  }
  /* Opening upwards from the bottom dock is not needed: it lives in the top bars. */

  input {
    width: 100%;
    padding: 8px 10px;
    font: 14px var(--sans, system-ui);
    color: var(--text);
    background: var(--hover-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2px;
  }
  .item {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 7px 10px;
    text-align: start;
    color: var(--text);
    background: transparent;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
  }
  .item:hover, .item:focus-visible { background: var(--hover-bg); }
  .item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .item.active { color: var(--accent); background: rgb(var(--accent-rgb) / 0.12); }
  .native { font-size: 14px; line-height: 1.25; }
  .english { font-size: 11px; color: var(--text-faint); }
  .none { margin: 8px; color: var(--text-dim); font-size: 14px; }

  @media (max-width: 420px) {
    ul { grid-template-columns: 1fr; }
    .name { display: none; }
  }
</style>
