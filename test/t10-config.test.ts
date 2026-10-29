import { describe, expect, it } from 'vitest';
import { serverConfig } from '../src/server/config.js';

describe('server configuration errors', () => {
  it('names the cookie secret variable without exposing its supplied value', () => {
    const suppliedValue = 'short-test-only-value';
    let message = '';
    try {
      serverConfig({
        SIDETHOUGHT_PASSCODE: 'test-only-passcode',
        SIDETHOUGHT_COOKIE_SECRET: suppliedValue,
        SIDETHOUGHT_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toContain('SIDETHOUGHT_COOKIE_SECRET');
    expect(message).not.toContain(suppliedValue);
  });
});
