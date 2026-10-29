import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RawData, WebSocket } from 'ws';
import { EventSchema, type ClientMessage } from '../contract/index.js';
import type { State } from '../kernel/index.js';
import type { RawEvent } from '../runtime/model-port.js';
import type { ServerConfig } from './config.js';
import { projectState } from './projection.js';

const allowed = new Set(['input.committed', 'input.activity', 'control.set', 'item.action', 'delivery.progress']);
const clientEvent = z.strictObject({
  type: z.string(),
  payload: z.unknown(),
});

type SocketPorts = {
  state: () => State;
  accept: (event: RawEvent) => void;
  sockets: Set<WebSocket>;
  recentMessages: number[];
};

function emit(ports: SocketPorts, type: string, payload: unknown): void {
  ports.accept({
    eventId: randomUUID(),
    sessionId: ports.state().sessionId,
    type,
    payload,
  });
}

function receive(socket: WebSocket, data: RawData, ports: SocketPorts): void {
  const now = Date.now();
  while (ports.recentMessages.length && ports.recentMessages[0]! <= now - 1000) ports.recentMessages.shift();
  if (ports.recentMessages.length >= 30) return socket.close(1008, 'rate limit');
  ports.recentMessages.push(now);
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
    sessionId: ports.state().sessionId,
    type: parsed.data.type,
    payload: parsed.data.payload,
  };
  if (!EventSchema.safeParse(event).success) return socket.close(1008, 'invalid message');
  ports.accept(event);
}

function connect(socket: WebSocket, ports: SocketPorts): void {
  if (ports.sockets.size === 0) emit(ports, 'client.connected', { modality: 'text' });
  socket.send(JSON.stringify({
    type: 'ui.snapshot',
    state: projectState(ports.state()),
  }));
  ports.sockets.add(socket);
  socket.on('message', data => receive(socket, data, ports));
  socket.on('close', () => {
    ports.sockets.delete(socket);
    if (ports.sockets.size === 0) emit(ports, 'client.disconnected', {});
  });
}

export function registerSockets(
  app: FastifyInstance,
  config: ServerConfig,
  state: () => State,
  accept: (event: RawEvent) => void,
): (message: ClientMessage) => void {
  const ports: SocketPorts = {
    state,
    accept,
    sockets: new Set(),
    recentMessages: [],
  };
  app.get('/ws', {
    websocket: true,
    preValidation: async (request, reply) => {
      const origin = request.headers.origin;
      if (!origin || !config.allowedOrigins.includes(origin)) return reply.code(403).send();
      const rawCookie = request.cookies.sidethought;
      if (!rawCookie || request.unsignCookie(rawCookie).value !== 'authenticated') return reply.code(401).send();
    },
  }, socket => connect(socket, ports));
  return message => {
    const json = JSON.stringify(message);
    for (const socket of ports.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(json);
    }
  };
}
