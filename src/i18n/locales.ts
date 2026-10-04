/**
 * The languages the site is translated into.
 *
 * `native` is how the language names itself: it is what the picker shows,
 * because someone who cannot read the page cannot be expected to find their
 * language under its English name. `dir` is the writing direction, applied to
 * the whole document so the layout mirrors for Arabic, Hebrew, Persian and
 * Urdu.
 *
 * Every entry has a file `locales/<code>.ts` with every message translated
 * (a test fails if a message is missing, or if a translation drops one of the
 * placeholders the English one has).
 */

export interface LocaleInfo {
  /** BCP 47 tag; also the file name under `locales/`. */
  code: string;
  /** English name, for sorting and for screen readers that read it. */
  name: string;
  /** The language's own name for itself. */
  native: string;
  dir: 'ltr' | 'rtl';
}

export const DEFAULT_LOCALE = 'en';

export const LOCALES: readonly LocaleInfo[] = [
  { code: 'en', name: 'English', native: 'English', dir: 'ltr' },
  { code: 'ar', name: 'Arabic', native: 'العربية', dir: 'rtl' },
  { code: 'bg', name: 'Bulgarian', native: 'Български', dir: 'ltr' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা', dir: 'ltr' },
  { code: 'ca', name: 'Catalan', native: 'Català', dir: 'ltr' },
  { code: 'cs', name: 'Czech', native: 'Čeština', dir: 'ltr' },
  { code: 'da', name: 'Danish', native: 'Dansk', dir: 'ltr' },
  { code: 'de', name: 'German', native: 'Deutsch', dir: 'ltr' },
  { code: 'el', name: 'Greek', native: 'Ελληνικά', dir: 'ltr' },
  { code: 'es', name: 'Spanish', native: 'Español', dir: 'ltr' },
  { code: 'et', name: 'Estonian', native: 'Eesti', dir: 'ltr' },
  { code: 'fa', name: 'Persian', native: 'فارسی', dir: 'rtl' },
  { code: 'fi', name: 'Finnish', native: 'Suomi', dir: 'ltr' },
  { code: 'fil', name: 'Filipino', native: 'Filipino', dir: 'ltr' },
  { code: 'fr', name: 'French', native: 'Français', dir: 'ltr' },
  { code: 'he', name: 'Hebrew', native: 'עברית', dir: 'rtl' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', dir: 'ltr' },
  { code: 'hr', name: 'Croatian', native: 'Hrvatski', dir: 'ltr' },
  { code: 'hu', name: 'Hungarian', native: 'Magyar', dir: 'ltr' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia', dir: 'ltr' },
  { code: 'it', name: 'Italian', native: 'Italiano', dir: 'ltr' },
  { code: 'ja', name: 'Japanese', native: '日本語', dir: 'ltr' },
  { code: 'ko', name: 'Korean', native: '한국어', dir: 'ltr' },
  { code: 'lt', name: 'Lithuanian', native: 'Lietuvių', dir: 'ltr' },
  { code: 'lv', name: 'Latvian', native: 'Latviešu', dir: 'ltr' },
  { code: 'ms', name: 'Malay', native: 'Bahasa Melayu', dir: 'ltr' },
  { code: 'nb', name: 'Norwegian', native: 'Norsk', dir: 'ltr' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands', dir: 'ltr' },
  { code: 'pl', name: 'Polish', native: 'Polski', dir: 'ltr' },
  { code: 'pt', name: 'Portuguese', native: 'Português', dir: 'ltr' },
  { code: 'ro', name: 'Romanian', native: 'Română', dir: 'ltr' },
  { code: 'ru', name: 'Russian', native: 'Русский', dir: 'ltr' },
  { code: 'sk', name: 'Slovak', native: 'Slovenčina', dir: 'ltr' },
  { code: 'sl', name: 'Slovenian', native: 'Slovenščina', dir: 'ltr' },
  { code: 'sr', name: 'Serbian', native: 'Srpski', dir: 'ltr' },
  { code: 'sv', name: 'Swedish', native: 'Svenska', dir: 'ltr' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்', dir: 'ltr' },
  { code: 'th', name: 'Thai', native: 'ไทย', dir: 'ltr' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe', dir: 'ltr' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська', dir: 'ltr' },
  { code: 'ur', name: 'Urdu', native: 'اردو', dir: 'rtl' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt', dir: 'ltr' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', native: '简体中文', dir: 'ltr' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', native: '繁體中文', dir: 'ltr' },
];

const BY_CODE = new Map(LOCALES.map((l) => [l.code.toLowerCase(), l]));

export function localeInfo(code: string): LocaleInfo {
  return BY_CODE.get(code.toLowerCase()) ?? BY_CODE.get(DEFAULT_LOCALE)!;
}

export function isSupported(code: string): boolean {
  return BY_CODE.has(code.toLowerCase());
}

/** Tags a browser may report that map onto a differently-named language here. */
const ALIASES: Record<string, string> = {
  no: 'nb',
  nn: 'nb',
  tl: 'fil',
  'zh-hk': 'zh-TW',
  'zh-mo': 'zh-TW',
  'zh-hant': 'zh-TW',
  'zh-hans': 'zh-CN',
  'zh-sg': 'zh-CN',
  zh: 'zh-CN',
  iw: 'he',
  in: 'id',
};

/**
 * The supported language that best matches an ordered list of the visitor's
 * preferences (`navigator.languages`), or null if none does. Tried whole
 * first ("pt-BR" is Portuguese), then by its base ("zh-Hant-TW" is not
 * Portuguese but is Traditional Chinese through the alias table).
 */
export function matchLocale(preferred: readonly string[]): string | null {
  for (const raw of preferred) {
    const tag = raw.trim().toLowerCase();
    if (!tag) continue;
    const candidates = [tag, ...tag.split('-').map((_, i, parts) => parts.slice(0, parts.length - 1 - i).join('-')).filter(Boolean)];
    for (const c of candidates) {
      const aliased = ALIASES[c] ?? c;
      const hit = BY_CODE.get(aliased.toLowerCase());
      if (hit) return hit.code;
    }
  }
  return null;
}
