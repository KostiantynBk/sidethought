import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';

export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const PAGE_USER_AGENT = 'Sidethought/0.1 (research quote verification)';
export type PageRequest = (
  url: URL,
  options: RequestOptions,
  receive: (response: IncomingMessage) => void,
) => ClientRequest;
export const requestPage: PageRequest = (url, options, receive) => (
  url.protocol === 'https:' ? httpsRequest(url, options, receive) : httpRequest(url, options, receive)
);
export type PageResponse = {
  location?: string;
  body?: string;
  contentType?: string;
};

function pinnedLookup(address: LookupAddress): LookupFunction {
  return (_hostname, options, callback) => {
    // Node may request all addresses (autoSelectFamily). Never consult DNS a second time.
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
}

function pageRequestOptions(address: LookupAddress): RequestOptions {
  return {
    method: 'GET',
    agent: false,
    lookup: pinnedLookup(address),
    family: address.family,
    headers: {
      'User-Agent': PAGE_USER_AGENT,
      'Accept': 'text/html, application/xhtml+xml, text/plain',
      'Accept-Encoding': 'identity',
    },
  };
}

function responseKind(response: IncomingMessage): PageResponse {
  const status = response.statusCode ?? 0;
  if ([301, 302, 303, 307, 308].includes(status)) {
    if (!response.headers.location) throw new Error('page_redirect_missing');
    return { location: response.headers.location };
  }
  const contentType = response.headers['content-type'] ?? '';
  const media = contentType.split(';')[0]!.trim().toLowerCase();
  const encoding = response.headers['content-encoding'];
  if (status < 200 || status >= 300 || (encoding && encoding !== 'identity')
    || !['text/html', 'application/xhtml+xml', 'text/plain'].includes(media)) {
    throw new Error('page_unsupported');
  }
  const length = Number(response.headers['content-length']);
  if (length > MAX_PAGE_BYTES) throw new Error('page_too_large');
  return { contentType };
}

function decodeBody(chunks: Buffer[], contentType: string): string {
  const charset = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/iu)?.[1] ?? 'utf-8';
  return new TextDecoder(charset, { fatal: true }).decode(Buffer.concat(chunks));
}

function readBody(response: IncomingMessage, contentType: string, finish: Finish): void {
  const chunks: Buffer[] = [];
  let bytes = 0;
  response.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_PAGE_BYTES) {
      finish(new Error('page_too_large'));
      return;
    }
    chunks.push(chunk);
  });
  response.once('end', () => {
    try {
      finish(undefined, {
        body: decodeBody(chunks, contentType),
        contentType,
      });
    } catch {
      finish(new Error('page_decode_failed'));
    }
  });
  response.once('aborted', () => finish(new Error('page_incomplete')));
  response.once('close', () => {
    if (!response.complete) finish(new Error('page_incomplete'));
  });
}

type Finish = (error?: Error, value?: PageResponse) => void;

export function fetchPageHop(
  url: URL,
  address: LookupAddress,
  signal: AbortSignal,
  request: PageRequest,
): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    let response: IncomingMessage | undefined;
    let req: ClientRequest | undefined;
    let settled = false;
    const finish: Finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      response?.destroy();
      req?.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => finish(new Error('page_aborted'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      req = request(url, pageRequestOptions(address), incoming => {
        response = incoming;
        response.on('error', () => finish(new Error('page_response_failed')));
        if (settled) return void response.destroy();
        receiveBody(response, finish);
      });
      req.on('error', () => finish(new Error('page_request_failed')));
      req.end();
    } catch {
      finish(new Error('page_request_failed'));
    }
  });
}

function receiveBody(response: IncomingMessage, finish: Finish): void {
  try {
    const kind = responseKind(response);
    if (kind.location) finish(undefined, kind);
    else readBody(response, kind.contentType!, finish);
  } catch {
    finish(new Error('page_unusable'));
  }
}
