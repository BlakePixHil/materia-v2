/**
 * Client error reports (FND-21). The web app's ErrorHandler sends unexpected errors to
 * `system-logClientError`, scrubbed of personal data on the client and scrubbed again on the server
 * (ADR-018, Security doc: logging). Nothing here may keep names, emails, phone numbers or document
 * text: messages are cut to 500 characters and quoted text is dropped.
 */

/** Errors one browser session may report per minute (the client drops the rest). */
export const CLIENT_ERRORS_PER_MINUTE = 20;
/** Longest message kept after scrubbing. */
export const CLIENT_ERROR_MESSAGE_MAX = 500;
/** Stack frames kept, and the longest frame line. */
export const CLIENT_ERROR_FRAMES_MAX = 30;
const FRAME_LINE_MAX = 300;

/** One report, as the client sends it (already scrubbed; the server scrubs again). */
export interface ClientErrorReport {
  message: string;
  stack?: string | undefined;
  route: string;
  version: string;
  userAgent: string;
}

/** `system-logClientError` input: a batch from one browser session (validated by the function). */
export interface LogClientErrorInput {
  sessionId: string;
  errors: ClientErrorReport[];
}

export interface LogClientErrorResult {
  accepted: number;
  dropped: number;
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// Phone numbers: +61 4xx xxx xxx, (03) 9xxx xxxx, 0412-345-678 and the like.
// Counted as a phone number once it has 8 or more digits.
const PHONE = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\b\d{2,4}(?:[\s-]\d{2,4}){1,4}\b/g;
// Six or more digits in a row: account, TFN, Medicare or card numbers.
const DIGIT_RUN = /\d{6,}/g;
// Quoted text, which may be a document's or a person's words. Apostrophes inside words stay.
const QUOTED = /"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|`[^`\n]*`|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu;
// A stack frame: V8 (`    at fn (url:1:2)`) or Firefox/Safari (`fn@url:1:2`).
const FRAME = /^\s*at\s|@\S*:\d+:\d+\)?\s*$/;

/** Scrubs one piece of free text: quoted text, emails, phone numbers and long digit runs. */
export function scrubText(text: string, max = CLIENT_ERROR_MESSAGE_MAX): string {
  const scrubbed = text
    .replace(QUOTED, '[quoted]')
    .replace(EMAIL, '[email]')
    .replace(PHONE, (match) => (match.replace(/\D/g, '').length >= 8 ? '[phone]' : match))
    .replace(DIGIT_RUN, '[number]');
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 1)}…` : scrubbed;
}

/** Strips the query string and fragment from a route (search terms can be personal). */
export function scrubRoute(route: string): string {
  const path = route.split(/[?#]/)[0] ?? '';
  return scrubText(path, 200);
}

/**
 * Scrubs a stack trace. Frame lines keep their file, line and column (needed to deobfuscate with
 * the private sourcemaps); every other line (the message, which can span lines) is scrubbed as text.
 */
export function scrubStack(stack: string): string {
  const lines = stack.split('\n');
  const out: string[] = [];
  let frames = 0;
  let textChars = 0;
  for (const line of lines) {
    if (FRAME.test(line)) {
      if (frames++ >= CLIENT_ERROR_FRAMES_MAX) continue;
      // A URL's query or fragment could carry data; frame positions never need them.
      out.push(line.replace(/\?[^:\s)]*/g, '').slice(0, FRAME_LINE_MAX));
    } else if (textChars < CLIENT_ERROR_MESSAGE_MAX) {
      const text = scrubText(line, CLIENT_ERROR_MESSAGE_MAX - textChars);
      textChars += text.length;
      out.push(text);
    }
  }
  return out.join('\n');
}

/** Scrubs a whole report: the client does this before sending and the server does it again. */
export function scrubClientError(report: ClientErrorReport): ClientErrorReport {
  return {
    message: scrubText(report.message),
    ...(report.stack ? { stack: scrubStack(report.stack) } : {}),
    route: scrubRoute(report.route),
    version: report.version.replace(/[^\w.+-]/g, '').slice(0, 40),
    userAgent: scrubText(report.userAgent, 300),
  };
}
