// Decision 11: fixed matching-only confusables, not arbitrary transliteration.
const lookalikes: Record<string, string> = {};
const groups: Record<string, string> = {
  a: 'аАαΑ',
  b: 'ВвΒβ',
  c: 'СсϹϲ',
  e: 'ЕеΕε',
  h: 'НнΗη',
  i: 'ІіΙιӀ',
  j: 'Јј',
  k: 'КкΚκ',
  m: 'МмΜμ',
  n: 'Ν',
  o: 'ОоΟο',
  p: 'РрΡρ',
  s: 'Ѕѕ',
  t: 'ТтΤτ',
  v: 'ν',
  x: 'ХхΧχ',
  y: 'УуΥυ',
  z: 'Ζζ',
};
for (const [latin, characters] of Object.entries(groups)) {
  for (const character of characters) lookalikes[character] = latin;
}

export const ABBREVIATION = /\b(?:e\.g\.|i\.e\.|etc\.|vs\.|approx\.|mr\.|mrs\.|ms\.|dr\.|no\.)$/iu;

export function normalizeOutput(text: string): string {
  return [...text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[。．｡]/gu, '.')]
    .map(character => lookalikes[character] ?? character).join('').toLowerCase()
    .replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ');
}

export function removeAbbreviationDots(text: string): string {
  return text.replace(/\b(?:e\.g\.|i\.e\.|etc\.|vs\.|approx\.|mr\.|mrs\.|ms\.|dr\.|no\.)/giu,
    value => value.replaceAll('.', ''));
}
