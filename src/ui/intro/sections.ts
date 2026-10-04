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

import { t, type MessageKey } from '@/i18n/index.svelte';

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
  id: 'hero' | 'map' | 'cockpit' | 'free';
  /** Whether the section has a second line under its title. */
  subtitle: boolean;
  /** How many titled points it has (`landing.<id>.p1.title`, …). */
  points: number;
  align: 'left' | 'center';
  hero: HeroPlacement;
}

/**
 * The words are in `i18n/en.ts` under `landing.<id>.*`, and in every other
 * language beside it; what stays here is the structure and where the
 * aeroplane sits.
 */
export const SECTIONS: readonly IntroSection[] = [
  { id: 'hero', subtitle: true, points: 0, align: 'left', hero: { topPct: 52, leftPct: 68, scale: 1.05 } },
  { id: 'map', subtitle: true, points: 0, align: 'center', hero: { topPct: 26, leftPct: 50, scale: 0.72 } },
  { id: 'cockpit', subtitle: true, points: 3, align: 'left', hero: { topPct: 34, leftPct: 70, scale: 1.2 } },
  { id: 'free', subtitle: false, points: 0, align: 'center', hero: { topPct: 50, leftPct: 50, scale: 1.75 } },
];

type Field = 'badge' | 'title' | 'subtitle' | 'body';

export function sectionText(section: IntroSection, field: Field): string {
  return t(`landing.${section.id}.${field}` as MessageKey);
}

export function pointText(section: IntroSection, index: number, field: 'title' | 'body'): string {
  return t(`landing.${section.id}.p${index + 1}.${field}` as MessageKey);
}
