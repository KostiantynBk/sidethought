const units: Record<string, bigint> = {
  zero: 0n,
  one: 1n,
  two: 2n,
  three: 3n,
  four: 4n,
  five: 5n,
  six: 6n,
  seven: 7n,
  eight: 8n,
  nine: 9n,
  ten: 10n,
  eleven: 11n,
  twelve: 12n,
  thirteen: 13n,
  fourteen: 14n,
  fifteen: 15n,
  sixteen: 16n,
  seventeen: 17n,
  eighteen: 18n,
  nineteen: 19n,
  twenty: 20n,
  thirty: 30n,
  forty: 40n,
  fifty: 50n,
  sixty: 60n,
  seventy: 70n,
  eighty: 80n,
  ninety: 90n,
};
const codes: Record<string, string> = {
  '€': 'EUR',
  eur: 'EUR',
  euro: 'EUR',
  euros: 'EUR',
  '$': 'USD',
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  '£': 'GBP',
  gbp: 'GBP',
  pound: 'GBP',
  pounds: 'GBP',
};
const numberWords = [...Object.keys(units), 'hundred', 'thousand'].join('|');
const wordsPattern = `(?:${numberWords})(?:[\\s-]+(?:and[\\s-]+)?(?:${numberWords}))*`;
// Capture the whole non-space numeric lexeme, including unsupported continuations.
const numberPattern = `(?:[+-]?\\d[^\\s!?;]*|${wordsPattern})`;
const amountPattern = new RegExp(
  `([€$£])\\s*(${numberPattern})(?![\\p{L}\\p{N}])|` +
    `(?<![\\p{L}\\p{N}.,])(${numberPattern})\\s+(eur|euros?|usd|dollars?|gbp|pounds?)(?![\\p{L}\\p{N}])`,
  'giu',
);

function digitValue(value: string): string | undefined {
  const grouped = /^\d{1,3}(?:,\d{3})+$/.test(value);
  const decimal = /^\d+\.\d+$/.test(value);
  if (!/^\d+$/.test(value) && !grouped && !decimal) return undefined;
  const [integer, fraction] = value.replace(/,/g, '').split('.');
  // Three digits after a dot are ambiguous with a locale grouping separator.
  if (fraction?.length === 3) return undefined;
  const whole = integer!.replace(/^0+(?=\d)/, '');
  const fractional = fraction?.replace(/0+$/, '');
  return fractional ? `${whole}.${fractional}` : whole;
}

function belowThousand(words: string[]): bigint | undefined {
  let result = 0n;
  const parts = [...words];
  if (parts[1] === 'hundred') {
    const lead = units[parts[0]!];
    if (lead === undefined || lead < 1n || lead > 9n) return undefined;
    result = lead * 100n;
    parts.splice(0, 2);
    if (parts[0] === 'and') parts.shift();
  }
  if (!parts.length) return result || undefined;
  const first = units[parts[0]!];
  if (first === undefined || parts.length > 2) return undefined;
  if (parts.length === 1) return result + first;
  const second = units[parts[1]!];
  if (first < 20n || second === undefined || second < 1n || second > 9n) return undefined;
  return result + first + second;
}

function wordValue(value: string): string | undefined {
  const words = value.toLowerCase().split(/[\s-]+/);
  const position = words.indexOf('thousand');
  if (position < 0) return belowThousand(words)?.toString();
  if (words.lastIndexOf('thousand') !== position) return undefined;
  const thousands = belowThousand(words.slice(0, position));
  if (thousands === undefined || thousands === 0n) return undefined;
  const tail = words.slice(position + 1);
  if (tail[0] === 'and') tail.shift();
  const remainder = tail.length ? belowThousand(tail) : 0n;
  if (remainder === undefined) return undefined;
  return (thousands * 1000n + remainder).toString();
}

function numericValue(value: string): string | undefined {
  return /^[+-]?\d/.test(value) ? digitValue(value) : wordValue(value);
}

export function extractAmounts(value: string): { remainder: string; amounts: string[] } {
  const amounts: string[] = [];
  const remainder = value.replace(amountPattern, (_match, symbol, symbolNumber, wordNumber, currency) => {
    const code = codes[String(symbol ?? currency).toLowerCase()];
    const raw = String(symbolNumber ?? wordNumber);
    // A final comma or period may be sentence punctuation, not part of the numeric lexeme.
    const lexeme = raw.replace(/[.,]$/, '');
    const canonical = numericValue(lexeme);
    amounts.push(canonical === undefined ? `UNMATCHED:${code}:${lexeme}` : `${code}:${canonical}`);
    return ' ';
  });
  return {
    remainder,
    amounts,
  };
}
