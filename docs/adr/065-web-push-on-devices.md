# ADR-065: Web push on devices

- **Status:** Accepted
- **Date:** 2026-10-07
- **Ticket:** [MOB-04](https://linear.app/materia-web/issue/MAT-109)
- **Builds on:** [ADR-030](030-notifications-infrastructure.md) (notifications, `PushPort`, `users/{uid}/devices`), [ADR-060](060-installable-app-updates-and-offline-indicators.md) (`sw.js`)

## Context

ADR-030 built push on the server: `notifications-deliver` sends through FCM to every token in `users/{uid}/devices/{deviceId}`, and deletes a device whose token FCM reports gone. Nothing registered a device yet. MOB-04 adds the browser side: asking for permission at a moment that makes sense, keeping one token per browser fresh, showing and routing the notification, a devices list in Settings, and pruning devices that went quiet. It must work in desktop Chrome, Android Chrome and an iOS app installed on the Home Screen (Safari delivers web push only there), and a lock screen must never show a client's name.

Firebase's own web setup expects a second service worker, `firebase-messaging-sw.js`, and a VAPID key pair generated in the console. Materia already has a service worker (`sw.js`, ADR-060) whose scope is the whole app, and a browser has one push subscription per service worker registration.

## Decision

**One service worker.** The token comes from `getToken(getMessaging(app), { serviceWorkerRegistration })` on the `sw.js` registration, with FCM's default VAPID key, so there is no key to generate or store. `firebase/messaging` loads only when someone turns push on or the daily refresh runs, never at start-up. `sw.js` handles `push` and `notificationclick` itself, before `ngsw-worker.js` sees them (`stopImmediatePropagation`), so Angular's worker never shows a second copy. Every push shows a notification (Safari revokes push from a site that doesn't).

**Device id and registry.** Each browser keeps a random id in IndexedDB (`materia-device`, store `kv`), with its registration (who, which token, when it was refreshed). Turning push on asks the browser for permission, gets a token and writes `users/{uid}/devices/{deviceId}`: `{token, platform, label, lastSeenAt}`, where `label` names the browser and system ("Chrome on macOS", "Materia app on iPhone") for Settings. Eight seconds after the app starts, at most once a day, the token and `lastSeenAt` are refreshed; a revoked permission or a device removed elsewhere clears it on this browser. Signing out deletes this browser's device and unsubscribes it before the auth sign-out. The rules keep devices private to their owner and check every field.

**Asking.** Never on sign-in. The first view of a critical deadline (a matter's Deadlines tab, or the Deadlines page) offers alerts in a card under the list; Settings → Preferences → Devices can turn push on at any time. Only an explicit "Turn on" asks the browser. Either answer to the card is remembered on the device. When the browser has notifications blocked, Materia never asks again and says how to allow them. iPhone and iPad Safari outside the Home Screen get "Install Materia to receive alerts", which opens the MOB-01 install steps. Turning a device on also turns on push in the person's preferences and for deadline reminders, unless they had already chosen for deadline reminders; escalations push by default.

**What a push says.** The server sends the notification's title (which names a matter by number at most) and a fixed body, `PUSH_BODY` ("Open Materia to see it."), with `data: {link, orgId, tag}`. The notification's own body, which can name a client or a deadline, stays in the app. FCM's `webpush` options mark it `Urgency: high`.

**Taps.** A tap focuses an open Materia window (focused, then visible, then any) and posts `{type: 'materia:push-open', url}` to it; with none open it opens one. Either way the URL is `/open?to=<link>&org=<orgId>`. The `/open` route accepts only paths inside Materia (`/` not followed by `/` or `\`; anything else goes to Today), and a notification from another practice asks before switching, because switching reloads Materia.

**Pruning.** Delivery skips and deletes devices whose `lastSeenAt` is more than 60 days old (`PUSH_DEVICE_STALE_DAYS`). A person whose only devices went quiet is recorded `skipped: inactive_devices`.

**Test push.** `notifications-testPush` sends a fixed test to one of the caller's own devices. A token FCM reports gone deletes the device.

**APIs.** The browser's FCM sign-up needs `fcmregistrations.googleapis.com` and `firebaseinstallations.googleapis.com` enabled in each project (Terraform, `firebase_env`).

## Consequences

- Push needs nothing from a person to set up: no VAPID key, no console steps, no secrets.
- A lock screen shows a matter number at most. The body is the same for every push, which is less useful than the full text, and is the price of that.
- A device someone stops using stops getting pushes after 60 days, and pushes to a browser whose site data was cleared stop at the next FCM "unregistered" answer.
- The emulators have no FCM: the browser's token is `emulator-{deviceId}`, and pushes land in `emulatorPushOutbox`, which the dev mail page shows.
- Real-device evidence (desktop Chrome, Android Chrome, an installed iOS app) is a manual check on dev.
