<!--
  The front door.

  A scroll-driven page with a fixed aeroplane that moves between sections. The
  layout follows a pattern that is usually built around a spinning globe; here
  the globe is the product, so putting one on the front page would be showing
  the visitor a worse version of the thing they are about to use. An airframe
  is the other half of it and is not on screen anywhere else at this size.

  ## It sits over a running app

  The orchestrator boots behind this, not after it. Reading the page takes a
  few seconds and that is exactly how long the first terrain and the first
  traffic snapshot take, so entering lands on a warm app rather than on a
  spinner. That is the whole reason this is an overlay rather than a route.

  ## Scroll handling

  One passive listener, coalesced into a frame. Anything heavier here shows up
  as scroll jank on the one page whose entire job is to feel smooth, and there
  is nothing to compute that a single `scrollTop` read does not give.
-->
<script lang="ts">
  import { onMount } from 'svelte';

  import { SECTIONS } from './sections';
  import { mountHeroScene, type HeroScene } from './heroScene';
  import { app } from '@/state/appStore.svelte';
  import ThemeToggle from '@/ui/ThemeToggle.svelte';

  let { onEnter, ready = false }: { onEnter: () => void; ready?: boolean } = $props();

  /** The airframe on the front page. A widebody reads best at this size. */
  const HERO_TYPE = 'B78X';

  /** Turns of heading across the whole page. Slightly over one, so it comes round. */
  const TOTAL_TURNS = 1.15;

  /** Turn rate, in turns per second, that corresponds to full bank. */
  const BANK_AT_TURNS_PER_SEC = 0.55;

  let scrollRoot: HTMLDivElement;
  let heroCanvas: HTMLCanvasElement;
  /*
   * `$state`, because `bind:this` into a plain array is not tracked.
   *
   * Svelte 5 warns about it and the consequence is real: `measure` reads these
   * on scroll, and without reactivity the array it reads is the one from the
   * first render, so a section re-created for any reason would never be
   * measured again.
   */
  let sectionEls = $state<HTMLElement[]>([]);

  let active = $state(0);
  let progress = $state(0);
  let leaving = $state(false);
  let webglFailed = $state(false);

  let hero: HeroScene | null = null;

  const placement = $derived(SECTIONS[active]?.hero ?? SECTIONS[0]!.hero);

  function measure(): void {
    const root = scrollRoot;
    if (!root) return;

    const max = root.scrollHeight - root.clientHeight;
    progress = max > 0 ? Math.min(Math.max(root.scrollTop / max, 0), 1) : 0;

    // Nearest section centre to the viewport centre. Simpler than an
    // IntersectionObserver and, unlike one, it always names exactly one
    // section — including at the very top and bottom, where thresholds
    // straddle and the observer reports either both or neither.
    const middle = root.clientHeight / 2;
    let nearest = 0;
    let best = Infinity;
    sectionEls.forEach((el, index) => {
      if (!el) return;
      const box = el.getBoundingClientRect();
      const distance = Math.abs(box.top + box.height / 2 - middle);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    });
    active = nearest;
  }

  onMount(() => {
    hero = mountHeroScene(heroCanvas, HERO_TYPE, app.theme);
    webglFailed = hero === null;

    let queued = false;
    const onScroll = (): void => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        measure();
      });
    };

    const onResize = (): void => {
      hero?.resize();
      measure();
    };

    scrollRoot.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    measure();

    return () => {
      scrollRoot.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      hero?.dispose();
      hero = null;
    };
  });

  /*
   * Fly the aeroplane from the scroll position.
   *
   * Heading comes from `progress` rather than from the current section, so the
   * turn is continuous under the thumb instead of stepping when a section
   * becomes current — a section-indexed heading meant the model sat still
   * through most of a scroll and then snapped.
   *
   * Bank is the *rate* of that turn, which is what makes it read as flying:
   * a real aeroplane banks into a turn and levels out of it, so deriving the
   * roll from how fast the heading is changing gets the relationship right for
   * free, including the roll-out at the end of a scroll.
   */
  let lastProgress = 0;
  let lastAt = 0;
  let bank = $state(0);

  $effect(() => {
    // Negative: scrolling *down* turns the aeroplane anticlockwise from above,
    // so the page reads as flying around it rather than the model spinning up
    // towards you.
    const turns = -progress * TOTAL_TURNS;
    const now = performance.now();
    const elapsed = lastAt === 0 ? 0 : (now - lastAt) / 1000;

    if (elapsed > 0) {
      const rate = ((progress - lastProgress) * TOTAL_TURNS) / elapsed;
      bank = Math.max(-1, Math.min(1, rate / BANK_AT_TURNS_PER_SEC));
    }
    lastProgress = progress;
    lastAt = now;

    hero?.steer(turns, bank);
  });

  // Level the wings once scrolling stops. Without this the aeroplane holds the
  // last bank it was given for ever, which reads as a stuck control.
  $effect(() => {
    hero?.setTheme(app.theme);
  });

  $effect(() => {
    if (bank === 0) return;
    const timer = setTimeout(() => (bank = 0), 260);
    return () => clearTimeout(timer);
  });

  function enter(): void {
    if (leaving) return;
    leaving = true;
    // Let the fade run before the overlay is unmounted and the WebGL context
    // released, or the aeroplane vanishes a beat before the page does.
    setTimeout(onEnter, 420);
  }

  function goTo(index: number): void {
    sectionEls[index]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault();
      enter();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="landing" class:leaving bind:this={scrollRoot}>
  <div class="progress" aria-hidden="true">
    <span style="transform: scaleX({progress})"></span>
  </div>

  <div class="corner">
    <ThemeToggle compact />
    <button class="enter-pill" onclick={enter}>
      {ready ? 'Enter' : 'Loading the sky…'}
      <span class="kbd">↵</span>
    </button>
  </div>

  <nav aria-label="Sections">
    {#each SECTIONS as section, index (section.id)}
      <button
        class="dot"
        class:active={active === index}
        onclick={() => goTo(index)}
        aria-label={section.badge}
        aria-current={active === index}
      >
        <span class="dot-label">{section.badge}</span>
      </button>
    {/each}
  </nav>

  <div
    class="hero"
    aria-hidden="true"
    style="
      --top: {placement.topPct}%;
      --left: {placement.leftPct}%;
      --scale: {placement.scale};
      --dim: {active === SECTIONS.length - 1 ? 0.5 : 0.95};
    "
  >
    <canvas bind:this={heroCanvas}></canvas>
    {#if webglFailed}
      <p class="no-webgl">This browser cannot run WebGL, which PlanesView needs.</p>
    {/if}
  </div>

  {#each SECTIONS as section, index (section.id)}
    <section
      bind:this={sectionEls[index]}
      class="chapter"
      class:centered={section.align === 'center'}
      class:current={active === index}
    >
      <div class="content">
        <p class="badge">{section.badge}</p>
        <h1 class:lead={index === 0}>
          {section.title}
          {#if section.subtitle}<span class="subtitle">{section.subtitle}</span>{/if}
        </h1>
        <p class="body">{section.body}</p>

        {#if section.points}
          <ul class="points">
            {#each section.points as point (point.title)}
              <li>
                <h2>{point.title}</h2>
                <p>{point.body}</p>
              </li>
            {/each}
          </ul>
        {/if}

        {#if index === 0}
          <div class="actions">
            <button class="primary" onclick={enter} disabled={!ready}>
              {ready ? 'Take me up' : 'Warming up…'}
            </button>
            <button class="secondary" onclick={() => goTo(1)}>What is this?</button>
          </div>
          <p class="hint">Scroll to read, or press <span class="kbd">↵</span> to skip straight in.</p>
        {/if}

        {#if index === SECTIONS.length - 1}
          <div class="actions">
            <button class="primary" onclick={enter} disabled={!ready}>
              {ready ? 'Open PlanesView' : 'Warming up…'}
            </button>
          </div>
        {/if}
      </div>
    </section>
  {/each}
</div>

<style>
  .landing {
    position: absolute;
    inset: 0;
    z-index: 200;
    overflow-y: auto;
    overflow-x: hidden;
    scroll-behavior: smooth;
    background:
      radial-gradient(120% 90% at 78% 12%, rgba(42, 95, 122, 0.3), transparent 60%),
      radial-gradient(90% 80% at 10% 90%, rgba(127, 223, 255, 0.08), transparent 60%),
      var(--bg);
    opacity: 1;
    transition: opacity 400ms ease;
  }
  .landing.leaving { opacity: 0; pointer-events: none; }

  .progress {
    position: fixed;
    inset: 0 0 auto 0;
    height: 2px;
    background: rgba(127, 223, 255, 0.12);
    z-index: 3;
  }
  .progress span {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
    transform-origin: left center;
    transition: transform 140ms ease-out;
  }

  .corner {
    position: fixed;
    top: 20px;
    right: 24px;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .enter-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    font: 600 12px/1 var(--mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
    background: var(--bg-chapter);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    backdrop-filter: blur(8px);
  }
  .enter-pill:hover { border-color: var(--border-strong); box-shadow: var(--glow); }

  nav {
    position: fixed;
    right: 26px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 4;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .dot {
    position: relative;
    width: 9px;
    height: 9px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    background: transparent;
    cursor: pointer;
    transition: background 200ms ease, transform 200ms ease;
  }
  .dot:hover { transform: scale(1.35); }
  .dot.active { background: var(--accent); box-shadow: var(--glow); }
  .dot-label {
    position: absolute;
    right: 18px;
    top: 50%;
    transform: translateY(-50%);
    white-space: nowrap;
    font: 600 10px/1 var(--mono);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-faint);
    opacity: 0;
    transition: opacity 200ms ease;
    pointer-events: none;
  }
  .dot:hover .dot-label,
  .dot.active .dot-label { opacity: 1; color: var(--accent); }

  .hero {
    position: fixed;
    top: var(--top);
    left: var(--left);
    width: min(46vw, 560px);
    aspect-ratio: 1;
    transform: translate(-50%, -50%) scale(var(--scale));
    opacity: var(--dim);
    pointer-events: none;
    z-index: 1;
    /* Long and heavily eased: the aeroplane is meant to glide between
       positions, and anything brisker reads as a jump-cut. */
    transition:
      top 1200ms cubic-bezier(0.22, 1, 0.3, 1),
      left 1200ms cubic-bezier(0.22, 1, 0.3, 1),
      transform 1200ms cubic-bezier(0.22, 1, 0.3, 1),
      opacity 800ms ease;
  }
  .hero canvas { width: 100%; height: 100%; display: block; }
  .no-webgl {
    position: absolute;
    inset: auto 0 20% 0;
    text-align: center;
    color: var(--text-faint);
    font-size: 13px;
    padding: 0 16px;
  }

  /*
   * Not `.panel`. That is a global class in `theme.css` carrying
   * `backdrop-filter: blur(14px)` and a scanline overlay, so a section using it
   * frosts everything behind it — which here is the fixed hero canvas. The
   * aeroplane rendered perfectly and was then blurred by the text sitting on
   * top of it, with the panel's own scanlines laid over the result.
   */
  .chapter {
    position: relative;
    z-index: 2;
    min-height: 100svh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 80px clamp(20px, 6vw, 96px);
  }
  .chapter.centered { align-items: center; text-align: center; }
  /*
   * A scrim, only where the text sits over the aeroplane.
   *
   * The centred sections put the hero directly behind the copy, and a white
   * fuselage under white text is unreadable however good the contrast is
   * elsewhere. A radial fade is used rather than a panel so the aeroplane
   * still reads as being *behind* the page rather than in a box.
   */
  .chapter.centered .content {
    padding: 28px 30px;
    background: radial-gradient(
      70% 70% at 50% 50%,
      rgba(3, 6, 12, 0.88),
      rgba(3, 6, 12, 0.55) 60%,
      transparent 100%
    );
  }

  .content {
    max-width: 44rem;
    opacity: 0.28;
    transform: translateY(14px);
    transition: opacity 600ms ease, transform 600ms ease;
  }
  .chapter.current .content { opacity: 1; transform: none; }

  .badge {
    margin: 0 0 18px;
    font: 600 11px/1 var(--mono);
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--accent);
  }

  h1 {
    margin: 0 0 22px;
    font-family: var(--sans);
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.05;
    font-size: clamp(2rem, 5.2vw, 3.6rem);
    color: var(--text);
  }
  h1.lead { font-size: clamp(2.4rem, 7vw, 5rem); }
  .subtitle {
    display: block;
    color: var(--text-dim);
    font-weight: 500;
    font-size: 0.62em;
    letter-spacing: 0.01em;
    margin-top: 6px;
  }

  .body {
    margin: 0;
    max-width: 34rem;
    font-size: clamp(1rem, 1.5vw, 1.15rem);
    line-height: 1.65;
    color: var(--text-dim);
  }
  .chapter.centered .body { margin-inline: auto; }

  .points {
    list-style: none;
    margin: 32px 0 0;
    padding: 0;
    display: grid;
    gap: 12px;
  }
  .points li {
    padding: 16px 18px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-chapter);
    transition: border-color 220ms ease, transform 220ms ease;
  }
  .points li:hover { border-color: var(--border-strong); transform: translateY(-2px); }
  .points h2 {
    margin: 0 0 6px;
    font-size: 0.95rem;
    font-weight: 650;
    color: var(--text);
  }
  .points p { margin: 0; font-size: 0.9rem; line-height: 1.55; color: var(--text-dim); }

  .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 32px; }
  .chapter.centered .actions { justify-content: center; }

  .actions button {
    padding: 13px 26px;
    font: 600 13px/1 var(--sans);
    letter-spacing: 0.02em;
    border-radius: var(--radius);
    cursor: pointer;
    transition: background 200ms ease, border-color 200ms ease, transform 120ms ease;
  }
  .actions button:active { transform: scale(0.98); }
  .actions button:disabled { opacity: 0.55; cursor: progress; }

  .primary {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #04121a;
  }
  .primary:not(:disabled):hover { box-shadow: var(--glow); }
  .secondary {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
  }
  .secondary:hover { border-color: var(--border-strong); }

  .hint { margin: 16px 0 0; font-size: 0.82rem; color: var(--text-faint); }

  .kbd {
    display: inline-block;
    min-width: 1.4em;
    padding: 1px 5px;
    text-align: center;
    font: 600 11px/1.5 var(--mono);
    color: var(--accent);
    border: 1px solid var(--border);
    border-radius: 2px;
  }

  @media (max-width: 820px) {
    nav { display: none; }
    .hero { width: 74vw; }
    /* Out of the text's way: at this width the copy is full-bleed and the
       aeroplane would sit on top of it wherever the section put it. */
    .hero { top: 22% !important; left: 50% !important; }
    .chapter { padding-top: 46svh; }
  }

  @media (prefers-reduced-motion: reduce) {
    .landing { scroll-behavior: auto; }
    .hero, .content, .progress span { transition: none; }
  }
</style>
