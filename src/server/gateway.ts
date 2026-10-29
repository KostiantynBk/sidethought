import { resolve } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { State } from '../kernel/index.js';
import type { RawEvent } from '../runtime/model-port.js';
import type { ServerConfig } from './config.js';
import { LoginThrottle } from './login-throttle.js';
import { registerLogin } from './login-routes.js';
import { registerSockets } from './ws-routes.js';

const maxMessageBytes = 16_384;

export async function createGateway(
  config: ServerConfig,
  state: () => State,
  accept: (event: RawEvent) => void,
) {
  const app = Fastify({
    logger: false,
    bodyLimit: maxMessageBytes,
  });
  const throttle = new LoginThrottle(config.dbPath);
  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(websocket, { options: { maxPayload: maxMessageBytes } });
  app.get('/health', async () => ({
    ok: true,
    model: config.model,
  }));
  registerLogin(app, config, throttle);
  const broadcast = registerSockets(app, config, state, accept);
  if (process.env.NODE_ENV === 'production' || process.argv.includes('--serve-static')) {
    await app.register(fastifyStatic, { root: resolve('web/dist') });
  }
  app.addHook('onClose', async () => throttle.close());
  return {
    app,
    broadcast,
  };
}
