/** A message with `<k>Esc</k>` key caps in it, split into plain text and key caps. */
export interface RichPart {
  text: string;
  kbd: boolean;
}

export function splitKeys(message: string): RichPart[] {
  const parts: RichPart[] = [];
  const re = /<k>(.*?)<\/k>/g;
  let last = 0;
  for (let m = re.exec(message); m; m = re.exec(message)) {
    if (m.index > last) parts.push({ text: message.slice(last, m.index), kbd: false });
    parts.push({ text: m[1]!, kbd: true });
    last = m.index + m[0].length;
  }
  if (last < message.length) parts.push({ text: message.slice(last), kbd: false });
  return parts;
}
