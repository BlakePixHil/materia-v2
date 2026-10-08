import * as z from 'zod';

import { withMeta } from './schemas/common';

/**
 * Help & feedback (SEC-08): anyone in a practice can tell the people who run Materia that
 * something isn't working, suggest something or ask a question, from the account menu, More on a
 * phone or ⌘K. `feedback-submit` keeps each message in `orgs/{orgId}/feedback` and emails it to
 * the support address once one is set. It replaces legacy's feedback collection (not migrated).
 */

export const FEEDBACK_KINDS = ['problem', 'idea', 'question'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** How each kind reads in the form and the support email. */
export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  problem: 'Something isn’t working',
  idea: 'An idea',
  question: 'A question',
};

/** The longest message, in characters. */
export const FEEDBACK_MAX_LENGTH = 4000;
/** How many messages one person can send in an hour (RATE_LIMITED after that). */
export const FEEDBACK_PER_HOUR = 10;

export const FEEDBACK_CALLABLES = { submit: 'feedback-submit' } as const;

/** The page the person was on: a path with ids only, never a query string or a fragment. */
const FeedbackPageSchema = z
  .string()
  .max(300)
  .regex(/^\/[^?#\s]*$/, 'A path, without a query string');

export const SubmitFeedbackInput = z.strictObject({
  requestId: z.uuid(),
  kind: z.enum(FEEDBACK_KINDS),
  body: z.string().trim().min(1, 'Write a message').max(FEEDBACK_MAX_LENGTH),
  page: FeedbackPageSchema.optional(),
  /** The web app's version and commit (`RELEASE`), to tell builds apart. */
  version: z.string().max(100).optional(),
});
export type SubmitFeedbackInput = z.input<typeof SubmitFeedbackInput>;

export interface SubmitFeedbackResult {
  feedbackId: string;
  /** Whether it was emailed to support (false while no support address is set, or if sending failed). */
  emailed: boolean;
}

/**
 * `orgs/{orgId}/feedback/{id}` (SEC-08): one message from a member. Server-only: written by
 * `feedback-submit`, read by the people who run Materia in the console, never by clients. The
 * message is `body`, so the audit log keeps only its hash.
 */
export const Feedback = withMeta(
  () => ({
    uid: z.string().min(1),
    kind: z.enum(FEEDBACK_KINDS),
    body: z.string().min(1).max(FEEDBACK_MAX_LENGTH),
    page: FeedbackPageSchema.optional(),
    version: z.string().max(100).optional(),
  }),
  {
    path: 'orgs/{orgId}/feedback',
    migratable: false,
    serverOwned: ['uid', 'kind', 'body', 'page', 'version'],
  },
);
export type Feedback = z.infer<typeof Feedback.schema>;
