// §11.3: only exact verified-current finding URLs may pass the existing broad URL detector.
const webTlds = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'io', 'ai', 'dev', 'app', 'co', 'me', 'info', 'xyz',
  'uk', 'de', 'es', 'fr', 'eu', 'us',
]);
const fileExtensions = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'py', 'rs', 'go', 'java', 'rb', 'sh',
  'yml', 'yaml', 'toml', 'txt', 'css', 'scss', 'html', 'sql', 'csv', 'env', 'lock', 'png', 'jpg',
  'svg', 'ipynb',
]);

export function containsUnapprovedUrl(text: string, allowed: readonly string[]): boolean {
  const allowlist = new Set(allowed);
  const remaining = text.replace(/\bhttps?:\/\/[^\s<>"`]+/gu, token => {
    const url = token.replace(/[.,!;:)\]}]+$/gu, '');
    // Match the complete URL token, never an allow-listed prefix of an attacker's URL.
    return allowlist.has(url) ? ' ' : token;
  });
  return containsUrl(remaining);
}

export function containsUrl(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[。．｡]/gu, '.');
  if (/\b[a-z][a-z0-9+.-]*:\/\/|\b(?:https?|ftp|file|mailto|data|javascript|wss?):|\bwww\./iu
    .test(normalized)) return true;
  if (/(?:^|[^\p{L}\p{N}:])\/\/(?=[\p{L}\p{N}\[])/u.test(normalized)) return true;
  if (/(?:^|[^\p{L}\p{N}])(?:\d{1,3}\.){3}\d{1,3}(?![\p{L}\p{N}])/u.test(normalized)) return true;
  if (/\[[0-9a-f:.]*:[0-9a-f:.]+\](?::\d+)?/iu.test(normalized)) return true;
  const hosts = /(?:^|[^\p{L}\p{N}_-])((?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+[\p{L}][\p{L}\p{N}-]*)(?::\d+|[/?#][^\s]*)?/gu;
  for (const match of normalized.matchAll(hosts)) {
    const host = match[1]!;
    const tld = host.slice(host.lastIndexOf('.') + 1).toLowerCase();
    const suffix = match[0].slice(match[0].indexOf(host) + host.length).replace(/[?!.,;:)\]]+$/u, '');
    if (fileExtensions.has(tld)) continue;
    if (webTlds.has(tld) || /[^\x00-\x7f]/u.test(tld) || suffix !== '') return true;
  }
  return false;
}
