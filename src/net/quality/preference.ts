/**
 * The user's detail setting, and why it is a *ceiling* rather than a level.
 *
 * `NetworkMonitor` measures what the connection can actually deliver and picks
 * a grade from it. That measurement is not a preference and cannot be
 * overruled: asking for maximum detail on a link that cannot carry it does not
 * produce maximum detail, it produces a quadtree that spends the whole pipe on
 * tiles that time out — which is the failure the whole profile system exists
 * to prevent (see `profile.ts`).
 *
 * So the setting does the one thing it honestly can: it puts a lid on the
 * measurement. `low` refuses to climb past the `slow` profile however good the
 * link turns out to be; `high` removes the lid and lets the measurement run
 * all the way up. Neither can make a weak connection strong, and the UI must
 * not imply otherwise — "High detail" means *allow* full detail, not force it.
 *
 * ## Why the default is low
 *
 * The app is meant to be opened by anyone, on anything, with no account and no
 * warning about what it is about to download. A first visit that immediately
 * starts streaming zoom-19 imagery is a poor guest on a phone tether, on a
 * metered connection, and on an integrated GPU. Starting economical and
 * offering the upgrade is the polite order, and it is reversible in one click;
 * starting expensive and making the user notice is not.
 */

import type { NetworkGrade } from './profile';
import { gradeRank } from './profile';

export type QualityPreference = 'low' | 'high';

/** What a first visit gets. See the note above. */
export const DEFAULT_QUALITY: QualityPreference = 'low';

/**
 * The best grade each setting will allow, however well the link measures.
 *
 * `high` is `fast` — that is, no lid at all, since `fast` is already the top
 * of the scale. It is spelled out rather than left as a special case so that
 * adding a grade above `fast` cannot silently change what `high` means.
 */
export const QUALITY_CEILING: Record<QualityPreference, NetworkGrade> = {
  low: 'slow',
  high: 'fast',
};

/** Short labels for the control. */
export const QUALITY_LABELS: Record<QualityPreference, { label: string; hint: string }> = {
  low: {
    label: 'Standard detail',
    hint: 'Lighter on your connection and your battery. Terrain stays complete, just softer.',
  },
  high: {
    label: 'High detail — 3D terrain',
    hint: 'Mountains and coastlines get real relief, and imagery streams as sharp as your connection allows. Heavier on your machine.',
  },
};

/** The measured grade, held under the user's ceiling. */
export function capGrade(measured: NetworkGrade, preference: QualityPreference): NetworkGrade {
  const ceiling = QUALITY_CEILING[preference];
  return gradeRank(measured) > gradeRank(ceiling) ? ceiling : measured;
}

const STORAGE_KEY = 'planesview.quality';

/**
 * Read the stored setting.
 *
 * Every failure mode returns the default rather than throwing: `localStorage`
 * access itself throws in a private window with site data blocked, and a
 * rendering app has no business failing to start over a preference.
 */
export function loadQualityPreference(storage?: Storage): QualityPreference {
  try {
    const store = storage ?? globalThis.localStorage;
    const raw = store?.getItem(STORAGE_KEY);
    return raw === 'low' || raw === 'high' ? raw : DEFAULT_QUALITY;
  } catch {
    return DEFAULT_QUALITY;
  }
}

export function saveQualityPreference(value: QualityPreference, storage?: Storage): void {
  try {
    const store = storage ?? globalThis.localStorage;
    store?.setItem(STORAGE_KEY, value);
  } catch {
    // A preference that cannot be remembered is still a preference that works
    // for this session.
  }
}

/** True the first time this browser has ever opened the app. */
export function isFirstVisit(storage?: Storage): boolean {
  try {
    const store = storage ?? globalThis.localStorage;
    return store?.getItem(STORAGE_KEY) === null;
  } catch {
    return false;
  }
}
