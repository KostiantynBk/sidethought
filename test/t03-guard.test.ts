import { describe, expect, it } from 'vitest';
import http, { get as httpGet, request as httpRequest } from 'node:http';
import https, { get as httpsGet, request as httpsRequest } from 'node:https';
import net, { connect, createConnection } from 'node:net';
import { replayFixture } from '../src/harness/index.js';
import { basicPath } from './t03-helpers.js';

const attempts: Array<[string, () => unknown]> = [
  ['named http.request', () => httpRequest('file:///guard-diagnostic')],
  ['default http.request', () => http.request('file:///guard-diagnostic')],
  ['named http.get', () => httpGet('file:///guard-diagnostic')],
  ['default http.get', () => http.get('file:///guard-diagnostic')],
  ['named https.request', () => httpsRequest('file:///guard-diagnostic')],
  ['default https.request', () => https.request('file:///guard-diagnostic')],
  ['named https.get', () => httpsGet('file:///guard-diagnostic')],
  ['default https.get', () => https.get('file:///guard-diagnostic')],
  ['named net.connect', () => connect(1)],
  ['default net.connect', () => net.connect(1)],
  ['named net.createConnection', () => createConnection(1)],
  ['default net.createConnection', () => net.createConnection(1)],
  ['fetch', () => fetch('https://example.com')],
];

describe('network defense in depth', () => {
  it.each(attempts)('latches caught %s', (_name, attempt) => {
    const result = replayFixture(basicPath, {
      replayHook: () => {
        try {
          attempt();
        } catch {
          // A caught denial must still fail the replay.
        }
      },
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.class).toBe('harness');
  });

  it('restores default and named exports after a failed replay', () => {
    const original = {
      httpRequest,
      httpGet,
      httpsRequest,
      httpsGet,
      connect,
      createConnection,
      fetch: globalThis.fetch,
      socket: net.Socket.prototype.connect,
    };
    const failed = replayFixture(basicPath, {
      replayHook: () => {
        try {
          http.request('file:///guard');
        } catch {
          // Restoration is checked after the replay fails.
        }
      },
    });
    expect(failed.ok).toBe(false);
    expect(failed.failures[0]?.class).toBe('harness');
    expect(httpRequest).toBe(original.httpRequest);
    expect(http.request).toBe(original.httpRequest);
    expect(httpGet).toBe(original.httpGet);
    expect(http.get).toBe(original.httpGet);
    expect(httpsRequest).toBe(original.httpsRequest);
    expect(https.request).toBe(original.httpsRequest);
    expect(httpsGet).toBe(original.httpsGet);
    expect(https.get).toBe(original.httpsGet);
    expect(connect).toBe(original.connect);
    expect(net.connect).toBe(original.connect);
    expect(createConnection).toBe(original.createConnection);
    expect(net.createConnection).toBe(original.createConnection);
    expect(globalThis.fetch).toBe(original.fetch);
    expect(net.Socket.prototype.connect).toBe(original.socket);
    expect(replayFixture(basicPath).ok).toBe(true);
  });
});
