const set = vi.hoisted(() => vi.fn(async () => undefined));
const doc = vi.hoisted(() => vi.fn(() => ({ set })));
vi.mock('../core/admin', () => ({ adminDb: () => ({ doc }), adminApp: () => ({}) }));

import { recordEcho } from './record-echo';

const REQUEST_ID = '6f1c1c2e-8a43-4b8e-9d0e-0a3f5b1d2c4e';

describe('system-recordEcho', () => {
  it('records that the task ran', async () => {
    await recordEcho.run({ data: { orgId: 'org-a', requestId: REQUEST_ID }, id: 't1', retryCount: 0 } as never);
    expect(doc).toHaveBeenCalledWith(`systemTasks/echo-${REQUEST_ID}`);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-a', requestId: REQUEST_ID }));
  });

  it('rejects an invalid payload', async () => {
    await expect(recordEcho.run({ data: { orgId: '' }, id: 't2', retryCount: 0 } as never)).rejects.toThrow();
  });
});
