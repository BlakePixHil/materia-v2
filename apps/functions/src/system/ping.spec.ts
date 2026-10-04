import type { CallableRequest } from 'firebase-functions/v2/https';

import { handlePing, ping } from './ping';

describe('system-ping', () => {
  afterEach(() => {
    delete process.env['MATERIA_RELEASE_VERSION'];
    delete process.env['MATERIA_RELEASE_SHA'];
  });

  it('reports the region, default timezone, version and SHA', () => {
    process.env['MATERIA_RELEASE_VERSION'] = '1.2.3';
    process.env['MATERIA_RELEASE_SHA'] = 'abc1234';
    expect(handlePing(new Date('2026-10-03T00:00:00.000Z'))).toEqual({
      ok: true,
      region: 'australia-southeast1',
      timezone: 'Australia/Melbourne',
      version: '1.2.3',
      sha: 'abc1234',
      at: '2026-10-03T00:00:00.000Z',
    });
  });

  it('falls back to dev values and is callable anonymously', async () => {
    const result = await ping.run({ data: {} } as unknown as CallableRequest);
    expect(result).toMatchObject({ ok: true, version: '0.0.0-dev', sha: 'unknown' });
  });
});
