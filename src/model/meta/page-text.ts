const entities: Readonly<Record<string, string>> = {
  amp: '&',
  AMP: '&',
  LT: '<',
  GT: '>',
  QUOT: '"',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  bull: '•',
  middot: '·',
  times: '×',
  divide: '÷',
  minus: '−',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/giu, (original: string, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity] ?? original;
    const hexadecimal = entity[1]?.toLowerCase() === 'x';
    const value = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!value || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return original;
    return String.fromCodePoint(value);
  });
}

function tagTokens(): RegExp {
  return /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?([a-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*(?:>|$)/giu;
}

function htmlText(html: string): string {
  // Bounded, conservative extraction, not a browser: no JS, CSS or subresource evaluation.
  const tags = tagTokens();
  const dropped = new Set(['script', 'style', 'noscript', 'svg', 'head']);
  const pieces: string[] = [];
  let cursor = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    pieces.push(html.slice(cursor, match.index));
    const name = match[1]?.toLowerCase();
    if (name && dropped.has(name) && !match[0].startsWith('</')) {
      tags.lastIndex = hiddenEnd(html, tags.lastIndex, name);
    }
    pieces.push(' ');
    cursor = tags.lastIndex;
  }
  pieces.push(html.slice(cursor));
  return decodeEntities(pieces.join(''));
}

function rawEnd(html: string, start: number, name: string): number {
  const close = new RegExp(`</${name}\\s*>`, 'giu');
  close.lastIndex = start;
  return close.exec(html) ? close.lastIndex : html.length;
}

function hiddenEnd(html: string, start: number, name: string): number {
  if (name === 'script' || name === 'style') return rawEnd(html, start, name);
  const tags = tagTokens();
  tags.lastIndex = start;
  let depth = 1;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    const inner = tag[1]?.toLowerCase();
    const closing = tag[0].startsWith('</');
    if (inner === name) {
      if (closing) depth--;
      else if (!tag[0].endsWith('/>')) depth++;
      if (!depth) return tags.lastIndex;
    } else if (inner && ['script', 'style', 'title', 'textarea'].includes(inner) && !closing) {
      tags.lastIndex = rawEnd(html, tags.lastIndex, inner);
    }
  }
  // An unclosed hidden block drops the rest, rather than exposing executable text as evidence.
  return html.length;
}

export function extractPageText(body: string, contentType: string): string {
  const plain = contentType.split(';')[0]!.trim().toLowerCase() === 'text/plain';
  return (plain ? body : htmlText(body)).replace(/\s+/gu, ' ').trim();
}
