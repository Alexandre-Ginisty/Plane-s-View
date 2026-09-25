/**
 * Dark or daylight.
 *
 * ## Why this runs before the app mounts
 *
 * A theme applied from a component runs after the first paint, so the page
 * opens in whichever scheme the stylesheet declares and then changes — a white
 * flash for a dark-mode visitor, or the reverse. `main.ts` calls `applyTheme`
 * before `mount`, which is the only point early enough for there to be nothing
 * to flash.
 *
 * ## Why the default is the system preference
 *
 * Nobody chooses a theme on their first visit; they arrive with one already
 * chosen, in their operating system, and an app that ignores it is an app that
 * is wrong for half its visitors. The stored value therefore records only an
 * *override* — the absence of one means "keep following the system", including
 * when the system changes later in the session.
 */

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'planesview.theme';

/** What the operating system is asking for right now. */
function systemTheme(): Theme {
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * The stored override, or null when the visitor has not chosen.
 *
 * Every failure returns null rather than throwing: `localStorage` access
 * itself throws in a private window with site data blocked, and a renderer has
 * no business failing to start over a colour scheme.
 */
function storedTheme(storage?: Storage): Theme | null {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(STORAGE_KEY);
    return raw === 'dark' || raw === 'light' ? raw : null;
  } catch {
    return null;
  }
}

export function saveTheme(theme: Theme, storage?: Storage): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(STORAGE_KEY, theme);
  } catch {
    // A preference that cannot be remembered still works for this session.
  }
}

/** The theme to open with: the override if there is one, else the system's. */
export function resolveTheme(storage?: Storage): Theme {
  return storedTheme(storage) ?? systemTheme();
}

/**
 * Put a theme on the document.
 *
 * `dark` is written out rather than left as the absence of an attribute, so
 * that choosing dark on a machine set to light is a choice the page honours
 * rather than a no-op that falls back to the system.
 */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset['theme'] = theme;
}

/**
 * Follow the system while the visitor has not overridden it.
 *
 * Returns an unsubscribe. Without this, someone whose machine switches at
 * sunset keeps the scheme it had at page load, which on a page left open all
 * evening is the one case where following the system matters most.
 */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  const query = globalThis.matchMedia?.('(prefers-color-scheme: light)');
  if (!query) return () => undefined;

  const handler = (event: MediaQueryListEvent): void => {
    if (storedTheme() !== null) return;
    onChange(event.matches ? 'light' : 'dark');
  };
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
