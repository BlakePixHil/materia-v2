import { ENGINE_VERSION } from './engine-version';

describe('deadline engine', () => {
  it('exposes a semver engine version', () => {
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
