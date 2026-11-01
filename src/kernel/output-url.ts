// §11.3: until findings supply provenance, recognized URL forms are not released.
const webTlds = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'io', 'ai', 'dev', 'app', 'co', 'me', 'info', 'xyz',
  'uk', 'de', 'es', 'fr', 'eu', 'us',
]);
const fileExtensions = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'py', 'rs', 'go', 'java', 'rb', 'sh',
  'yml', 'yaml', 'toml', 'txt', 'css', 'scss', 'html', 'sql', 'csv', 'env', 'lock', 'png', 'jpg',
  'svg', 'ipynb',
]);

// A bare prose label such as "Check your data:" is not a data URI. Recognize compact
// and empty headers by their comma; block MIME/parameter prefixes before the comma so
// sentence splitting cannot release a recognizable URI header ahead of its payload.
const dataUri = /\bdata:(?:[^\s,]*,|\s*,|\s*(?:[a-z0-9!#$&^_.+-]+\s*\/\s*[a-z0-9!#$&^_.+-]+|;))/iu;

function isDataframeCall(host: string, afterHost: string): boolean {
  // Narrow syntax exception, not an exemption for code blocks or arbitrary .info domains.
  // Explicit schemes/network paths were already checked; URI continuations stay blocked.
  return host === 'df.info' && /^\(\s*\)(?![/?#:])/u.test(afterHost);
}

export function containsUrl(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[。．｡]/gu, '.');
  if (/\b[a-z][a-z0-9+.-]*:\/\/|\b(?:https?|ftp|file|mailto|javascript|wss?):|\bwww\./iu
    .test(normalized) || dataUri.test(normalized)) return true;
  if (/(?:^|[^\p{L}\p{N}:])\/\/(?=[\p{L}\p{N}\[])/u.test(normalized)) return true;
  if (/(?:^|[^\p{L}\p{N}])(?:\d{1,3}\.){3}\d{1,3}(?![\p{L}\p{N}])/u.test(normalized)) return true;
  if (/\[[0-9a-f:.]*:[0-9a-f:.]+\](?::\d+)?/iu.test(normalized)) return true;
  const hosts = /(?:^|[^\p{L}\p{N}_-])((?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+[\p{L}][\p{L}\p{N}-]*)(?::\d+|[/?#][^\s]*)?/gu;
  for (const match of normalized.matchAll(hosts)) {
    const host = match[1]!;
    const tld = host.slice(host.lastIndexOf('.') + 1).toLowerCase();
    const suffix = match[0].slice(match[0].indexOf(host) + host.length).replace(/[?!.,;:)\]]+$/u, '');
    if (fileExtensions.has(tld)) continue;
    const afterHost = normalized.slice(match.index! + match[0].indexOf(host) + host.length);
    if (isDataframeCall(host, afterHost)) continue;
    if (webTlds.has(tld) || /[^\x00-\x7f]/u.test(tld) || suffix !== '') return true;
  }
  return false;
}
