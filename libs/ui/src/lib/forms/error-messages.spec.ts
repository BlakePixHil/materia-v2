import { mtErrorMessage } from './error-messages';

describe('mtErrorMessage', () => {
  it('words the first error with the defaults', () => {
    expect(mtErrorMessage({ required: true })).toBe('Fill in this field.');
    expect(mtErrorMessage({ minlength: { requiredLength: 3, actualLength: 1 } })).toBe('Use at least 3 characters.');
    expect(mtErrorMessage({ maxlength: { requiredLength: 10, actualLength: 12 } })).toBe('Use 10 characters or fewer.');
    expect(mtErrorMessage({ min: { min: 1, actual: 0 } })).toBe('Enter 1 or more.');
    expect(mtErrorMessage({ max: { max: 9, actual: 10 } })).toBe('Enter 9 or less.');
  });

  it('prefers field overrides, falls back for unknown keys, and returns null without errors', () => {
    expect(mtErrorMessage({ required: true }, { required: 'Enter the date of death.' })).toBe(
      'Enter the date of death.',
    );
    expect(mtErrorMessage({ notADate: true })).toBe('Check this field.');
    expect(mtErrorMessage(null)).toBeNull();
    expect(mtErrorMessage({})).toBeNull();
  });
});
