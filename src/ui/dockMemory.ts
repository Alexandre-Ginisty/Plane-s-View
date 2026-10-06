/**
 * Whether each dock was left folded, per visitor.
 *
 * A convenience and nothing more, so it lives in `localStorage` and every
 * access is guarded: a private window or blocked storage simply starts from
 * the default again. On a phone the docks start folded — the view is small
 * and is what someone came for — and open everywhere else.
 */

const key = (dock: string): string => `pv.dock.${dock}`;

export function dockFolded(dock: string, onPhone = true): boolean {
  try {
    const stored = localStorage.getItem(key(dock));
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    /* storage blocked: the default */
  }
  return onPhone && typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches;
}

export function rememberDockFolded(dock: string, folded: boolean): void {
  try {
    localStorage.setItem(key(dock), folded ? '1' : '0');
  } catch {
    /* storage blocked: forgotten on the next visit */
  }
}
