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

  it('defaults guardEnabled to false when JUNO_GUARD_ENABLED is unset', () => {
    stubRequiredEnv();
    vi.stubEnv('JUNO_GUARD_ENABLED', undefined);

    expect(loadEnv().guardEnabled).toBe(false);
  });

  it('enables the guard only for literal true', () => {
    stubRequiredEnv();
    vi.stubEnv('JUNO_GUARD_ENABLED', 'true');
    expect(loadEnv().guardEnabled).toBe(true);

    vi.stubEnv('JUNO_GUARD_ENABLED', 'TRUE');
    expect(loadEnv().guardEnabled).toBe(false);

    vi.stubEnv('JUNO_GUARD_ENABLED', 'false');
    expect(loadEnv().guardEnabled).toBe(false);
  });
});
