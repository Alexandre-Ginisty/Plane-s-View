/**
 * Behaving like a good tab.
 *
 *  - **The title says what this tab is showing** — the aircraft and the view
 *    — so a row of PlanesView tabs can be told apart, and a tab left on an
 *    approach says so in the tab strip.
 *  - **A tab in the background is quiet.** The feed already stops polling
 *    there (`TrafficClient`), and the browser stops drawing it; the engine
 *    note is suspended too, rather than droning from a tab nobody can see.
 *  - **Several tabs know about each other.** Only the one in front streams
 *    traffic, which is what the feeds' operators would want; a second tab
 *    says so once, so a frozen map in the first is not a surprise.
 */

import { app } from '@/state/appStore.svelte';
import { t as tr } from '@/i18n/index.svelte';
import { cameraLabel, phaseLabel } from '@/ui/labels';

const CHANNEL = 'planesview.tabs';

/** The document title for what the app is showing now. */
export function titleFor(): string {
  const s = app.selected;
  if (!s) return tr('meta.title');
  const name = s.latest.callsign?.trim() || app.dossier?.meta?.registration || s.hex.toUpperCase();
  const type = app.dossier?.meta?.icaoTypeCode;
  if (app.view !== 'pov') return type ? tr('tab.titleType', { name, type }) : tr('tab.title', { name });
  const view = cameraLabel(app.cameraMode);
  const phase = app.phase ? ` · ${phaseLabel(app.phase)}` : '';
  return tr('tab.titleFlying', { name, view, phase });
}

/** Start the tab housekeeping; returns the function that stops it. */
export function watchTab(onBackground: (hidden: boolean) => void): () => void {
  const onVisibility = (): void => onBackground(document.hidden);
  document.addEventListener('visibilitychange', onVisibility);

  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANNEL);
    let told = false;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      // Only these two strings mean anything; anything else is ignored.
      if (event.data === 'hello') channel?.postMessage('here');
      else if (event.data === 'here' && !told) {
        told = true;
        app.notify(tr('notice.otherTab'), 'info', 6000);
      }
    };
    channel.postMessage('hello');
  } catch {
    // No BroadcastChannel (an old Safari, a locked-down context): each tab
    // still pauses itself in the background, which is the part that matters.
  }

  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    channel?.close();
  };
}

/**
 * Keep the screen on while riding an aircraft.
 *
 * A phone dims and locks after half a minute without a touch, which is about
 * the length of a final approach. Held only in the 3D view and only while the
 * tab is in front (the browser drops the lock when it is not, so it is taken
 * again on return); released on the map, where the phone may sleep as usual.
 */
export class ScreenAwake {
  private lock: WakeLockSentinel | null = null;
  private wanted = false;
  private readonly onVisibility = (): void => void this.take();

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  set(on: boolean): void {
    this.wanted = on;
    if (on) void this.take();
    else void this.lock?.release();
  }

  dispose(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    void this.lock?.release();
  }

  private async take(): Promise<void> {
    if (!this.wanted || this.lock || document.hidden || !('wakeLock' in navigator)) return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => {
        if (this.lock === lock) this.lock = null;
      });
      this.lock = lock;
    } catch {
      // Refused (battery saver, permissions policy): the screen just sleeps.
    }
  }
}
