import { fetchIntervalMs } from './firebase-flag-source';

describe('fetchIntervalMs', () => {
  it('fetches Remote Config hourly in prod', () => {
    expect(fetchIntervalMs('prod')).toBe(3_600_000);
  });

  it('fetches each minute on the deployed dev site and locally', () => {
    expect(fetchIntervalMs('dev')).toBe(60_000);
    expect(fetchIntervalMs('local')).toBe(60_000);
  });
});
