import { modelConfiguration, type MetaConnection } from '../model/meta/config.js';

export type ServerConfig = {
  passcode: string;
  cookieSecret: string;
  allowedOrigins: string[];
  insecureCookie: boolean;
  dbPath: string;
  port: number;
  banner?: string;
  model: 'dev' | 'meta';
  meta?: MetaConnection;
};

export function serverConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const passcode = env.SIDETHOUGHT_PASSCODE;
  const cookieSecret = env.SIDETHOUGHT_COOKIE_SECRET;
  if (!passcode) throw new Error('SIDETHOUGHT_PASSCODE is required');
  if (!cookieSecret || cookieSecret.length < 32) {
    throw new Error('SIDETHOUGHT_COOKIE_SECRET must be at least 32 characters');
  }
  const origins = (env.SIDETHOUGHT_ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean);
  if (!origins.length) throw new Error('SIDETHOUGHT_ALLOWED_ORIGINS is required');
  const port = Number(env.PORT || '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid PORT');
  const banner = env.SIDETHOUGHT_BANNER?.trim();
  if (banner && banner.length > 300) throw new Error('SIDETHOUGHT_BANNER must be at most 300 characters');
  const model = modelConfiguration(env);
  return {
    passcode,
    cookieSecret,
    allowedOrigins: origins,
    insecureCookie: env.SIDETHOUGHT_DEV_INSECURE_COOKIE === '1',
    dbPath: env.SIDETHOUGHT_DB_PATH || 'sidethought.sqlite',
    port,
    ...(banner ? { banner } : {}),
    ...model,
  };
}
