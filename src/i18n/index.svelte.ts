/**
 * The site's language.
 *
 * `t('key', params)` returns the message in the current language, and because
 * the language is reactive state, every template that calls it redraws when the
 * language changes — nothing to subscribe to.
 *
 * English is built into the page and every other language is its own small
 * file, fetched only when chosen (and kept by the browser afterwards), so a
 * visitor pays for one language, not forty-four. A message missing from the
 * chosen language falls back to English rather than showing a key; a test
 * keeps that from ever being needed.
 *
 * The choice is remembered, and on a first visit it comes from the browser's
 * own language preferences (`?lang=xx` overrides both, so a link can pick one).
 */

import en from './en';
import { DEFAULT_LOCALE, isSupported, localeInfo, matchLocale } from './locales';
import { formatMessage, type MessageParams } from './message';

export type MessageKey = keyof typeof en;
type Dictionary = Partial<Record<MessageKey, string>>;

const STORAGE_KEY = 'planesview.lang';

/** One loader per language file, found by the bundler, each its own chunk. */
const loaders = import.meta.glob<{ default: Dictionary }>('./locales/*.ts');

let code = $state(DEFAULT_LOCALE);
let dictionary = $state.raw<Dictionary>({});

/** The active language: its code, and the direction the page is laid out in. */
export const i18n = {
  get locale(): string {
    return code;
  },
  get dir(): 'ltr' | 'rtl' {
    return localeInfo(code).dir;
  },
};

export function t(key: MessageKey, params?: MessageParams): string {
  const raw = dictionary[key] ?? en[key];
  return formatMessage(raw, params, code);
}

/**
 * A message split around one of its parameters, so the parameter can be drawn
 * as something else (a link) while the sentence around it is translated:
 * `tAround('landing.madeBy', 'name')` is `['Made by ', '']` in English.
 */
export function tAround(key: MessageKey, param: string, params?: MessageParams): [string, string] {
  const mark = '\u0001';
  const [before = '', after = ''] = t(key, { ...params, [param]: mark }).split(mark);
  return [before, after];
}

function read(): string | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && isSupported(stored) ? localeInfo(stored).code : null;
  } catch {
    return null;
  }
}

function remember(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // a private window: the choice lasts until the page is closed
  }
}

/** Where the language is stamped on the document: for screen readers, hyphenation, search engines and layout. */
function applyToDocument(): void {
  if (typeof document === 'undefined') return;
  const info = localeInfo(code);
  document.documentElement.lang = info.code;
  document.documentElement.dir = info.dir;
  document.title = t('meta.title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('meta.description'));
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', t('meta.title'));
  document.querySelector('meta[property="og:description"]')?.setAttribute('content', t('meta.ogDescription'));
}

async function load(target: string): Promise<Dictionary> {
  if (target === DEFAULT_LOCALE) return {};
  const loader = loaders[`./locales/${target}.ts`];
  if (!loader) return {};
  try {
    return (await loader()).default;
  } catch {
    // a failed download: English, rather than a broken page
    return {};
  }
}

/** Switch language. Resolves once the new messages are in place. */
export async function setLocale(target: string, persist = true): Promise<void> {
  const info = localeInfo(target);
  const next = await load(info.code);
  dictionary = next;
  code = info.code;
  if (persist) remember(info.code);
  applyToDocument();
}

/** Pick the language for this visit: `?lang=`, then the saved choice, then the browser's. */
function initialLocale(): string {
  try {
    const asked = new URLSearchParams(location.search).get('lang');
    if (asked && isSupported(asked)) return localeInfo(asked).code;
  } catch {
    // no location: the default
  }
  return read() ?? matchLocale(typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language]) ?? DEFAULT_LOCALE;
}

export async function initI18n(): Promise<void> {
  const chosen = initialLocale();
  // A first visit by browser preference is not a choice, so it is not saved.
  await setLocale(chosen, false);
}
