<!--
  A floating dock of icon buttons that folds into its menu button.

  Everything the app can do is a button here rather than a key to remember:
  nobody browsing a website reaches for the keyboard, and on a phone there is
  none. The dock opens and closes from the menu button pinned at its end, so
  when the view itself is what someone wants to look at, one tap puts every
  tool away.

  Two pieces of movement, both springs:

   - The strip of icons is clipped, and its width springs between nothing and
     its measured size, so the icons slide out of the menu button and tuck back
     into it. The dock keeps its open footprint while closed, so the menu
     button never moves under the finger that pressed it.
   - One label rail sits above (or below) the dock with every label side by
     side. Hovering a button slides the rail and clips it to that one label,
     centred over the button, so moving along the dock reads as one label
     gliding from name to name instead of tooltips blinking in and out. A tap
     on a touch screen shows the label for a moment, since there is no hover.

  Geometry is read from layout (offsets), not from transformed boxes, so
  nothing fights an animation already in flight.
-->
<script lang="ts" module>
  import type { IconName } from './Icon.svelte';

  export interface DockItem {
    id: string;
    label: string;
    icon: IconName;
    onclick: () => void;
    /** A switch that is on. */
    active?: boolean;
    /** A count, or a dot when true. */
    badge?: number | boolean;
    disabled?: boolean;
    /** Red while true: a recording under way. */
    alert?: boolean;
  }
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Spring } from 'svelte/motion';
  import Icon from './Icon.svelte';

  let {
    items,
    label,
    openLabel,
    closeLabel,
    tips = 'above',
    hud = false,
    collapsed = $bindable(false),
  }: {
    items: DockItem[];
    /** The toolbar's accessible name. */
    label: string;
    /** The menu button's label while folded, and while open. */
    openLabel: string;
    closeLabel: string;
    /** Where the labels appear: above a dock at the bottom of the screen, below one at the top. */
    tips?: 'above' | 'below';
    /** Over the 3D view: the HUD's colours instead of the panels'. */
    hud?: boolean;
    collapsed?: boolean;
  } = $props();

  let wrapper: HTMLDivElement;
  let pill: HTMLDivElement;
  let clip: HTMLDivElement;
  let strip: HTMLDivElement;
  let rail: HTMLDivElement;
  const segs: HTMLSpanElement[] = $state([]);
  const buttons: HTMLButtonElement[] = $state([]);

  /* Measured: the strip's open width, and the dock's footprint when open. */
  let stripWidth = $state(0);
  let footprint = $state(0);
  let measured = $state(false);

  /* Springs tuned per role: the clip settles without overshoot, the slide has a touch more life. */
  const width = new Spring(0, { stiffness: 0.16, damping: 0.78 });
  const x = new Spring(0, { stiffness: 0.24, damping: 0.74 });
  const clipLeft = new Spring(0, { stiffness: 0.3, damping: 0.9 });
  const clipRight = new Spring(0, { stiffness: 0.3, damping: 0.9 });
  let visible = $state(false);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const labels = $derived([...items.map((i) => i.label), collapsed ? openLabel : closeLabel]);

  function measure(): void {
    if (!strip || !pill || !clip) return;
    stripWidth = strip.offsetWidth;
    // The pill around the strip — padding, the menu button, the gap — is the same open or closed.
    footprint = stripWidth + (pill.offsetWidth - clip.offsetWidth);
    if (!measured) width.set(collapsed ? 0 : stripWidth, { instant: true });
    else width.target = collapsed ? 0 : stripWidth;
    measured = true;
  }

  onMount(() => {
    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(strip);
    return () => observer.disconnect();
  });

  $effect(() => {
    width.target = collapsed ? 0 : stripWidth;
  });

  /** Slide the label rail to button `index` (the menu button is the last). */
  async function reveal(index: number): Promise<void> {
    clearTimeout(hideTimer);
    await tick();
    const seg = segs[index];
    const button = buttons[index];
    if (!seg || !button || !rail || !wrapper) return;
    const railWidth = rail.offsetWidth || 1;
    const left = seg.offsetLeft;
    const right = railWidth - left - seg.offsetWidth;
    const centre = offsetWithin(button, wrapper) + button.offsetWidth / 2;
    // Centred over the button, but kept inside the dock's own footprint.
    const room = wrapper.offsetWidth;
    let dx = centre - (left + seg.offsetWidth / 2);
    dx = Math.min(dx, room - left - seg.offsetWidth);
    dx = Math.max(dx, -left);
    const instant = !visible;
    visible = true;
    x.set(dx, { instant });
    clipLeft.set(left, { instant });
    clipRight.set(right, { instant });
  }

  function hide(): void {
    clearTimeout(hideTimer);
    visible = false;
  }

  /** How the last press was made: a click event does not say so in every browser. */
  let lastPointer = 'mouse';

  /** A tap has no hover: the label shows for a moment instead. */
  function flash(index: number, event: MouseEvent): void {
    if (lastPointer === 'mouse' || event.detail === 0) return;
    void reveal(index);
    hideTimer = setTimeout(hide, 1300);
  }

  function offsetWithin(el: HTMLElement, ancestor: HTMLElement): number {
    let left = 0;
    let node: HTMLElement | null = el;
    while (node && node !== ancestor) {
      left += node.offsetLeft;
      node = node.offsetParent as HTMLElement | null;
    }
    return left;
  }

  function toggle(event: MouseEvent): void {
    collapsed = !collapsed;
    hide();
    flash(items.length, event);
  }
</script>

<div
  class="dock-wrap"
  class:hud
  class:below={tips === 'below'}
  bind:this={wrapper}
  style:width={measured ? `${footprint}px` : undefined}
>
  <div class="rail-anchor" aria-hidden="true">
    <div
      class="rail"
      class:shown={visible}
      bind:this={rail}
      style:transform="translateX({x.current}px)"
      style:clip-path="inset(0 {clipRight.current}px 0 {clipLeft.current}px round 8px)"
    >
      {#each labels as text, i (i)}
        <span class="seg" bind:this={segs[i]}>{text}</span>
      {/each}
    </div>
  </div>

  <div
    class="pill"
    role="toolbar"
    aria-label={label}
    tabindex="-1"
    bind:this={pill}
    onpointerdown={(e) => (lastPointer = e.pointerType)}
    onpointerleave={(e) => e.pointerType === 'mouse' && hide()}
    onfocusout={(e) => {
      if (!pill.contains(e.relatedTarget as Node)) hide();
    }}
  >
    <div
      class="clip"
      bind:this={clip}
      style:width={measured ? `${width.current}px` : undefined}
      style:opacity={measured ? Math.min(1, width.current / Math.max(1, stripWidth) * 1.6) : 1}
    >
      <div class="strip" bind:this={strip}>
        {#each items as item, i (item.id)}
          <button
            class="btn"
            data-dock-item={item.id}
            class:active={item.active}
            class:alert={item.alert}
            bind:this={buttons[i]}
            disabled={item.disabled}
            tabindex={collapsed ? -1 : undefined}
            aria-label={item.label}
            aria-pressed={item.active === undefined ? undefined : item.active}
            onpointerenter={(e) => e.pointerType === 'mouse' && void reveal(i)}
            onfocus={() => void reveal(i)}
            onclick={(e) => {
              item.onclick();
              flash(i, e);
            }}
          >
            <Icon name={item.icon} size={18} />
            {#if item.badge}
              <span class="badge" class:dot={item.badge === true}>{item.badge === true ? '' : item.badge}</span>
            {/if}
          </button>
        {/each}
      </div>
    </div>

    <button
      class="btn toggle"
      bind:this={buttons[items.length]}
      aria-expanded={!collapsed}
      aria-label={collapsed ? openLabel : closeLabel}
      onpointerenter={(e) => e.pointerType === 'mouse' && void reveal(items.length)}
      onfocus={() => void reveal(items.length)}
      onclick={toggle}
    >
      <span class="burger" class:x={!collapsed} aria-hidden="true"><i></i><i></i><i></i></span>
    </button>
  </div>
</div>

<style>
  .dock-wrap {
    --dock-bg: var(--bg-panel);
    --dock-border: var(--border);
    --dock-text: var(--text-dim);
    --dock-hover: var(--hover-bg);
    --dock-accent: var(--accent);
    --tip-bg: var(--text);
    --tip-text: var(--bg);
    position: relative;
    display: inline-flex;
    justify-content: flex-end;
    height: 48px;
    pointer-events: none;
  }
  .dock-wrap.hud {
    --dock-bg: var(--hud-bg);
    --dock-border: var(--hud-border);
    --dock-text: var(--hud-dim);
    --dock-hover: rgb(255 255 255 / 0.08);
    --dock-accent: var(--hud-accent);
  }

  .pill {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    height: 48px;
    padding: 6px;
    gap: 2px;
    background: var(--dock-bg);
    border: 1px solid var(--dock-border);
    border-radius: 999px;
    box-shadow: var(--shadow);
    backdrop-filter: blur(14px) saturate(1.2);
    -webkit-backdrop-filter: blur(14px) saturate(1.2);
    pointer-events: auto;
    outline: none;
  }

  /* Overflow-clipped; its width springs. The strip inside is anchored right, so it slides out of the menu button. */
  .clip { position: relative; height: 36px; overflow: hidden; }
  .strip {
    position: absolute;
    top: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    height: 36px;
    padding-right: 2px;
  }

  .btn {
    position: relative;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 36px;
    height: 36px;
    padding: 0;
    color: var(--dock-text);
    background: transparent;
    border: 0;
    border-radius: 50%;
    cursor: pointer;
    transition: color 0.18s var(--ease), background 0.18s var(--ease), transform 0.18s var(--ease);
  }
  .btn:hover { color: var(--dock-accent); background: var(--dock-hover); }
  .btn:active { transform: scale(0.92); }
  .btn:focus-visible { outline: 2px solid var(--dock-accent); outline-offset: -2px; }
  .btn.active { color: var(--dock-accent); background: rgb(var(--accent-rgb) / 0.14); }
  .btn.alert { color: #ff5a4f; background: rgb(255 90 79 / 0.14); }
  .btn:disabled { opacity: 0.45; cursor: progress; }

  .badge {
    position: absolute;
    top: 3px;
    right: 1px;
    min-width: 15px;
    height: 15px;
    padding: 0 4px;
    font: 700 9px/15px var(--mono);
    text-align: center;
    color: var(--on-accent);
    background: var(--dock-accent);
    border: 1.5px solid var(--dock-bg);
    border-radius: 8px;
  }
  .badge.dot { top: 6px; right: 6px; min-width: 0; width: 8px; height: 8px; padding: 0; }

  /* The menu button: three bars that fold into a cross. */
  .toggle { color: var(--dock-accent); }
  .burger { position: relative; width: 16px; height: 12px; }
  .burger i {
    position: absolute;
    left: 0;
    width: 16px;
    height: 2px;
    background: currentColor;
    border-radius: 1px;
    transition: transform 0.3s var(--ease), opacity 0.2s var(--ease), top 0.3s var(--ease);
  }
  .burger i:nth-child(1) { top: 0; }
  .burger i:nth-child(2) { top: 5px; }
  .burger i:nth-child(3) { top: 10px; }
  .burger.x i:nth-child(1) { top: 5px; transform: rotate(45deg); }
  .burger.x i:nth-child(2) { opacity: 0; transform: scaleX(0.2); }
  .burger.x i:nth-child(3) { top: 5px; transform: rotate(-45deg); }

  /* The label rail: one surface, slid and clipped to the label in use. */
  .rail-anchor {
    position: absolute;
    left: 0;
    bottom: calc(100% + 10px);
    z-index: 2;
    pointer-events: none;
  }
  .below .rail-anchor { bottom: auto; top: calc(100% + 10px); }
  .rail {
    display: flex;
    width: max-content;
    color: var(--tip-text);
    background: var(--tip-bg);
    border-radius: 8px;
    box-shadow: var(--shadow);
    opacity: 0;
    transition: opacity 0.18s cubic-bezier(0.22, 1, 0.36, 1);
    will-change: transform, clip-path, opacity;
  }
  .rail.shown { opacity: 1; }
  .seg {
    display: inline-flex;
    align-items: center;
    height: 30px;
    padding: 0 12px;
    font: 600 12px/1 var(--sans);
    letter-spacing: -0.005em;
    white-space: nowrap;
    text-shadow: none;
  }

  /* A narrow phone: a little tighter, so a full dock still fits across it. */
  @media (max-width: 420px) {
    .btn { width: 34px; height: 34px; }
    .strip, .clip { height: 34px; gap: 0; }
    .pill { height: 46px; padding: 5px; gap: 0; }
    .dock-wrap { height: 46px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .burger i, .btn { transition: none; }
  }
</style>
