/**
 * The user's pins on the selection map.
 *
 * DOM markers rather than a map layer. There are a handful of them at most,
 * each needs a name in real text (see `labels.ts` for why the map has no text
 * layers) and two controls — rename and delete — which are exactly what DOM
 * elements are for. MapLibre moves them with the map on every frame.
 */

import { Marker, type Map as MapLibreMap } from 'maplibre-gl';

import type { Pin } from '@/state/appStore.svelte';

export interface PinActions {
  remove(id: string): void;
  rename(id: string, name: string): void;
}

interface Entry {
  marker: Marker;
  name: HTMLElement;
  pin: Pin;
}

export class MapPins {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly map: MapLibreMap,
    private readonly actions: PinActions,
  ) {}

  /** Make the markers match `pins`: add, move, rename, remove. */
  sync(pins: readonly Pin[]): void {
    const keep = new Set<string>();
    for (const pin of pins) {
      keep.add(pin.id);
      const entry = this.entries.get(pin.id);
      if (!entry) {
        this.entries.set(pin.id, this.create(pin));
        continue;
      }
      if (entry.pin.lat !== pin.lat || entry.pin.lon !== pin.lon) entry.marker.setLngLat([pin.lon, pin.lat]);
      // Not while it is being edited: that would reset the caret mid-word.
      if (entry.pin.name !== pin.name && document.activeElement !== entry.name) {
        entry.name.textContent = pin.name;
      }
      entry.pin = pin;
    }
    for (const [id, entry] of this.entries) {
      if (keep.has(id)) continue;
      entry.marker.remove();
      this.entries.delete(id);
    }
  }

  private create(pin: Pin): Entry {
    const el = document.createElement('div');
    el.className = 'pv-pin';

    const dot = document.createElement('span');
    dot.className = 'pv-pin-dot';

    const name = document.createElement('span');
    name.className = 'pv-pin-name';
    name.textContent = pin.name;
    name.title = 'Double-click to rename';
    name.spellcheck = false;

    // Rename in place: double-click, type, Enter (or click away) to keep,
    // Escape to cancel.
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      name.contentEditable = 'plaintext-only';
      name.focus();
      document.getSelection()?.selectAllChildren(name);
    });
    name.addEventListener('keydown', (e) => {
      // The app's shortcuts must not fire while a name is being typed.
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        name.blur();
      } else if (e.key === 'Escape') {
        name.textContent = this.entries.get(pin.id)?.pin.name ?? pin.name;
        name.blur();
      }
    });
    name.addEventListener('blur', () => {
      name.contentEditable = 'false';
      const text = (name.textContent ?? '').trim().slice(0, 40);
      const current = this.entries.get(pin.id)?.pin.name ?? pin.name;
      if (text && text !== current) this.actions.rename(pin.id, text);
      else name.textContent = current;
    });

    const remove = document.createElement('button');
    remove.className = 'pv-pin-remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove this pin';
    remove.setAttribute('aria-label', `Remove pin ${pin.name}`);
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      this.actions.remove(pin.id);
    });

    // A click on a pin is about the pin, never a selection or a new pin.
    for (const type of ['click', 'mousedown', 'dblclick', 'contextmenu'] as const) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }

    el.append(dot, name, remove);
    const marker = new Marker({ element: el, anchor: 'left', offset: [-6, 0] })
      .setLngLat([pin.lon, pin.lat])
      .addTo(this.map);
    return { marker, name, pin };
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.marker.remove();
    this.entries.clear();
  }
}
