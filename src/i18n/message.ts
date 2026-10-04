/**
 * Message formatting: the small part of ICU MessageFormat the site needs.
 *
 *  - `{name}` is replaced by a parameter. A number is formatted for the
 *    language, with Latin digits (an altitude or a speed reads the same in
 *    every language, and in every other tracker).
 *  - `{n, plural, one {# aircraft} other {# aircraft}}` picks the form the
 *    language uses for `n`, and `#` inside it is `n` formatted. A language
 *    needs only the forms it has; `other` is the fallback.
 *
 * Not a general ICU parser, on purpose: nothing else is needed, and a message
 * that uses anything else is a bug the test catches.
 */

export type MessageParams = Readonly<Record<string, string | number>>;

function numberFormat(locale: string): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(`${locale}-u-nu-latn`);
  } catch {
    return new Intl.NumberFormat('en');
  }
}

/** The index of the brace that closes the one at `open`, or -1. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** `one {# aircraft} other {# aircraft}` as a map of form to text. */
function pluralForms(body: string): Map<string, string> {
  const forms = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i]!)) i++;
    const start = i;
    while (i < body.length && !/[\s{]/.test(body[i]!)) i++;
    const name = body.slice(start, i);
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (body[i] !== '{' || !name) break;
    const end = closingBrace(body, i);
    if (end < 0) break;
    forms.set(name, body.slice(i + 1, end));
    i = end + 1;
  }
  return forms;
}

export function formatMessage(message: string, params: MessageParams | undefined, locale: string): string {
  if (!message.includes('{')) return message;
  const nf = numberFormat(locale);
  const show = (v: string | number | undefined): string =>
    v === undefined ? '' : typeof v === 'number' ? nf.format(v) : v;

  let out = '';
  let i = 0;
  while (i < message.length) {
    const open = message.indexOf('{', i);
    if (open < 0) {
      out += message.slice(i);
      break;
    }
    out += message.slice(i, open);
    const close = closingBrace(message, open);
    if (close < 0) {
      out += message.slice(open);
      break;
    }
    const inner = message.slice(open + 1, close);
    const plural = /^\s*(\w+)\s*,\s*plural\s*,([\s\S]*)$/.exec(inner);
    if (plural) {
      const value = params?.[plural[1]!];
      const n = typeof value === 'number' ? value : Number(value ?? 0);
      const forms = pluralForms(plural[2]!);
      let category = 'other';
      try {
        category = new Intl.PluralRules(locale).select(n);
      } catch {
        // an unknown language tag: the generic form
      }
      const chosen = forms.get(category) ?? forms.get('other') ?? '';
      out += chosen.replace(/#/g, nf.format(n));
    } else {
      out += show(params?.[inner.trim()]);
    }
    i = close + 1;
  }
  return out;
}

/** The parameter names and plural variables a message refers to, for the translation test. */
export function placeholdersOf(message: string): string[] {
  const names = new Set<string>();
  let i = 0;
  while (i < message.length) {
    const open = message.indexOf('{', i);
    if (open < 0) break;
    const close = closingBrace(message, open);
    if (close < 0) break;
    const inner = message.slice(open + 1, close);
    const plural = /^\s*(\w+)\s*,\s*plural\s*,/.exec(inner);
    if (plural) {
      names.add(plural[1]!);
      // Parameters used inside the forms (other than `#`) count too.
      for (const m of inner.matchAll(/\{(\w+)\}/g)) names.add(m[1]!);
    } else {
      names.add(inner.trim());
    }
    i = close + 1;
  }
  return [...names].sort();
}
