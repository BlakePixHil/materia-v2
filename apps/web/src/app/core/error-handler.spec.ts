import { TestBed } from '@angular/core/testing';

import { ToastService } from '@materia/ui';

import { ERROR_REPORTER, GlobalErrorHandler } from './error-handler';

describe('GlobalErrorHandler', () => {
  function setup() {
    const report = vi.fn();
    TestBed.configureTestingModule({ providers: [GlobalErrorHandler, { provide: ERROR_REPORTER, useValue: report }] });
    const handler = TestBed.inject(GlobalErrorHandler);
    const show = vi.spyOn(TestBed.inject(ToastService), 'show');
    let now = 10_000;
    handler.now = () => now;
    return { handler, report, show, advance: (ms: number) => (now += ms) };
  }

  it('reports every error and shows one toast without the error details', () => {
    const { handler, report, show } = setup();
    const error = new TypeError('details that may contain data');
    handler.handleError(error);
    expect(report).toHaveBeenCalledWith(error);
    expect(show).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(show.mock.calls[0])).not.toContain('details that may contain data');
  });

  it('throttles toasts to one every few seconds', () => {
    const { handler, report, show, advance } = setup();
    handler.handleError(new Error('a'));
    advance(1000);
    handler.handleError(new Error('b'));
    expect(report).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenCalledTimes(1);
    advance(4000);
    handler.handleError(new Error('c'));
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('logs the error name only by default', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.inject(ERROR_REPORTER)(new RangeError('secret client name'));
    TestBed.inject(ERROR_REPORTER)('a string');
    expect(log.mock.calls).toEqual([
      ['Unexpected error', 'RangeError'],
      ['Unexpected error', 'string'],
    ]);
    log.mockRestore();
  });
});
