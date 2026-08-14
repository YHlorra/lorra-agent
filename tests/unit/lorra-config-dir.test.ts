import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lorraConfigDir } from '../../src/main/pi-sdk-driver/lorra-config-dir';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('lorraConfigDir', () => {
  it('uses the e2e user data directory when configured', () => {
    vi.stubEnv('LORRA_E2E_USERDATA', 'C:/test/user-data');

    expect(lorraConfigDir()).toBe(path.join('C:/test/user-data', '.lorra'));
  });

  it('falls back to the home directory when e2e user data is unset', () => {
    vi.stubEnv('LORRA_E2E_USERDATA', undefined);

    expect(lorraConfigDir()).toBe(path.join(os.homedir(), '.lorra'));
  });

  it('falls back to the home directory when e2e user data is empty', () => {
    vi.stubEnv('LORRA_E2E_USERDATA', '');

    expect(lorraConfigDir()).toBe(path.join(os.homedir(), '.lorra'));
  });
});
