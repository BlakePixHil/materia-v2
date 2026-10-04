import { createLog, type LogSink } from './log';

describe('createLog', () => {
  it('writes structured entries with context, durationMs and redacted data', () => {
    const entries: [string, string, Record<string, unknown>][] = [];
    const sink: LogSink = (severity, message, entry) => entries.push([severity, message, entry]);
    const log = createLog({ fn: 'system-echo', requestId: 'r-1', uid: 'u-1', orgId: 'org-a' }, sink, Date.now() - 25);
    log.info('echo', { message: 'Hello from Margaret Whitfield', length: 29 });
    log.child({ role: 'lawyer' }).warn('rejected', { code: 'PERMISSION_DENIED' });
    log.debug('d');
    log.error('e');

    const [severity, message, entry] = entries[0] ?? [];
    expect([severity, message]).toEqual(['info', 'echo']);
    expect(entry).toMatchObject({
      fn: 'system-echo',
      requestId: 'r-1',
      uid: 'u-1',
      orgId: 'org-a',
      message: '[redacted]',
      length: 29,
    });
    expect(entry?.['durationMs']).toBeGreaterThanOrEqual(25);
    expect(JSON.stringify(entries)).not.toContain('Whitfield');
    expect(entries[1]?.[2]).toMatchObject({ role: 'lawyer', code: 'PERMISSION_DENIED', fn: 'system-echo' });
    expect(entries.map(([s]) => s)).toEqual(['info', 'warn', 'debug', 'error']);
  });

  it('context fields win over data with the same key', () => {
    const entries: Record<string, unknown>[] = [];
    createLog({ fn: 'f', uid: 'real' }, (_s, _m, e) => entries.push(e)).info('x', { uid: 'spoofed' });
    expect(entries[0]?.['uid']).toBe('real');
  });
});
