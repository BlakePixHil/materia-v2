import {
  DomainError,
  FEEDBACK_CALLABLES,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_PER_HOUR,
  Feedback,
  ROLES,
  SubmitFeedbackInput,
  type SubmitFeedbackResult,
} from '@materia/domain';

import { compact } from '../contacts/shared';
import { defineCallable, type CallableDefinition } from '../core/callable';
import { supportEmail } from '../core/params';
import { RESEND_API_KEY } from '../core/secrets';

const HOUR_MS = 3_600_000;

/**
 * `feedback-submit` (SEC-08; every role; idempotent): keeps a member's message in
 * `orgs/{orgId}/feedback`, then emails it to the support address when one is set. At most
 * `FEEDBACK_PER_HOUR` an hour per person (`counters/feedback-rate-{uid}`, RATE_LIMITED). The
 * message is stored before anything is emailed, so a mail failure never loses it; it is logged and
 * the result says `emailed: false`. Runs while a practice waits to be deleted, so people can still
 * reach support.
 */
export const submitDefinition = {
  name: FEEDBACK_CALLABLES.submit,
  input: SubmitFeedbackInput,
  roles: ROLES,
  idempotent: true,
  secrets: [RESEND_API_KEY],
  handler: async ({ input, uid, orgId, role, db, clock, requestId, ports, log }): Promise<SubmitFeedbackResult> => {
    const now = clock.now();
    const ref = db.collection(`orgs/${orgId}/feedback`).doc();
    const limit = db.doc(`orgs/${orgId}/counters/feedback-rate-${uid}`);
    const data = Feedback.schema.parse(
      compact({
        uid,
        kind: input.kind,
        body: input.body,
        page: input.page,
        version: input.version,
        createdAt: now,
        createdBy: uid,
        updatedAt: now,
        updatedBy: uid,
        schemaVersion: Feedback.version,
        _requestId: requestId,
      }),
    );
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(limit);
      const hits = ((snapshot.get('hits') as number[] | undefined) ?? []).filter((at) => at > now.getTime() - HOUR_MS);
      if (hits.length >= FEEDBACK_PER_HOUR) {
        throw new DomainError('RATE_LIMITED', 'Too many messages to support in the last hour', {
          perHour: FEEDBACK_PER_HOUR,
        });
      }
      tx.set(limit, { hits: [...hits, now.getTime()], updatedAt: now });
      tx.create(ref, data);
    });

    const to = supportEmail();
    let emailed = false;
    if (to) {
      const [org, member] = await Promise.all([
        db.doc(`orgs/${orgId}`).get(),
        db.doc(`orgs/${orgId}/members/${uid}`).get(),
      ]);
      try {
        await ports.mail.send({
          to,
          template: 'feedback',
          model: {
            orgName: org.get('name') ?? 'A practice',
            orgId,
            feedbackId: ref.id,
            senderName: member.get('displayName') ?? 'Someone',
            senderEmail: member.get('email') ?? 'no email address',
            role,
            kindLabel: FEEDBACK_KIND_LABELS[input.kind],
            body: data.body,
            page: data.page,
            version: data.version,
          },
          idempotencyKey: `feedback-${orgId}-${ref.id}`,
        });
        emailed = true;
      } catch (error) {
        log.warn('feedback email not sent', {
          feedbackId: ref.id,
          errorCode: (error as { code?: string }).code ?? 'unknown',
        });
      }
    }
    log.info('feedback received', { feedbackId: ref.id, kind: input.kind, emailed });
    return { feedbackId: ref.id, emailed };
  },
} satisfies CallableDefinition<typeof SubmitFeedbackInput, SubmitFeedbackResult>;

export const submit = defineCallable(submitDefinition);
