import {
  CLIENT_ERROR_FRAMES_MAX,
  CLIENT_ERROR_MESSAGE_MAX,
  scrubClientError,
  scrubRoute,
  scrubStack,
  scrubText,
} from './client-errors';

// Fictional data only.
const FIXTURE = {
  message:
    'Failed to render "Margaret Whitfield leaves the house at 12 Seaview Rd to her son" for margaret.whitfield@example.test, call 0412 345 678 or (03) 9555 0123, account 123456789',
  stack: [
    'TypeError: Failed to render "Margaret Whitfield leaves the house" for margaret.whitfield@example.test',
    '    at Ui.render (https://materia-v2-dev.web.app/chunk-ABC123.js:1:204857)',
    '    at https://materia-v2-dev.web.app/main-XYZ.js?v=jane@example.test:2:1234567',
    'render@https://materia-v2-dev.web.app/chunk-ABC123.js:1:204857',
  ].join('\n'),
  route: '/matters/m-123/documents?q=Whitfield+will#para-3',
  version: '1.4.0+abc1234',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0.6668.89 Safari/537.36',
};

const PII = [
  'Margaret',
  'Whitfield',
  'margaret.whitfield',
  'jane@',
  '0412 345 678',
  '9555 0123',
  '123456789',
  'Seaview',
];

describe('client error scrubbing', () => {
  it('leaves no personal data in the fixture', () => {
    const scrubbed = JSON.stringify(scrubClientError(FIXTURE));
    for (const value of PII) expect(scrubbed).not.toContain(value);
  });

  it('scrubs emails, phone numbers, digit runs and quoted text', () => {
    expect(scrubText('mail a.b+c@firm.example.com.au now')).toBe('mail [email] now');
    expect(scrubText('ring +61 412 345 678 or 03-9555-0123')).toBe('ring [phone] or [phone]');
    expect(scrubText('TFN 123456782')).toBe('TFN [number]');
    expect(scrubText('said “hello there” and ‘hi’ and `code` and "x"')).toBe(
      'said [quoted] and [quoted] and [quoted] and [quoted]',
    );
    expect(scrubText("Cannot read properties of undefined (reading 'name')")).toBe(
      'Cannot read properties of undefined (reading [quoted])',
    );
  });

  it('keeps apostrophes inside words and short numbers', () => {
    expect(scrubText("Can't find the matter's party 42")).toBe("Can't find the matter's party 42");
  });

  it('truncates messages to 500 characters', () => {
    const long = scrubText('x'.repeat(2000));
    expect(long).toHaveLength(CLIENT_ERROR_MESSAGE_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(scrubText('short', 3)).toBe('sh…');
  });

  it('drops the query and fragment from routes', () => {
    expect(scrubRoute('/matters/m-1/documents?q=Whitfield#x')).toBe('/matters/m-1/documents');
    expect(scrubRoute('')).toBe('');
  });

  it('keeps frame positions (for the sourcemaps) and scrubs the message lines', () => {
    const stack = scrubStack(FIXTURE.stack);
    expect(stack).toContain('chunk-ABC123.js:1:204857');
    expect(stack).toContain('main-XYZ.js:2:1234567');
    expect(stack).not.toContain('jane@');
    expect(stack.split('\n')[0]).toBe('TypeError: Failed to render [quoted] for [email]');
  });

  it('caps frames and message text', () => {
    const frames = Array.from({ length: 50 }, (_, i) => `    at f${i} (https://x.example/a.js:1:${i})`);
    expect(scrubStack(['Error: boom', ...frames].join('\n')).split('\n')).toHaveLength(1 + CLIENT_ERROR_FRAMES_MAX);
    const lines = Array.from({ length: 10 }, () => 'y'.repeat(200));
    expect(scrubStack(lines.join('\n')).length).toBeLessThanOrEqual(CLIENT_ERROR_MESSAGE_MAX + 10);
  });

  it('keeps a clean version and omits a missing stack', () => {
    const { stack, version, ...rest } = scrubClientError({ ...FIXTURE, stack: undefined, version: '1.0.0 <script>' });
    expect(stack).toBeUndefined();
    expect(version).toBe('1.0.0script');
    expect(rest.route).toBe('/matters/m-123/documents');
  });
});
