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
import { preloadHero } from './ui/intro/heroScene';
import { initI18n, t } from './i18n/index.svelte';

/*
 * Before anything renders.
 *
 * A theme applied from a component runs after the first paint, so the page
 * opens in whichever scheme the stylesheet declares and then changes — a white
 * flash for a dark-mode visitor, or the reverse. This is the only point early
 * enough for there to be nothing to flash.
 */
applyTheme(resolveTheme());

// The front page's aeroplane, downloading before anything is mounted, so it
// is ready — whole — by the time the page is (see `heroScene`).
preloadHero();

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

/*
 * The language first, so the very first thing drawn is already in it: English
 * is built in and costs nothing, any other is one small file, and a failed
 * download falls back to English rather than holding the page up.
 */
void initI18n().finally(() => {
  if (!webgl2Available()) {
    const box = document.createElement('div');
    box.setAttribute(
      'style',
      'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;padding:24px;text-align:center;font-family:system-ui;color:#e8eef5;background:#05070d',
    );
    const title = document.createElement('h1');
    title.setAttribute('style', 'margin:0;font-size:18px');
    title.textContent = t('webgl.title');
    const body = document.createElement('p');
    body.setAttribute('style', 'margin:0;color:#9aa9bd;max-width:44ch');
    body.textContent = t('webgl.body');
    box.append(title, body);
    target.replaceChildren(box);
  } else {
    mount(App, { target });
  }
});
