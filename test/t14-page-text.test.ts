import { describe, expect, it } from 'vitest';
import { normalizeEvidence } from '../src/kernel/research/support.js';
import { pageExcerpt } from '../src/model/meta/page-evidence.js';
import { extractPageText } from '../src/model/meta/page-text.js';

describe('T14 extracted source text', () => {
  it('removes script text', () => {
    expect(extractPageText('<p>Visible</p><script>invented quote</script><p>source</p>', 'text/html'))
      .toBe('Visible source');
  });

  it('removes style text', () => {
    expect(extractPageText('<style>.invented { content: "fake quote"; }</style><p>Source</p>', 'text/html'))
      .toBe('Source');
  });

  it('removes head text', () => {
    expect(extractPageText('<head><title>Not body evidence</title></head><body>Source</body>', 'text/html'))
      .toBe('Source');
  });

  it('removes noscript text', () => {
    expect(extractPageText('<noscript>fake quote</noscript><p>Source</p>', 'text/html')).toBe('Source');
  });

  it('removes nested SVG content', () => {
    const html = '<svg><svg><text>nested hidden</text></svg><text>outer hidden</text></svg><p>Source</p>';
    expect(extractPageText(html, 'text/html')).toBe('Source');
  });

  it('does not terminate an SVG block at a closing tag inside an attribute', () => {
    const html = '<svg><text title="</svg>">hidden</text></svg><p>Source</p>';
    expect(extractPageText(html, 'text/html')).toBe('Source');
  });

  it('does not terminate the head at closing-tag text inside a script', () => {
    const html = '<head><script>const x = "</head>";</script>hidden</head><p>Source</p>';
    expect(extractPageText(html, 'text/html')).toBe('Source');
  });

  it('does not expose an unclosed script', () => {
    expect(extractPageText('<p>Source</p><script>hidden forever', 'text/html')).toBe('Source');
  });

  it('removes comments rather than verifying their text', () => {
    expect(extractPageText('Source <!-- hidden quote --> text', 'text/html')).toBe('Source text');
  });

  it('does not treat quoted tag attributes as visible text', () => {
    expect(extractPageText('<p title="fake > quote">Source</p>', 'text/html')).toBe('Source');
  });

  it('decodes common named entities without double-decoding', () => {
    const html = '&lt;Tag&gt; &amp; &quot;quote&quot; &apos;word&apos;&nbsp;&mdash; &euro; &amp;lt;';
    expect(extractPageText(html, 'text/html')).toBe('<Tag> & "quote" \'word\' — € &lt;');
  });

  it('decodes decimal and hexadecimal numeric entities', () => {
    expect(extractPageText('&#65;&#x42;&#X43; &#x1F680;', 'text/html')).toBe('ABC 🚀');
  });

  it('preserves unknown or invalid entities instead of inventing characters', () => {
    expect(extractPageText('&madeup; &#x110000; &#xD800;', 'text/html'))
      .toBe('&madeup; &#x110000; &#xD800;');
  });

  it('collapses whitespace after HTML extraction', () => {
    expect(extractPageText('  <p>Some\n\t source</p>\r\n<p>text&nbsp; here</p> ', 'text/html'))
      .toBe('Some source text here');
  });

  it('preserves literal tags and entities in text/plain', () => {
    expect(extractPageText('  use <script> &amp;\n literally  ', 'text/plain')).toBe('use <script> &amp; literally');
  });

  it('retains a real substring while using kernel normalization for Unicode matches', () => {
    const text = `${'ﬃ '.repeat(400)}Provider A’s “ﬁle” — works. ${'e\u0301 '.repeat(400)}`;
    const quote = 'provider a\'s "file" - works.';
    const snippet = pageExcerpt(text, quote, 2000)!;
    expect(text.includes(snippet)).toBe(true);
    expect(snippet).toContain('Provider A’s “ﬁle” — works.');
    expect(normalizeEvidence(snippet)).toContain(normalizeEvidence(quote));
    expect(snippet.length).toBeLessThanOrEqual(quote.length + 600);
  });

  it('finds a combining-character quote after an expanding normalization prefix', () => {
    const text = `${'ﬃ'.repeat(1000)} cafe\u0301 supports 12 users ${'z'.repeat(1000)}`;
    const snippet = pageExcerpt(text, 'café supports 12 users', 100)!;
    expect(text.includes(snippet)).toBe(true);
    expect(normalizeEvidence(snippet)).toContain('café supports 12 users');
    expect(snippet.length).toBeLessThanOrEqual(100);
  });

  it('bounds an excerpt to maxSnippetChars without altering its text', () => {
    const text = `${'x'.repeat(1000)} Provider A supports 12 users ${'y'.repeat(1000)}`;
    const snippet = pageExcerpt(text, 'Provider A supports 12 users', 70)!;
    expect(snippet).toHaveLength(70);
    expect(text.includes(snippet)).toBe(true);
    expect(snippet).toContain('Provider A supports 12 users');
  });

  it('retains a quote exactly at the snippet limit', () => {
    const quote = 'Provider A supports 12 users';
    expect(pageExcerpt(`before ${quote} after`, quote, quote.length)).toBe(quote);
  });

  it('returns no excerpt when the quote is absent', () => {
    expect(pageExcerpt('Provider A supports 5 users', 'Provider A supports 12 users', 2000)).toBeUndefined();
  });

  it('returns no excerpt when the actual quote cannot fit the snippet limit', () => {
    expect(pageExcerpt('Provider A supports 12 users', 'Provider A supports 12 users', 10)).toBeUndefined();
  });
});
