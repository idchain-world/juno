import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/env.js';

describe('loadEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubRequiredEnv() {
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('OPENROUTER_MODEL', 'test-model');
    vi.stubEnv('PUBLIC_URL', 'https://agent.example.com');
  }

  it('defaults guardEnabled to true when JUNO_GUARD_ENABLED is unset', () => {
    stubRequiredEnv();
    vi.stubEnv('JUNO_GUARD_ENABLED', undefined);

    expect(loadEnv().guardEnabled).toBe(true);
  });

  it('disables the guard only for literal false', () => {
    stubRequiredEnv();
    vi.stubEnv('JUNO_GUARD_ENABLED', 'false');
    expect(loadEnv().guardEnabled).toBe(false);

    vi.stubEnv('JUNO_GUARD_ENABLED', 'FALSE');
    expect(loadEnv().guardEnabled).toBe(true);
  });
});
