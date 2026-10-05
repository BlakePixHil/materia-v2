import { resetPerformanceMonitoring, startPerformanceMonitoring, startTrace } from './perf';

describe('performance traces', () => {
  afterEach(() => resetPerformanceMonitoring());

  it('records nothing until monitoring starts (emulator builds)', () => {
    const done = startTrace('matter_open');
    expect(() => done()).not.toThrow();
  });

  it('buffers traces until the SDK loads, then records them once', async () => {
    const recorded: string[] = [];
    let resolve!: (r: (name: string) => void) => void;
    startPerformanceMonitoring(() => new Promise((r) => (resolve = r)));
    const done = startTrace('palette_search');
    done();
    done();
    resolve((name) => recorded.push(name));
    await Promise.resolve();
    await Promise.resolve();
    expect(recorded).toEqual(['palette_search']);
    startTrace('matter_open')();
    expect(recorded).toEqual(['palette_search', 'matter_open']);
  });

  it('fails silently when the SDK is blocked or throws', async () => {
    startPerformanceMonitoring(() => Promise.reject(new Error('blocked by an ad blocker')));
    await Promise.resolve();
    expect(() => startTrace('clerk_first_token')()).not.toThrow();
    resetPerformanceMonitoring();
    startPerformanceMonitoring(async () => () => {
      throw new Error('sdk error');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(() => startTrace('matter_open')()).not.toThrow();
  });
});
