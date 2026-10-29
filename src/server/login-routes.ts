import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerConfig } from './config.js';
import type { LoginThrottle } from './login-throttle.js';

const loginBody = z.strictObject({ passcode: z.string().max(1024) });

function equalPasscode(left: string, right: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

export function registerLogin(app: FastifyInstance, config: ServerConfig, throttle: LoginThrottle): void {
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
}
