import { InjectionToken } from '@angular/core';
import type { ValidationErrors } from '@angular/forms';

/** Builds the message for one validation error from that error's value (for example `{ requiredLength: 3 }`). */
export type MtErrorMessage = string | ((error: unknown) => string);

/**
 * Default copy for Angular's built-in validators. The design system's writing rule: say what's
 * wrong and how to fix it, never "Invalid input". Fields override these with `errorMessages`, and an
 * app can replace the defaults with the `MT_ERROR_MESSAGES` token.
 */
export const MT_DEFAULT_ERROR_MESSAGES: Readonly<Record<string, MtErrorMessage>> = {
  required: 'Fill in this field.',
  requiredTrue: 'Tick this box to continue.',
  email: 'Enter an email address, like name@example.com.',
  minlength: (e) => `Use at least ${(e as { requiredLength: number }).requiredLength} characters.`,
  maxlength: (e) => `Use ${(e as { requiredLength: number }).requiredLength} characters or fewer.`,
  min: (e) => `Enter ${(e as { min: number }).min} or more.`,
  max: (e) => `Enter ${(e as { max: number }).max} or less.`,
  pattern: 'Check the format and try again.',
};

export const MT_ERROR_MESSAGES = new InjectionToken<Readonly<Record<string, MtErrorMessage>>>('MT_ERROR_MESSAGES', {
  factory: () => MT_DEFAULT_ERROR_MESSAGES,
});

/** The message for the first error in `errors`, or null. Unknown error keys get a generic message. */
export function mtErrorMessage(
  errors: ValidationErrors | null,
  overrides: Readonly<Record<string, MtErrorMessage>> = {},
  defaults: Readonly<Record<string, MtErrorMessage>> = MT_DEFAULT_ERROR_MESSAGES,
): string | null {
  if (!errors) return null;
  const [key] = Object.keys(errors);
  if (key === undefined) return null;
  const message = overrides[key] ?? defaults[key];
  if (message === undefined) return 'Check this field.';
  return typeof message === 'function' ? message(errors[key]) : message;
}
