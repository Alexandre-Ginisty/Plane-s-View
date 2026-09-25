/**
 * The one palette.
 *
 * Three surfaces have to agree on colour — the CSS chrome, the MapLibre
 * symbology and the WebGL traffic — and they cannot share a stylesheet,
 * because two of them need numbers and one needs strings. Everything is
 * therefore declared once here and exported in both forms.
 *
 * ## The scheme
 *
 * Holographic: a cold cyan-blue for structure, amber for anything the viewer
 * is meant to act on, and near-black behind all of it. It reads as a cockpit
 * projection rather than as a web page, which is the intent — but it is also
 * the *legible* choice, because the HUD sits over live satellite imagery and
 * only a very cold or very warm hue stays distinguishable against both a
 * Mediterranean noon and an ocean at night.
 *
 * ## The encoding rule
 *
 * Colour carries **state**, geometry carries **kind**. A helicopter is not
 * given its own colour; it is given its own silhouette, and it still turns
 * amber when it descends like everything else. Overloading one channel with
 * both would make a descending helicopter indistinguishable from a climbing
 * airliner, and there is no legend that can rescue that.
 */

/** CSS colours. Keep in step with the custom properties in `theme.css`. */
export const PALETTE = {
  /** Structure, rules, inactive chrome. */
  holo: '#7fdfff',
  holoDim: '#3d7f9c',
  /** Anything actionable, and the aircraft the viewer is riding. */
  amber: '#ffb02e',
  /** Climbing. */
  green: '#43f0a0',
  /** Emergency squawk. */
  red: '#ff3b4e',
  /** Level flight, and body text. */
  ice: '#e9f4ff',
  /** Stale: the position is extrapolated, not received. */
  slate: '#5d7186',
} as const;

/** The same palette as 24-bit integers, for Three.js and MapLibre. */
export const HEX = {
  holo: 0x7fdfff,
  holoDim: 0x3d7f9c,
  amber: 0xffb02e,
  green: 0x43f0a0,
  red: 0xff3b4e,
  ice: 0xe9f4ff,
  slate: 0x5d7186,
} as const;

/**
 * The front page's aeroplane, which is lit rather than liveried.
 *
 * Deliberately not an airline's colours. The hero is the app's own object, and
 * painting it in someone's livery would both misrepresent the aircraft the
 * visitor is about to see and borrow a mark nobody granted.
 */
export const HERO = {
  hull: 0xaebdcc,
  trim: 0x16222f,
  glow: 0x4fa8d8,
} as const;

/** What a traffic colour means, for the on-screen legend. */
export const TRAFFIC_LEGEND: readonly { color: string; meaning: string }[] = [
  { color: PALETTE.green, meaning: 'Climbing' },
  { color: PALETTE.ice, meaning: 'Level' },
  { color: PALETTE.amber, meaning: 'Descending' },
  { color: PALETTE.red, meaning: 'Emergency' },
  { color: PALETTE.slate, meaning: 'Signal lost — position estimated' },
];
