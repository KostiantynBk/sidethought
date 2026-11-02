import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPage } from '../src/model/meta/page-fetch.js';
import { MAX_PAGE_BYTES } from '../src/model/meta/page-http.js';
import { fakePageIo, pageQuote, pageUrl, publicAddress } from './t14-page-helpers.js';

const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

describe('T14 redirects and page limits', () => {
  it('blocks a public page redirecting to a private IP', async () => {
    const fake = fakePageIo([{ status: 302, headers: { location: 'http://10.0.0.5/' } }]);
    expect(await fetchPage(pageUrl, signal(), fake.io)).toEqual({ status: 'blocked' });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.req.destroyed).toBe(true);
  });

  it('blocks a redirect hostname resolving to a private IP', async () => {
    const fake = fakePageIo([{ status: 307, headers: { location: 'https://internal.example/' } }]);
    fake.resolve.mockResolvedValueOnce([{ address: publicAddress, family: 4 }]);
    fake.resolve.mockResolvedValue([{ address: '192.168.1.1', family: 4 }]);
    expect(await fetchPage(pageUrl, signal(), fake.io)).toEqual({ status: 'blocked' });
    expect(fake.requests).toHaveLength(1);
  });

  it('revalidates DNS on same-host redirects', async () => {
    const fake = fakePageIo([{ status: 301, headers: { location: '/next' } }]);
    fake.resolve.mockResolvedValueOnce([{ address: publicAddress, family: 4 }]);
    fake.resolve.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    expect(await fetchPage(pageUrl, signal(), fake.io)).toEqual({ status: 'blocked' });
    expect(fake.requests).toHaveLength(1);
  });

  it('rejects credentials introduced by a redirect', async () => {
    const fake = fakePageIo([{ status: 302, headers: { location: 'https://user:pass@public.example/' } }]);
    expect(await fetchPage(pageUrl, signal(), fake.io)).toEqual({ status: 'blocked' });
    expect(fake.requests).toHaveLength(1);
  });

  it('rejects a disallowed scheme introduced by a redirect', async () => {
    const fake = fakePageIo([{ status: 302, headers: { location: 'file:///private' } }]);
    expect(await fetchPage(pageUrl, signal(), fake.io)).toEqual({ status: 'blocked' });
    expect(fake.requests).toHaveLength(1);
  });

  it('rejects a non-default port introduced by a redirect', async () => {
    const fake = fakePageIo([{ status: 302, headers: { location: 'http://public.example:8080/' } }]);
    expect(await fetchPage(pageUrl, signal(), fake.io)).toEqual({ status: 'blocked' });
    expect(fake.requests).toHaveLength(1);
  });

  it('follows up to three revalidated redirects', async () => {
    const fake = fakePageIo([
      { status: 301, headers: { location: '/one' } },
      { status: 302, headers: { location: '/two' } },
      { status: 308, headers: { location: 'https://other.example/three' } },
      {},
    ]);
    expect(await fetchPage(pageUrl, signal(), fake.io)).toEqual({ status: 'fetched', text: pageQuote });
    expect(fake.requests).toHaveLength(4);
    expect(fake.resolve).toHaveBeenCalledTimes(4);
  });

  it('never connects to a fourth redirect destination', async () => {
    const fake = fakePageIo([{ status: 303, headers: { location: '/loop' } }]);
    expect(await fetchPage(pageUrl, signal(), fake.io)).toEqual({ status: 'failed' });
    expect(fake.requests).toHaveLength(4);
  });

  it('aborts a streamed body beyond 2 MB without trusting Content-Length', async () => {
    const fake = fakePageIo([{
      chunks: [Buffer.alloc(MAX_PAGE_BYTES, 'a'), Buffer.from('overflow')],
      headers: { 'content-type': 'text/html', 'content-length': '1' },
    }]);
    expect(await fetchPage(pageUrl, signal(), fake.io)).toEqual({ status: 'failed' });
    expect(fake.requests[0]!.req.destroyed).toBe(true);
    expect(fake.requests[0]!.response!.destroyed).toBe(true);
  });

  it('rejects an oversized advertised body before reading it', async () => {
    const fake = fakePageIo([{
      headers: { 'content-type': 'text/plain', 'content-length': String(MAX_PAGE_BYTES + 1) },
    }]);
    expect(await fetchPage(pageUrl, signal(), fake.io)).toEqual({ status: 'failed' });
    expect(fake.requests[0]!.response!.destroyed).toBe(true);
  });

  it('accepts a plain-text body exactly at the byte limit', async () => {
    const fake = fakePageIo([{
      chunks: [Buffer.alloc(MAX_PAGE_BYTES, 'a')],
      headers: { 'content-type': 'text/plain' },
    }]);
    const result = await fetchPage(pageUrl, signal(), fake.io);
    expect(result.status).toBe('fetched');
    if (result.status === 'fetched') expect(result.text).toHaveLength(MAX_PAGE_BYTES);
  });

  it('times out and destroys a stalled HTTP response after five seconds', async () => {
    vi.useFakeTimers();
    const fake = fakePageIo([{ hang: true }]);
    const result = fetchPage(pageUrl, signal(), fake.io);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toEqual({ status: 'failed' });
    expect(fake.requests[0]!.req.destroyed).toBe(true);
    expect(fake.requests[0]!.response!.destroyed).toBe(true);
  });

  it('times out DNS and never connects after the late answer', async () => {
    vi.useFakeTimers();
    const fake = fakePageIo();
    let release!: (value: Array<{ address: string; family: number }>) => void;
    fake.resolve.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const result = fetchPage(pageUrl, signal(), fake.io);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toEqual({ status: 'failed' });
    release([{ address: publicAddress, family: 4 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.requests).toHaveLength(0);
  });

  it('does not reset the five-second timer at a redirect', async () => {
    vi.useFakeTimers();
    const fake = fakePageIo([
      { status: 302, headers: { location: '/next' } },
      { hang: true },
    ]);
    fake.resolve.mockImplementationOnce(() => new Promise(resolve => {
      setTimeout(() => resolve([{ address: publicAddress, family: 4 }]), 4000);
    }));
    const result = fetchPage(pageUrl, signal(), fake.io);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toEqual({ status: 'failed' });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]!.req.destroyed).toBe(true);
  });

  it('skips PDF responses', async () => {
    const fake = fakePageIo([{ headers: { 'content-type': 'application/pdf' } }]);
    expect(await fetchPage(pageUrl, signal(), fake.io)).toEqual({ status: 'failed' });
    expect(fake.requests[0]!.response!.destroyed).toBe(true);
  });

  it('skips responses without a content type', async () => {
    const fake = fakePageIo([{ headers: {} }]);
    expect(await fetchPage(pageUrl, signal(), fake.io)).toEqual({ status: 'failed' });
  });

  it('accepts XHTML responses', async () => {
    const fake = fakePageIo([{ headers: { 'content-type': 'application/xhtml+xml' } }]);
    expect(await fetchPage(pageUrl, signal(), fake.io)).toEqual({ status: 'fetched', text: pageQuote });
  });

  it('rejects compressed responses rather than risking decompression bombs', async () => {
    const fake = fakePageIo([{ headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } }]);
    expect(await fetchPage(pageUrl, signal(), fake.io)).toEqual({ status: 'failed' });
  });

  it('isolates a failed HTTP request', async () => {
    const fake = fakePageIo([{ error: true }]);
    expect(await fetchPage(pageUrl, signal(), fake.io)).toEqual({ status: 'failed' });
  });

  it('does not resolve or connect for an already cancelled fetch', async () => {
    const fake = fakePageIo();
    const controller = new AbortController();
    controller.abort();
    expect(await fetchPage(pageUrl, controller.signal, fake.io)).toEqual({ status: 'failed' });
    expect(fake.resolve).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
  });
});
