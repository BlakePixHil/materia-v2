import { FEEDBACK_MAX_LENGTH, SubmitFeedbackInput } from './feedback';

const valid = { requestId: '7b7a2c1e-8f43-4c1b-9d5e-2a6f0b3c4d5e', kind: 'idea', body: 'A darker sidebar, please.' };

describe('SubmitFeedbackInput (SEC-08)', () => {
  it('takes a kind, a message, the page and the version', () => {
    const parsed = SubmitFeedbackInput.parse({
      ...valid,
      body: '  Trim me  ',
      page: '/matters/m-1',
      version: '1.2.0+abc',
    });
    expect(parsed).toMatchObject({ kind: 'idea', body: 'Trim me', page: '/matters/m-1', version: '1.2.0+abc' });
  });

  it('needs a message, at most the longest allowed', () => {
    expect(SubmitFeedbackInput.safeParse({ ...valid, body: '   ' }).success).toBe(false);
    expect(SubmitFeedbackInput.safeParse({ ...valid, body: 'x'.repeat(FEEDBACK_MAX_LENGTH + 1) }).success).toBe(false);
    expect(SubmitFeedbackInput.safeParse({ ...valid, body: 'x'.repeat(FEEDBACK_MAX_LENGTH) }).success).toBe(true);
  });

  it('keeps the page to a path, so a search typed into the address never reaches support', () => {
    expect(SubmitFeedbackInput.safeParse({ ...valid, page: '/contacts?q=Smith' }).success).toBe(false);
    expect(SubmitFeedbackInput.safeParse({ ...valid, page: '/matters#notes' }).success).toBe(false);
    expect(SubmitFeedbackInput.safeParse({ ...valid, page: 'https://example.test/' }).success).toBe(false);
  });

  it('refuses an unknown kind or field', () => {
    expect(SubmitFeedbackInput.safeParse({ ...valid, kind: 'complaint' }).success).toBe(false);
    expect(SubmitFeedbackInput.safeParse({ ...valid, uid: 'someone-else' }).success).toBe(false);
  });
});
