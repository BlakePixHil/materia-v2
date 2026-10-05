import type { CallableClient } from '@materia/data-access';

import { sendClientErrors } from './send-client-errors';

describe('sendClientErrors', () => {
  it('scrubs before sending (fictional data)', async () => {
    const call = vi.fn(async () => ({ accepted: 1, dropped: 0 }));
    await sendClientErrors({ call } as unknown as CallableClient, {
      sessionId: 'session-1',
      errors: [{ message: 'Failed for sam.lee@example.test', route: '/contacts?q=Lee', version: '1', userAgent: 'ua' }],
    });
    expect(call).toHaveBeenCalledWith('system-logClientError', {
      sessionId: 'session-1',
      errors: [{ message: 'Failed for [email]', route: '/contacts', version: '1', userAgent: 'ua' }],
    });
  });
});
