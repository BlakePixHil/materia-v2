import { redact } from './redact';

describe('redact', () => {
  it('replaces personal fields at any depth and keeps ids, enums and numbers', () => {
    const input = {
      matterId: 'matter-1',
      status: 'active',
      minutes: 18,
      client: { name: 'Margaret Whitfield', email: 'm.whitfield@example.com', phones: ['+61400000000'] },
      notes: [{ id: 'n1', body: 'Called the executor', quote: 'Fictional quote' }],
      Title: 'Estate of Margaret Whitfield',
    };
    expect(redact(input)).toEqual({
      matterId: 'matter-1',
      status: 'active',
      minutes: 18,
      client: { name: '[redacted]', email: '[redacted]', phones: '[redacted]' },
      notes: '[redacted]',
      Title: '[redacted]',
    });
  });

  it('redacts inside arrays of objects and leaves dates and primitives alone', () => {
    const at = new Date('2026-03-14T00:00:00.000Z');
    expect(redact([{ narrative: 'x', taskId: 't1' }, 3, 'id-only', null, at])).toEqual([
      { narrative: '[redacted]', taskId: 't1' },
      3,
      'id-only',
      null,
      at,
    ]);
  });

  it('stops at a maximum depth instead of recursing forever', () => {
    let deep: Record<string, unknown> = { leaf: 'id' };
    for (let i = 0; i < 10; i++) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).toContain('[depth]');
  });
});
