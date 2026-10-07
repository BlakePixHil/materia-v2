import * as z from 'zod';

import { DocIdSchema, InstantSchema, MetaShape, NonEmptyString } from './common';

const ORG = 'orgs/{orgId}';

export const NOTIFICATION_CHANNELS = ['inapp', 'email', 'push'] as const;
export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;
/** `critical` always emails, and is never collapsed or held back for quiet hours (FND-20). */
export const NOTIFICATION_PRIORITIES = ['normal', 'high', 'critical'] as const;
export const NotificationPrioritySchema = z.enum(NOTIFICATION_PRIORITIES);
export type NotificationPriority = z.infer<typeof NotificationPrioritySchema>;

/** One delivery outcome on a channel other than in-app (FND-20), written by `notifications-deliver`. */
export const NotificationDeliverySchema = z.object({
  channel: z.enum(['email', 'push']),
  status: z.enum(['sent', 'skipped', 'failed', 'dropped']),
  /** Why it was skipped, failed or dropped (`not_configured`, `not_member`, `invalid_token`, …). */
  reason: z.string().max(64).optional(),
  at: InstantSchema,
  /** The Cloud Tasks attempt (0 for the first). */
  attempt: z.number().int().min(0),
  /** The provider's message id (Resend, FCM); never content. */
  providerId: z.string().max(300).optional(),
  /** The device a push went to (`users/{uid}/devices/{deviceId}`). */
  deviceId: DocIdSchema.optional(),
});
export type NotificationDelivery = z.infer<typeof NotificationDeliverySchema>;

const notificationBase = {
  recipientUid: DocIdSchema,
  /** Also the email subject: never matter content ("Deadline in 3 days: M-2026-0142" at most). */
  title: NonEmptyString,
  /** Never privileged content: name the thing and link to it instead. */
  body: z.string(),
  link: z.string().startsWith('/'),
  /** `null` until read (stored explicitly, so the unread query can match it). */
  readAt: InstantSchema.nullable().optional(),
  /** The channels this recipient gets it on, after their preferences (FND-20). */
  channels: z.array(NotificationChannelSchema).min(1),
  /** `high` and `critical` are shown prominently (a toast while online). Absent means normal. */
  priority: NotificationPrioritySchema.optional(),
  /** Email and push outcomes, appended by `notifications-deliver` (server-owned). */
  deliveries: z.array(NotificationDeliverySchema).optional(),
  /** Email and push wait until then (the recipient's quiet hours). */
  deliverAfter: InstantSchema.optional(),
  /**
   * Part of a burst for this recipient: listed in the inbox but not delivered or counted; its
   * summary is. `null` otherwise (stored explicitly, so the unread badge can leave bursts out).
   */
  summaryId: DocIdSchema.nullable().optional(),
  /** On a burst summary: how many notifications it stands for. */
  collapsedCount: z.number().int().min(1).optional(),
  /** Archived from the inbox by its recipient (CORE-22): hidden from the list, kept until `expireAt`. */
  hiddenAt: InstantSchema.nullable().optional(),
  /** Firestore TTL deletes it then: `NOTIFICATION_RETENTION_DAYS` after it was sent (CORE-22). */
  expireAt: InstantSchema.optional(),
};

/**
 * `notifications/{id}`, discriminated on `kind`. Written only through `notify()` (FND-20). Each
 * kind's default channels and priority live in `NOTIFICATION_KINDS` (notifications.ts): a new
 * kind is one member here (its payload ids) and one entry there.
 */
export const NotificationPayloadSchema = z.discriminatedUnion('kind', [
  // Someone who already has an account was invited to another org (FND-17).
  z.object({ kind: z.literal('invite'), inviteId: DocIdSchema, ...notificationBase }),
  z.object({
    kind: z.literal('deadline_reminder'),
    deadlineId: DocIdSchema,
    matterId: DocIdSchema,
    ...notificationBase,
  }),
  z.object({
    kind: z.literal('deadline_escalation'),
    deadlineId: DocIdSchema,
    matterId: DocIdSchema,
    ...notificationBase,
  }),
  // A recompute proposed a date change or removal (`changeId`), or the engine's date fell earlier
  // than an override (no `changeId`) (CORE-10). A critical deadline moved into the past is `high`.
  z.object({
    kind: z.literal('deadline_changed'),
    deadlineId: DocIdSchema,
    matterId: DocIdSchema,
    changeId: DocIdSchema.optional(),
    ...notificationBase,
  }),
  // The daily missed check asks the responsible lawyer to confirm a deadline missed (CORE-10).
  z.object({
    kind: z.literal('deadline_missed'),
    deadlineId: DocIdSchema,
    matterId: DocIdSchema,
    ...notificationBase,
  }),
  z.object({
    kind: z.literal('task_assigned'),
    taskId: DocIdSchema,
    matterId: DocIdSchema.optional(),
    ...notificationBase,
  }),
  // A task is due soon (CORE-11, reminders-dispatch); `matterId` is absent for personal tasks.
  z.object({
    kind: z.literal('task_reminder'),
    taskId: DocIdSchema,
    matterId: DocIdSchema.optional(),
    ...notificationBase,
  }),
  z.object({ kind: z.literal('mention'), noteId: DocIdSchema, matterId: DocIdSchema, ...notificationBase }),
  z.object({ kind: z.literal('suggestion'), suggestionId: DocIdSchema, matterId: DocIdSchema, ...notificationBase }),
  // A party added to an open matter is on other matters (CORE-02, conflicts-onPartyAdded).
  z.object({
    kind: z.literal('conflict_alert'),
    matterId: DocIdSchema,
    checkId: DocIdSchema,
    contactId: DocIdSchema,
    ...notificationBase,
  }),
  // An upload to a matter was infected and deleted (CORE-12): to the uploader and the org's owners
  // and admins. High priority.
  z.object({
    kind: z.literal('document_infected'),
    matterId: DocIdSchema,
    documentId: DocIdSchema,
    ...notificationBase,
  }),
  z.object({ kind: z.literal('invite_accepted'), memberUid: DocIdSchema, ...notificationBase }),
  // A matter, or one of its deadlines, was given to someone (as the responsible lawyer).
  z.object({
    kind: z.literal('assignment'),
    matterId: DocIdSchema,
    deadlineId: DocIdSchema.optional(),
    ...notificationBase,
  }),
  // Clerk finished something a person asked for on a matter (AI-04 onwards).
  z.object({
    kind: z.literal('suggestion_ready'),
    matterId: DocIdSchema,
    suggestionId: DocIdSchema.optional(),
    ...notificationBase,
  }),
  // A generated or uploaded document finished processing (CORE-12, DOC tickets).
  z.object({
    kind: z.literal('document_ready'),
    matterId: DocIdSchema,
    documentId: DocIdSchema,
    ...notificationBase,
  }),
  z.object({
    kind: z.literal('integration_error'),
    provider: z.enum(['microsoft', 'google', 'xero']),
    ...notificationBase,
  }),
  z.object({ kind: z.literal('export_ready'), exportId: DocIdSchema, ...notificationBase }),
  // The practice was scheduled for deletion, or the deletion was cancelled (SEC-05): to every member.
  z.object({ kind: z.literal('org_deletion'), ...notificationBase }),
  // A testator whose original is held in safe custody has died (CORE-17): to the packet's lawyer.
  z.object({ kind: z.literal('safe_custody'), packetId: DocIdSchema, ...notificationBase }),
  z.object({ kind: z.literal('budget_alert'), matterId: DocIdSchema, ...notificationBase }),
  // A costs disclosure is due: unsent 7 days on, or an estimate revision made it out of date (BILL-06).
  z.object({ kind: z.literal('costs_disclosure'), matterId: DocIdSchema, ...notificationBase }),
  z.object({ kind: z.literal('system'), ...notificationBase }),
]);
export type NotificationKind = z.infer<typeof NotificationPayloadSchema>['kind'];
export const Notification = {
  schema: NotificationPayloadSchema.and(z.object(MetaShape)),
  create: NotificationPayloadSchema,
  update: z.object({ readAt: InstantSchema.nullable(), hiddenAt: InstantSchema.nullable() }).partial().strict(),
  // v2 (FND-20): `channels` replaces `channel`; adds `critical`, `readAt: null`, deliveries and
  // bursts. v1 documents (in-app only) are not read by anything.
  version: 2,
  path: `${ORG}/notifications`,
};
export type Notification = z.infer<typeof Notification.schema>;
