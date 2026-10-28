import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export class NetworkAttemptError extends Error {
  constructor(readonly replayError?: unknown) {
    super('network prohibited during replay');
  }
}

// The kernel's static purity guard is primary. This defense in depth cannot intercept
// aliases captured before replay; replay code must not pre-capture network functions.
export function guarded<T>(fn: () => T): T {
  const original = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    connect: net.connect,
    createConnection: net.createConnection,
    socketConnect: net.Socket.prototype.connect,
  };
  let attempted = false;
  const reject = () => {
    attempted = true;
    throw new Error('network prohibited during replay');
  };
  try {
    globalThis.fetch = reject as typeof globalThis.fetch;
    http.request = reject as typeof http.request;
    http.get = reject as typeof http.get;
    https.request = reject as typeof https.request;
    https.get = reject as typeof https.get;
    net.connect = reject as typeof net.connect;
    net.createConnection = reject as typeof net.createConnection;
    net.Socket.prototype.connect = reject as typeof net.Socket.prototype.connect;
    syncBuiltinESMExports();
    let result: T;
    try {
      result = fn();
    } catch (error) {
      if (attempted) throw new NetworkAttemptError(error);
      throw error;
    }
    if (attempted) throw new NetworkAttemptError();
    return result;
  } finally {
    globalThis.fetch = original.fetch;
    http.request = original.httpRequest;
    http.get = original.httpGet;
    https.request = original.httpsRequest;
    https.get = original.httpsGet;
    net.connect = original.connect;
    net.createConnection = original.createConnection;
    net.Socket.prototype.connect = original.socketConnect;
    syncBuiltinESMExports();
  }
}
