import { FEEDBACK_CALLABLES, type SubmitFeedbackInput, type SubmitFeedbackResult } from '@materia/domain';

import type { CallableClient } from './callable-client';

type Input<T> = Omit<T, 'requestId'>;

/** The `feedback-*` callables (SEC-08). */
export interface FeedbackCallables {
  /**
   * `feedback-submit` (every role; idempotent): sends a message to the people who run Materia. It
   * is kept, then emailed to support once a support address is set. RATE_LIMITED past ten an hour.
   */
  submit(input: Input<SubmitFeedbackInput>, options?: { requestId?: string }): Promise<SubmitFeedbackResult>;
}

export function feedbackCallables(client: Pick<CallableClient, 'call'>): FeedbackCallables {
  return {
    submit: (input, options = {}) =>
      client.call<Input<SubmitFeedbackInput>, SubmitFeedbackResult>(FEEDBACK_CALLABLES.submit, input, {
        idempotent: true,
        ...options,
      }),
  };
}
