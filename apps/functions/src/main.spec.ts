import type { CallableRequest } from 'firebase-functions/v2/https';

import * as main from './main';

describe('functions entry point', () => {
  it('exports the platform-ping callable, which returns the ping result', async () => {
    const request = { auth: { uid: 'user-test-1' }, data: {} } as unknown as CallableRequest;
    const result = await main.platform.ping.run(request);
    expect(result).toMatchObject({ ok: true, region: 'australia-southeast1', timezone: 'Australia/Melbourne' });
  });

  it('accepts anonymous callers for the placeholder', async () => {
    const request = { data: {} } as unknown as CallableRequest;
    await expect(main.platform.ping.run(request)).resolves.toMatchObject({ ok: true });
  });
});
