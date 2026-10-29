import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import { EventSchema, type ClientMessage } from '../contract/index.js';
import type { State } from '../kernel/index.js';
import type { RawEvent } from '../runtime/model-port.js';
import type { ServerConfig } from './config.js';
import { LoginThrottle } from './login-throttle.js';
import { projectState } from './projection.js';

const allowed = new Set(['input.committed', 'input.activity', 'control.set', 'item.action', 'delivery.progress']);
const clientEvent = z.strictObject({ type: z.string(), payload: z.unknown() });
const loginBody = z.strictObject({ passcode: z.string().max(1024) });
const maxMessageBytes = 16_384;

function equalPasscode(left: string, right: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

export async function createGateway(
  config: ServerConfig,
  state: () => State,
  accept: (event: RawEvent) => void,
) {
  const app = Fastify({ logger: false, bodyLimit: maxMessageBytes });
  const throttle = new LoginThrottle(config.dbPath);
  const sockets = new Set<WebSocket>();
  const recentMessages: number[] = [];
  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(websocket, { options: { maxPayload: maxMessageBytes } });

  app.get('/health', async () => ({ ok: true, model: config.model }));
  app.post('/login', async (request, reply) => {
    if (throttle.locked()) return reply.code(429).send({ error: 'try later' });
    const body = loginBody.safeParse(request.body);
    if (!body.success || !equalPasscode(body.data.passcode, config.passcode)) {
      throttle.failure();
      return reply.code(401).send({ error: 'invalid login' });
    }
    throttle.success();
    const localInsecure = config.insecureCookie && request.hostname === '127.0.0.1' && request.protocol === 'http';
    reply.setCookie('sidethought', 'authenticated', {
      signed: true,
      httpOnly: true,
      secure: !localInsecure,
      sameSite: 'strict',
      path: '/',
    });
    return { ok: true };
  });

  app.get('/ws', { websocket: true, preValidation: async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || !config.allowedOrigins.includes(origin)) return reply.code(403).send();
    const rawCookie = request.cookies.sidethought;
    if (!rawCookie || request.unsignCookie(rawCookie).value !== 'authenticated') return reply.code(401).send();
  } }, socket => {
    if (sockets.size === 0) emit('client.connected', { modality: 'text' });
    socket.send(JSON.stringify({ type: 'ui.snapshot', state: projectState(state()) }));
    sockets.add(socket);
    socket.on('message', data => {
      const now = Date.now();
      while (recentMessages.length && recentMessages[0]! <= now - 1000) recentMessages.shift();
      if (recentMessages.length >= 30) return socket.close(1008, 'rate limit');
      recentMessages.push(now);
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return socket.close(1008, 'invalid message');
      }
      const parsed = clientEvent.safeParse(raw);
      if (!parsed.success || !allowed.has(parsed.data.type)) return socket.close(1008, 'invalid message');
      const event = {
        eventId: randomUUID(),
        sessionId: state().sessionId,
        type: parsed.data.type,
        payload: parsed.data.payload,
      };
      if (!EventSchema.safeParse(event).success) return socket.close(1008, 'invalid message');
      accept(event);
    });
    socket.on('close', () => {
      sockets.delete(socket);
      if (sockets.size === 0) emit('client.disconnected', {});
    });
  });

  function emit(type: string, payload: unknown): void {
    accept({ eventId: randomUUID(), sessionId: state().sessionId, type, payload });
  }

  if (process.env.NODE_ENV === 'production' || process.argv.includes('--serve-static')) {
    await app.register(fastifyStatic, { root: resolve('web/dist') });
  }
  app.addHook('onClose', async () => throttle.close());
  return {
    app,
    broadcast(message: ClientMessage) {
      const json = JSON.stringify(message);
      for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(json);
    },
  };
}
