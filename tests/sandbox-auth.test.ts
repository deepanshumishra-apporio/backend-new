import { describe, expect, test } from 'bun:test';
import { assertSandboxAuth } from '../src/utils/sandbox-auth.ts';
describe('sandbox authentication boundary', () => {
  const enabled = { NODE_ENV: 'development', SANDBOX_AUTH_ENABLED: 'true', FP_BASE_URL: 'https://s.finprim.com' };
  test('accepts an explicitly configured development sandbox', () => {
    expect(() => assertSandboxAuth(enabled)).not.toThrow();
  });
  test('cannot be enabled in production, by omission, or for another provider host', () => {
    for (const override of [{ NODE_ENV: 'production' }, { NODE_ENV: undefined },
      { SANDBOX_AUTH_ENABLED: 'false' }, { FP_BASE_URL: 'https://api.fintechprimitives.com' }]) {
      expect(() => assertSandboxAuth({ ...enabled, ...override })).toThrow();
    }
  });
});
