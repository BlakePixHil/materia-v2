import { ENGINE_VERSION } from './engine-version';

describe('deadline engine', () => {
  it('exposes a semver engine version', () => {
    expect(ENGINE_VERSION).toBe('9.9.9'); // FND-04 demo (reverted): failing unit test
  });
});
