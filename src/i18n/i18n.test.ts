import { describe, expect, it } from 'vitest';

import en from './en';
import { DEFAULT_LOCALE, LOCALES, localeInfo, matchLocale } from './locales';
import { formatMessage, placeholdersOf } from './message';
import { splitKeys } from './rich';

const files = import.meta.glob<{ default: Record<string, string> }>('./locales/*.ts', { eager: true });
const dictionaries = new Map(
  Object.entries(files).map(([path, mod]) => [path.replace('./locales/', '').replace('.ts', ''), mod.default]),
);
const enKeys = Object.keys(en) as (keyof typeof en)[];

describe('formatMessage', () => {
  it('fills in parameters, formatting numbers for the language in Latin digits', () => {
    expect(formatMessage('{a} and {b}', { a: 'x', b: 'y' }, 'en')).toBe('x and y');
    expect(formatMessage('{n} ft', { n: 12345 }, 'en')).toBe('12,345 ft');
    expect(formatMessage('{n} ft', { n: 12345 }, 'de')).toBe('12.345 ft');
    expect(formatMessage('{n} ft', { n: 1234 }, 'ar')).toMatch(/^[0-9٬,.\s]+ ft$/);
    expect(formatMessage('{n} ft', { n: 1234 }, 'ar')).not.toMatch(/[٠-٩]/);
  });

  it('chooses the plural form the language uses', () => {
    const m = '{n, plural, one {# aircraft} other {# aircraft}}';
    expect(formatMessage(m, { n: 1 }, 'en')).toBe('1 aircraft');
    expect(formatMessage(m, { n: 3 }, 'en')).toBe('3 aircraft');
    const ru = '{n, plural, one {# самолёт} few {# самолёта} many {# самолётов} other {# самолёта}}';
    expect(formatMessage(ru, { n: 1 }, 'ru')).toBe('1 самолёт');
    expect(formatMessage(ru, { n: 3 }, 'ru')).toBe('3 самолёта');
    expect(formatMessage(ru, { n: 5 }, 'ru')).toBe('5 самолётов');
    expect(formatMessage(ru, { n: 21 }, 'ru')).toBe('21 самолёт');
  });

  it('falls back to other when a form is missing, and leaves plain text alone', () => {
    expect(formatMessage('{n, plural, other {# x}}', { n: 1 }, 'en')).toBe('1 x');
    expect(formatMessage('no braces', undefined, 'en')).toBe('no braces');
    expect(formatMessage('a {missing} b', {}, 'en')).toBe('a  b');
  });

  it('lists the placeholders a message uses', () => {
    expect(placeholdersOf('{a} then {b} then {a}')).toEqual(['a', 'b']);
    expect(placeholdersOf('{n, plural, one {# of {x}} other {# of {x}}}')).toEqual(['n', 'x']);
    expect(placeholdersOf('plain')).toEqual([]);
  });
});

describe('splitKeys', () => {
  it('splits key caps from text', () => {
    expect(splitKeys('Press <k>F</k> or <k>Esc</k> now')).toEqual([
      { text: 'Press ', kbd: false },
      { text: 'F', kbd: true },
      { text: ' or ', kbd: false },
      { text: 'Esc', kbd: true },
      { text: ' now', kbd: false },
    ]);
    expect(splitKeys('plain')).toEqual([{ text: 'plain', kbd: false }]);
  });
});

describe('the language list', () => {
  it('has English first and no duplicates', () => {
    expect(LOCALES[0]!.code).toBe(DEFAULT_LOCALE);
    expect(new Set(LOCALES.map((l) => l.code.toLowerCase())).size).toBe(LOCALES.length);
  });

  it('marks the right-to-left languages', () => {
    for (const code of ['ar', 'he', 'fa', 'ur']) expect(localeInfo(code).dir).toBe('rtl');
    for (const code of ['en', 'fr', 'zh-CN', 'ja']) expect(localeInfo(code).dir).toBe('ltr');
  });

  it('matches what a browser reports', () => {
    expect(matchLocale(['fr-FR', 'en'])).toBe('fr');
    expect(matchLocale(['pt-BR'])).toBe('pt');
    expect(matchLocale(['zh-TW'])).toBe('zh-TW');
    expect(matchLocale(['zh-Hant-HK'])).toBe('zh-TW');
    expect(matchLocale(['zh'])).toBe('zh-CN');
    expect(matchLocale(['nn-NO'])).toBe('nb');
    expect(matchLocale(['xx', 'de-AT'])).toBe('de');
    expect(matchLocale(['xx'])).toBeNull();
    expect(matchLocale([])).toBeNull();
  });
});

describe('every translation', () => {
  const others = LOCALES.filter((l) => l.code !== DEFAULT_LOCALE);

  it('has a file for every language in the list, and no stray files', () => {
    for (const l of others) expect(dictionaries.has(l.code), `locales/${l.code}.ts`).toBe(true);
    for (const code of dictionaries.keys()) expect(LOCALES.some((l) => l.code === code), `unlisted ${code}`).toBe(true);
  });

  for (const l of others) {
    describe(l.code, () => {
      const dict = dictionaries.get(l.code) ?? {};

      it('translates every message and invents none', () => {
        const missing = enKeys.filter((k) => !(k in dict));
        const extra = Object.keys(dict).filter((k) => !(k in en));
        expect({ missing, extra }).toEqual({ missing: [], extra: [] });
      });

      it('keeps the placeholders, the key caps and the plural syntax of the English', () => {
        const broken: string[] = [];
        for (const key of enKeys) {
          const text = dict[key];
          if (typeof text !== 'string' || text.trim() === '') {
            broken.push(`${key}: empty`);
            continue;
          }
          const source = en[key] as string;
          if (placeholdersOf(text).join() !== placeholdersOf(source).join()) broken.push(`${key}: placeholders`);
          if ((text.match(/<k>/g) ?? []).length !== (source.match(/<k>/g) ?? []).length) broken.push(`${key}: key caps`);
          if ((text.match(/<\/k>/g) ?? []).length !== (source.match(/<\/k>/g) ?? []).length) broken.push(`${key}: key caps`);
          if (source.includes('plural') !== text.includes('plural')) broken.push(`${key}: plural`);
          // Braces must balance, or the formatter would print them.
          if ((text.match(/\{/g) ?? []).length !== (text.match(/\}/g) ?? []).length) broken.push(`${key}: braces`);
        }
        expect(broken).toEqual([]);
      });

      it('formats without throwing', () => {
        for (const key of enKeys) {
          const params = Object.fromEntries(placeholdersOf(en[key] as string).map((p) => [p, 3]));
          expect(() => formatMessage(dict[key] ?? '', params, l.code)).not.toThrow();
        }
      });
    });
  }
});
