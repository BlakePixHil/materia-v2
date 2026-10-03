import { handlePing } from './ping';

describe('handlePing', () => {
  it('reports the Sydney region and the default org timezone', () => {
    const result = handlePing(new Date('2026-10-03T00:00:00.000Z'));
    expect(result).toEqual({
      ok: true,
      region: 'australia-southeast1',
      timezone: 'Australia/Melbourne',
      at: '2026-10-03T00:00:00.000Z',
    });
  });
});
