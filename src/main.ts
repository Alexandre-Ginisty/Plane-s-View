/**
 * Entry point.
 *
 * Deliberately thin: everything lives in `App.svelte` and the orchestrator it
 * mounts. The only work done here is the capability check, because a blank
 * black screen is the worst possible way to tell someone their browser cannot
 * run this.
 */

import { mount } from 'svelte';
import App from './App.svelte';
import './ui/theme.css';
import { applyTheme, resolveTheme } from './ui/theme';

/*
 * Before anything renders.
 *
 * A theme applied from a component runs after the first paint, so the page
 * opens in whichever scheme the stylesheet declares and then changes — a white
 * flash for a dark-mode visitor, or the reverse. This is the only point early
 * enough for there to be nothing to flash.
 */
applyTheme(resolveTheme());

function webgl2Available(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

const target = document.getElementById('app');
if (!target) throw new Error('#app mount point missing from index.html');

if (!webgl2Available()) {
  target.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                height:100%;gap:12px;padding:24px;text-align:center;font-family:system-ui;
                color:#e8eef5;background:#05070d">
      <h1 style="margin:0;font-size:18px">WebGL2 is not available</h1>
      <p style="margin:0;color:#9aa9bd;max-width:44ch">
        PlanesView renders the globe with WebGL2. It is available in every current
        browser, but may be disabled by a flag, a driver blocklist, or hardware
        acceleration being switched off.
      </p>
    </div>`;
} else {
  mount(App, { target });
}
