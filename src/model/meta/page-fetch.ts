import { BlockedPage, pageAddress, pageUrl, resolvePageHost, type PageResolver } from './page-address.js';
import { fetchPageHop, requestPage, type PageRequest } from './page-http.js';
import { extractPageText } from './page-text.js';

export const PAGE_TIMEOUT_MS = 5000;
export const MAX_PAGE_REDIRECTS = 3;
export type PageFetchIo = {
  resolve: PageResolver;
  request: PageRequest;
};
export const defaultPageFetchIo: PageFetchIo = {
  resolve: resolvePageHost,
  request: requestPage,
};
export type PageFetchResult =
  | {
    status: 'fetched';
    text: string;
  }
  | { status: 'blocked' | 'failed' };

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('page_aborted'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    // dns.lookup itself cannot be cancelled. Late DNS answers cannot initiate a connection.
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function fetchHops(value: string, signal: AbortSignal, io: PageFetchIo): Promise<string> {
  let url = pageUrl(value);
  for (let redirects = 0; redirects <= MAX_PAGE_REDIRECTS; redirects++) {
    signal.throwIfAborted();
    const address = await abortable(pageAddress(url, io.resolve), signal);
    signal.throwIfAborted();
    const response = await fetchPageHop(url, address, signal, io.request);
    signal.throwIfAborted();
    if (response.location !== undefined) {
      // Each hop rechecks protocol, credentials, port and ALL resolved addresses before connecting.
      url = pageUrl(new URL(response.location, url).href);
      continue;
    }
    return extractPageText(response.body!, response.contentType!);
  }
  throw new Error('page_redirect_limit');
}

export async function fetchPage(
  url: string,
  parent: AbortSignal,
  io: PageFetchIo = defaultPageFetchIo,
): Promise<PageFetchResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, PAGE_TIMEOUT_MS);
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) abort();
  const deadline = Date.now() + PAGE_TIMEOUT_MS;
  try {
    const text = await fetchHops(url, controller.signal, io);
    if (controller.signal.aborted || Date.now() >= deadline) return { status: 'failed' };
    return {
      status: 'fetched',
      text,
    };
  } catch (error) {
    // Never log exceptions: DNS/HTTP errors may contain URLs or response content (§11.3).
    return { status: error instanceof BlockedPage ? 'blocked' : 'failed' };
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', abort);
  }
}
