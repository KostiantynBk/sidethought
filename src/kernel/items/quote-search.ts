import { normalize } from './normalize.js';

type MappedCharacter = {
  value: string;
  start: number;
  end: number;
};

// Lowercase the whole string to retain contextual Unicode casing, while mapping UTF-16 units to raw offsets.
function lowercaseMap(text: string): MappedCharacter[] {
  const lower = text.toLowerCase();
  const result: MappedCharacter[] = [];
  let raw = 0;
  let position = 0;
  for (const character of text) {
    const end = raw + character.length;
    const length = character.toLowerCase().length;
    for (let i = 0; i < length; i += 1) {
      result.push({
        value: lower[position + i]!,
        start: raw,
        end,
      });
    }
    raw = end;
    position += length;
  }
  return result;
}

function normalizedMap(text: string): MappedCharacter[] {
  const result: MappedCharacter[] = [];
  for (const character of lowercaseMap(text)) {
    const value = character.value.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/[‐‑‒–—―]/g, '-');
    if (/\s/.test(value)) {
      if (!result.length) continue;
      const previous = result[result.length - 1]!;
      if (previous.value === ' ') {
        previous.end = character.end;
        continue;
      }
      result.push({
        ...character,
        value: ' ',
      });
    } else {
      result.push({
        ...character,
        value,
      });
    }
  }
  if (result.at(-1)?.value === ' ') result.pop();
  return result;
}

function isWord(character: string | undefined): boolean {
  return character !== undefined && /^[\p{L}\p{N}]$/u.test(character);
}

function hasBoundaries(text: string, quote: string, start: number, end: number): boolean {
  const first = Array.from(quote)[0];
  const last = Array.from(quote).at(-1);
  const before = Array.from(text.slice(0, start)).at(-1);
  const after = Array.from(text.slice(end))[0];
  return !(isWord(first) && isWord(before)) && !(isWord(last) && isWord(after));
}

export function quoteMatches(text: string, quote: string, boundaryQuote: string): { start: number; end: number }[] {
  const mapped = normalizedMap(text);
  const normalizedText = mapped.map(character => character.value).join('');
  const matches: { start: number; end: number }[] = [];
  for (let at = normalizedText.indexOf(quote); at !== -1; at = normalizedText.indexOf(quote, at + 1)) {
    const start = mapped[at]!.start;
    const end = mapped[at + quote.length - 1]!.end;
    if (hasBoundaries(text, boundaryQuote, start, end) && normalize(text.slice(start, end)) === quote) {
      matches.push({
        start,
        end,
      });
    }
  }
  return matches;
}

