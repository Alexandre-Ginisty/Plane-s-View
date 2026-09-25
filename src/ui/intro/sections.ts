/**
 * What the front page says, and where the aeroplane sits while it says it.
 *
 * Data rather than markup so the two stay in step: the hero's position is
 * indexed by section, and a section added to the markup without a matching
 * position would leave the aeroplane wherever the previous one put it. Here
 * they cannot be added separately.
 *
 * The copy is deliberately about what the app *does* rather than about how it
 * is built. "No account, no key, no card" is the one implementation detail
 * worth putting on the front page, because it is the thing a visitor is
 * bracing for.
 */

interface HeroPlacement {
  /** Centre of the aeroplane, as a percentage of the viewport. */
  topPct: number;
  leftPct: number;
  /**
   * Multiplier on its base size.
   *
   * Only the size and the position live here. Heading and bank are driven
   * continuously from scroll position in `Landing.svelte`, because indexing
   * them by section made the aeroplane sit still through most of a scroll and
   * then snap when the next section became current.
   */
  scale: number;
}

export interface IntroSection {
  id: string;
  badge: string;
  title: string;
  subtitle?: string;
  body: string;
  align: 'left' | 'center';
  points?: { title: string; body: string }[];
  hero: HeroPlacement;
}

export const SECTIONS: readonly IntroSection[] = [
  {
    id: 'hero',
    badge: 'PlanesView',
    title: 'Every aircraft',
    subtitle: 'in the sky, right now',
    body: 'Live ADS-B traffic on a photoreal globe. Pick any aircraft and step inside it — the view from the flight deck, over real terrain, streaming as you fly.',
    align: 'left',
    hero: { topPct: 52, leftPct: 68, scale: 1.05 },
  },
  {
    id: 'map',
    badge: 'The map',
    title: 'Thousands of aircraft,',
    subtitle: 'drawn as one',
    body: 'Positions arrive once or twice a second and are filtered and extrapolated between reports, so aircraft move rather than jump. Each one is drawn with the silhouette of its actual type.',
    align: 'center',
    hero: { topPct: 26, leftPct: 50, scale: 0.72 },
  },
  {
    id: 'cockpit',
    badge: 'The cockpit',
    title: 'Step inside',
    subtitle: 'any of them',
    body: 'Four camera positions around an aircraft that is genuinely where the feed says it is, at true scale, over terrain built from real elevation data.',
    align: 'left',
    points: [
      {
        title: 'Never loading',
        body: 'The ground ahead is requested before you reach it, and no tile is ever blank — it borrows detail from the level above until its own arrives.',
      },
      {
        title: 'Real relief',
        body: 'Elevation is meshed per tile and exaggerated consistently, so an aircraft on the ground stands on the terrain you can see.',
      },
      {
        title: 'Honest instruments',
        body: 'Speed, altitude, attitude and heading come from the aircraft, not from an animation. The compass follows where you are looking.',
      },
    ],
    hero: { topPct: 34, leftPct: 70, scale: 1.2 },
  },
  {
    id: 'free',
    badge: 'The catch',
    title: 'There isn’t one',
    body: 'No account, no API key, no card. Every feed, tile source and airframe in this project is free to use, and the whole thing runs in your browser — there is no backend to sign up to.',
    align: 'center',
    hero: { topPct: 50, leftPct: 50, scale: 1.75 },
  },
];
