import { resolve } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { State } from '../kernel/index.js';
import type { RawEvent } from '../runtime/model-port.js';
import type { ServerConfig } from './config.js';
import { LoginThrottle } from './login-throttle.js';
import { closeWebSockets } from './socket-shutdown.js';
import { registerLogin } from './login-routes.js';
import { registerSockets, type SocketSession } from './ws-routes.js';
import { registerProjectRoutes } from './project-routes.js';
import type { ProjectMemoryStore } from '../memory/store.js';

const maxMessageBytes = 16_384;

export async function createGateway(
  config: ServerConfig,
  state: () => State,
  accept: (event: RawEvent) => void,
  options: {
    resolveSession?: (projectId: string) => SocketSession;
    memory?: ProjectMemoryStore;
    invalidate?: (projectIds: string[]) => void;
  } = {},
) {
  const app = Fastify({
    logger: false,
    bodyLimit: maxMessageBytes,
  });
  const throttle = new LoginThrottle(config.dbPath);
  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(websocket, {
    options: { maxPayload: maxMessageBytes },
    preClose: closeWebSockets,
  });
  app.get('/health', async () => ({
    ok: true,
    model: config.model,
  }));
  registerLogin(app, config, throttle);
  const broadcast = registerSockets(app, config, state, accept, options.resolveSession);
  if (options.memory && options.invalidate) {
    await registerProjectRoutes(app, config, { memory: options.memory, invalidate: options.invalidate });
  }
  if (process.env.NODE_ENV === 'production' || process.argv.includes('--serve-static')) {
    await app.register(fastifyStatic, { root: resolve('web/dist') });
  }
  app.addHook('onClose', async () => throttle.close());
  return {
    app,
    broadcast,
  };
}
