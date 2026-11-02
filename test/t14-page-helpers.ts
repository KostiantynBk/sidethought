import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import type { LookupAddress } from 'node:dns';
import { vi } from 'vitest';
import type { InvestigatorOutput, RetrievalEvidence } from '../src/contract/index.js';
import type { PageFetchIo } from '../src/model/meta/page-fetch.js';
import type { PageRequest } from '../src/model/meta/page-http.js';

export const publicAddress = '93.184.216.34';
export const pageUrl = 'https://provider.example/docs';
export const pageQuote = 'Provider A supports 12 users';
export const pageLimits = {
  maxSnippetChars: 2000,
  maxEvidenceResults: 20,
};
export function pageOutput(urls = [pageUrl], quote = pageQuote): InvestigatorOutput {
  return {
    verdict: 'supported',
    claims: urls.map(url => ({
      text: quote,
      support: [{
        url,
        quote,
        title: 'Public documentation',
        sourceKind: 'official',
      }],
    })),
    caveats: [],
  };
}

export function emptyEvidence(urls = [pageUrl]): RetrievalEvidence {
  return {
    completedSearchCalls: 1,
    issuedQueries: ['public question'],
    results: urls.map(url => ({
      url,
      title: 'Search title',
      snippet: '',
    })),
  };
}

export type Reply = {
  status?: number;
  headers?: IncomingMessage['headers'];
  body?: string;
  chunks?: Buffer[];
  hang?: boolean;
  error?: boolean;
};
type CapturedRequest = {
  url: string;
  options: RequestOptions;
  req: FakeRequest;
  response?: IncomingMessage;
  release?: () => void;
};
class FakeRequest extends EventEmitter {
  destroyed = false;
  constructor(private start: () => void) {
    super();
  }
  end(): this {
    queueMicrotask(this.start);
    return this;
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function deliver(captured: CapturedRequest, reply: Reply, receive: Parameters<PageRequest>[2]): void {
  if (captured.req.destroyed) return;
  if (reply.error) {
    captured.req.emit('error', new Error('sensitive URL must not leak'));
    return;
  }
  const response = new PassThrough() as unknown as IncomingMessage;
  response.statusCode = reply.status ?? 200;
  response.headers = reply.headers ?? { 'content-type': 'text/html; charset=utf-8' };
  response.complete = false;
  captured.response = response;
  receive(response);
  const finish = () => {
    const stream = response as unknown as PassThrough;
    for (const chunk of reply.chunks ?? [Buffer.from(reply.body ?? `<p>${pageQuote}</p>`)]) {
      if (stream.destroyed) return;
      stream.write(chunk);
    }
    response.complete = true;
    stream.end();
  };
  captured.release = finish;
  if (!reply.hang) finish();
}

export function fakePageIo(replies: Reply[] = [{}]) {
  const requests: CapturedRequest[] = [];
  const resolve = vi.fn<(hostname: string) => Promise<LookupAddress[]>>(async () => [{
    address: publicAddress,
    family: 4,
  }]);
  const request: PageRequest = (url, options, receive) => {
    const reply = replies[requests.length] ?? replies.at(-1)!;
    let captured: CapturedRequest;
    const req = new FakeRequest(() => deliver(captured, reply, receive));
    captured = { url: url.href, options, req };
    requests.push(captured);
    return req as unknown as ClientRequest;
  };
  const io: PageFetchIo = { resolve, request };
  return { io, resolve, requests };
}
