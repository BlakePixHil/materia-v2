# ADR-030: Notifications go through one notify() and a delivery queue

- **Status:** Accepted
- **Date:** 2026-10-05
- **Ticket:** [FND-20](https://linear.app/materia-web/issue/MAT-29)

## Context

Several functions already wrote notification documents by hand: task assignment, conflict alerts, deadline changes and missed deadlines. Each picked its own fields, nothing went beyond the app, and nobody's preferences applied. FND-20 adds email (Postmark, ADR-015) and push (FCM), preferences, quiet hours, a daily digest and bounce handling. More kinds are coming (mentions, escalations, Clerk, documents, exports). The design has to:

- send only what a person asked for, and always send what they must not miss (a critical deadline);
- never put matter content in an email subject, or a notification body in the logs;
- survive provider outages and retries without double-sending;
- keep a flood of events (an import, a bulk reassign) from turning into a flood of email;
- cost nothing in the web app's initial bundle (budget 300 kB, at 297.1 kB).

## Decision

We will route every notification through `notify(ctx, input, {tx?})` in `apps/functions/src/notifications/notify.ts`. It writes one `orgs/{orgId}/notifications/{id}` per recipient and enqueues one Cloud Task per external channel on the `notifications-deliver` queue. The rules that decide channels and timing are pure functions in `libs/domain/src/lib/notifications.ts`.

- **A typed kind registry.** `Notification` (schema v2) is a zod discriminated union on `kind`, each kind carrying its own ids. `NOTIFICATION_KINDS` gives each kind a label, default channels and priority, and is typed `satisfies Record<NotificationKind, …>`, so adding a kind is one union member and one registry entry.
- **Preferences on the user** (`users/{uid}.prefs.notifications`): channel master switches, per-kind overrides, the digest hour and quiet hours. `resolveChannels` applies them on the server. **Critical always goes in-app and by email**, whatever is stored; the rules also refuse turning off email for `deadline_escalation`. Unreadable fields fall back to defaults, so a bad settings document never stops a notification.
- **Quiet hours by schedule time.** Email and push for a non-critical notification created in quiet hours (default 19:00–07:00, the user's time zone, else the org's) are enqueued with a `scheduleTime` at the end of quiet hours. In-app is immediate.
- **Delivery is a queue worker**, `notifications-deliver`, one task per notification and channel, 6 attempts with exponential backoff (30 s to 1 h). Every attempt appends an outcome to `deliveries[]`: `sent`, `skipped` (with a reason: `read`, `no_address`, `undeliverable`, `no_devices`, `not_configured`), `failed`, or `dropped` (`not_member`: the recipient left the org). The worker is idempotent: a channel or device already sent is not sent again. Task names derive from the notification id, so re-enqueueing is a no-op.
- **Ports.** Email goes through `MailPort` (Postmark over `fetch`, stream `outbound`, templates in `apps/functions/src/mail/templates.ts`; no SDK). Push goes through a new `PushPort` (FCM via firebase-admin messaging) to `users/{uid}/devices/{deviceId}`; FCM's unregistered or invalid-token answers delete the device. Both have fakes, used in tests and in the emulator (which writes to `emulatorOutbox` and `emulatorPushOutbox`). With no `POSTMARK_TOKEN` outside the emulator, email is recorded `skipped: not_configured` rather than failing.
- **Bursts collapse.** Past 100 notifications for one person in a minute, later ones are written in-app with a `summaryId` and no channels, and one summary notification per minute is delivered instead. Critical notifications never collapse.
- **The digest is a 15-minute schedule** (`notifications-digest`) that, for each member whose digest hour has arrived in their local day, first creates `digests/digest-{uid}-{date}` (create fails if it exists, so it sends at most once a day) and sends only when there is something to report.
- **Bounces mark the address.** `notifications-postmarkWebhook` (HTTPS, basic auth with a shared secret, compared in constant time) sets `users/{uid}.emailDeliverability` on a hard bounce or spam complaint, and tells the person in-app.
- **The web app listens in the shell.** `NotificationsStore` (provided by the lazy shell) watches the person's unread in-app notifications, capped at 99, for the Inbox badge, and toasts high and critical arrivals while online. It starts 1.5 s after the shell, so the page's own reads go first.

## Consequences

- Existing writers (`tasks-onWrite`, `conflicts-onPartyAdded`/`onPartyRevived`, deadline recomputes, `deadlines-flagMissed`, and the documents upload pipeline's `document_infected` from CORE-12) call `notify()`. Task assignments and infected uploads now also email by default.
- Every notify call reads each recipient's member and user documents, and counts their last minute of notifications (an index on recipientUid, createdAt). That is cheap at practice scale and keeps the rules in one place.
- `notifications` is server-written except `readAt`, which the recipient may set to the server time or null. Devices and preferences are owner-only, with values checked in the rules.
- Two secrets (`POSTMARK_TOKEN`, `POSTMARK_WEBHOOK_SECRET`) and the FCM API must exist before deploy; infra/MANUAL.md lists the steps, including sender signature and SPF/DKIM/DMARC.
- The web bundle grows by about 20 bytes gzipped in the initial chunks; the store and its query live in the lazy shell chunk.
- Client device registration (web push with VAPID, mobile tokens), the inbox (CORE-22) and the settings screen come later; the schema and rules for them are in place.

## Alternatives considered

- **A Firestore trigger on `notifications` that delivers.** No queue to manage, but triggers retry without backoff control or scheduling, and quiet hours would need a second mechanism.
- **Preferences in a separate `notificationPrefs` collection.** Cleaner separation, but one more read per recipient and per digest, for no gain while the settings are small.
- **Postmark's SDK.** It works, but we use one endpoint (`POST /email`); `fetch` avoids a dependency in the functions bundle.
- **Client-side toasts for every arrival.** Noisy; only high and critical arrivals warrant interrupting the person.
